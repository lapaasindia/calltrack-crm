// End-to-end mobile sync test against a real server instance on a throwaway
// database: pairing, batch call sync (known/unknown/invalid), reinstall
// re-sync dedupe, recording upload + matching, review actions, revocation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sync-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

let baseUrl;
let server;
let adminCookie;
let deviceToken;
let leadId;

const api = async (pathname, { method = 'GET', body, token, cookie, raw } = {}) => {
  const headers = {};
  if (body && !raw) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Admin session (bootstrap created admin/admin123).
  const login = await api('/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'admin123' },
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get('set-cookie').split(';')[0];

  // A lead the synced calls should attach to.
  const lead = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Known Lead', phone: '9876543210', assigned_to: 1 },
  });
  leadId = lead.data.id;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('pairing: bad code rejected, good code exchanges once', async () => {
  const bad = await api('/api/auth/pair', { method: 'POST', body: { code: 'NOPE99' } });
  assert.equal(bad.status, 401);

  const codeRes = await api('/api/devices/pairing-code', {
    method: 'POST', cookie: adminCookie, body: { user_id: 1 },
  });
  assert.equal(codeRes.status, 200);

  const pair = await api('/api/auth/pair', {
    method: 'POST', body: { code: codeRes.data.code, device_name: 'Test Phone' },
  });
  assert.equal(pair.status, 200);
  assert.ok(pair.data.token.length >= 64);
  deviceToken = pair.data.token;

  // One-time: same code again must fail.
  const replay = await api('/api/auth/pair', {
    method: 'POST', body: { code: codeRes.data.code },
  });
  assert.equal(replay.status, 401);
});

test('bearer token authenticates sync endpoints', async () => {
  const status = await api('/api/sync/status', { token: deviceToken });
  assert.equal(status.status, 200);
  assert.equal(status.data.user.id, 1);
  // Browser session must NOT pass device-only endpoints.
  const viaSession = await api('/api/sync/status', { cookie: adminCookie });
  assert.equal(viaSession.status, 403);
});

const BATCH = {
  calls: [
    { call_log_ts: Date.now() - 3600000, phone: '+91 98765 43210', direction: 'outgoing', duration_seconds: 120 }, // known lead, connected
    { call_log_ts: Date.now() - 3000000, phone: '9876543210', direction: 'outgoing', duration_seconds: 0 },        // known lead, not picked
    { call_log_ts: Date.now() - 2400000, phone: '9123456789', direction: 'incoming', duration_seconds: 45 },       // unknown → captured
    { call_log_ts: Date.now() - 1800000, phone: '12345', direction: 'outgoing', duration_seconds: 10 },            // invalid number
  ],
};

test('call batch: attach known, capture unknown, reject invalid', async () => {
  const res = await api('/api/sync/calls', { method: 'POST', token: deviceToken, body: BATCH });
  assert.equal(res.status, 200);
  const statuses = res.data.results.map((r) => r.status);
  assert.deepEqual(statuses, ['attached', 'attached', 'captured', 'invalid']);
  assert.equal(res.data.results[0].lead_id, leadId);
});

test('reinstall re-sync: identical batch is all duplicates, zero new rows', async () => {
  const res = await api('/api/sync/calls', { method: 'POST', token: deviceToken, body: BATCH });
  const statuses = res.data.results.map((r) => r.status);
  assert.deepEqual(statuses, ['duplicate', 'duplicate', 'duplicate', 'invalid']);

  const lead = await api(`/api/leads/${leadId}`, { cookie: adminCookie });
  assert.equal(lead.data.calls.length, 2); // not 4
  assert.equal(lead.data.calls.find((c) => c.duration_seconds === 120).disposition, 'connected');
  assert.equal(lead.data.calls.find((c) => c.duration_seconds === 0).disposition, 'not_picked');
});

