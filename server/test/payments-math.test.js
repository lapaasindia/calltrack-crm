// README "Tracking definitions" (audit SCALE-11):
//   Pending = deal value − payments received (never derived from EMI statuses)
// Asserts that today.js payments_due, reports/summary overdue tiles, the
// dashboard pipeline and /collections all honour it — including partial
// payments and payments recorded WITHOUT picking an installment (applied FIFO).
// Also covers SCALE-9: a manager can view the team queue.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-payments-math-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

const { ensureBootstrapped } = await import('../bootstrap.js');
ensureBootstrapped();
const db = (await import('../db.js')).default;
const { applyInstallmentDues, loadOpenInstallments } = await import('../lib/installmentDues.js');
const { todayIst, addDays } = await import('../lib/istTime.js');

// ── Pure FIFO math ───────────────────────────────────────────────────────────
test('applyInstallmentDues: linked payments reduce their installment only', () => {
  const rows = applyInstallmentDues([
    { id: 1, deal_id: 7, seq: 1, amount_paise: 2500000, paid_paise: 1000000, deal_unlinked_paise: 0 },
    { id: 2, deal_id: 7, seq: 2, amount_paise: 2500000, paid_paise: 0, deal_unlinked_paise: 0 },
  ]);
  assert.equal(rows[0].due_paise, 1500000);
  assert.equal(rows[1].due_paise, 2500000);
});

