// GET/PUT /api/settings visibility (QA-18): non-admin roles see only the public
// subset; the upload quota is owner-editable and range-checked; the owner-only
// /paths endpoint reports where the server keeps its files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-settings-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
const C = {};

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

const PUBLIC_KEYS = ['company_name', 'gst_percent', 'whatsapp_enabled'];
const SENSITIVE_KEYS = ['company_gstin', 'company_address', 'company_legal_name', 'has_sarvam_key',
  'ai_cloud_enabled', 'last_backup', 'upload_daily_quota_mb', 'sarvam_api_key'];

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  C.admin = await login('admin', 'admin123');
  for (const [u, role] of [['mgr', 'manager'], ['cal', 'caller'], ['ro', 'read_only']]) {
    const r = await api('/api/users', { method: 'POST', cookie: C.admin, body: { username: u, full_name: u, password: `${u}pass1234`, role } });
    assert.equal(r.status, 200);
    C[u] = await login(u, `${u}pass1234`);
  }
  // Populate the sensitive fields so a leak would be visible.
  const put = await api('/api/settings', {
    method: 'PUT', cookie: C.admin,
    body: { company_gstin: '27aaapl1234c1zv', company_address: '1 Market Rd', company_legal_name: 'Acme Pvt Ltd', sarvam_api_key: 'sk-secret', ai_cloud_enabled: true },
  });
  assert.equal(put.status, 200);
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('QA-18: admin tier gets the full settings payload (key still never echoed)', async () => {
  for (const key of ['admin', 'mgr']) {
    const r = await api('/api/settings', { cookie: C[key] });
    assert.equal(r.status, 200);
    assert.equal(r.data.company_gstin, '27AAAPL1234C1ZV');
    assert.equal(r.data.has_sarvam_key, true);
    assert.equal(r.data.ai_cloud_enabled, true);
    assert.equal(r.data.upload_daily_quota_mb, 2048, 'default quota reported');
    assert.equal(r.data.sarvam_api_key, undefined, 'raw key never echoed');
    for (const k of PUBLIC_KEYS) assert.ok(k in r.data, `${key} sees ${k}`);
  }
});

test('QA-18: caller / read_only get ONLY the public subset', async () => {
  for (const key of ['cal', 'ro']) {
    const r = await api('/api/settings', { cookie: C[key] });
    assert.equal(r.status, 200, `${key} can still read public settings`);
    assert.deepEqual(Object.keys(r.data).sort(), PUBLIC_KEYS, `${key} sees exactly the public keys`);
    for (const k of SENSITIVE_KEYS) assert.equal(r.data[k], undefined, `${key} must not see ${k}`);
    assert.equal(r.data.company_name, 'Our Company');
    assert.equal(r.data.gst_percent, 18);
    assert.equal(r.data.whatsapp_enabled, false);
  }
});

test('upload_daily_quota_mb: owner-editable integer in 100..100000', async () => {
  const ok = await api('/api/settings', { method: 'PUT', cookie: C.admin, body: { upload_daily_quota_mb: 500 } });
  assert.equal(ok.status, 200);
  assert.equal((await api('/api/settings', { cookie: C.admin })).data.upload_daily_quota_mb, 500);
  const max = await api('/api/settings', { method: 'PUT', cookie: C.admin, body: { upload_daily_quota_mb: 100000 } });
  assert.equal(max.status, 200);
  const min = await api('/api/settings', { method: 'PUT', cookie: C.admin, body: { upload_daily_quota_mb: 100 } });
  assert.equal(min.status, 200);
  for (const bad of [99, 100001, 'abc', 1024.5, -5, null, true]) {
    const r = await api('/api/settings', { method: 'PUT', cookie: C.admin, body: { upload_daily_quota_mb: bad } });
    assert.equal(r.status, 400, `quota ${JSON.stringify(bad)} rejected`);
    assert.match(r.data.error, /quota/i);
  }
  assert.equal((await api('/api/settings', { cookie: C.admin })).data.upload_daily_quota_mb, 100, 'last valid value kept');
  // The sync route reads the same setting.
  const { getSetting } = await import('../db.js');
  assert.equal(getSetting('upload_daily_quota_mb'), 100);
  // Manager is admin tier but not owner: settings writes stay 403.
  const mgr = await api('/api/settings', { method: 'PUT', cookie: C.mgr, body: { upload_daily_quota_mb: 300 } });
  assert.equal(mgr.status, 403);
  const cal = await api('/api/settings', { method: 'PUT', cookie: C.cal, body: { company_name: 'Nope' } });
  assert.equal(cal.status, 403);
});

test('GET /api/settings/paths is owner-only and reports absolute directories', async () => {
  const r = await api('/api/settings/paths', { cookie: C.admin });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ['backup_dir', 'data_dir', 'logs_dir', 'recordings_dir']);
  for (const v of Object.values(r.data)) assert.ok(path.isAbsolute(v), `${v} is absolute`);
  assert.equal(r.data.data_dir, path.resolve(process.env.CRM_DATA_DIR));
  assert.equal(r.data.backup_dir, path.resolve(process.env.CRM_BACKUP_DIR));
  assert.equal(r.data.recordings_dir, path.join(path.resolve(process.env.CRM_DATA_DIR), 'recordings'));
  assert.equal(path.basename(r.data.logs_dir), 'logs');
  for (const key of ['mgr', 'cal', 'ro']) {
    assert.equal((await api('/api/settings/paths', { cookie: C[key] })).status, 403, `${key} cannot read server paths`);
  }
});

test('POST /backup-now awaits the async backup; last_backup carries {date, at, file, bytes, ms}', async () => {
  const r = await api('/api/settings/backup-now', { method: 'POST', cookie: C.admin });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(typeof r.data.file, 'string', 'resolved file path, not a pending promise');
  assert.ok(fs.existsSync(r.data.file), 'backup file exists when the response arrives');
  assert.ok(r.data.file.startsWith(path.resolve(process.env.CRM_BACKUP_DIR)));
  const lb = r.data.last_backup;
  assert.deepEqual(Object.keys(lb).sort(), ['at', 'bytes', 'date', 'file', 'ms']);
  assert.ok(lb.bytes > 0);
  assert.match(lb.date, /^\d{4}-\d{2}-\d{2}$/);
  // GET passes the same object through for the admin tier only.
  const got = await api('/api/settings', { cookie: C.mgr });
  assert.deepEqual(got.data.last_backup, lb);
  assert.equal((await api('/api/settings', { cookie: C.cal })).data.last_backup, undefined);
  // Manager may trigger it (requireAdmin); caller / read_only may not.
  assert.equal((await api('/api/settings/backup-now', { method: 'POST', cookie: C.mgr })).status, 200);
  assert.equal((await api('/api/settings/backup-now', { method: 'POST', cookie: C.cal })).status, 403);
  assert.equal((await api('/api/settings/backup-now', { method: 'POST', cookie: C.ro })).status, 403);
});