test('recording upload matches the connected call via filename number', async () => {
  const ts = BATCH.calls[0].call_log_ts;
  const d = new Date(ts + 5.5 * 3600000); // IST wall time for the filename
  const pad = (n) => String(n).padStart(2, '0');
  const fname = `Call recording 9876543210_${String(d.getUTCFullYear()).slice(2)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.m4a`;

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('fake-audio-bytes-1')]), fname);
  form.append('filename', fname);
  form.append('last_modified_ms', String(ts + 120000));
  form.append('duration_seconds', '118');

  const res = await api('/api/sync/recordings', {
    method: 'POST', token: deviceToken, body: form, raw: true,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.match_status, 'matched');

  const lead = await api(`/api/leads/${leadId}`, { cookie: adminCookie });
  const call = lead.data.calls.find((c) => c.duration_seconds === 120);
  assert.ok(call.recording_id, 'recording linked to the call');

  // Audio streams with access control.
  const audio = await fetch(`${baseUrl}/api/review/audio/${call.recording_id}`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(audio.status, 200);
});

test('ambiguous recording lands in review queue, manual attach works', async () => {
  // Rapid redial: two calls 8s apart, similar durations, recording filename
  // with NO number → timestamps can't separate them → must be ambiguous.
  const ts = Date.now() - 600000;
  await api('/api/sync/calls', {
    method: 'POST', token: deviceToken,
    body: { calls: [
      { call_log_ts: ts, phone: '9876543210', direction: 'outgoing', duration_seconds: 60 },
      { call_log_ts: ts + 8000, phone: '9123456789', direction: 'outgoing', duration_seconds: 58 },
    ] },
  });
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('fake-audio-bytes-2')]), 'Recording.m4a');
  form.append('filename', 'Recording.m4a');
  form.append('last_modified_ms', String(ts + 63000));
  form.append('duration_seconds', '60');
  const res = await api('/api/sync/recordings', {
    method: 'POST', token: deviceToken, body: form, raw: true,
  });
  assert.equal(res.data.match_status, 'ambiguous');

  const queue = await api('/api/review/recordings', { cookie: adminCookie });
  const rec = queue.data.find((r) => r.id === res.data.recording_id);
  assert.ok(rec, 'in review queue');
  assert.ok(rec.candidates.length >= 2, 'candidates offered');

  const candidate = rec.candidates.find((c) => c.call_id);
  const attach = await api(`/api/review/recordings/${rec.id}/attach`, {
    method: 'POST', cookie: adminCookie, body: { call_id: candidate.call_id },
  });
  assert.equal(attach.status, 200);
});

test('captured call → one-tap create lead moves calls and recordings', async () => {
  const captured = await api('/api/review/captured', { cookie: adminCookie });
  const row = captured.data.find((c) => c.phone === '9123456789');
  assert.ok(row, 'captured call visible');

  const create = await api(`/api/review/captured/${row.id}/create-lead`, {
    method: 'POST', cookie: adminCookie, body: { name: 'New Prospect' },
  });
  assert.equal(create.status, 200);

  const lead = await api(`/api/leads/${create.data.lead_id}`, { cookie: adminCookie });
  assert.equal(lead.data.name, 'New Prospect');
  assert.ok(lead.data.calls.length >= 2, 'all captured calls from this number moved');

  // Re-syncing the original batch must STILL not duplicate (now as lead calls).
  const resync = await api('/api/sync/calls', { method: 'POST', token: deviceToken, body: BATCH });
  assert.equal(resync.data.results[2].status, 'duplicate');
});

test('ignore-always suppresses future syncs of that number', async () => {
  await api('/api/sync/calls', {
    method: 'POST', token: deviceToken,
    body: { calls: [{ call_log_ts: Date.now() - 100000, phone: '9000099990', direction: 'incoming', duration_seconds: 5 }] },
  });
  const captured = await api('/api/review/captured', { cookie: adminCookie });
  const row = captured.data.find((c) => c.phone === '9000099990');
  await api(`/api/review/captured/${row.id}/ignore`, {
    method: 'POST', cookie: adminCookie, body: { always: true },
  });
  const again = await api('/api/sync/calls', {
    method: 'POST', token: deviceToken,
    body: { calls: [{ call_log_ts: Date.now() - 50000, phone: '9000099990', direction: 'incoming', duration_seconds: 9 }] },
  });
  assert.equal(again.data.results[0].status, 'ignored');
});

