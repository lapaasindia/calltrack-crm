// Mobile sync hardening (audit SEC-6 / SEC-7 / SCALE-18): upload size cap →
// 413, timestamp validation → 400, per-device daily quota → 429, disk floor →
// 507, HEAD/GET existence pre-check by sha256, non-owner calls never drive a
// lead's stage/score, and re-attachment after a phone is re-used is idempotent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sync-hardening-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';
// Tiny per-file cap so the 413 path is cheap to exercise (read at module load).
process.env.CRM_MAX_RECORDING_BYTES = '4096';

let baseUrl;
let server;
let db;
let setSetting;
let adminCookie;
let token;
let deviceId;
let ownerId;
let otherId;

const api = async (pathname, { method = 'GET', body, cookie, token: tok, raw } = {}) => {
  const headers = {};
  if (body && !raw) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};
const login = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
};
const upload = (bytes, fields = {}) => {
  const form = new FormData();
  const fname = fields.filename || 'Recording.m4a';
  form.append('file', new Blob([bytes]), fname);
  form.append('filename', fname);
  for (const [k, v] of Object.entries(fields)) if (k !== 'filename') form.append(k, String(v));
  return api('/api/sync/recordings', { method: 'POST', token, body: form, raw: true });
};
const randomBytes = (n) => crypto.randomBytes(n);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dbm = await import('../db.js');
  db = dbm.default;
  setSetting = dbm.setSetting;
  adminCookie = await login('admin', 'admin123');
  const mk = async (u, role) => {
    const r = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: u, full_name: u, password: 'somepass123', role } });
    assert.equal(r.status, 200);
    return r.data.id;
  };
  ownerId = await mk('devowner', 'caller');
  otherId = await mk('other', 'agent');
  const code = await api('/api/devices/pairing-code', { method: 'POST', cookie: adminCookie, body: { user_id: ownerId } });
  const pair = await api('/api/auth/pair', { method: 'POST', body: { code: code.data.code, device_name: 'Owner phone', android_id: 'OWNER_PHONE' } });
  assert.equal(pair.status, 200);
  token = pair.data.token;
  deviceId = pair.data.device_id;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('SEC-7: a synced call on someone else\'s lead is recorded but never moves the stage or rescores', async () => {
  const mine = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'Mine', phone: '9866600001', assigned_to: ownerId } });
  const theirs = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'Theirs', phone: '9866600002', assigned_to: otherId } });
  // Leads carry an initial score from creation (SCALE-10); "not rescored"
  // means that snapshot is untouched by the foreign sync.
  const snap = (id) => db.prepare('SELECT stage, score, score_factors FROM leads WHERE id = ?').get(id);
  const mineBefore = snap(mine.data.id);
  const theirsBefore = snap(theirs.data.id);
  assert.ok(Number.isInteger(theirsBefore.score), 'initial score present');
  const r = await api('/api/sync/calls', {
    method: 'POST', token,
    body: { calls: [
      { call_log_ts: Date.now() - 400000, phone: '9866600001', direction: 'outgoing', duration_seconds: 90 },
      { call_log_ts: Date.now() - 300000, phone: '9866600002', direction: 'outgoing', duration_seconds: 90 },
    ] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map((x) => x.status), ['attached', 'attached'], 'response shape unchanged');

  const mineRow = snap(mine.data.id);
  assert.equal(mineRow.stage, 'contacted', 'own lead: connected call moves new → contacted');
  assert.notDeepEqual([mineRow.score, mineRow.score_factors], [mineBefore.score, mineBefore.score_factors], 'own lead rescored after its connected call');

  const theirsRow = snap(theirs.data.id);
  assert.equal(theirsRow.stage, 'new', 'foreign lead: stage untouched');
  assert.deepEqual([theirsRow.score, theirsRow.score_factors], [theirsBefore.score, theirsBefore.score_factors], 'foreign lead: score snapshot untouched');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_events WHERE lead_id = ?').get(theirs.data.id).n, 0);
  // ...but the call itself is on record (append-only truth), attributed to the syncing user.
  const call = db.prepare('SELECT user_id, auto_logged FROM calls WHERE lead_id = ?').get(theirs.data.id);
  assert.equal(call.user_id, ownerId);
  assert.equal(call.auto_logged, 1);
});

