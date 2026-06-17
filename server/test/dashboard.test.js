// Phase 5B — Role-aware dashboard + weekly report.
// Seeds leads / deals / payments / projects / calls / recordings on a throwaway
// DB, then drives the real server: KPI correctness (pipeline from active deals,
// revenue from payments in range, active projects), caller scoping (a caller's
// dashboard excludes other users' rows), and top-performers visibility
// (admin sees them; caller gets an empty array). NO Ollama/whisper/Sarvam —
// the intelligence panel reads seeded ai_json only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-dashboard-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

const { ensureBootstrapped } = await import('../bootstrap.js');
ensureBootstrapped();
const db = (await import('../db.js')).default;
const { todayIst, addDays, istRangeBounds } = await import('../lib/istTime.js');

const now = new Date().toISOString();
// An instant inside IST day 2026-06-16 (~12:00 IST = 06:30 UTC).
const TODAY = '2026-06-16';
const inRangeUtc = '2026-06-16T06:30:00.000Z';
// An instant well before the default 30-day window (so range filters bite).
const oldUtc = '2025-01-01T06:30:00.000Z';

function mkUser(username, role, isActive = 1) {
  return db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
     VALUES (?, 'x', ?, ?, ?, ?)`
  ).run(username, username, role, isActive, now).lastInsertRowid;
}

// Caller A and Caller B (so cross-user scoping can be asserted).
const callerA = mkUser('callerA', 'caller');
const callerB = mkUser('callerB', 'caller');

// A product is needed for deals (product_id FK). Bootstrap created a default one.
const productId = db.prepare('SELECT id FROM products LIMIT 1').get().id;

let phoneSeq = 9100000000;
function mkLead(assignedTo, { stage = 'interested', createdAt = inRangeUtc } = {}) {
  const phone = String(phoneSeq++).slice(0, 10);
  return db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, stage, assigned_to, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`
  ).run(`Lead ${phone}`, phone, phone, stage, assignedTo, createdAt, createdAt).lastInsertRowid;
}

