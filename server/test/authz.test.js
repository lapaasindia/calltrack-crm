// Role-model consistency matrix (SCALE-9 / CLIENT-8 / client contract rows
// 1,2,6,7,8,9) + the smaller authz fixes that ride with it (SEC-9 money
// clamps, SEC-10 team-wide ignore, SEC-12 OAuth host check, SCALE-19).
// Logs in as super_admin, manager, agent, caller and read_only against a real
// server on a throwaway database and asserts what each tier may see and do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-authz-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
let db;
const C = {}; // cookies by role key
const U = {}; // user ids by role key
const L = {}; // lead ids

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
const login = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, `login ${username}`);
  return r.headers.get('set-cookie').split(';')[0];
};
const mkUser = async (key, role) => {
  const r = await api('/api/users', {
    method: 'POST', cookie: C.admin,
    body: { username: key, full_name: `User ${key}`, password: `${key}pass123`, role },
  });
  assert.equal(r.status, 200, `create ${key} (${role})`);
  U[key] = r.data.id;
  C[key] = await login(key, `${key}pass123`);
};
const mkLead = async (key, phone, assignedTo) => {
  const r = await api('/api/leads', {
    method: 'POST', cookie: C.admin, body: { name: `Lead ${key}`, phone, assigned_to: assignedTo },
  });
  assert.equal(r.status, 200, `lead ${key}`);
  L[key] = r.data.id;
};
const idsOf = (r) => (r.data.leads || []).map((l) => l.id);

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  C.admin = await login('admin', 'admin123');
  U.admin = (await api('/api/auth/me', { cookie: C.admin })).data.id;
  await mkUser('sa', 'super_admin');
  await mkUser('mgr', 'manager');
  await mkUser('agt', 'agent');
  await mkUser('cal', 'caller');
  await mkUser('ro', 'read_only');
  await mkLead('agt', '9822200001', U.agt);
  await mkLead('cal', '9822200002', U.cal);
  await mkLead('adm', '9822200003', U.admin);
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('leads list scope: admin tier sees all, agent/caller only their own, read_only none', async () => {
  for (const key of ['sa', 'mgr']) {
    const ids = idsOf(await api('/api/leads', { cookie: C[key] }));
    for (const lk of ['agt', 'cal', 'adm']) assert.ok(ids.includes(L[lk]), `${key} sees lead ${lk}`);
  }
  const agt = idsOf(await api('/api/leads', { cookie: C.agt }));
  assert.deepEqual(agt, [L.agt]);
  const cal = idsOf(await api('/api/leads', { cookie: C.cal }));
  assert.deepEqual(cal, [L.cal]);
  const ro = await api('/api/leads', { cookie: C.ro });
  assert.equal(ro.status, 200);
  assert.deepEqual(idsOf(ro), []);
  // SCALE-10: a lead created via POST /api/leads is scored immediately.
  for (const lk of ['agt', 'cal', 'adm']) {
    assert.ok(Number.isInteger(db.prepare('SELECT score FROM leads WHERE id = ?').get(L[lk]).score), `lead ${lk} has an initial score`);
  }
});

test('CLIENT-7: ?limit= is honoured (1..500) and echoed as page_size', async () => {
  const two = await api('/api/leads?limit=2', { cookie: C.sa });
  assert.equal(two.data.page_size, 2);
  assert.equal(two.data.leads.length, 2);
  assert.ok(two.data.total >= 3);
  assert.equal((await api('/api/leads?limit=9999', { cookie: C.sa })).data.page_size, 500);
  assert.equal((await api('/api/leads?limit=0', { cookie: C.sa })).data.page_size, 50);
  assert.equal((await api('/api/leads', { cookie: C.sa })).data.page_size, 50);
});

