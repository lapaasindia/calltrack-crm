// SCALE-12 — (a) the 30 s response cache on /api/dashboard,
// /api/reports/summary, /api/reports/leaderboard, /api/coaching/leaderboard
// (X-Cache HIT/MISS, per-scope keys, invalidation on writes), and (b) the
// calls_daily rollup: random calls across users / IST days / sources /
// dispositions, then every rollup-backed endpoint is compared with the
// pre-018 SQL it replaced, through inserts, updates and deletes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-wave2-rollup-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
let db;
let cache;
let adminCookie;
let callerCookie;
let callerAId;
let callerBId;
let ist;
const leadIds = [];

const api = async (pathname, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};
const login = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
};

// Deterministic PRNG so a failure is reproducible.
let seed = 20260905;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

const RULE = "(auto_logged = 0 OR disposition = 'connected') AND source != 'whatsapp'";
const DISPOSITIONS = ['connected', 'not_picked', 'busy', 'switched_off', 'connected'];
const SOURCES = ['manual', 'manual', 'mobile', 'whatsapp'];

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  cache = await import('../lib/cache.js');
  ist = await import('../lib/istTime.js');
  adminCookie = await login('admin', 'admin123');
  const mk = async (u, role) => {
    const r = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: u, full_name: u, password: 'somepass123', role } });
    return r.data.id;
  };
  callerAId = await mk('rcA', 'caller');
  callerBId = await mk('rcB', 'agent');
  callerCookie = await login('rcA', 'somepass123');
  const insLead = db.prepare("INSERT INTO leads (name, phone, phone_raw, source, assigned_to, created_at, updated_at) VALUES (?, ?, ?, 'import', ?, ?, ?)");
  const now = new Date().toISOString();
  for (let i = 0; i < 30; i += 1) {
    leadIds.push(insLead.run(`R ${i}`, String(9600000000 + i), String(9600000000 + i), i % 2 ? callerAId : callerBId, now, now).lastInsertRowid);
  }
  // 600 random calls over the last ~40 IST days for 3 users (admin included).
  const users = [1, callerAId, callerBId];
  const ins = db.prepare(
    `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at, source, auto_logged)
     VALUES (?, ?, 'sales', ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (let i = 0; i < 600; i += 1) {
      const ms = Date.now() - rnd(40 * 86400000);
      ins.run(leadIds[rnd(leadIds.length)], users[rnd(3)], DISPOSITIONS[rnd(5)],
        new Date(ms).toISOString(), SOURCES[rnd(4)], rnd(3) === 0 ? 1 : 0);
    }
  })();
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── oracles: the pre-018 queries ────────────────────────────────────────────
function oldKpis(userId, from, to) {
  const { startUtc, endUtc } = ist.istRangeBounds(from, to);
  return db.prepare(
    `SELECT COUNT(*) AS dials, COALESCE(SUM(c.disposition = 'connected'), 0) AS connects FROM calls c
      WHERE c.called_at >= ? AND c.called_at < ? AND ${RULE} ${userId ? 'AND c.user_id = ?' : ''}`
  ).get(...(userId ? [startUtc, endUtc, userId] : [startUtc, endUtc]));
}
function oldAgentDaily(from, to) {
  const { startUtc, endUtc } = ist.istRangeBounds(from, to);
  return db.prepare(
    `SELECT date(c.called_at, '+330 minutes') AS day, u.full_name AS agent, COUNT(*) AS dials,
            SUM(c.disposition = 'connected') AS connects, COUNT(DISTINCT c.lead_id) AS unique_leads,
            ROUND(100.0 * SUM(c.disposition = 'connected') / COUNT(*)) AS connect_rate_pct
       FROM calls c JOIN users u ON u.id = c.user_id
      WHERE c.called_at >= ? AND c.called_at < ? AND ${RULE}
      GROUP BY day, u.id ORDER BY day DESC, dials DESC, agent`
  ).all(startUtc, endUtc);
}
function oldLeaderboardCalls(from, to) {
  const { startUtc, endUtc } = ist.istRangeBounds(from, to);
  return db.prepare(
    `SELECT user_id, COUNT(*) AS dials, SUM(disposition = 'connected') AS connects, COUNT(DISTINCT lead_id) AS unique_leads
       FROM calls WHERE called_at >= ? AND called_at < ? AND ${RULE} GROUP BY user_id`
  ).all(startUtc, endUtc);
}
function oldDailyTrend(from, to) {
  const { startUtc, endUtc } = ist.istRangeBounds(from, to);
  return db.prepare(
    `SELECT date(called_at, '+330 minutes') AS day, COUNT(*) AS dials, SUM(disposition = 'connected') AS connects
       FROM calls WHERE called_at >= ? AND called_at < ? AND ${RULE} GROUP BY day ORDER BY day`
  ).all(startUtc, endUtc);
}
const sortRows = (rows) => [...rows].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.dials - a.dials || a.agent.localeCompare(b.agent)));

async function assertEverythingEqual(label) {
  const today = ist.todayIst();
  const from30 = ist.addDays(today, -29);
  // Dashboard KPIs (admin: team; caller: own).
  const dash = await api(`/api/dashboard?nocache=1`, { cookie: adminCookie });
  const kA = oldKpis(null, from30, today);
  assert.deepEqual([dash.data.kpis.callsInRange, dash.data.kpis.connectsInRange], [kA.dials, kA.connects], `${label}: dashboard admin calls`);
  const dashC = await api(`/api/dashboard?nocache=1`, { cookie: callerCookie });
  const kC = oldKpis(callerAId, from30, today);
  assert.deepEqual([dashC.data.kpis.callsInRange, dashC.data.kpis.connectsInRange], [kC.dials, kC.connects], `${label}: dashboard caller calls`);
  // Explicit range.
  const from7 = ist.addDays(today, -6);
  const dash7 = await api(`/api/dashboard?from=${from7}&to=${today}&nocache=1`, { cookie: adminCookie });
  const k7 = oldKpis(null, from7, today);
  assert.deepEqual([dash7.data.kpis.callsInRange, dash7.data.kpis.connectsInRange], [k7.dials, k7.connects], `${label}: dashboard 7d`);
  // Top performers' calls/connects.
  const oldTop = Object.fromEntries(oldLeaderboardCalls(from30, today).map((r) => [r.user_id, r]));
  for (const p of dash.data.topPerformers) {
    assert.deepEqual([p.calls, p.connects], [oldTop[p.id]?.dials || 0, oldTop[p.id]?.connects || 0], `${label}: top performer ${p.full_name}`);
  }
  // Agent-daily.
  const ad = await api(`/api/reports/agent-daily?from=${from30}&to=${today}`, { cookie: adminCookie });
  const strip = (r) => ({ day: r.day, agent: r.agent, dials: r.dials, connects: r.connects, unique_leads: r.unique_leads, connect_rate_pct: r.connect_rate_pct });
  assert.deepEqual(sortRows(ad.data.filter((r) => r.dials > 0).map(strip)), sortRows(oldAgentDaily(from30, today).map(strip)), `${label}: agent-daily`);
  // Leaderboard today / week / month.
  for (const period of ['today', 'week', 'month']) {
    const lb = await api(`/api/reports/leaderboard?period=${period}&nocache=1`, { cookie: adminCookie });
    const { from, to } = lb.data.period;
    const old = Object.fromEntries(oldLeaderboardCalls(from, to).map((r) => [r.user_id, r]));
    for (const row of lb.data.rows) {
      const o = old[row.id] || { dials: 0, connects: 0, unique_leads: 0 };
      assert.deepEqual([row.dials, row.connects, row.unique_leads], [o.dials, o.connects, o.unique_leads], `${label}: leaderboard ${period} ${row.full_name}`);
    }
  }
  // Daily trend.
  const trend = await api(`/api/reports/daily-trend?from=${from30}&to=${today}`, { cookie: adminCookie });
  const oldTrend = Object.fromEntries(oldDailyTrend(from30, today).map((r) => [r.day, r]));
  for (const d of trend.data) {
    assert.deepEqual([d.dials, d.connects], [oldTrend[d.day]?.dials || 0, oldTrend[d.day]?.connects || 0], `${label}: trend ${d.day}`);
  }
  // Summary tiles (today).
  const sum = await api('/api/reports/summary?nocache=1', { cookie: adminCookie });
  const kT = oldKpis(null, today, today);
  assert.deepEqual([sum.data.calls_today, sum.data.connects_today], [kT.dials, kT.connects], `${label}: summary today`);
}

test('rollup-backed endpoints equal the old calls scans on random data', async () => {
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM calls_daily').get().n > 30, 'many buckets');
  await assertEverythingEqual('seeded');
});

test('…and stay equal after updates that move rows across days/users/rules, and after deletes', async () => {
  const rows = db.prepare('SELECT id, called_at FROM calls ORDER BY RANDOM() LIMIT 60').all();
  db.transaction(() => {
    rows.slice(0, 15).forEach((r) => db.prepare("UPDATE calls SET called_at = ? WHERE id = ?")
      .run(new Date(Date.parse(r.called_at) + 86400000).toISOString(), r.id));
    rows.slice(15, 30).forEach((r) => db.prepare("UPDATE calls SET disposition = CASE disposition WHEN 'connected' THEN 'busy' ELSE 'connected' END WHERE id = ?").run(r.id));
    rows.slice(30, 40).forEach((r) => db.prepare("UPDATE calls SET source = CASE source WHEN 'whatsapp' THEN 'manual' ELSE 'whatsapp' END WHERE id = ?").run(r.id));
    rows.slice(40, 50).forEach((r) => db.prepare('UPDATE calls SET user_id = ? WHERE id = ?').run(callerAId, r.id));
    rows.slice(50, 55).forEach((r) => db.prepare('UPDATE calls SET auto_logged = 1 - auto_logged WHERE id = ?').run(r.id));
    rows.slice(55, 60).forEach((r) => db.prepare('DELETE FROM calls WHERE id = ?').run(r.id));
  })();
  await assertEverythingEqual('after updates/deletes');
  // Calls logged through the API (the real write path) are reflected immediately.
  const r = await api(`/api/leads/${leadIds[0]}/calls`, { method: 'POST', cookie: adminCookie, body: { disposition: 'connected', outcome: 'interested' } });
  assert.equal(r.status, 200);
  await assertEverythingEqual('after an API call log');
});

test('cache: MISS then HIT within the TTL, per-scope keys, X-Cache header on the four routes', async () => {
  cache._resetCacheForTests();
  const first = await api('/api/dashboard', { cookie: adminCookie });
  assert.equal(first.headers.get('x-cache'), 'MISS');
  const second = await api('/api/dashboard', { cookie: adminCookie });
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.deepEqual(second.data, first.data, 'identical body');
  assert.equal(second.headers.get('content-type'), 'application/json; charset=utf-8');
  // Another scope is a different key — and never sees the admin payload.
  const caller = await api('/api/dashboard', { cookie: callerCookie });
  assert.equal(caller.headers.get('x-cache'), 'MISS');
  assert.equal(caller.data.scope, 'self');
  assert.deepEqual(caller.data.topPerformers, []);
  assert.equal((await api('/api/dashboard', { cookie: callerCookie })).headers.get('x-cache'), 'HIT');
  // Different query → different key.
  const ranged = await api('/api/dashboard?from=2026-01-01&to=2026-01-31', { cookie: adminCookie });
  assert.equal(ranged.headers.get('x-cache'), 'MISS');
  assert.equal((await api('/api/dashboard?to=2026-01-31&from=2026-01-01', { cookie: adminCookie })).headers.get('x-cache'), 'HIT', 'query keys are canonicalised');
  for (const url of ['/api/reports/summary', '/api/reports/leaderboard?period=week', '/api/coaching/leaderboard']) {
    const a = await api(url, { cookie: adminCookie });
    assert.equal(a.status, 200, url);
    assert.equal(a.headers.get('x-cache'), 'MISS', url);
    const b = await api(url, { cookie: adminCookie });
    assert.equal(b.headers.get('x-cache'), 'HIT', url);
    assert.deepEqual(b.data, a.data);
  }
  // The leaderboard is one shared payload for everyone (motivation board).
  assert.equal((await api('/api/reports/leaderboard?period=week', { cookie: callerCookie })).headers.get('x-cache'), 'HIT');
  // Non-200 (caller on an admin route) is never cached.
  const forbidden = await api('/api/coaching/leaderboard', { cookie: callerCookie });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('x-cache'), 'MISS');
  assert.equal((await api('/api/coaching/leaderboard', { cookie: callerCookie })).headers.get('x-cache'), 'MISS');
  assert.ok(cache.cacheStats().hits >= 6);
});

test('cache: every write path invalidates — call log, lead create/patch/delete, deal, payment, sync, task', async () => {
  const warm = async () => {
    await api('/api/dashboard', { cookie: adminCookie });
    const r = await api('/api/dashboard', { cookie: adminCookie });
    assert.equal(r.headers.get('x-cache'), 'HIT');
  };
  const expectMiss = async (label) => {
    const r = await api('/api/dashboard', { cookie: adminCookie });
    assert.equal(r.headers.get('x-cache'), 'MISS', `${label} should have invalidated`);
    assert.equal((await api('/api/reports/leaderboard', { cookie: adminCookie })).headers.get('x-cache'), 'MISS', `${label} (leaderboard)`);
  };
  await warm();
  const lead = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'Cache Lead', phone: '9655500001', assigned_to: 1 } });
  await expectMiss('lead create');
  await warm();
  await api(`/api/leads/${lead.data.id}/calls`, { method: 'POST', cookie: adminCookie, body: { disposition: 'not_picked' } });
  await expectMiss('call log');
  await warm();
  await api(`/api/leads/${lead.data.id}`, { method: 'PATCH', cookie: adminCookie, body: { city: 'Delhi' } });
  await expectMiss('lead patch');
  await warm();
  const product = db.prepare('SELECT id FROM products LIMIT 1').get().id;
  const deal = await api(`/api/leads/${lead.data.id}/deals`, { method: 'POST', cookie: adminCookie, body: { product_id: product, deal_value_rupees: 1000, installments: [{ amount_rupees: 1000, due_date: ist.todayIst() }] } });
  assert.equal(deal.status, 200, JSON.stringify(deal.data));
  await expectMiss('deal');
  await warm();
  const pay = await api(`/api/deals/${deal.data.deal_id}/payments`, { method: 'POST', cookie: adminCookie, body: { amount_rupees: 500, method: 'upi', received_date: ist.todayIst() } });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  await expectMiss('payment');
  await warm();
  await api('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: 'x' } });
  await expectMiss('task (catch-all)');
  await warm();
  // A failed write does NOT invalidate.
  const bad = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: '', phone: 'nope' } });
  assert.equal(bad.status, 400);
  assert.equal((await api('/api/dashboard', { cookie: adminCookie })).headers.get('x-cache'), 'HIT');
  // Reads never invalidate; bump() is exported for out-of-band writers.
  await api('/api/leads', { cookie: adminCookie });
  assert.equal((await api('/api/dashboard', { cookie: adminCookie })).headers.get('x-cache'), 'HIT');
  cache.bump();
  assert.equal((await api('/api/dashboard', { cookie: adminCookie })).headers.get('x-cache'), 'MISS');
  await warm();
  await api(`/api/leads/${lead.data.id}`, { method: 'DELETE', cookie: adminCookie });
  await expectMiss('lead delete');
});

test('cache: entries expire after the TTL; ops health reports cache + transcode status', async () => {
  cache._resetCacheForTests();
  await api('/api/reports/summary', { cookie: adminCookie });
  const stats = cache.cacheStats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.ttl_ms, 30000);
  const realNow = Date.now;
  Date.now = () => realNow() + 31000;
  try {
    assert.equal((await api('/api/reports/summary', { cookie: adminCookie })).headers.get('x-cache'), 'MISS', 'expired after 30 s');
  } finally {
    Date.now = realNow;
  }
  const health = await api('/api/ops/health', { cookie: adminCookie });
  assert.equal(health.status, 200);
  assert.ok(health.data.cache && typeof health.data.cache.entries === 'number');
  assert.ok(health.data.transcode && typeof health.data.transcode.enabled === 'boolean');
});