test('tasks: create, appear in today queue, complete', async () => {
  const create = await api('/api/tasks', {
    method: 'POST', cookie: adminCookie,
    body: { title: 'Send brochure PDF', lead_id: leadId },
  });
  assert.equal(create.status, 200);
  const today = await api('/api/today', { cookie: adminCookie });
  assert.ok(today.data.tasks.some((t) => t.id === create.data.id));
  const done = await api(`/api/tasks/${create.data.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { status: 'done' },
  });
  assert.equal(done.status, 200);
});

test('fresh install seeds a product so a lead converts to a deal out of the box', async () => {
  // Regression: bootstrap previously seeded no product, so winning a deal 400'd
  // ("Pick a valid product") on every fresh install.
  const products = await api('/api/products', { cookie: adminCookie });
  assert.equal(products.status, 200);
  assert.ok(products.data.length >= 1, 'a default product exists on a fresh install');
  const productId = products.data[0].id;

  const lead = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Deal Lead', phone: '9811122233', assigned_to: 1 },
  });
  const deal = await api(`/api/leads/${lead.data.id}/deals`, {
    method: 'POST', cookie: adminCookie,
    body: { product_id: productId, deal_value_rupees: 5000 },
  });
  assert.equal(deal.status, 200, 'deal created out of the box');

  const detail = await api(`/api/leads/${lead.data.id}`, { cookie: adminCookie });
  assert.equal(detail.data.stage, 'won', 'lead marked won');
  assert.ok(detail.data.deals?.length >= 1, 'deal recorded on the lead');
});

test('repeat call on an existing lead\'s alt number attaches to it, no duplicate', async () => {
  // A lead whose PRIMARY phone differs from the called number; the called number
  // is its secondary (alt) phone, so sync (primary-only) can't match it and it
  // lands in the captured queue.
  const lead = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Repeat Caller', phone: '9700000001', alt_phone: '9700000002', assigned_to: 1 },
  });
  const existingLeadId = lead.data.id;

  const synced = await api('/api/sync/calls', {
    method: 'POST', token: deviceToken,
    body: { calls: [{ call_log_ts: Date.now() - 120000, phone: '9700000002', direction: 'outgoing', duration_seconds: 75 }] },
  });
  assert.equal(synced.data.results[0].status, 'captured');

  // The captured row offers the existing lead as a candidate (alt-phone match).
  const captured = await api('/api/review/captured', { cookie: adminCookie });
  const row = captured.data.find((c) => c.phone === '9700000002');
  assert.ok(row, 'captured call visible');
  const cand = (row.lead_candidates || []).find((x) => x.id === existingLeadId);
  assert.ok(cand, 'existing lead offered as a candidate');
  assert.equal(cand.match, 'alt_phone');

  // Attach to the existing lead + schedule a follow-up — no new lead created.
  const attach = await api(`/api/review/captured/${row.id}/attach-existing`, {
    method: 'POST', cookie: adminCookie,
    body: { lead_id: existingLeadId, as_follow_up: true },
  });
  assert.equal(attach.status, 200);

  const detail = await api(`/api/leads/${existingLeadId}`, { cookie: adminCookie });
  assert.ok(detail.data.calls.some((c) => c.duration_seconds === 75), 'captured call moved onto the existing lead');
  assert.ok(detail.data.follow_up, 'a follow-up was scheduled');

  const after = await api('/api/review/captured', { cookie: adminCookie });
  assert.ok(!after.data.some((c) => c.phone === '9700000002'), 'captured row consumed, no duplicate');
});

test('revoked device gets 401 immediately', async () => {
  const devices = await api('/api/devices', { cookie: adminCookie });
  const dev = devices.data.find((d) => !d.revoked_at);
  await api(`/api/devices/${dev.id}/revoke`, { method: 'POST', cookie: adminCookie });
  const res = await api('/api/sync/status', { token: deviceToken });
  assert.equal(res.status, 401);
});