test('applyInstallmentDues: unlinked payments are applied FIFO by seq, never twice', () => {
  const rows = applyInstallmentDues([
    { id: 2, deal_id: 7, seq: 2, amount_paise: 2500000, paid_paise: 0, deal_unlinked_paise: 4000000 },
    { id: 1, deal_id: 7, seq: 1, amount_paise: 2500000, paid_paise: 0, deal_unlinked_paise: 4000000 },
    { id: 3, deal_id: 8, seq: 1, amount_paise: 1000000, paid_paise: 200000, deal_unlinked_paise: 100000 },
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[1].due_paise, 0, 'seq 1 fully covered by unlinked money');
  assert.equal(byId[1].unlinked_applied_paise, 2500000);
  assert.equal(byId[2].due_paise, 1000000, 'seq 2 gets the remaining 15,000 of unlinked');
  assert.equal(byId[2].unlinked_applied_paise, 1500000);
  assert.equal(byId[3].due_paise, 700000, 'other deal: 10,000 − 2,000 linked − 1,000 unlinked');
});

// ── Against the real routes ─────────────────────────────────────────────────
const now = new Date().toISOString();
const TODAY = todayIst();
const YESTERDAY = addDays(TODAY, -1);
const NEXT_MONTH = addDays(TODAY, 30);
let baseUrl;
let server;
let adminCookie;
let managerCookie;
let callerCookie;
let callerId;
let managerId;
let dealLinked; // deal A: ₹50,000, 2 × 25,000; ₹10,000 linked to inst 1 (overdue)
let dealUnlinked; // deal B: ₹50,000, 2 × 25,000; ₹40,000 UNLINKED
let dealSettled; // deal C: ₹30,000, 1 installment overdue but fully paid unlinked

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

let phoneSeq = 9300000000;
function mkLead(assignedTo, stage = 'won') {
  const phone = String(phoneSeq++);
  return db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, stage, assigned_to, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`
  ).run(`Lead ${phone}`, phone, phone, stage, assignedTo, now, now).lastInsertRowid;
}
function mkDeal(leadId, createdBy, value, schedule) {
  const productId = db.prepare('SELECT id FROM products LIMIT 1').get().id;
  const dealId = db.prepare(
    `INSERT INTO deals (lead_id, product_id, created_by, deal_value_paise, won_at, won_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(leadId, productId, createdBy, value, now, TODAY, now).lastInsertRowid;
  const ins = db.prepare(
    'INSERT INTO installments (deal_id, seq, amount_paise, due_date, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const instIds = schedule.map((s, i) => ins.run(dealId, i + 1, s.amount, s.due, now).lastInsertRowid);
  return { dealId, instIds };
}
function mkPayment(dealId, installmentId, amount, recordedBy) {
  return db.prepare(
    `INSERT INTO payments (deal_id, installment_id, amount_paise, method, received_date, recorded_by, recorded_at)
     VALUES (?, ?, ?, 'upi', ?, ?, ?)`
  ).run(dealId, installmentId, amount, TODAY, recordedBy, now).lastInsertRowid;
}

before(async () => {
  const bcrypt = (await import('bcryptjs')).default;
  const hash = bcrypt.hashSync('pw12345', 8);
  const mkUser = (u, role) => db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)`
  ).run(u, hash, u, role, now).lastInsertRowid;
  managerId = mkUser('mgr', 'manager');
  callerId = mkUser('caller', 'caller');

  const leadA = mkLead(callerId);
  dealLinked = mkDeal(leadA, callerId, 5000000, [{ amount: 2500000, due: YESTERDAY }, { amount: 2500000, due: NEXT_MONTH }]);
  mkPayment(dealLinked.dealId, dealLinked.instIds[0], 1000000, callerId);

  const leadB = mkLead(callerId);
  dealUnlinked = mkDeal(leadB, callerId, 5000000, [{ amount: 2500000, due: YESTERDAY }, { amount: 2500000, due: TODAY }]);
  mkPayment(dealUnlinked.dealId, null, 4000000, callerId);

  const leadC = mkLead(callerId);
  dealSettled = mkDeal(leadC, callerId, 3000000, [{ amount: 3000000, due: YESTERDAY }]);
  mkPayment(dealSettled.dealId, null, 3000000, callerId);

  const { createApp } = await import('../app.js');
  const app = createApp();
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await login('admin', 'admin123');
  managerCookie = await login('mgr', 'pw12345');
  callerCookie = await login('caller', 'pw12345');
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('loadOpenInstallments: due = amount − linked − FIFO-applied unlinked; settled rows dropped', () => {
  const rows = loadOpenInstallments(db, { dueOnOrBefore: TODAY, assignedTo: callerId });
  const byInst = Object.fromEntries(rows.map((r) => [r.installment_id, r]));
  assert.equal(byInst[dealLinked.instIds[0]].due_paise, 1500000, 'A/1: 25,000 − 10,000 linked');
  assert.equal(byInst[dealUnlinked.instIds[0]], undefined, 'B/1 fully covered by unlinked 40,000');
  assert.equal(byInst[dealUnlinked.instIds[1]].due_paise, 1000000, 'B/2: 25,000 − remaining 15,000 unlinked');
  assert.equal(byInst[dealSettled.instIds[0]], undefined, 'C settled via unlinked payment: not due');
  assert.equal(rows.length, 2);
});

test('GET /api/today payments_due subtracts linked AND unlinked payments (paid_paise = amount − due)', async () => {
  const r = await api('/api/today', { cookie: callerCookie });
  assert.equal(r.status, 200);
  const due = r.data.payments_due;
  assert.equal(due.length, 2);
  const a1 = due.find((p) => p.installment_id === dealLinked.instIds[0]);
  assert.equal(a1.due_paise, 1500000);
  assert.equal(a1.amount_paise - a1.paid_paise, a1.due_paise, 'client math (amount − paid) still yields the due');
  assert.equal(a1.linked_paid_paise, 1000000);
  const b2 = due.find((p) => p.installment_id === dealUnlinked.instIds[1]);
  assert.equal(b2.due_paise, 1000000);
  assert.equal(b2.paid_paise, 1500000);
  assert.ok(!due.some((p) => p.deal_id === dealSettled.dealId), 'fully paid deal not in the queue');
  // Legacy keys still present for the mobile app.
  for (const k of ['installment_id', 'due_date', 'seq', 'amount_paise', 'installment_status', 'paid_paise',
    'deal_id', 'deal_value_paise', 'product_name', 'lead_id', 'name', 'phone', 'stage', 'assigned_to_name']) {
    assert.ok(k in a1, `payments_due row has ${k}`);
  }
});

test('GET /api/today/counts matches the queue and its scoping', async () => {
  const c = await api('/api/today/counts', { cookie: callerCookie });
  assert.equal(c.status, 200);
  assert.deepEqual(Object.keys(c.data).sort(), ['date', 'followups', 'payments_due', 'tasks', 'total']);
  assert.equal(c.data.payments_due, 2);
  assert.equal(c.data.total, c.data.followups + c.data.payments_due + c.data.tasks);
  const full = await api('/api/today', { cookie: callerCookie });
  assert.equal(c.data.followups, full.data.followups.length);
  assert.equal(c.data.tasks, full.data.tasks.length);
});

test('SCALE-9: a manager (not just legacy admin) can view the team queue with ?user_id=all', async () => {
  const all = await api('/api/today?user_id=all', { cookie: managerCookie });
  assert.equal(all.status, 200);
  assert.equal(all.data.payments_due.length, 2, 'team-wide queue includes the caller\'s installments');
  const own = await api('/api/today', { cookie: managerCookie });
  assert.equal(own.data.payments_due.length, 0, 'manager\'s own queue is empty');
  const counts = await api('/api/today/counts?user_id=all', { cookie: managerCookie });
  assert.equal(counts.data.payments_due, 2);
  // A caller asking for ?user_id=all still only gets their own queue.
  const callerAll = await api(`/api/today?user_id=${managerId}`, { cookie: callerCookie });
  assert.equal(callerAll.data.payments_due.length, 2);
});

test('reports/summary overdue tiles count only what is still owed on past-due installments', async () => {
  const r = await api('/api/reports/summary', { cookie: adminCookie });
  assert.equal(r.status, 200);
  // Past due (yesterday): A/1 owes 15,000; B/1 covered; C covered → one installment, ₹15,000.
  assert.equal(r.data.overdue_installments, 1);
  assert.equal(r.data.overdue_amount_paise, 1500000);
});

test('dashboard pipeline = deal value − payments (never full deal value)', async () => {
  const r = await api('/api/dashboard', { cookie: callerCookie });
  assert.equal(r.status, 200);
  // A: 50,000 − 10,000 = 40,000; B: 50,000 − 40,000 = 10,000; C: 30,000 − 30,000 = 0.
  assert.equal(r.data.kpis.pipelineValuePaise, 5000000);
});

test('/collections: pending = value − payments; default shows open balances, ?all=1 adds settled', async () => {
  const open = await api('/api/collections', { cookie: callerCookie });
  assert.equal(open.status, 200);
  const ids = open.data.deals.map((d) => d.id);
  assert.ok(ids.includes(dealLinked.dealId) && ids.includes(dealUnlinked.dealId));
  assert.ok(!ids.includes(dealSettled.dealId), 'settled deal hidden by default');
  const a = open.data.deals.find((d) => d.id === dealLinked.dealId);
  assert.equal(a.pending_paise, 4000000);
  assert.equal(a.overdue, true);
  assert.equal(a.overdue_paise, 1500000, 'A/1: 25,000 due yesterday − 10,000 linked');
  const b = open.data.deals.find((d) => d.id === dealUnlinked.dealId);
  assert.equal(b.pending_paise, 1000000);
  assert.equal(b.overdue, false, 'B: yesterday\'s installment was covered by the unlinked ₹40,000');
  assert.equal(b.overdue_paise, 0);
  assert.equal(open.data.total, 2);
  // Summary spans the whole scope (settled included), as before.
  assert.equal(open.data.summary.total_value_paise, 13000000);
  assert.equal(open.data.summary.collected_paise, 8000000);
  assert.equal(open.data.summary.pending_paise, 5000000);
  assert.equal(open.data.summary.overdue_count, 1, 'only deal A is overdue AND still owes');
  assert.equal(open.data.summary.overdue_paise, 1500000);

  const all = await api('/api/collections?all=1', { cookie: callerCookie });
  assert.equal(all.data.deals.length, 3);
  const c = all.data.deals.find((d) => d.id === dealSettled.dealId);
  assert.equal(c.pending_paise, 0);
  assert.equal(c.overdue, false, 'a past-due installment on a fully paid deal is not overdue');
  assert.equal(all.data.total, 3);

  const page = await api('/api/collections?all=1&limit=2&offset=2', { cookie: callerCookie });
  assert.equal(page.data.deals.length, 1);
  assert.equal(page.data.total, 3);
});

test('recording a payment against an installment still refreshes its status (indexed path)', async () => {
  const r = await api(`/api/deals/${dealLinked.dealId}/payments`, {
    method: 'POST', cookie: callerCookie,
    body: { amount_rupees: 15000, installment_id: dealLinked.instIds[0] },
  });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT status FROM installments WHERE id = ?').get(dealLinked.instIds[0]).status, 'paid');
  const today = await api('/api/today', { cookie: callerCookie });
  assert.ok(!today.data.payments_due.some((p) => p.installment_id === dealLinked.instIds[0]));
  const summary = await api('/api/reports/summary', { cookie: adminCookie });
  assert.equal(summary.data.overdue_amount_paise, 0);
});
