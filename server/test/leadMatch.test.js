// findLeadCandidatesBatch (SCALE-15): one query for a whole review page,
// same semantics as the old per-row lookup — exact phone first, alt_phone
// (last 10 digits) second, scoped to what the user may access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-leadmatch-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
let db;
let adminCookie;
let callerId;
let L = {};
let findLeadCandidatesBatch;
let findLeadCandidates;

const api = async (pathname, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  ({ findLeadCandidatesBatch, findLeadCandidates } = await import('../lib/leadMatch.js'));
  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  adminCookie = login.headers.get('set-cookie').split(';')[0];
  const u = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'lmcaller', full_name: 'LM Caller', password: 'callerpass1', role: 'caller' } });
  callerId = u.data.id;
  const mk = async (key, body) => {
    const r = await api('/api/leads', { method: 'POST', cookie: adminCookie, body });
    assert.equal(r.status, 200, key);
    L[key] = r.data.id;
  };
  await mk('a', { name: 'A', phone: '9711100001', assigned_to: callerId });
  await mk('b', { name: 'B', phone: '9711100002', alt_phone: '+91 97111 00003', assigned_to: 1 });
  await mk('c', { name: 'C', phone: '9711100004', alt_phone: '097111-00005', assigned_to: callerId });
  await mk('d', { name: 'D', phone: '9711100006', alt_phone: '9711100001', assigned_to: 1 }); // alt == A's primary
  const del = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'Deleted', phone: '9711100007', assigned_to: 1 } });
  await api(`/api/leads/${del.data.id}`, { method: 'DELETE', cookie: adminCookie });
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('one batch resolves phone and alt_phone matches for a whole page, every input gets an entry', () => {
  const admin = { id: 1, role: 'admin' };
  const out = findLeadCandidatesBatch(['9711100001', '9711100003', '9711100005', '9711100007', '9711100009', '9711100001'], admin);
  assert.deepEqual([...out.keys()], ['9711100001', '9711100003', '9711100005', '9711100007', '9711100009'], 'deduped, every phone present');
  const a = out.get('9711100001');
  assert.deepEqual(a.map((c) => [c.id, c.match]), [[L.a, 'phone'], [L.d, 'alt_phone']], 'exact match first, alt match second');
  assert.deepEqual(out.get('9711100003').map((c) => [c.id, c.match]), [[L.b, 'alt_phone']], '+91 formatted alt_phone matches by last 10 digits');
  assert.deepEqual(out.get('9711100005').map((c) => [c.id, c.match]), [[L.c, 'alt_phone']], 'leading-zero alt_phone matches');
  assert.deepEqual(out.get('9711100007'), [], 'soft-deleted lead never offered');
  assert.deepEqual(out.get('9711100009'), []);
  assert.deepEqual(Object.keys(a[0]).sort(), ['assigned_to', 'id', 'match', 'name', 'phone', 'stage']);
});

test('scoped to the user: a caller only sees candidates among their own leads', () => {
  const caller = { id: callerId, role: 'caller' };
  const out = findLeadCandidatesBatch(['9711100001', '9711100003', '9711100005'], caller);
  assert.deepEqual(out.get('9711100001').map((c) => c.id), [L.a], 'D (admin\'s) hidden, A (own) shown');
  assert.deepEqual(out.get('9711100003'), [], 'B belongs to admin');
  assert.deepEqual(out.get('9711100005').map((c) => c.id), [L.c]);
  const mgr = findLeadCandidatesBatch(['9711100003'], { id: 999, role: 'manager' });
  assert.equal(mgr.get('9711100003').length, 1, 'manager (admin tier) sees all');
});

test('single-phone wrapper equals the batch entry; empty input is an empty map', () => {
  const admin = { id: 1, role: 'admin' };
  assert.deepEqual(findLeadCandidates('9711100003', admin), findLeadCandidatesBatch(['9711100003'], admin).get('9711100003'));
  assert.deepEqual(findLeadCandidates('', admin), []);
  assert.equal(findLeadCandidatesBatch([], admin).size, 0);
  assert.equal(findLeadCandidatesBatch([null, undefined, 5], admin).size, 0);
});

test('a page larger than one chunk still resolves every phone', () => {
  const admin = { id: 1, role: 'admin' };
  const many = Array.from({ length: 450 }, (_, i) => `98${String(10000000 + i).padStart(8, '0')}`);
  many.push('9711100001');
  const out = findLeadCandidatesBatch(many, admin);
  assert.equal(out.size, 451);
  assert.equal(out.get('9711100001').length, 2);
  assert.ok(many.slice(0, 450).every((p) => out.get(p).length === 0));
});
