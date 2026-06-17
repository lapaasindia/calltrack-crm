// Phase 1 — Foundations: role widening (migration rebuild preserved data),
// audit logging on login, notifications create/list/read-all, and the settings
// round-trip where the Sarvam key is write-only (never echoed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-foundations-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

let baseUrl;
let server;
let dbMod;
let adminCookie;

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

const loginCookie = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, `login ${username} should succeed`);
  return r.headers.get('set-cookie').split(';')[0];
};

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  dbMod = (await import('../db.js')).default;
  adminCookie = await loginCookie('admin', 'admin123');
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('role widening: bootstrap admin survived the table rebuild', async () => {
  const me = await api('/api/auth/me', { cookie: adminCookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.username, 'admin');
  assert.equal(me.data.role, 'admin');
  // The widened CHECK + department column exist on the rebuilt table.
  const cols = dbMod.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('department'), 'department column added');
});

test('new wider roles are accepted, unknown roles rejected', async () => {
  // A manager (new role) can be created with a department.
  const created = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'mgr1', full_name: 'Manager One', password: 'secret9', role: 'manager', department: 'Sales' },
  });
  assert.equal(created.status, 200);

  // read_only is a valid role too.
  const ro = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'viewer1', full_name: 'View Only', password: 'secret9', role: 'read_only' },
  });
  assert.equal(ro.status, 200);

  const list = await api('/api/users', { cookie: adminCookie });
  const mgr = list.data.find((u) => u.username === 'mgr1');
  assert.equal(mgr.role, 'manager');
  assert.equal(mgr.department, 'Sales');

  // An unknown role on update is rejected.
  const bad = await api(`/api/users/${mgr.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { role: 'wizard' },
  });
  assert.equal(bad.status, 400);
});

test('manager authorizes as admin tier; read_only blocked from owner writes', async () => {
  const mgrCookie = await loginCookie('mgr1', 'secret9');
  // Manager (isAdmin tier) can manage team — list users (requireAdmin).
  const asMgr = await api('/api/users', { cookie: mgrCookie });
  assert.equal(asMgr.status, 200);
  // But manager is NOT an owner — settings writes (requireOwner) are blocked.
  const mgrSettings = await api('/api/settings', {
    method: 'PUT', cookie: mgrCookie, body: { company_name: 'Nope Inc' },
  });
  assert.equal(mgrSettings.status, 403, 'manager cannot change settings');
  // Manager cannot view the audit log (requireOwner).
  const mgrAudit = await api('/api/audit', { cookie: mgrCookie });
  assert.equal(mgrAudit.status, 403);

  const roCookie = await loginCookie('viewer1', 'secret9');
  // read_only cannot manage team (requireAdmin).
  const roUsers = await api('/api/users', { cookie: roCookie });
  assert.equal(roUsers.status, 403);
});

test('audit: a row is written on successful login and visible to owner', async () => {
  // Fresh login generates a LOGIN_SUCCESS audit row.
  await loginCookie('admin', 'admin123');
  const audit = await api('/api/audit?limit=50', { cookie: adminCookie });
  assert.equal(audit.status, 200);
  assert.ok(audit.data.total >= 1);
  const login = audit.data.logs.find((l) => l.action === 'LOGIN_SUCCESS');
  assert.ok(login, 'LOGIN_SUCCESS recorded');
  assert.equal(login.user_email, 'admin', 'username captured as user_email');

  // A failed login is recorded too.
  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  const after = await api('/api/audit?limit=50', { cookie: adminCookie });
  assert.ok(after.data.logs.some((l) => l.action === 'LOGIN_FAILED'), 'LOGIN_FAILED recorded');

  // Employee CRUD is audited.
  assert.ok(after.data.logs.some((l) => l.action === 'EMPLOYEE_CREATED'), 'EMPLOYEE_CREATED recorded');
});

test('notifications: create, list with unread count, read-all', async () => {
  // Drop two notifications on the admin (user id 1) via the server lib.
  const { sendNotification } = await import('../lib/notify.js');
  sendNotification(1, 'Welcome', 'Phase 1 is live', 'success');
  sendNotification(1, 'Heads up', 'A follow-up is due', 'warning');

  const list = await api('/api/notifications', { cookie: adminCookie });
  assert.equal(list.status, 200);
  assert.ok(list.data.notifications.length >= 2);
  assert.ok(list.data.unread >= 2, 'unread count reflects new notifications');
  // Newest first.
  assert.equal(list.data.notifications[0].title, 'Heads up');

  const readAll = await api('/api/notifications/read-all', { method: 'POST', cookie: adminCookie });
  assert.equal(readAll.status, 200);
  assert.ok(readAll.data.marked >= 2);

  const after = await api('/api/notifications', { cookie: adminCookie });
  assert.equal(after.data.unread, 0, 'all read after read-all');
});

test('privilege escalation: manager cannot create or promote into the owner tier', async () => {
  const mgrCookie = await loginCookie('mgr1', 'secret9');

  // A manager (isAdmin, NOT isOwner) must not be able to mint a super_admin.
  const createSuper = await api('/api/users', {
    method: 'POST', cookie: mgrCookie,
    body: { username: 'sneaky_super', full_name: 'Sneaky', password: 'secret9', role: 'super_admin' },
  });
  assert.equal(createSuper.status, 403, 'manager cannot create a super_admin');

  // ...nor an admin.
  const createAdmin = await api('/api/users', {
    method: 'POST', cookie: mgrCookie,
    body: { username: 'sneaky_admin', full_name: 'Sneaky2', password: 'secret9', role: 'admin' },
  });
  assert.equal(createAdmin.status, 403, 'manager cannot create an admin');

  // A manager CAN still create a non-owner (e.g. a caller).
  const createCaller = await api('/api/users', {
    method: 'POST', cookie: mgrCookie,
    body: { username: 'plain_caller', full_name: 'Caller', password: 'secret9', role: 'caller' },
  });
  assert.equal(createCaller.status, 200, 'manager can still create a caller');

  // ...but cannot then PATCH that caller up to super_admin.
  const promote = await api(`/api/users/${createCaller.data.id}`, {
    method: 'PATCH', cookie: mgrCookie, body: { role: 'super_admin' },
  });
  assert.equal(promote.status, 403, 'manager cannot promote a user to super_admin');

  // The owner (admin bootstrap) CAN create an owner-tier account.
  const ownerCreate = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'real_super', full_name: 'Real Super', password: 'secret9', role: 'super_admin' },
  });
  assert.equal(ownerCreate.status, 200, 'owner can create a super_admin');
});

test('settings round-trip: Sarvam key is write-only, invoice block persists', async () => {
  const put = await api('/api/settings', {
    method: 'PUT', cookie: adminCookie,
    body: {
      ai_cloud_enabled: true,
      sarvam_api_key: 'sk-secret-xyz',
      company_legal_name: 'Acme Pvt Ltd',
      company_address: '1 Market Rd, Mumbai',
      company_gstin: '27aaapl1234c1zv',
      gst_percent: 12,
    },
  });
  assert.equal(put.status, 200);

  const get = await api('/api/settings', { cookie: adminCookie });
  assert.equal(get.data.ai_cloud_enabled, true);
  assert.equal(get.data.has_sarvam_key, true, 'key presence exposed as boolean');
  assert.equal(get.data.sarvam_api_key, undefined, 'raw key NEVER echoed');
  assert.equal(get.data.company_legal_name, 'Acme Pvt Ltd');
  assert.equal(get.data.company_gstin, '27AAAPL1234C1ZV', 'GSTIN upper-cased');
  assert.equal(get.data.gst_percent, 12);

  // Out-of-range GST is rejected.
  const bad = await api('/api/settings', {
    method: 'PUT', cookie: adminCookie, body: { gst_percent: 500 },
  });
  assert.equal(bad.status, 400);
});