test('SCALE-18: re-syncing history after a phone number is re-used as a new lead is idempotent', async () => {
  const ts1 = Date.now() - 900000;
  const a = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'Lead A', phone: '9866600003', assigned_to: ownerId } });
  const first = await api('/api/sync/calls', {
    method: 'POST', token, body: { calls: [{ call_log_ts: ts1, phone: '9866600003', direction: 'outgoing', duration_seconds: 30 }] },
  });
  assert.equal(first.data.results[0].status, 'attached');

  // Lead A is soft-deleted; the same number comes back as Lead B.
  assert.equal((await api(`/api/leads/${a.data.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200);
  const b = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'Lead B', phone: '9866600003', assigned_to: ownerId } });
  assert.equal(b.status, 200);

  // A full re-sync (reinstall) replays the old call: it must NOT land on B.
  const replay = await api('/api/sync/calls', {
    method: 'POST', token, body: { calls: [{ call_log_ts: ts1, phone: '9866600003', direction: 'outgoing', duration_seconds: 30 }] },
  });
  assert.equal(replay.data.results[0].status, 'duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls WHERE lead_id = ?').get(b.data.id).n, 0, 'B has no backdated history');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls WHERE lead_id = ?').get(a.data.id).n, 1, 'A keeps its call');

  // A genuinely new call attaches to B.
  const fresh = await api('/api/sync/calls', {
    method: 'POST', token, body: { calls: [{ call_log_ts: ts1 + 60000, phone: '9866600003', direction: 'outgoing', duration_seconds: 30 }] },
  });
  assert.equal(fresh.data.results[0].status, 'attached');
  assert.equal(fresh.data.results[0].lead_id, b.data.id);
});

test('SEC-6: oversize upload → 413 JSON, bad last_modified_ms → 400, unsupported type → 400', async () => {
  const big = await upload(randomBytes(5000));
  assert.equal(big.status, 413);
  assert.equal(big.data.error, 'File too large');
  assert.equal(fs.readdirSync(path.join(TMP, 'data', 'recordings', 'tmp')).length, 0, 'no temp file left behind');

  for (const bad of ['abc', '5', '1e3', String(Date.now() + 3 * 86400000), '1.5']) {
    const r = await upload(randomBytes(300), { last_modified_ms: bad });
    assert.equal(r.status, 400, `last_modified_ms=${bad} → 400`);
    assert.match(r.data.error, /last_modified_ms/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recordings').get().n, 0, 'nothing stored');
  const exe = await upload(randomBytes(300), { filename: 'evil.exe' });
  assert.equal(exe.status, 400);
});

test('HEAD /api/sync/recordings/:sha256 and GET .../exists let the app skip re-uploads', async () => {
  const bytes = randomBytes(700);
  const stored = await upload(bytes, { last_modified_ms: Date.now() - 1000, duration_seconds: 10 });
  assert.equal(stored.status, 200);
  assert.equal(stored.data.status, 'stored');
  const hash = sha(bytes);

  const head = await fetch(`${baseUrl}/api/sync/recordings/${hash}`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(head.status, 200);
  const headUpper = await fetch(`${baseUrl}/api/sync/recordings/${hash.toUpperCase()}`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(headUpper.status, 200, 'case-insensitive hex');
  const headMissing = await fetch(`${baseUrl}/api/sync/recordings/${'0'.repeat(64)}`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(headMissing.status, 404);
  const headBad = await fetch(`${baseUrl}/api/sync/recordings/not-a-hash`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(headBad.status, 400);
  const headNoAuth = await fetch(`${baseUrl}/api/sync/recordings/${hash}`, { method: 'HEAD' });
  assert.equal(headNoAuth.status, 401);

  const exists = await api(`/api/sync/recordings/${hash}/exists`, { token });
  assert.equal(exists.status, 200);
  assert.equal(exists.data.exists, true);
  assert.equal(exists.data.recording_id, stored.data.recording_id);
  const missing = await api(`/api/sync/recordings/${'f'.repeat(64)}/exists`, { token });
  assert.deepEqual(missing.data, { exists: false, recording_id: null, match_status: null });

  // Re-uploading the same bytes is still answered as a duplicate.
  const dup = await upload(bytes);
  assert.equal(dup.data.status, 'duplicate');
  assert.equal(dup.data.recording_id, stored.data.recording_id);
});

test('SEC-6: per-device daily quota (upload_daily_quota_mb) → 429 with Retry-After; duplicates never count', async () => {
  const usedBefore = db.prepare('SELECT COALESCE(SUM(size_bytes),0) n FROM recordings WHERE device_id = ?').get(deviceId).n;
  assert.equal(usedBefore, 700);
  const status = await api('/api/sync/status', { token });
  assert.equal(status.data.upload_quota.used_bytes, 700);
  assert.equal(status.data.upload_quota.quota_bytes, 2048 * 1024 * 1024, 'default 2 GB/day');

  // Quota of ~1 KB: the 700 B already used + a 1.2 KB file is over.
  setSetting('upload_daily_quota_mb', 0.001);
  const over = await upload(randomBytes(1200));
  assert.equal(over.status, 429);
  assert.match(over.data.error, /quota/i);
  assert.ok(Number(over.headers.get('retry-after')) >= 60);
  assert.equal(over.data.used_bytes, 700);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recordings').get().n, 1, 'rejected upload not stored');

  // Back to the default → the same file is accepted.
  setSetting('upload_daily_quota_mb', 2048);
  const ok = await upload(randomBytes(1200));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'stored');
  assert.equal((await api('/api/sync/status', { token })).data.upload_quota.used_bytes, 1900);
});

test('SEC-6: uploads are refused with 507 when free disk is below the floor', async () => {
  process.env.CRM_MIN_FREE_DISK_BYTES = '1e18';
  try {
    const r = await upload(randomBytes(500));
    assert.equal(r.status, 507);
    assert.match(r.data.error, /disk/i);
    assert.ok(r.data.free_bytes > 0);
  } finally {
    delete process.env.CRM_MIN_FREE_DISK_BYTES;
  }
  const r = await upload(randomBytes(500));
  assert.equal(r.status, 200, 'accepted again once the floor is back to normal');
});

test('read_only cannot sync from a paired phone', async () => {
  const ro = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'rodev', full_name: 'rodev', password: 'somepass123', role: 'read_only' } });
  const code = await api('/api/devices/pairing-code', { method: 'POST', cookie: adminCookie, body: { user_id: ro.data.id } });
  const pair = await api('/api/auth/pair', { method: 'POST', body: { code: code.data.code, device_name: 'RO phone', android_id: 'RO_PHONE' } });
  assert.equal(pair.status, 200);
  assert.equal((await api('/api/sync/status', { token: pair.data.token })).status, 200, 'GET is fine');
  const r = await api('/api/sync/calls', {
    method: 'POST', token: pair.data.token,
    body: { calls: [{ call_log_ts: Date.now() - 1000, phone: '9866600009', direction: 'incoming', duration_seconds: 5 }] },
  });
  assert.equal(r.status, 403);
});

test('SCALE-25: the recordings subfolder is the IST month of the recording, not the UTC month', async () => {
  // 2025-06-30 20:00 UTC is 2025-07-01 01:30 IST → July, not June.
  const r1 = await upload(randomBytes(400), { last_modified_ms: Date.UTC(2025, 5, 30, 20, 0, 0), duration_seconds: 5 });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const f1 = db.prepare('SELECT file_path FROM recordings WHERE id = ?').get(r1.data.recording_id).file_path;
  assert.ok(f1.startsWith('2025-07/'), `IST month folder, got ${f1}`);
  assert.ok(fs.existsSync(path.join(TMP, 'data', 'recordings', f1)));
  // 2025-07-31 19:00 UTC is 2025-08-01 00:30 IST → August.
  const r2 = await upload(randomBytes(400), { last_modified_ms: Date.UTC(2025, 6, 31, 19, 0, 0) });
  const f2 = db.prepare('SELECT file_path FROM recordings WHERE id = ?').get(r2.data.recording_id).file_path;
  assert.ok(f2.startsWith('2025-08/'), `got ${f2}`);
  // A midday instant lands in the same month either way.
  const r3 = await upload(randomBytes(400), { last_modified_ms: Date.UTC(2025, 2, 15, 8, 0, 0) });
  const f3 = db.prepare('SELECT file_path FROM recordings WHERE id = ?').get(r3.data.recording_id).file_path;
  assert.ok(f3.startsWith('2025-03/'), `got ${f3}`);
});
