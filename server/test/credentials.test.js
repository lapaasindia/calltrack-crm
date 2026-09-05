// Credential lifecycle + device-token hardening (audit SEC-4 / SEC-5 / SEC-15 /
// SEC-16). Runs against a real server on a throwaway database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-credentials-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
let db;
let adminCookie;

const api = async (pathname, { method = 'GET', body, cookie, token } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};
const login = (username, password) =>
  api('/api/auth/login', { method: 'POST', body: { username, password } });
const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];
const createUser = async (username, password, role = 'caller') => {
  const r = await api('/api/users', {
    method: 'POST', cookie: adminCookie, body: { username, full_name: username, password, role },
  });
  assert.equal(r.status, 200, `create ${username}`);
  return r.data.id;
};
const pairDevice = async (userId, androidId) => {
  const code = await api('/api/devices/pairing-code', { method: 'POST', cookie: adminCookie, body: { user_id: userId } });
  assert.equal(code.status, 200);
  const pair = await api('/api/auth/pair', {
    method: 'POST', body: { code: code.data.code, device_name: 'Phone', android_id: androidId },
  });
  assert.equal(pair.status, 200);
  return pair.data;
};

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  const r = await login('admin', 'admin123');
  assert.equal(r.status, 200);
  adminCookie = cookieOf(r);
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('SEC-4: ?token= authenticates ONLY the audio GET route; every other route needs the header', async () => {
  const uid = await createUser('tokuser', 'tokpass123');
  const lead = await api('/api/leads', {
    method: 'POST', cookie: adminCookie, body: { name: 'Tok Lead', phone: '9811100001', assigned_to: uid },
  });
  const { token } = await pairDevice(uid, 'TOK_PHONE');

  // Header works everywhere.
  assert.equal((await api('/api/sync/status', { token })).status, 200);
  assert.equal((await api('/api/leads', { token })).status, 200);

  // Query-string token is refused on ordinary GETs and on writes.
  assert.equal((await api(`/api/leads?token=${token}`)).status, 401, 'GET /api/leads?token= refused');
  assert.equal((await api(`/api/sync/status?token=${token}`)).status, 401, 'GET /api/sync/status?token= refused');
  const write = await fetch(`${baseUrl}/api/leads/${lead.data.id}/follow-up?token=${token}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ due_at: new Date(Date.now() + 86400000).toISOString() }),
  });
  assert.equal(write.status, 401, 'PUT ...?token= refused (no state change via URL creds)');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM follow_ups WHERE lead_id = ? AND status = 'pending'").get(lead.data.id).n, 0);

  // The audio GET path still accepts it (older APKs): auth passes, 404 for a
  // recording that does not exist (never 401).
  const audio = await fetch(`${baseUrl}/api/review/audio/999999?token=${token}`);
  assert.equal(audio.status, 404, 'audio route authenticates via ?token=');
  // ...but only for GET.
  const audioPost = await fetch(`${baseUrl}/api/review/audio/999999?token=${token}`, { method: 'POST' });
  assert.equal(audioPost.status, 401);
});

test('device last_seen_at is written at most once per 60 s', async () => {
  const uid = await createUser('seenuser', 'seenpass123');
  const { token, device_id } = await pairDevice(uid, 'SEEN_PHONE');
  await api('/api/sync/status', { token });
  const first = db.prepare('SELECT last_seen_at FROM device_tokens WHERE id = ?').get(device_id).last_seen_at;
  assert.ok(first, 'first request stamps last_seen_at');
  await new Promise((r) => setTimeout(r, 15));
  await api('/api/sync/status', { token });
  const second = db.prepare('SELECT last_seen_at FROM device_tokens WHERE id = ?').get(device_id).last_seen_at;
  assert.equal(second, first, 'a request 15 ms later does not rewrite last_seen_at');
});

test('SEC-16: a must_change_password account keeps syncing from its phone, but its browser session is gated', async () => {
  const uid = await createUser('gatedev', 'gatepass123');
  const reset = await api(`/api/users/${uid}`, { method: 'PATCH', cookie: adminCookie, body: { new_password: 'resetpass123' } });
  assert.equal(reset.status, 200);
  assert.equal(db.prepare('SELECT must_change_password m FROM users WHERE id = ?').get(uid).m, 1);

  const { token } = await pairDevice(uid, 'GATE_PHONE');
  assert.equal((await api('/api/sync/status', { token })).status, 200, 'phone is not stranded by the gate');

  const sess = cookieOf(await login('gatedev', 'resetpass123'));
  const gated = await api('/api/leads', { cookie: sess });
  assert.equal(gated.status, 403);
  assert.equal(gated.data.must_change_password, true, 'browser session still gated');
});

test('SEC-5: self-service password change revokes device tokens and OTHER sessions, keeps the current one', async () => {
  const uid = await createUser('rotate', 'rotatepass1');
  const { token } = await pairDevice(uid, 'ROT_PHONE');
  const s1 = cookieOf(await login('rotate', 'rotatepass1'));
  const s2 = cookieOf(await login('rotate', 'rotatepass1'));
  assert.equal((await api('/api/sync/status', { token })).status, 200);
  assert.equal((await api('/api/auth/me', { cookie: s2 })).status, 200);

  const change = await api('/api/auth/change-password', {
    method: 'POST', cookie: s1, body: { current_password: 'rotatepass1', new_password: 'rotatepass2' },
  });
  assert.equal(change.status, 200);
  assert.equal(change.data.revoked_devices, 1);
  assert.equal(change.data.revoked_sessions, 1, 'exactly the OTHER session was destroyed');

  assert.equal((await api('/api/sync/status', { token })).status, 401, 'pre-change device token is dead');
  assert.equal((await api('/api/auth/me', { cookie: s2 })).status, 401, 'other session is dead');
  assert.equal((await api('/api/leads', { cookie: s1 })).status, 200, 'the session that changed the password survives');
  assert.equal((await login('rotate', 'rotatepass2')).status, 200);
});

test('SEC-5: an admin password reset kills the user\'s sessions and phones', async () => {
  const uid = await createUser('resetme', 'resetpass1');
  const { token } = await pairDevice(uid, 'RESET_PHONE');
  const sess = cookieOf(await login('resetme', 'resetpass1'));
  const r = await api(`/api/users/${uid}`, { method: 'PATCH', cookie: adminCookie, body: { new_password: 'resetpass2' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.revoked_devices, 1);
  assert.equal(r.data.revoked_sessions, 1);
  assert.equal((await api('/api/sync/status', { token })).status, 401);
  assert.equal((await api('/api/auth/me', { cookie: sess })).status, 401);
});

test('SEC-5 + SCALE-20: deactivation revokes everything and reports open work for reassignment', async () => {
  const uid = await createUser('leaver', 'leaverpass1');
  const { token } = await pairDevice(uid, 'LEAVER_PHONE');
  const sess = cookieOf(await login('leaver', 'leaverpass1'));
  const lead = await api('/api/leads', {
    method: 'POST', cookie: adminCookie, body: { name: 'Leaver Lead', phone: '9811100002', assigned_to: uid },
  });
  assert.equal(lead.status, 200);
  const fu = await api(`/api/leads/${lead.data.id}/follow-up`, {
    method: 'PUT', cookie: adminCookie, body: { due_at: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(fu.status, 200);
  db.prepare(
    `INSERT INTO tasks (title, lead_id, assigned_to, due_date, created_by, created_at)
     VALUES ('Send deck', ?, ?, '2030-01-01', 1, ?)`
  ).run(lead.data.id, uid, new Date().toISOString());

  const del = await api(`/api/users/${uid}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(del.status, 200);
  assert.deepEqual(del.data.open_work, { leads: 1, follow_ups: 1, tasks: 1 });
  assert.equal(del.data.revoked_devices, 1);
  assert.equal((await api('/api/sync/status', { token })).status, 401, 'deactivated user\'s phone is cut off');
  assert.equal((await api('/api/auth/me', { cookie: sess })).status, 401, 'deactivated user\'s session is gone');
  // Nothing was reassigned automatically.
  assert.equal(db.prepare('SELECT assigned_to FROM leads WHERE id = ?').get(lead.data.id).assigned_to, uid);

  // PATCH is_active:0 takes the same path.
  const uid2 = await createUser('leaver2', 'leaverpass1');
  await pairDevice(uid2, 'LEAVER2_PHONE');
  const patch = await api(`/api/users/${uid2}`, { method: 'PATCH', cookie: adminCookie, body: { is_active: false } });
  assert.equal(patch.status, 200);
  assert.deepEqual(patch.data.open_work, { leads: 0, follow_ups: 0, tasks: 0 });
  assert.equal(patch.data.revoked_devices, 1);
});

test('SEC-15: a legacy token with NULL expires_at expires 90 days after paired_at / last_seen_at', async () => {
  const { hashToken } = await import('../middleware/auth.js');
  const uid = await createUser('legacy', 'legacypass1');
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const mk = (raw, pairedAt, lastSeen) => db.prepare(
    `INSERT INTO device_tokens (user_id, device_name, token_hash, paired_at, last_seen_at, expires_at)
     VALUES (?, 'Legacy phone', ?, ?, ?, NULL)`
  ).run(uid, hashToken(raw), pairedAt, lastSeen);

  mk('legacy-stale-token', daysAgo(120), null);
  assert.equal((await api('/api/sync/status', { token: 'legacy-stale-token' })).status, 401, 'paired 120 d ago, never seen → expired');

  mk('legacy-stale-seen-token', daysAgo(200), daysAgo(95));
  assert.equal((await api('/api/sync/status', { token: 'legacy-stale-seen-token' })).status, 401, 'last seen 95 d ago → expired');

  mk('legacy-live-token', daysAgo(200), daysAgo(10));
  assert.equal((await api('/api/sync/status', { token: 'legacy-live-token' })).status, 200, 'last seen 10 d ago → still valid (sliding)');
});
