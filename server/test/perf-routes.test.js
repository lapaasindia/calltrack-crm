// Route-level regressions for the scalability fixes (audit SCALE-5/9/21/22/23):
// meetings visibility in SQL, task timer server-side + idempotent, invoice
// counters, leaderboard role pool, exact money in reports, and the
// /collections scope rules for read_only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-perf-routes-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

const { ensureBootstrapped } = await import('../bootstrap.js');
ensureBootstrapped();
const db = (await import('../db.js')).default;
const { todayIst } = await import('../lib/istTime.js');

const now = new Date().toISOString();
let baseUrl;
let server;
let adminCookie;
let agentCookie;
let employeeCookie;
let readOnlyCookie;
let agentId;
let employeeId;
let readOnlyId;

const api = async (pathname, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
};
const login = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, `login ${username}`);
  return r.headers.get('set-cookie').split(';')[0];
};

before(async () => {
  const bcrypt = (await import('bcryptjs')).default;
  const hash = bcrypt.hashSync('pw12345', 8);
  const mkUser = (u, role) => db.prepare(
    'INSERT INTO users (username, password_hash, full_name, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(u, hash, u, role, now).lastInsertRowid;
  agentId = mkUser('agent1', 'agent');
  employeeId = mkUser('emp1', 'employee');
  readOnlyId = mkUser('ro1', 'read_only');

  const { createApp } = await import('../app.js');
  const app = createApp();
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await login('admin', 'admin123');
  agentCookie = await login('agent1', 'pw12345');
  employeeCookie = await login('emp1', 'pw12345');
  readOnlyCookie = await login('ro1', 'pw12345');
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Meetings: visibility predicate in SQL, before LIMIT ─────────────────────
test('meetings list: visibility applied in SQL (owner OR attendee), limit honoured, malformed attendee_ids tolerated', async () => {
  const mk = (title, ownerId, attendeeIds) => db.prepare(
    `INSERT INTO meetings (title, start_at, end_at, owner_id, attendee_ids, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(title, now, now, ownerId, JSON.stringify(attendeeIds), ownerId, now).lastInsertRowid;
  const own = mk('agent owns', agentId, []);
  const attending = mk('agent attends', employeeId, [agentId, 999]);
  const foreign = mk('employee private', employeeId, []);
  // A hand-corrupted JSON value must not abort the whole listing.
  const broken = db.prepare(
    `INSERT INTO meetings (title, start_at, end_at, owner_id, attendee_ids, created_by, created_at)
     VALUES ('broken json', ?, ?, ?, 'not-json', ?, ?)`
  ).run(now, now, employeeId, employeeId, now).lastInsertRowid;

  const list = await api('/api/meetings', { cookie: agentCookie });
  assert.equal(list.status, 200);
  const ids = list.data.map((m) => m.id);
  assert.ok(ids.includes(own) && ids.includes(attending), 'owner + attendee visible');
  assert.ok(!ids.includes(foreign) && !ids.includes(broken), 'others hidden');

  const limited = await api('/api/meetings?limit=1', { cookie: agentCookie });
  assert.equal(limited.data.length, 1);

  const admin = await api('/api/meetings', { cookie: adminCookie });
  const adminIds = admin.data.map((m) => m.id);
  assert.ok([own, attending, foreign, broken].every((id) => adminIds.includes(id)), 'admin tier sees all');
  const filtered = await api(`/api/meetings?owner_id=${employeeId}`, { cookie: adminCookie });
  assert.ok(filtered.data.every((m) => m.owner_id === employeeId));
});

// ── Task timer: server-side start, idempotent stop ──────────────────────────
test('task timer: start is idempotent, stop computes from the server start and is a no-op when repeated', async () => {
  const t = await api('/api/tasks', { method: 'POST', cookie: agentCookie, body: { title: 'Timed' } });
  const id = t.data.id;
  const s1 = await api(`/api/tasks/${id}/timer/start`, { method: 'POST', cookie: agentCookie });
  assert.equal(s1.status, 200);
  assert.equal(s1.data.already_running, false);
  assert.equal(db.prepare('SELECT timer_started_at FROM tasks WHERE id = ?').get(id).timer_started_at, s1.data.started);
  const s2 = await api(`/api/tasks/${id}/timer/start`, { method: 'POST', cookie: agentCookie });
  assert.equal(s2.data.already_running, true);
  assert.equal(s2.data.started, s1.data.started, 'second start keeps the original instant');

  // A client-supplied start_iso is ignored: backdate the SERVER start by 120 s.
  db.prepare('UPDATE tasks SET timer_started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 120000).toISOString(), id);
  const stop = await api(`/api/tasks/${id}/timer/stop`, {
    method: 'POST', cookie: agentCookie, body: { start_iso: new Date(Date.now() - 36_000_000).toISOString() },
  });
  assert.equal(stop.status, 200);
  assert.ok(stop.data.duration >= 119 && stop.data.duration <= 125, `~120s, got ${stop.data.duration}`);
  let row = db.prepare('SELECT time_tracked, time_entries, timer_started_at FROM tasks WHERE id = ?').get(id);
  assert.equal(row.timer_started_at, null);
  assert.equal(JSON.parse(row.time_entries).length, 1);
  assert.equal(row.time_tracked, stop.data.duration);

  const again = await api(`/api/tasks/${id}/timer/stop`, { method: 'POST', cookie: agentCookie });
  assert.equal(again.data.duration, 0);
  assert.equal(again.data.running, false);
  row = db.prepare('SELECT time_tracked, time_entries FROM tasks WHERE id = ?').get(id);
  assert.equal(JSON.parse(row.time_entries).length, 1, 'double stop adds nothing');
  assert.equal(row.time_tracked, stop.data.duration);
});

// ── Invoice numbers from the counters table ────────────────────────────────
test('invoice numbers come from counters inside the create transaction and skip taken numbers', async () => {
  const body = { items: [{ description: 'Thing', qty: 1, unit_price_paise: 10000 }] };
  const a = await api('/api/invoices', { method: 'POST', cookie: adminCookie, body });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const na = parseInt(a.data.invoice_number.slice(4), 10);
  assert.equal(db.prepare("SELECT next FROM counters WHERE name = 'invoice'").get().next, na + 1);
  // Someone hand-inserts the next number: the sequence must skip it.
  const taken = `INV-${String(na + 1).padStart(5, '0')}`;
  db.prepare(
    `INSERT INTO invoices (invoice_number, issue_date, due_date, subtotal_paise, gst_percent, tax_paise, total_paise, created_by, created_at)
     VALUES (?, ?, ?, 1, 0, 0, 1, 1, ?)`
  ).run(taken, todayIst(), todayIst(), now);
  const b = await api('/api/invoices', { method: 'POST', cookie: adminCookie, body });
  assert.equal(b.status, 200);
  assert.equal(b.data.invoice_number, `INV-${String(na + 2).padStart(5, '0')}`);
  assert.equal(db.prepare("SELECT next FROM counters WHERE name = 'invoice'").get().next, na + 3);
  // Counter table gone (older DB edge) → falls back to MAX()+1 and re-creates it.
  db.prepare("DELETE FROM counters WHERE name = 'invoice'").run();
  const c = await api('/api/invoices', { method: 'POST', cookie: adminCookie, body });
  assert.equal(c.data.invoice_number, `INV-${String(na + 3).padStart(5, '0')}`);
  assert.equal(db.prepare("SELECT next FROM counters WHERE name = 'invoice'").get().next, na + 4);
});

test('QA-4: deleting an invoice never reuses its number (soft-cancel keeps the row)', async () => {
  const body = { items: [{ description: 'Thing', qty: 1, unit_price_paise: 10000 }] };
  const a = await api('/api/invoices', { method: 'POST', cookie: adminCookie, body });
  const na = parseInt(a.data.invoice_number.slice(4), 10);
  const del = await api(`/api/invoices/${a.data.id}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(del.status, 200);
  // Hidden from list/detail/html, but the row (and number) survive.
  assert.equal((await api(`/api/invoices/${a.data.id}`, { cookie: adminCookie })).status, 404);
  assert.equal((await api(`/api/invoices/${a.data.id}/html`, { cookie: adminCookie })).status, 404);
  assert.equal((await api(`/api/invoices/${a.data.id}`, { method: 'DELETE', cookie: adminCookie })).status, 404, 'delete is not repeatable');
  const list = await api('/api/invoices', { cookie: adminCookie });
  assert.ok(!list.data.some((i) => i.id === a.data.id));
  const deletedList = await api('/api/invoices?deleted=1', { cookie: adminCookie });
  assert.ok(deletedList.data.some((i) => i.id === a.data.id && i.status === 'cancelled' && i.deleted_at));
  const row = db.prepare('SELECT status, deleted_at, invoice_number FROM invoices WHERE id = ?').get(a.data.id);
  assert.equal(row.status, 'cancelled');
  assert.ok(row.deleted_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoice_items WHERE invoice_id = ?').get(a.data.id).n, 1, 'items kept');
  const b = await api('/api/invoices', { method: 'POST', cookie: adminCookie, body });
  assert.equal(b.status, 200);
  assert.equal(parseInt(b.data.invoice_number.slice(4), 10), na + 1, 'sequence continues past the deleted number');
});

test('read_only cannot write anywhere under /api (global requireWriter)', async () => {
  const post = await api('/api/tasks', { method: 'POST', cookie: readOnlyCookie, body: { title: 'nope' } });
  assert.equal(post.status, 403);
  const get = await api('/api/tasks', { cookie: readOnlyCookie });
  assert.equal(get.status, 200);
});

// ── Leaderboard pool + exact money ─────────────────────────────────────────
test('leaderboard includes agent and employee roles, not only legacy callers', async () => {
  const r = await api('/api/reports/leaderboard?period=month', { cookie: agentCookie });
  assert.equal(r.status, 200);
  const ids = r.data.rows.map((x) => x.id);
  assert.ok(ids.includes(agentId), 'agent on the board');
  assert.ok(ids.includes(employeeId), 'employee on the board');
  assert.ok(!ids.includes(readOnlyId), 'read_only never competes');
  assert.ok(!ids.includes(1), 'admin never competes');
});

test('reports return exact rupees (2 dp) plus *_paise siblings instead of truncated integers', async () => {
  const productId = db.prepare('SELECT id FROM products LIMIT 1').get().id;
  const phone = '9400000001';
  const leadId = db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, stage, assigned_to, created_at, updated_at)
     VALUES ('Money', ?, ?, 'manual', 'won', ?, ?, ?)`
  ).run(phone, phone, agentId, now, now).lastInsertRowid;
  const today = todayIst();
  const dealId = db.prepare(
    `INSERT INTO deals (lead_id, product_id, created_by, deal_value_paise, won_at, won_date, created_at)
     VALUES (?, ?, ?, 123457, ?, ?, ?)`
  ).run(leadId, productId, agentId, now, today, now).lastInsertRowid; // ₹1,234.57
  db.prepare(
    `INSERT INTO payments (deal_id, amount_paise, method, received_date, recorded_by, recorded_at)
     VALUES (?, 99999, 'upi', ?, ?, ?)`
  ).run(dealId, today, agentId, now); // ₹999.99

  const byProduct = await api('/api/reports/revenue-by-product', { cookie: adminCookie });
  const row = byProduct.data.find((p) => p.deal_value_paise === 123457);
  assert.ok(row, 'product row present');
  assert.equal(row.deal_value_rupees, 1234.57);
  assert.equal(row.collected_paise, 99999);
  assert.equal(row.collected_rupees, 999.99);

  const trend = await api('/api/reports/daily-trend', { cookie: adminCookie });
  const day = trend.data.find((d) => d.day === today);
  assert.equal(day.collected_paise, 99999);
  assert.equal(day.collected_rupees, 999.99);

  const daily = await api('/api/reports/agent-daily', { cookie: adminCookie });
  const agentRow = daily.data.find((d) => d.day === today && d.agent === 'agent1');
  assert.ok(agentRow, 'agent-daily row for the deal day');
  assert.equal(agentRow.deal_value_paise, 123457);
  assert.equal(agentRow.deal_value_rupees, 1234.57);
});

test('/collections: read_only sees an empty list, agent sees only own deals, admin sees all', async () => {
  const ro = await api('/api/collections?all=1', { cookie: readOnlyCookie });
  assert.equal(ro.status, 200);
  assert.deepEqual(ro.data.deals, []);
  assert.equal(ro.data.summary.total_value_paise, 0);
  const agent = await api('/api/collections?all=1', { cookie: agentCookie });
  assert.ok(agent.data.deals.length >= 1);
  assert.ok(agent.data.deals.every((d) => d.assigned_to === agentId));
  const admin = await api('/api/collections?all=1', { cookie: adminCookie });
  assert.ok(admin.data.deals.length >= agent.data.deals.length);
});
