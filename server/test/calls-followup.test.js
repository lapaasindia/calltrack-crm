// QA-5: logging a call must not silently drop a lead's pending follow-up. Only
// a call that reached someone (connected) or proved the number dead
// (wrong_number) completes it; not_picked / busy / switched_off keep it
// pending unless the caller scheduled a new next follow-up, which supersedes
// it. The response says which happened via follow_up_kept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-calls-followup-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
let db;
let adminCookie;
let callerCookie;
let callerId;
let leadId;

const api = async (pathname, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};
const login = async (username, password) => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  return res.headers.get('set-cookie').split(';')[0];
};
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const pendingRow = () => db.prepare("SELECT * FROM follow_ups WHERE lead_id = ? AND status = 'pending'").get(leadId) || null;
const rowById = (id) => db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(id);
const schedule = async (days) => {
  const r = await api(`/api/leads/${leadId}/follow-up`, { method: 'PUT', cookie: callerCookie, body: { due_at: inDays(days), reason: 'Call back' } });
  assert.equal(r.status, 200);
  return pendingRow();
};
const logCall = (body) => api(`/api/leads/${leadId}/calls`, { method: 'POST', cookie: callerCookie, body });

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  adminCookie = await login('admin', 'admin123');
  const u = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'fucaller', full_name: 'FU Caller', password: 'callerpass1', role: 'caller' } });
  assert.equal(u.status, 200);
  callerId = u.data.id;
  callerCookie = await login('fucaller', 'callerpass1');
  const lead = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'Follow Me', phone: '9877700001', assigned_to: callerId } });
  assert.equal(lead.status, 200);
  leadId = lead.data.id;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('not_picked / busy / switched_off without a next follow-up keep the pending follow-up (follow_up_kept: true)', async () => {
  const fu = await schedule(1);
  assert.ok(fu, 'follow-up pending before the calls');
  for (const disposition of ['not_picked', 'busy', 'switched_off']) {
    const r = await logCall({ disposition });
    assert.equal(r.status, 200, disposition);
    assert.equal(r.data.follow_up_kept, true, `${disposition}: follow-up kept`);
    const still = pendingRow();
    assert.ok(still, `${disposition}: follow-up still pending`);
    assert.equal(still.id, fu.id, `${disposition}: same follow-up row, not replaced`);
    assert.equal(still.completed_by_call_id, null);
  }
  // Visible on the lead (and hence in the Today queue) as before.
  const detail = await api(`/api/leads/${leadId}`, { cookie: callerCookie });
  assert.equal(detail.data.follow_up?.id, fu.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls WHERE lead_id = ?').get(leadId).n, 3, 'the attempts are still logged');
});

test('an unreached call WITH a next follow-up supersedes the old one (cancelled, not done)', async () => {
  const old = pendingRow();
  assert.ok(old);
  const r = await logCall({ disposition: 'busy', next_follow_up_at: inDays(3), follow_up_reason: 'Try again Thursday' });
  assert.equal(r.status, 200);
  assert.equal(r.data.follow_up_kept, false);
  assert.equal(rowById(old.id).status, 'cancelled', 'old follow-up superseded, not marked done');
  assert.equal(rowById(old.id).completed_by_call_id, null);
  const fresh = pendingRow();
  assert.ok(fresh && fresh.id !== old.id, 'a new pending follow-up exists');
  assert.equal(fresh.reason, 'Try again Thursday');
  assert.equal(fresh.created_by_call_id, r.data.call_id);
});

test('a connected call completes the pending follow-up (follow_up_kept: false)', async () => {
  const fu = pendingRow();
  assert.ok(fu);
  const r = await logCall({ disposition: 'connected', outcome: 'interested' });
  assert.equal(r.status, 200);
  assert.equal(r.data.follow_up_kept, false);
  const done = rowById(fu.id);
  assert.equal(done.status, 'done');
  assert.equal(done.completed_by_call_id, r.data.call_id);
  assert.ok(done.completed_at);
  assert.equal(pendingRow(), null);
});

test('a connected call with a next follow-up completes the old one and schedules the new one', async () => {
  const fu = await schedule(1);
  const r = await logCall({ disposition: 'connected', next_follow_up_at: inDays(2) });
  assert.equal(r.data.follow_up_kept, false);
  assert.equal(rowById(fu.id).status, 'done');
  const fresh = pendingRow();
  assert.ok(fresh && fresh.id !== fu.id);
});

test('wrong_number completes the pending follow-up (the number is dead)', async () => {
  // Reset to a pending follow-up first (previous test left a new one pending).
  const fu = pendingRow();
  assert.ok(fu);
  const r = await logCall({ disposition: 'wrong_number' });
  assert.equal(r.data.follow_up_kept, false);
  assert.equal(rowById(fu.id).status, 'done');
  assert.equal(pendingRow(), null);
});

test('no pending follow-up → follow_up_kept is false and nothing is invented', async () => {
  assert.equal(pendingRow(), null);
  const r = await logCall({ disposition: 'not_picked' });
  assert.equal(r.status, 200);
  assert.equal(r.data.follow_up_kept, false);
  assert.equal(pendingRow(), null);
  // ...and a new next follow-up on an unreached call is still scheduled.
  const r2 = await logCall({ disposition: 'not_picked', next_follow_up_at: inDays(1) });
  assert.equal(r2.data.follow_up_kept, false);
  assert.ok(pendingRow());
});