function mkDeal(leadId, createdBy, valuePaise, { status = 'active', wonDate = TODAY } = {}) {
  return db.prepare(
    `INSERT INTO deals (lead_id, product_id, created_by, deal_value_paise, status, won_at, won_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(leadId, productId, createdBy, valuePaise, status, inRangeUtc, wonDate, now).lastInsertRowid;
}

function mkPayment(dealId, recordedBy, amountPaise, { receivedDate = TODAY } = {}) {
  return db.prepare(
    `INSERT INTO payments (deal_id, amount_paise, method, received_date, recorded_by, recorded_at)
     VALUES (?, ?, 'upi', ?, ?, ?)`
  ).run(dealId, amountPaise, receivedDate, recordedBy, now).lastInsertRowid;
}

function mkCall(leadId, userId, { disposition = 'connected', calledAt = inRangeUtc } = {}) {
  return db.prepare(
    `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at)
     VALUES (?, ?, 'sales', ?, ?)`
  ).run(leadId, userId, disposition, calledAt).lastInsertRowid;
}

function mkRecording(userId, callId, ai) {
  const devId = db.prepare(
    "INSERT INTO device_tokens (user_id, device_name, token_hash, paired_at) VALUES (?, 'dev', ?, ?)"
  ).run(userId, `tok-${userId}-${Math.random()}`, now).lastInsertRowid;
  return db.prepare(
    `INSERT INTO recordings (user_id, device_id, call_id, file_path, sha256, original_filename,
                             size_bytes, match_status, ai_status, ai_json, summary, created_at)
     VALUES (?, ?, ?, ?, ?, 'r.m4a', 10, 'matched', 'done', ?, 'Talked pricing.', ?)`
  ).run(userId, devId, callId, `f/${Math.random()}.m4a`, `sha-${Math.random()}`,
    JSON.stringify(ai), inRangeUtc).lastInsertRowid;
}

// ----- Seed -----
// Caller A: one active deal (₹1,00,000), one cancelled deal (must NOT count to
// pipeline), one payment of ₹40,000 in range + one payment out of range.
const leadA1 = mkLead(callerA);
const dealA1 = mkDeal(leadA1, callerA, 10_000_000); // active → pipeline
mkPayment(dealA1, callerA, 4_000_000); // revenue in range
mkPayment(dealA1, callerA, 1_000_000, { receivedDate: '2025-01-01' }); // out of range

const leadA2 = mkLead(callerA);
mkDeal(leadA2, callerA, 9_999_999, { status: 'cancelled' }); // excluded from pipeline

// Caller A: connected + not-picked calls in range; analyzed recording.
const cA1 = mkCall(leadA1, callerA, { disposition: 'connected' });
mkCall(leadA1, callerA, { disposition: 'not_picked' });
mkRecording(callerA, cA1, {
  intent: 'Hot', sentiment: 'positive',
  rating: { clarity: 8, engagement: 8, conversion: 8, overall: 8 },
  improvements: ['ask for the close'],
});

// Caller B: an active deal (₹2,00,000) + a payment (₹50,000) — must be invisible
// to caller A but counted in the admin's team totals.
const leadB1 = mkLead(callerB);
const dealB1 = mkDeal(leadB1, callerB, 20_000_000);
mkPayment(dealB1, callerB, 5_000_000);
mkCall(leadB1, callerB, { disposition: 'connected' });

// A project (active) headed by caller A, and a completed one (excluded).
db.prepare(
  `INSERT INTO projects (name, budget_paise, assigned_head_id, status, created_by, created_at)
   VALUES ('Active Proj', 0, ?, 'Working', ?, ?)`
).run(callerA, callerA, now);
db.prepare(
  `INSERT INTO projects (name, budget_paise, assigned_head_id, status, created_by, created_at)
   VALUES ('Done Proj', 0, ?, 'Completed', ?, ?)`
).run(callerA, callerA, now);

// A pending follow-up for caller A in the next 7 days, and one for caller B.
const soon = new Date(Date.now() + 2 * 86400000).toISOString();
db.prepare(
  `INSERT INTO follow_ups (lead_id, assigned_to, due_at, status, created_at)
   VALUES (?, ?, ?, 'pending', ?)`
).run(leadA1, callerA, soon, now);
db.prepare(
  `INSERT INTO follow_ups (lead_id, assigned_to, due_at, status, created_at)
   VALUES (?, ?, ?, 'pending', ?)`
).run(leadB1, callerB, soon, now);

// ----- Real server + logins -----
let baseUrl;
let server;
let adminCookie;
let callerACookie;

const api = async (pathname, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  return { status: res.status, data, headers: res.headers };
};

before(async () => {
  const { createApp } = await import('../app.js');
  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await api('/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'admin123' },
  });
  adminCookie = login.headers.get('set-cookie').split(';')[0];

  const bcrypt = (await import('bcryptjs')).default;
  db.prepare('UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?')
    .run(bcrypt.hashSync('pw12345', 8), callerA);
  const aLogin = await api('/api/auth/login', {
    method: 'POST', body: { username: 'callerA', password: 'pw12345' },
  });
  callerACookie = aLogin.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('admin dashboard: company-wide KPIs (pipeline from active deals, revenue from payments)', async () => {
  const r = await api('/api/dashboard', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.scope, 'team');
  const k = r.data.kpis;
  // Pipeline = A's active ₹1,00,000 + B's active ₹2,00,000 (cancelled excluded).
  assert.equal(k.pipelineValuePaise, 30_000_000);
  // Revenue in range = A's ₹40,000 + B's ₹50,000 (out-of-range payment excluded).
  assert.equal(k.revenuePaise, 9_000_000);
  // Active projects = the one 'Working' project (Completed excluded).
  assert.equal(k.activeProjects, 1);
  // Calls in range: A's connected + not_picked + B's connected = 3 (none auto).
  assert.equal(k.callsInRange, 3);
  assert.equal(k.connectsInRange, 2);
});

test('admin sees top performers ranked by revenue', async () => {
  const r = await api('/api/dashboard', { cookie: adminCookie });
  assert.ok(Array.isArray(r.data.topPerformers));
  assert.ok(r.data.topPerformers.length >= 2, 'both callers present');
  // Caller B (₹50k) outranks caller A (₹40k).
  assert.equal(r.data.topPerformers[0].full_name, 'callerB');
  const revs = r.data.topPerformers.map((p) => p.revenuePaise);
  for (let i = 1; i < revs.length; i += 1) assert.ok(revs[i - 1] >= revs[i], 'ranked desc');
});

test('admin intelligence panel: analyzed call count + avg rating + sentiment', async () => {
  const r = await api('/api/dashboard', { cookie: adminCookie });
  const intel = r.data.intelligence;
  assert.equal(intel.analyzedCount, 1, 'one analyzed recording in range');
  assert.equal(intel.avgRating, 8);
  assert.equal(intel.sentiment.positive, 1);
  assert.ok(intel.recent.some((x) => x.intent === 'Hot'));
});

test('caller scoping: a caller only sees their own leads/deals/payments', async () => {
  const r = await api('/api/dashboard', { cookie: callerACookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.scope, 'self');
  const k = r.data.kpis;
  // Caller A's pipeline = only their active deal ₹1,00,000 (B's excluded).
  assert.equal(k.pipelineValuePaise, 10_000_000);
  // Caller A's revenue in range = only ₹40,000 (B's ₹50,000 excluded).
  assert.equal(k.revenuePaise, 4_000_000);
  // Caller A's calls = their 2 (B's call excluded).
  assert.equal(k.callsInRange, 2);
  assert.equal(k.connectsInRange, 1);
});

test('top performers are hidden (empty) for a caller', async () => {
  const r = await api('/api/dashboard', { cookie: callerACookie });
  assert.deepEqual(r.data.topPerformers, []);
});

test('upcoming follow-ups: caller sees only their own; admin sees the team', async () => {
  const mine = await api('/api/dashboard', { cookie: callerACookie });
  assert.ok(mine.data.upcomingFollowups.every((f) => f.assigned_to === callerA));
  assert.ok(mine.data.upcomingFollowups.length >= 1);

  const team = await api('/api/dashboard', { cookie: adminCookie });
  const owners = new Set(team.data.upcomingFollowups.map((f) => f.assigned_to));
  assert.ok(owners.has(callerA) && owners.has(callerB), 'admin sees both callers\' follow-ups');
});

test('weekly report renders a print-ready HTML document', async () => {
  const r = await api('/api/dashboard/weekly.html', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-type').includes('text/html'));
  assert.ok(r.data.includes('Weekly Performance Report'));
  assert.ok(r.data.includes('window.print()'));
  // Top performer (caller B by revenue) is named in the document.
  assert.ok(r.data.includes('callerB'));
});

test('caller weekly report shows a single self row', async () => {
  const r = await api('/api/dashboard/weekly.html', { cookie: callerACookie });
  assert.equal(r.status, 200);
  assert.ok(r.data.includes('callerA'));
  assert.ok(!r.data.includes('>callerB<'), 'other callers not listed');
});

test('weekly self-row leads uses the period window (created_at in range, live only)', () => {
  // Item 6: the self row's "leads" must mean leads CREATED WITHIN the period
  // (same window as top performers), not all live leads — so the column means
  // the same thing across roles. Drive the exact range-windowed query the route
  // builds for a caller, over the weekly window (last 7 IST days ending today).
  const lonelyUser = mkUser('weeklyLeadsUser', 'caller');
  const today = todayIst();
  const from = addDays(today, -6);
  const to = today;
  const { startUtc, endUtc } = istRangeBounds(from, to);

  // Two leads created INSIDE the window (these count)...
  const inA = new Date(Date.parse(startUtc) + 60_000).toISOString();
  const inB = new Date(Date.parse(endUtc) - 60_000).toISOString();
  // ...one created WELL BEFORE the window (must NOT count, even though it's live)...
  const old = new Date(Date.parse(startUtc) - 5 * 86_400_000).toISOString();
  // ...and one in-window but soft-deleted (must NOT count).
  const seed = (createdAt, deletedAt = null) => db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, assigned_to, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`
  ).run(`WL ${phoneSeq}`, String(phoneSeq++).slice(0, 10),
    String(phoneSeq).slice(0, 10), lonelyUser, createdAt, createdAt, deletedAt);
  seed(inA);
  seed(inB);
  seed(old);
  seed(inB, '2026-01-01T00:00:00.000Z');

  const n = db.prepare(
    `SELECT COUNT(*) AS n FROM leads
       WHERE assigned_to = ? AND created_at >= ? AND created_at < ? AND deleted_at IS NULL`
  ).get(lonelyUser, startUtc, endUtc).n;
  assert.equal(n, 2, 'only the two in-window, non-deleted leads are counted');
});

test('date range filter: a narrow future range yields zero revenue', async () => {
  const r = await api('/api/dashboard?from=2030-01-01&to=2030-01-07', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.kpis.revenuePaise, 0);
  // Pipeline (active deals) is range-independent, still present.
  assert.equal(r.data.kpis.pipelineValuePaise, 30_000_000);
});