test('reassign is admin-tier (super_admin/manager), never agent/caller/read_only; pending tasks move with the lead', async () => {
  db.prepare(
    `INSERT INTO tasks (title, lead_id, assigned_to, due_date, created_by, created_at)
     VALUES ('Prep quote', ?, ?, '2030-01-01', 1, ?)`
  ).run(L.agt, U.agt, new Date().toISOString());

  const byMgr = await api(`/api/leads/${L.agt}`, { method: 'PATCH', cookie: C.mgr, body: { assigned_to: U.cal } });
  assert.equal(byMgr.status, 200, 'manager can reassign');
  assert.equal(db.prepare('SELECT assigned_to FROM leads WHERE id = ?').get(L.agt).assigned_to, U.cal);
  assert.equal(db.prepare("SELECT assigned_to FROM tasks WHERE lead_id = ? AND status = 'pending'").get(L.agt).assigned_to, U.cal,
    'pending task followed the lead');

  const bySa = await api(`/api/leads/${L.agt}`, { method: 'PATCH', cookie: C.sa, body: { assigned_to: U.agt } });
  assert.equal(bySa.status, 200, 'super_admin can reassign');
  assert.equal(db.prepare("SELECT assigned_to FROM tasks WHERE lead_id = ? AND status = 'pending'").get(L.agt).assigned_to, U.agt);

  const byAgt = await api(`/api/leads/${L.agt}`, { method: 'PATCH', cookie: C.agt, body: { assigned_to: U.cal } });
  assert.equal(byAgt.status, 403, 'agent cannot reassign even their own lead');
  const byCal = await api(`/api/leads/${L.cal}`, { method: 'PATCH', cookie: C.cal, body: { assigned_to: U.agt } });
  assert.equal(byCal.status, 403);
  const byRo = await api(`/api/leads/${L.agt}`, { method: 'PATCH', cookie: C.ro, body: { assigned_to: U.cal } });
  assert.equal(byRo.status, 403);

  // Bulk assign round-robin is admin-tier and uses the shared pool (agents + callers).
  const bulk = await api('/api/leads/bulk-assign', {
    method: 'POST', cookie: C.mgr, body: { lead_ids: [L.agt, L.cal, L.adm], round_robin: true },
  });
  assert.equal(bulk.status, 200);
  const owners = [L.agt, L.cal, L.adm].map((id) => db.prepare('SELECT assigned_to a FROM leads WHERE id = ?').get(id).a);
  for (const o of owners) assert.ok([U.agt, U.cal].includes(o), 'round-robin only hands leads to agents/callers');
  assert.equal(new Set(owners).size, 2, 'both pool members received leads');
  // Restore ownership for the remaining tests.
  for (const [lk, uk] of [['agt', 'agt'], ['cal', 'cal'], ['adm', 'admin']]) {
    await api(`/api/leads/${L[lk]}`, { method: 'PATCH', cookie: C.sa, body: { assigned_to: U[uk] } });
  }
});

test('?all=1 on products/templates works for the whole admin tier, not just literal admin', async () => {
  const prod = await api('/api/products', { method: 'POST', cookie: C.sa, body: { name: 'Hidden Prod', price_rupees: 10 } });
  assert.equal(prod.status, 200);
  await api(`/api/products/${prod.data.id}`, { method: 'PATCH', cookie: C.sa, body: { is_active: false } });
  const tpl = await api('/api/templates', { method: 'POST', cookie: C.sa, body: { name: 'Hidden Tpl', body: 'hi {name}' } });
  assert.equal(tpl.status, 200);
  await api(`/api/templates/${tpl.data.id}`, { method: 'PATCH', cookie: C.sa, body: { is_active: false } });

  for (const key of ['sa', 'mgr', 'admin']) {
    const p = await api('/api/products?all=1', { cookie: C[key] });
    assert.ok(p.data.some((x) => x.id === prod.data.id), `${key} sees the inactive product with ?all=1`);
    const t = await api('/api/templates?all=1', { cookie: C[key] });
    assert.ok(t.data.some((x) => x.id === tpl.data.id), `${key} sees the inactive template with ?all=1`);
  }
  for (const key of ['cal', 'agt', 'ro']) {
    const p = await api('/api/products?all=1', { cookie: C[key] });
    assert.ok(!p.data.some((x) => x.id === prod.data.id), `${key} never sees inactive products`);
    const t = await api('/api/templates?all=1', { cookie: C[key] });
    assert.ok(!t.data.some((x) => x.id === tpl.data.id), `${key} never sees inactive templates`);
  }
});

