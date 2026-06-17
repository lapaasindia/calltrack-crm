// Security-hardening regression tests (audit remediation). Covers the access
// control, authentication, and injection fixes so they can't silently regress:
//   H-1 forced password change gate · H-2 login lockout · H-7 lead scoping ·
//   H-8 manager→owner pairing block · M-4 Sarvam key sealed · M-7 CSV injection.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-security-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
// Provision the bootstrap admin password so it isn't gated by must_change_password.
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
let dbMod;
let adminCookie;
let adminId;

const api = async (pathname, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};

const apiText = async (pathname, { cookie } = {}) => {
  const res = await fetch(`${baseUrl}${pathname}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, text: await res.text() };
};

const login = async (username, password) =>
  api('/api/auth/login', { method: 'POST', body: { username, password } });

const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  dbMod = (await import('../db.js')).default;
  const r = await login('admin', 'admin123');
  assert.equal(r.status, 200, 'admin login should succeed (CRM_ADMIN_PASSWORD set)');
  assert.equal(r.data.must_change_password, false, 'env-provisioned admin is not force-changed');
  adminCookie = cookieOf(r);
  const me = await api('/api/auth/me', { cookie: adminCookie });
  adminId = me.data.id;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- H-1: forced password change gate ----
test('H-1: an admin-reset account is locked to change-password until rotated', async () => {
  const created = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'gateuser', full_name: 'Gate User', password: 'initpass123', role: 'caller' },
  });
  assert.equal(created.status, 200);
  const uid = created.data.id;

  // Admin resets the password → must_change_password is set.
  const reset = await api(`/api/users/${uid}`, {
    method: 'PATCH', cookie: adminCookie, body: { new_password: 'reset12345' },
  });
  assert.equal(reset.status, 200);

  // Login still works and signals the forced change.
  const loginRes = await login('gateuser', 'reset12345');
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.data.must_change_password, true);
  const cookie = cookieOf(loginRes);

  // ...but every other endpoint is blocked until the password is changed.
  const blocked = await api('/api/leads', { cookie });
  assert.equal(blocked.status, 403, 'gated account cannot reach the API');
  assert.equal(blocked.data.must_change_password, true);

  // Changing the password lifts the gate.
  const change = await api('/api/auth/change-password', {
    method: 'POST', cookie, body: { current_password: 'reset12345', new_password: 'freshpass123' },
  });
  assert.equal(change.status, 200);
  const ok = await api('/api/leads', { cookie });
  assert.equal(ok.status, 200, 'gate lifted after password change');
});

test('H-1/H-2: password policy rejects short and default-ish passwords', async () => {
  const short = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'shorty', full_name: 'Shorty', password: 'short1', role: 'caller' },
  });
  assert.equal(short.status, 400, 'sub-8-char password rejected');
  const weak = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'weaky', full_name: 'Weaky', password: 'admin123', role: 'caller' },
  });
  assert.equal(weak.status, 400, 'common default password rejected');
});

// ---- H-7: lead list scoping for non-admin roles ----
test('H-7: an agent sees only their own leads, never everyone\'s', async () => {
  const agent = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'agent_sec', full_name: 'Agent Sec', password: 'agentpass1', role: 'agent' },
  });
  assert.equal(agent.status, 200);
  const agentId = agent.data.id;

  // One lead assigned to the agent, one to the admin.
  const mine = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Agent Lead', phone: '9876500001', assigned_to: agentId, source: 'manual' },
  });
  assert.equal(mine.status, 200);
  const other = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Admin Lead', phone: '9876500002', assigned_to: adminId, source: 'manual' },
  });
  assert.equal(other.status, 200);

  const agentCookie = cookieOf(await login('agent_sec', 'agentpass1'));
  const list = await api('/api/leads', { cookie: agentCookie });
  assert.equal(list.status, 200);
  const ids = (list.data.leads || list.data).map((l) => l.id);
  assert.ok(ids.includes(mine.data.id), 'agent sees their own lead');
  assert.ok(!ids.includes(other.data.id), 'agent does NOT see the admin-only lead');
});

// ---- H-8: manager cannot pair a phone to an owner account ----
test('H-8: a manager cannot mint a pairing code for an owner account', async () => {
  const mgr = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'mgr_sec', full_name: 'Manager Sec', password: 'mgrpass123', role: 'manager' },
  });
  assert.equal(mgr.status, 200);
  const caller = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'callee_sec', full_name: 'Callee', password: 'calleepass1', role: 'caller' },
  });
  assert.equal(caller.status, 200);

  const mgrCookie = cookieOf(await login('mgr_sec', 'mgrpass123'));
  // Pairing a phone to the (owner-tier) admin must be refused.
  const escalate = await api('/api/devices/pairing-code', {
    method: 'POST', cookie: mgrCookie, body: { user_id: adminId },
  });
  assert.equal(escalate.status, 403, 'manager blocked from pairing to an owner');
  // But pairing a non-owner (a caller) is allowed.
  const ok = await api('/api/devices/pairing-code', {
    method: 'POST', cookie: mgrCookie, body: { user_id: caller.data.id },
  });
  assert.equal(ok.status, 200, 'manager can still pair a non-owner');
});

// ---- M-4: Sarvam API key is sealed at rest, never plaintext ----
test('M-4: the Sarvam key is encrypted in the settings table', async () => {
  const r = await api('/api/settings', {
    method: 'PUT', cookie: adminCookie, body: { sarvam_api_key: 'sk-secret-plaintext-123' },
  });
  assert.equal(r.status, 200);
  const row = dbMod.prepare("SELECT value FROM settings WHERE key = 'sarvam_api_key'").get();
  assert.ok(row, 'key is stored');
  assert.ok(!row.value.includes('sk-secret-plaintext-123'), 'plaintext key is NOT in the DB');
  assert.match(JSON.parse(row.value), /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/, 'stored as sealed iv:tag:ct');
  const status = await api('/api/settings', { cookie: adminCookie });
  assert.equal(status.data.has_sarvam_key, true);
});

// ---- M-7: CSV export neutralizes spreadsheet formula injection ----
test('M-7: a formula-injected lead source is defanged in the CSV export', async () => {
  const r = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'CSV Victim', phone: '9876500003', source: '=HYPERLINK("http://evil","x")' },
  });
  assert.equal(r.status, 200);
  const csv = await apiText('/api/reports/sources?format=csv', { cookie: adminCookie });
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes("'=HYPERLINK"), 'formula cell is prefixed with an apostrophe');
  assert.ok(!/(^|,)=HYPERLINK/.test(csv.text), 'no bare =HYPERLINK cell remains');
});

// ---- H-2: login lockout (runs LAST — it locks this IP) ----
test('H-2: repeated failed logins are locked out', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await login('lockuser', 'wrongpass');
    assert.equal(r.status, 401, `attempt ${i + 1} is a normal auth failure`);
  }
  const locked = await login('lockuser', 'wrongpass');
  assert.equal(locked.status, 429, 'further attempts are rate-limited');
});
