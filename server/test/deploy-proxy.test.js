// Reverse-proxy / container deployment contract (Coolify + Traefik, nginx,
// Caddy) — the LAN deployment must keep today's behaviour when nothing is set.
//   * CRM_TRUST_PROXY — Express trusts X-Forwarded-For / X-Forwarded-Proto from
//     the proxy, so the login/pair throttles (and the audit log) key on the
//     real client IP and req.secure follows the proxy's TLS. Unset = headers
//     ignored, req.ip is the socket peer.
//   * CRM_SECURE_COOKIES=true behind a proxy needs CRM_TRUST_PROXY, or
//     express-session never emits the Secure cookie and nobody can log in.
//   * CRM_PUBLIC_URL — validated strictly; the public origin goes first in the
//     pairing URLs (what the QR encodes) and counts as an "own host" for the
//     Drive OAuth redirect. /api/health never reports any of this.
// Each variant is its own createApp() on one throwaway database (env is read
// at createApp() time); sessions and the secret are shared, so a cookie from
// one app is valid on the others.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-deploy-proxy-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';
for (const k of ['CRM_TRUST_PROXY', 'CRM_SECURE_COOKIES', 'CRM_PUBLIC_URL', 'CRM_TLS_CERT', 'CRM_TLS_KEY']) {
  delete process.env[k];
}

const servers = [];
let plain;          // nothing set — today's LAN default
let proxied;        // CRM_TRUST_PROXY=1
let proxiedSecure;  // CRM_TRUST_PROXY=true + CRM_SECURE_COOKIES=true (the Coolify shape)
let secureOnly;     // CRM_SECURE_COOKIES=true WITHOUT trust proxy (the misconfiguration)
let db;
let resetLoginThrottle;

const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => {
    servers.push(s);
    resolve(`http://127.0.0.1:${s.address().port}`);
  });
});
// Run fn with env vars set (null = unset), restoring afterwards.
const withEnv = async (env, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  }
};

const api = async (base, pathname, { method = 'GET', body, cookie, headers: extra = {} } = {}) => {
  const headers = { ...extra };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};
const login = (base, username, password, headers) =>
  api(base, '/api/auth/login', { method: 'POST', body: { username, password }, headers });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const XFF = (ip) => ({ 'X-Forwarded-For': ip });
const HTTPS = { 'X-Forwarded-Proto': 'https' };

before(async () => {
  const { startServer, createApp } = await import('../app.js');
  const { server } = await startServer({ port: 0 });
  servers.push(server);
  plain = `http://127.0.0.1:${server.address().port}`;
  proxied = await withEnv({ CRM_TRUST_PROXY: '1' }, () => listen(createApp()));
  proxiedSecure = await withEnv({ CRM_TRUST_PROXY: 'true', CRM_SECURE_COOKIES: 'true' }, () => listen(createApp()));
  secureOnly = await withEnv({ CRM_SECURE_COOKIES: 'true' }, () => listen(createApp()));
  db = (await import('../db.js')).default;
  ({ resetLoginThrottle } = await import('../routes/auth.js'));
});