test('review scope + SEC-10: admin tier sees everyone\'s captures; only admin tier can block a number team-wide', async () => {
  // Pair a phone to the caller and sync two unknown numbers → captured rows owned by cal.
  const code = await api('/api/devices/pairing-code', { method: 'POST', cookie: C.admin, body: { user_id: U.cal } });
  const pair = await api('/api/auth/pair', { method: 'POST', body: { code: code.data.code, device_name: 'Cal phone', android_id: 'CAL_PHONE' } });
  assert.equal(pair.status, 200);
  const token = pair.data.token;
  const sync = await api('/api/sync/calls', {
    method: 'POST', token,
    body: { calls: [
      { call_log_ts: Date.now() - 300000, phone: '9833300001', direction: 'incoming', duration_seconds: 20 },
      { call_log_ts: Date.now() - 200000, phone: '9833300002', direction: 'incoming', duration_seconds: 25 },
    ] },
  });
  assert.deepEqual(sync.data.results.map((r) => r.status), ['captured', 'captured']);

  const phones = (r) => r.data.map((c) => c.phone);
  assert.ok(phones(await api('/api/review/captured', { cookie: C.mgr })).includes('9833300001'), 'manager sees the caller\'s capture');
  assert.ok(phones(await api('/api/review/captured', { cookie: C.sa })).includes('9833300001'), 'super_admin sees it');
  assert.ok(phones(await api('/api/review/captured', { cookie: C.cal })).includes('9833300001'), 'owner sees it');
  assert.deepEqual(phones(await api('/api/review/captured', { cookie: C.agt })), [], 'another agent sees nothing');
  const summaryMgr = await api('/api/review/summary', { cookie: C.mgr });
  assert.ok(summaryMgr.data.captured >= 2);

  // Caller: "ignore always" degrades to a per-capture ignore, no team-wide block.
  const row1 = (await api('/api/review/captured', { cookie: C.cal })).data.find((c) => c.phone === '9833300001');
  const ignCal = await api(`/api/review/captured/${row1.id}/ignore`, { method: 'POST', cookie: C.cal, body: { always: true } });
  assert.equal(ignCal.status, 200);
  assert.equal(ignCal.data.always, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ignored_numbers WHERE phone = '9833300001'").get().n, 0, 'caller cannot blacklist team-wide');
  assert.equal(db.prepare("SELECT status FROM captured_calls WHERE id = ?").get(row1.id).status, 'ignored', 'but the capture itself is ignored');

  // Manager: team-wide block applies.
  const row2 = (await api('/api/review/captured', { cookie: C.mgr })).data.find((c) => c.phone === '9833300002');
  const ignMgr = await api(`/api/review/captured/${row2.id}/ignore`, { method: 'POST', cookie: C.mgr, body: { always: true } });
  assert.equal(ignMgr.status, 200);
  assert.equal(ignMgr.data.always, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ignored_numbers WHERE phone = '9833300002'").get().n, 1);
});

test('GET /api/users: admin tier gets the management payload, others a slim {id, full_name, role} directory', async () => {
  const full = await api('/api/users', { cookie: C.mgr });
  assert.equal(full.status, 200);
  assert.ok(full.data.every((u) => 'username' in u && 'is_active' in u), 'manager gets usernames + active flags');
  for (const key of ['agt', 'cal', 'ro']) {
    const slim = await api('/api/users', { cookie: C[key] });
    assert.equal(slim.status, 200, `${key} can list the directory`);
    assert.ok(slim.data.length >= 5);
    for (const u of slim.data) assert.deepEqual(Object.keys(u).sort(), ['full_name', 'id', 'role']);
    assert.ok(slim.data.some((u) => u.id === U.mgr));
  }
  // The slim list only carries ACTIVE users.
  const tmp = await api('/api/users', { method: 'POST', cookie: C.admin, body: { username: 'gone', full_name: 'Gone', password: 'gonepass123', role: 'caller' } });
  await api(`/api/users/${tmp.data.id}`, { method: 'DELETE', cookie: C.admin });
  assert.ok(!(await api('/api/users', { cookie: C.cal })).data.some((u) => u.id === tmp.data.id));
});

test('read_only is refused on every write, can still read', async () => {
  const writes = [
    ['POST', '/api/leads', { name: 'RO Lead', phone: '9844400001' }],
    ['PATCH', `/api/leads/${L.agt}`, { name: 'x' }],
    ['POST', `/api/leads/${L.agt}/calls`, { disposition: 'connected' }],
    ['PUT', `/api/leads/${L.agt}/follow-up`, { due_at: new Date().toISOString() }],
    ['DELETE', `/api/leads/${L.agt}/follow-up`],
    ['POST', '/api/leads/bulk-assign', { lead_ids: [L.agt], assigned_to: U.cal }],
    ['POST', '/api/review/captured/1/ignore', {}],
    ['POST', '/api/review/captured/1/create-lead', {}],
    ['PATCH', '/api/review/calls/1', { outcome: 'interested' }],
    ['POST', '/api/ai/suggestions/1/accept'],
    ['POST', '/api/products', { name: 'x', price_rupees: 1 }],
    ['POST', '/api/templates', { name: 'x', body: 'y' }],
    ['POST', '/api/imports', { filename: 'a.csv', rows: [{ name: 'a', phone: '9844400002' }] }],
    ['POST', '/api/users', { username: 'z', full_name: 'z', password: 'zzzzzzzz1', role: 'caller' }],
    ['POST', '/api/devices/pairing-code', { user_id: U.cal }],
    ['POST', '/api/catalog/services', { name: 'x' }],
  ];
  for (const [method, p, body] of writes) {
    const r = await api(p, { method, cookie: C.ro, body });
    assert.equal(r.status, 403, `read_only ${method} ${p} → 403 (got ${r.status})`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE phone = '9844400001'").get().n, 0);
  for (const p of ['/api/leads', '/api/products', '/api/templates', '/api/review/summary', '/api/users', '/api/auth/me']) {
    assert.equal((await api(p, { cookie: C.ro })).status, 200, `read_only GET ${p}`);
  }
});

test('SEC-9: products and catalog clamp money to the shared deals/invoices bound and safe integers', async () => {
  const { MAX_PAISE } = await import('../routes/catalog.js');
  assert.equal(MAX_PAISE, 100_00_00_000 * 100, 'same constant as deals.js / invoices.js');
  const capRupees = MAX_PAISE / 100;
  const over = await api('/api/products', { method: 'POST', cookie: C.sa, body: { name: 'Overflow', price_rupees: 1e15 } });
  assert.equal(over.status, 400);
  const edge = await api('/api/products', { method: 'POST', cookie: C.sa, body: { name: 'At cap', price_rupees: capRupees } });
  assert.equal(edge.status, 200, 'the cap itself is allowed');
  const edgePlus = await api('/api/products', { method: 'POST', cookie: C.sa, body: { name: 'Over cap', price_rupees: capRupees + 0.01 } });
  assert.equal(edgePlus.status, 400);
  const notNum = await api('/api/products', { method: 'POST', cookie: C.sa, body: { name: 'NaN', price_rupees: 'abc' } });
  assert.equal(notNum.status, 400);
  const neg = await api(`/api/products/${edge.data.id}`, { method: 'PATCH', cookie: C.sa, body: { price_rupees: -1 } });
  assert.equal(neg.status, 400);
  const zero = await api('/api/products', { method: 'POST', cookie: C.sa, body: { name: 'Free', price_rupees: 0 } });
  assert.equal(zero.status, 200, '₹0 stays allowed');

  const svcOver = await api('/api/catalog/services', { method: 'POST', cookie: C.sa, body: { name: 'Svc', base_price_paise: 99999999999999999 } });
  assert.equal(svcOver.status, 400);
  const svcEdge = await api('/api/catalog/services', { method: 'POST', cookie: C.sa, body: { name: 'Svc ok', base_price_paise: MAX_PAISE } });
  assert.equal(svcEdge.status, 200);
  const svcEdgePlus = await api('/api/catalog/services', { method: 'POST', cookie: C.sa, body: { name: 'Svc over', base_price_paise: MAX_PAISE + 1 } });
  assert.equal(svcEdgePlus.status, 400);
  const addonOver = await api('/api/catalog/addons', { method: 'POST', cookie: C.sa, body: { name: 'Addon', price_paise: 2 ** 53 } });
  assert.equal(addonOver.status, 400);
  const cfgOver = await api('/api/catalog/pricing-config', {
    method: 'PUT', cookie: C.sa, body: { platform_tiers: [{ name: 'Pro', price_paise: 1e18 }] },
  });
  assert.equal(cfgOver.status, 400);
  const bad = db.prepare('SELECT COUNT(*) n FROM products WHERE price_paise > ?').get(MAX_PAISE).n;
  assert.equal(bad, 0, 'nothing over the cap reached the DB');
});

test('SEC-12: the OAuth redirect host must be one of ours', async () => {
  const { isOwnHost } = await import('../routes/backup.js');
  assert.equal(isOwnHost('localhost:3000'), true);
  assert.equal(isOwnHost('127.0.0.1'), true);
  assert.equal(isOwnHost('office-mac.local:3000'), true);
  assert.equal(isOwnHost('evil.example.com'), false);
  assert.equal(isOwnHost('evil.example.com:3000'), false);
  assert.equal(isOwnHost('localhost.evil.com'), false);
  assert.equal(isOwnHost(''), false);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) assert.equal(isOwnHost(`${lan.address}:3000`), true, 'this machine\'s LAN IP is accepted');

  // End to end: a spoofed Host on /connect is refused, a real one is not.
  await api('/api/backup/google/credentials', { method: 'POST', cookie: C.sa, body: { client_id: 'cid', client_secret: 'csec' } });
  const raw = (host) => new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl}/api/backup/google/connect`);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { Cookie: C.sa, Host: host, 'Content-Length': 0 },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    req.end();
  });
  const spoofed = await raw('evil.example.com');
  assert.equal(spoofed.status, 400);
  assert.match(spoofed.data.error, /Host/);
  const ok = await raw('localhost:3000');
  assert.equal(ok.status, 200);
  assert.ok(ok.data.url.includes(encodeURIComponent('http://localhost:3000/api/backup/google/callback')));
});

test('SCALE-19: a WhatsApp chat linked to a soft-deleted lead can be promoted again', async () => {
  const dead = await api('/api/leads', { method: 'POST', cookie: C.admin, body: { name: 'Dead WA lead', phone: '9855500001', assigned_to: U.cal } });
  assert.equal(dead.status, 200);
  db.prepare(
    `INSERT INTO wa_contacts (wa_jid, phone, display_name, lead_id, first_seen_at)
     VALUES ('919855500001@s.whatsapp.net', '9855500001', 'WA Person', ?, ?)`
  ).run(dead.data.id, new Date().toISOString());
  const contactId = db.prepare("SELECT id FROM wa_contacts WHERE phone = '9855500001'").get().id;

  const stillLinked = await api(`/api/whatsapp/contacts/${contactId}/create-lead`, { method: 'POST', cookie: C.mgr });
  assert.equal(stillLinked.status, 409, 'linked to a live lead → 409');

  assert.equal((await api(`/api/leads/${dead.data.id}`, { method: 'DELETE', cookie: C.admin })).status, 200);
  const again = await api(`/api/whatsapp/contacts/${contactId}/create-lead`, { method: 'POST', cookie: C.mgr, body: { name: 'Revived' } });
  assert.equal(again.status, 200, 'promotable again once the old lead is soft-deleted');
  assert.equal(again.data.created, true);
  assert.notEqual(again.data.lead_id, dead.data.id);
  assert.equal(db.prepare('SELECT lead_id FROM wa_contacts WHERE id = ?').get(contactId).lead_id, again.data.lead_id);
});
