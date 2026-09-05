// Device pairing hardening (orchestrator MOB-9 / MOB-20): the pairing-code
// URLs/QR carry the real scheme (https when TLS is configured), /pair treats a
// non-string or oversize android_id as absent instead of 500ing, and an
// optional device_model becomes the device's display name.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-pairing-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';
delete process.env.CRM_TLS_CERT;
delete process.env.CRM_TLS_KEY;

let baseUrl;
let server;
let db;
let adminCookie;
let callerId;

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
const mintCode = async () => {
  const r = await api('/api/devices/pairing-code', { method: 'POST', cookie: adminCookie, body: { user_id: callerId } });
  assert.equal(r.status, 200);
  return r;
};
const pair = async (extra) => {
  const code = (await mintCode()).data.code;
  return api('/api/auth/pair', { method: 'POST', body: { code, ...extra } });
};
const deviceRow = (id) => db.prepare('SELECT * FROM device_tokens WHERE id = ?').get(id);

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  adminCookie = res.headers.get('set-cookie').split(';')[0];
  const u = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'pairme', full_name: 'Pair Me', password: 'pairpass123', role: 'caller' } });
  assert.equal(u.status, 200);
  callerId = u.data.id;
  // Every request here comes from 127.0.0.1; start from a clean /pair limiter.
  const { _resetPairThrottleForTests } = await import('../routes/auth.js');
  _resetPairThrottleForTests();
});

after(() => {
  server?.close();
  delete process.env.CRM_TLS_CERT;
  delete process.env.CRM_TLS_KEY;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('MOB-9: pairing URLs use http on a plain server and https once TLS is configured', async () => {
  const plain = await mintCode();
  assert.equal(plain.data.scheme, 'http');
  for (const u of plain.data.urls) assert.ok(u.startsWith('http://'), `plain: ${u}`);

  // tlsConfig() is evaluated per request: point it at any readable PEM-ish
  // files (the server itself stays http for this test — only the advertised
  // scheme is under test).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const anyFile = path.join(here, '..', '..', 'package.json');
  process.env.CRM_TLS_CERT = anyFile;
  process.env.CRM_TLS_KEY = anyFile;
  try {
    const tls = await mintCode();
    assert.equal(tls.data.scheme, 'https');
    for (const u of tls.data.urls) assert.ok(u.startsWith('https://'), `tls: ${u}`);
    assert.equal(tls.data.urls.length, plain.data.urls.length, 'same addresses, different scheme');
  } finally {
    delete process.env.CRM_TLS_CERT;
    delete process.env.CRM_TLS_KEY;
  }
  assert.equal((await mintCode()).data.scheme, 'http', 'back to http once TLS is unset');
});

test('MOB-20: android_id must be a string ≤ 64 chars — anything else is treated as absent, never a 500', async () => {
  const cases = [
    [{ android_id: { evil: 1 } }, null, 'object'],
    [{ android_id: 12345 }, null, 'number'],
    [{ android_id: ['a'] }, null, 'array'],
    [{ android_id: 'x'.repeat(65) }, null, '65 chars'],
    [{ android_id: 'unknown' }, null, 'the "unknown" sentinel'],
    [{ android_id: '' }, null, 'empty'],
    [{ android_id: '  ' }, null, 'blank'],
    [{ android_id: 'a1b2c3d4e5f6a7b8' }, 'a1b2c3d4e5f6a7b8', 'a real ANDROID_ID'],
    [{ android_id: 'y'.repeat(64) }, 'y'.repeat(64), 'exactly 64 chars'],
    [{}, null, 'omitted'],
  ];
  for (const [body, expected, label] of cases) {
    const r = await pair({ device_name: 'Phone', ...body });
    assert.equal(r.status, 200, `${label}: pairs fine (got ${r.status} ${JSON.stringify(r.data)})`);
    assert.equal(deviceRow(r.data.device_id).android_id, expected, `${label}: stored android_id`);
  }
});

test('MOB-20: device_model (≤ 80 chars) becomes the device name when present; device_name stays the fallback', async () => {
  const model = await pair({ device_name: 'Android phone', device_model: '  Pixel 8 Pro ' });
  assert.equal(model.status, 200);
  assert.equal(deviceRow(model.data.device_id).device_name, 'Pixel 8 Pro');

  const long = await pair({ device_model: 'M'.repeat(120) });
  assert.equal(deviceRow(long.data.device_id).device_name, 'M'.repeat(80), 'truncated to 80');

  const nonString = await pair({ device_name: 'Legacy name', device_model: { brand: 'x' } });
  assert.equal(nonString.status, 200);
  assert.equal(deviceRow(nonString.data.device_id).device_name, 'Legacy name', 'non-string model ignored');

  const blankModel = await pair({ device_name: 'Legacy name 2', device_model: '   ' });
  assert.equal(deviceRow(blankModel.data.device_id).device_name, 'Legacy name 2');

  const neither = await pair({});
  assert.equal(deviceRow(neither.data.device_id).device_name, 'Android phone');

  // Re-pairing the same physical phone keeps its device row (reinstall dedupe)
  // and picks up the new model name.
  const first = await pair({ android_id: 'SAMEPHONE01', device_model: 'Galaxy S23' });
  const again = await pair({ android_id: 'SAMEPHONE01', device_model: 'Galaxy S23 (reinstalled)' });
  assert.equal(again.data.device_id, first.data.device_id);
  assert.equal(deviceRow(again.data.device_id).device_name, 'Galaxy S23 (reinstalled)');
});

// Runs LAST: it leaves this IP locked out of /pair for 5 minutes.
test('/pair rate limit counts only FAILED exchanges: the many successful pairings above did not lock this IP, ten bad codes do', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await api('/api/auth/pair', { method: 'POST', body: { code: `BAD${String(i).padStart(3, '0')}` } });
    assert.equal(r.status, 401, `bad code ${i + 1} is a plain 401`);
  }
  const locked = await api('/api/auth/pair', { method: 'POST', body: { code: 'BAD999' } });
  assert.equal(locked.status, 429);
  const real = await pair({ device_name: 'Late phone' });
  assert.equal(real.status, 429, 'even a valid code is refused while the IP is locked');
});