after(() => {
  for (const s of servers) s.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('trustProxySetting: 1/true → one hop, a number → hops, a list → verbatim, 0/false/blank → unset', async () => {
  const { trustProxySetting } = await import('../app.js');
  assert.equal(trustProxySetting(undefined), null);
  assert.equal(trustProxySetting(''), null);
  assert.equal(trustProxySetting('  '), null);
  assert.equal(trustProxySetting('0'), null);
  assert.equal(trustProxySetting('false'), null);
  assert.equal(trustProxySetting('off'), null);
  assert.equal(trustProxySetting('1'), 1);
  assert.equal(trustProxySetting('true'), 1);
  assert.equal(trustProxySetting(' TRUE '), 1);
  assert.equal(trustProxySetting('2'), 2);
  assert.equal(trustProxySetting('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
  assert.equal(trustProxySetting('172.18.0.0/16'), '172.18.0.0/16');
});

test('without CRM_TRUST_PROXY the login throttle keys on the socket peer — X-Forwarded-For can neither dodge nor forge it', async () => {
  resetLoginThrottle();
  // "ghost" does not exist, so only the per-IP budget (5 free failures) moves.
  for (let i = 0; i < 5; i++) {
    assert.equal((await login(plain, 'ghost', 'nope12345', XFF('203.0.113.7'))).status, 401, `free failure ${i + 1}`);
  }
  assert.equal((await login(plain, 'ghost', 'nope12345', XFF('203.0.113.7'))).status, 429, 'sixth failure from this socket locks it');
  assert.equal((await login(plain, 'ghost', 'nope12345', XFF('203.0.113.8'))).status, 429, 'a different forwarded address changes nothing — the key is the socket');
  assert.equal((await login(plain, 'ghost', 'nope12345')).status, 429, 'no header: same socket, still locked');
  const row = db.prepare("SELECT ip FROM audit_logs WHERE action = 'LOGIN_FAILED' ORDER BY id DESC LIMIT 1").get();
  assert.match(String(row.ip), /127\.0\.0\.1$/, 'audit log records the socket peer, not the header');
  resetLoginThrottle();
});

test('with CRM_TRUST_PROXY=1 the throttle keys on the forwarded client IP (rightmost hop); the audit log records it too', async () => {
  resetLoginThrottle();
  for (let i = 0; i < 5; i++) {
    assert.equal((await login(proxied, 'ghost', 'nope12345', XFF('203.0.113.7'))).status, 401, `free failure ${i + 1}`);
  }
  assert.equal((await login(proxied, 'ghost', 'nope12345', XFF('203.0.113.7'))).status, 429, 'sixth failure from 203.0.113.7 locks that client');
  assert.equal((await login(proxied, 'ghost', 'nope12345', XFF('203.0.113.8'))).status, 401, 'another client behind the same proxy is not locked');
  assert.equal((await login(proxied, 'ghost', 'nope12345')).status, 401, 'a direct connection (no header) is its own key');
  // One trusted hop: only the LAST address (appended by our proxy) counts, so
  // a client-supplied prefix can neither hide the locked client nor frame another.
  assert.equal((await login(proxied, 'ghost', 'nope12345', XFF('203.0.113.7, 203.0.113.9'))).status, 401, 'client-supplied prefix ignored — rightmost hop is the key');
  assert.equal((await login(proxied, 'ghost', 'nope12345', XFF('203.0.113.9, 203.0.113.7'))).status, 429, 'the locked client cannot hide behind a prefix');
  const ok = await login(proxied, 'admin', 'admin123', XFF('203.0.113.42'));
  assert.equal(ok.status, 200);
  const row = db.prepare("SELECT ip FROM audit_logs WHERE action = 'LOGIN_SUCCESS' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.ip, '203.0.113.42', 'audit log records the real client');
  resetLoginThrottle();
});

test('pairing-code scheme follows X-Forwarded-Proto only when the proxy is trusted', async () => {
  const cookie = cookieOf(await login(proxied, 'admin', 'admin123'));
  const me = await api(proxied, '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  const mint = (base, headers) => api(base, '/api/devices/pairing-code', {
    method: 'POST', cookie, body: { user_id: me.data.id }, headers,
  });
  const viaProxy = await mint(proxied, HTTPS);
  assert.equal(viaProxy.status, 200);
  assert.equal(viaProxy.data.scheme, 'https');
  for (const u of viaProxy.data.urls) assert.ok(u.startsWith('https://'), u);

  const direct = await mint(proxied, {});
  assert.equal(direct.data.scheme, 'http', 'no forwarded proto: plain http');

  const untrusted = await mint(plain, HTTPS);
  assert.equal(untrusted.data.scheme, 'http', 'header ignored without CRM_TRUST_PROXY');
  for (const u of untrusted.data.urls) assert.ok(u.startsWith('http://'), u);
});

test('CRM_SECURE_COOKIES=true behind a proxy: the Secure cookie is emitted only when CRM_TRUST_PROXY makes the request count as https', async () => {
  // The Coolify shape: trusted proxy + X-Forwarded-Proto: https → Secure
  // cookie, and the session it names works.
  const good = await login(proxiedSecure, 'admin', 'admin123', HTTPS);
  assert.equal(good.status, 200);
  const setCookie = good.headers.get('set-cookie') || '';
  assert.match(setCookie, /crm\.sid=/);
  assert.match(setCookie, /;\s*Secure/i, 'cookie flagged Secure');
  assert.match(setCookie, /;\s*HttpOnly/i);
  const me = await api(proxiedSecure, '/api/auth/me', { cookie: cookieOf(good), headers: HTTPS });
  assert.equal(me.status, 200);
  assert.equal(me.data.username, 'admin');

  // Same app but the proxy said plain http: express-session refuses to emit a
  // Secure cookie, so the login "succeeds" with no session behind it.
  const plainHttp = await login(proxiedSecure, 'admin', 'admin123');
  assert.equal(plainHttp.status, 200);
  assert.equal(plainHttp.headers.get('set-cookie'), null, 'no cookie over what looks like plain http');

  // CRM_SECURE_COOKIES without CRM_TRUST_PROXY is the misconfiguration this
  // documents: the forwarded proto is ignored, so nobody could ever log in.
  const misconfigured = await login(secureOnly, 'admin', 'admin123', HTTPS);
  assert.equal(misconfigured.status, 200);
  assert.equal(misconfigured.headers.get('set-cookie'), null, 'CRM_SECURE_COOKIES alone never sets the cookie behind a proxy');
});

test('CRM_PUBLIC_URL is parsed strictly: an http(s) origin only, everything else rejected with a reason', async () => {
  const { parsePublicUrl } = await import('../lib/publicUrl.js');
  assert.equal(parsePublicUrl(undefined).origin, null);
  assert.equal(parsePublicUrl('').error, null);
  assert.deepEqual(parsePublicUrl('https://crm.example.com'), {
    origin: 'https://crm.example.com', host: 'crm.example.com', hostname: 'crm.example.com', scheme: 'https', error: null,
  });
  assert.equal(parsePublicUrl('https://crm.example.com/').origin, 'https://crm.example.com', 'lone trailing slash tolerated');
  assert.equal(parsePublicUrl(' HTTPS://CRM.Example.com:8443 ').origin, 'https://crm.example.com:8443');
  assert.equal(parsePublicUrl('https://crm.example.com:443').origin, 'https://crm.example.com', 'default port dropped');
  assert.equal(parsePublicUrl('http://10.0.0.5:3000').origin, 'http://10.0.0.5:3000');
  for (const bad of [
    'crm.example.com', 'ftp://crm.example.com', 'https://crm.example.com/crm',
    'https://crm.example.com/?x=1', 'https://crm.example.com/#a',
    'https://user:pw@crm.example.com', 'not a url',
  ]) {
    const r = parsePublicUrl(bad);
    assert.equal(r.origin, null, `${bad} rejected`);
    assert.ok(r.error, `${bad} carries a reason`);
  }
});

test('CRM_PUBLIC_URL goes first in the pairing URLs (LAN addresses follow) and is an own host for the Drive OAuth redirect', async () => {
  const cookie = cookieOf(await login(plain, 'admin', 'admin123'));
  const me = await api(plain, '/api/auth/me', { cookie });
  const mint = () => api(plain, '/api/devices/pairing-code', { method: 'POST', cookie, body: { user_id: me.data.id } });
  const { isOwnHost } = await import('../routes/backup.js');

  const unset = await mint();
  assert.equal(unset.status, 200);
  assert.ok(unset.data.urls.every((u) => u.startsWith('http://')), 'unset: LAN http URLs only');
  assert.equal(unset.data.public_url, null);
  assert.equal(isOwnHost('crm.example.com'), false);

  await withEnv({ CRM_PUBLIC_URL: 'https://crm.example.com' }, async () => {
    const r = await mint();
    assert.equal(r.data.urls[0], 'https://crm.example.com', 'public origin first — what the QR encodes when the admin is on localhost');
    assert.deepEqual(r.data.urls.slice(1), unset.data.urls, 'LAN addresses unchanged after it');
    assert.equal(r.data.public_url, 'https://crm.example.com');
    assert.equal(isOwnHost('crm.example.com'), true);
    assert.equal(isOwnHost('CRM.example.com'), true);
    assert.equal(isOwnHost('crm.example.com.evil.com'), false);
    assert.equal(isOwnHost('evil.com'), false);
    assert.equal(isOwnHost('localhost:3000'), true, 'localhost still accepted');
  });
  await withEnv({ CRM_PUBLIC_URL: 'https://crm.example.com:8443' }, async () => {
    assert.equal(isOwnHost('crm.example.com:8443'), true);
    assert.equal(isOwnHost('crm.example.com'), true, 'hostname alone matches too');
    assert.equal((await mint()).data.urls[0], 'https://crm.example.com:8443');
  });
  await withEnv({ CRM_PUBLIC_URL: 'https://crm.example.com/crm' }, async () => {
    const r = await mint();
    assert.deepEqual(r.data.urls, unset.data.urls, 'an invalid value is ignored as a whole');
    assert.equal(r.data.public_url, null);
    assert.equal(isOwnHost('crm.example.com'), false, 'an invalid value grants nothing');
  });
});

test('/api/health stays a liveness fingerprint — CRM_PUBLIC_URL and the proxy settings never leak', async () => {
  await withEnv({ CRM_PUBLIC_URL: 'https://crm.example.com' }, async () => {
    for (const base of [plain, proxied, proxiedSecure]) {
      const r = await api(base, '/api/health', { headers: { ...HTTPS, ...XFF('203.0.113.1') } });
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.data).sort(), ['app', 'version']);
      assert.equal(r.data.app, 'calltrack-crm');
    }
  });
});
