// Phase 2B — lead routing + coaching / daily-learning.
// getAutoAssignedOwner (rule/round-robin/fallback) + getDailyCoaching aggregation
// + grade boundaries run DB-only on a throwaway database. Auto-assign on an
// admin-created lead and learnings scoping run against a real server. NO
// Ollama/whisper/ffmpeg/Sarvam is ever touched — coaching reads seeded ai_json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-coaching-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

// ---------- pure: gradeFor boundaries ----------
const { gradeFor } = await import('../lib/coaching.js');

test('gradeFor boundaries: A+>=9, A>=8, B>=7, C>=6, D>=5, else F', () => {
  assert.equal(gradeFor(9), 'A+');
  assert.equal(gradeFor(9.5), 'A+');
  assert.equal(gradeFor(8), 'A');
  assert.equal(gradeFor(7.9), 'B');
  assert.equal(gradeFor(7), 'B');
  assert.equal(gradeFor(6), 'C');
  assert.equal(gradeFor(5), 'D');
  assert.equal(gradeFor(4.9), 'F');
  assert.equal(gradeFor(0), 'F');
  assert.equal(gradeFor(null), 'N/A');
});

// ---------- DB setup (real schema on throwaway db) ----------
const { ensureBootstrapped } = await import('../bootstrap.js');
ensureBootstrapped();
const db = (await import('../db.js')).default;
const { getSetting, setSetting } = await import('../db.js');
const { getAutoAssignedOwner } = await import('../lib/assignment.js');
const { getDailyCoaching } = await import('../lib/coaching.js');

const now = new Date().toISOString();

// Seed extra users covering the round-robin pool + an inactive one. User 1 is
// the bootstrap admin (admin tier → fallback owner).
function mkUser(username, role, isActive = 1, createdAt = now) {
  return db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
     VALUES (?, 'x', ?, ?, ?, ?)`
  ).run(username, username, role, isActive, createdAt).lastInsertRowid;
}

const agentA = mkUser('agentA', 'agent');
const agentB = mkUser('agentB', 'caller');
const agentC = mkUser('agentC', 'agent', 0); // inactive → never round-robined

// ---------- getAutoAssignedOwner ----------
test('auto-assign: subject rule wins over round-robin', () => {
  db.prepare(
    'INSERT INTO lead_routing_rules (subject, assigned_to, created_at) VALUES (?, ?, ?)'
  ).run('Enterprise', agentA, now);
  const r = getAutoAssignedOwner(db, { subject: 'enterprise', source: 'website' });
  assert.equal(r.method, 'RULE');
  assert.equal(r.userId, agentA);
});

test('auto-assign: source rule used when no subject rule matches', () => {
  db.prepare(
    'INSERT INTO lead_routing_rules (subject, assigned_to, created_at) VALUES (?, ?, ?)'
  ).run('facebook', agentB, now);
  const r = getAutoAssignedOwner(db, { subject: 'something else', source: 'Facebook' });
  assert.equal(r.method, 'RULE');
  assert.equal(r.userId, agentB);
});

test('auto-assign: round-robin rotates through active agents/callers only', () => {
  setSetting('rr_cursor', 0);
  // No rule match → round-robin. Pool (active agent/caller) = [agentA, agentB].
  const first = getAutoAssignedOwner(db, { subject: 'no-rule', source: 'manual' });
  const second = getAutoAssignedOwner(db, { subject: 'no-rule', source: 'manual' });
  const third = getAutoAssignedOwner(db, { subject: 'no-rule', source: 'manual' });
  assert.equal(first.method, 'ROUND_ROBIN');
  assert.deepEqual([first.userId, second.userId], [agentA, agentB], 'rotates A then B');
  assert.equal(third.userId, agentA, 'wraps back to A');
  assert.notEqual(first.userId, agentC, 'inactive agent never picked');
});

test('auto-assign: cursor persists across calls', () => {
  setSetting('rr_cursor', agentA); // pretend A was last handed a lead
  const r = getAutoAssignedOwner(db, { subject: 'x', source: 'y' });
  assert.equal(r.userId, agentB, 'next after A is B');
  assert.equal(Number(getSetting('rr_cursor', 0)), agentB);
});

test('auto-assign: fallback to oldest active admin when no agents/callers', () => {
  // Deactivate the round-robin pool; only the bootstrap admin (id 1) remains.
  db.prepare("UPDATE users SET is_active = 0 WHERE role IN ('agent','caller')").run();
  const r = getAutoAssignedOwner(db, { subject: 'orphan', source: 'manual' });
  assert.equal(r.method, 'FALLBACK');
  assert.equal(r.userId, 1, 'falls back to the bootstrap admin');
  // Restore the pool for later tests.
  db.prepare("UPDATE users SET is_active = 1 WHERE id IN (?, ?)").run(agentA, agentB);
});

// ---------- getDailyCoaching aggregation ----------
const DATE = '2026-06-16';
// A call inside the IST day 2026-06-16 (06:00 IST → 00:30 UTC).
const callAt = (iso) => iso;
const istNoon = '2026-06-16T06:30:00.000Z'; // ~12:00 IST on 2026-06-16

// Seed a lead + N analyzed connected calls for a user with the given overall
// ratings. Each call gets a recording carrying an ai_json blob.
function seedAnalyzedCalls(userId, overalls, { calledAt = istNoon, intent = 'Warm', sentiment = 'positive' } = {}) {
  const leadInfo = db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, assigned_to, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?)`
  ).run(`Lead ${userId}-${Math.random().toString(36).slice(2, 7)}`,
    String(9000000000 + Math.floor(Math.random() * 999999999)).slice(0, 10),
    'raw', userId, now, now);
  const leadId = leadInfo.lastInsertRowid;
  // device_id is NOT NULL FK on recordings; reuse one device per user.
  const devId = db.prepare(
    "INSERT INTO device_tokens (user_id, device_name, token_hash, paired_at) VALUES (?, 'dev', ?, ?)"
  ).run(userId, `tok-${userId}-${Math.random()}`, now).lastInsertRowid;

  overalls.forEach((overall, idx) => {
    const callInfo = db.prepare(
      `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at)
       VALUES (?, ?, 'sales', 'connected', ?)`
    ).run(leadId, userId, callAt(calledAt));
    const ai = {
      intent, sentiment,
      rating: { clarity: overall, engagement: overall, conversion: overall, overall },
      strengths: ['clear pitch'], improvements: ['ask for the close'],
    };
    db.prepare(
      `INSERT INTO recordings (user_id, device_id, call_id, file_path, sha256, original_filename,
                               size_bytes, match_status, ai_status, ai_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'r.m4a', 10, 'matched', 'done', ?, ?)`
    ).run(userId, devId, callInfo.lastInsertRowid, `f/${userId}-${idx}.m4a`,
      `sha-${userId}-${idx}-${Math.random()}`, JSON.stringify(ai), now);
  });
  return leadId;
}

test('getDailyCoaching aggregates ratings, calls, sentiment, grade', () => {
  // agentA: three connected analyzed calls rated 8, 8, 8 → avg 8 → grade A.
  seedAnalyzedCalls(agentA, [8, 8, 8]);
  const card = getDailyCoaching(db, agentA, DATE);
  assert.equal(card.callsToday, 3);
  assert.equal(card.connected, 3);
  assert.equal(card.analyzedCalls, 3);
  assert.equal(card.avgRating, 8);
  assert.equal(card.grade, 'A');
  assert.equal(card.positivePct, 100, 'all positive sentiment');
  assert.equal(card.conversionRate, 100, 'all connected');
  assert.equal(card.ratingTrend.length, 7, '7-day trend');
  assert.equal(card.ratingTrend[6].date, DATE, 'trend ends today');
  assert.equal(card.ratingTrend[6].avg, 8);
  assert.ok(card.currentStreak >= 1);
  assert.ok(card.topStrengths.some((s) => s.text === 'clear pitch'));
  assert.ok(card.topFocusAreas.some((s) => s.text === 'ask for the close'));
});

test('getDailyCoaching excludes WhatsApp-mirrored rows from calling stats', () => {
  // A fresh agent with ONE real connected phone call that day.
  const waUser = mkUser('waCoachUser', 'agent');
  const leadInfo = db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, assigned_to, created_at, updated_at)
     VALUES ('WA Coach Lead', '9911000099', '9911000099', 'manual', ?, ?, ?)`
  ).run(waUser, now, now);
  const leadId = leadInfo.lastInsertRowid;
  db.prepare(
    `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at, source)
     VALUES (?, ?, 'sales', 'connected', ?, 'manual')`
  ).run(leadId, waUser, istNoon);
  // Plus three WhatsApp messages mirrored into calls (source='whatsapp',
  // disposition='connected') — messaging activity, NOT phone dials.
  for (let i = 0; i < 3; i += 1) {
    db.prepare(
      `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at, source)
       VALUES (?, ?, 'support', 'connected', ?, 'whatsapp')`
    ).run(leadId, waUser, istNoon);
  }
  const card = getDailyCoaching(db, waUser, DATE);
  assert.equal(card.callsToday, 1, 'WhatsApp mirror rows do not inflate callsToday');
  assert.equal(card.connected, 1, 'WhatsApp mirror rows do not inflate connects');
  assert.equal(card.analyzedCalls, 0, 'no analyzed (ai_json) calls for this agent');
});

test('getDailyCoaching grade boundary: avg 9 → A+, avg < 5 → F', () => {
  seedAnalyzedCalls(agentB, [9, 9]); // avg 9
  const a = getDailyCoaching(db, agentB, DATE);
  assert.equal(a.avgRating, 9);
  assert.equal(a.grade, 'A+');

  // A fresh user with only low ratings → F.
  const lowUser = mkUser('lowUser', 'agent');
  seedAnalyzedCalls(lowUser, [3, 4]); // avg 3.5
  const b = getDailyCoaching(db, lowUser, DATE);
  assert.equal(b.grade, 'F');
});

test('getDailyCoaching: no data → null avg, N/A grade, empty lists', () => {
  const empty = mkUser('emptyUser', 'agent');
  const card = getDailyCoaching(db, empty, DATE);
  assert.equal(card.callsToday, 0);
  assert.equal(card.avgRating, null);
  assert.equal(card.grade, 'N/A');
  assert.deepEqual(card.topStrengths, []);
  assert.equal(card.currentStreak, 0);
});

test('getDailyCoaching surfaces the agent\'s hot leads', () => {
  const hotUser = mkUser('hotUser', 'agent');
  db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, assigned_to, ai_intent, ai_score, created_at, updated_at)
     VALUES ('Hot One', '9900000001', '9900000001', 'manual', ?, 'Hot', 92, ?, ?)`
  ).run(hotUser, now, now);
  db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, assigned_to, score, created_at, updated_at)
     VALUES ('Warm One', '9900000002', '9900000002', 'manual', ?, 40, ?, ?)`
  ).run(hotUser, now, now);
  const card = getDailyCoaching(db, hotUser, DATE);
  assert.equal(card.hotLeads.length, 1, 'only the Hot/>=80 lead is surfaced');
  assert.equal(card.hotLeads[0].name, 'Hot One');
});

// ---------- endpoints: real server (auto-assign + learnings scoping) ----------
let baseUrl;
let server;
let adminCookie;
let agentACookie;

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

  // Give agentA a known password + active so it can log in.
  const bcrypt = (await import('bcryptjs')).default;
  db.prepare('UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?')
    .run(bcrypt.hashSync('pw12345', 8), agentA);
  const aLogin = await api('/api/auth/login', {
    method: 'POST', body: { username: 'agentA', password: 'pw12345' },
  });
  agentACookie = aLogin.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('admin-created lead with no owner is auto-assigned via routing', async () => {
  // A subject rule → agentA. Admin creates a lead with that subject, no owner.
  await api('/api/routing-rules', {
    method: 'POST', cookie: adminCookie, body: { subject: 'PremiumPlan', assigned_to: agentA },
  });
  const res = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Routed Lead', phone: '9876000111', subject: 'PremiumPlan' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.assigned_to, agentA, 'routed to the rule owner');
  assert.equal(res.data.auto_assign.method, 'RULE');
});

test('explicit assigned_to is respected over auto-assign', async () => {
  const res = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Explicit Lead', phone: '9876000222', assigned_to: agentB },
  });
  assert.equal(res.data.assigned_to, agentB);
  assert.equal(res.data.auto_assign, null);
});

test('a non-admin creating a lead still gets assigned_to = self', async () => {
  const res = await api('/api/leads', {
    method: 'POST', cookie: agentACookie,
    body: { name: 'My Own Lead', phone: '9876000333' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.assigned_to, agentA, 'agent keeps the lead');
});

test('routing rules CRUD is owner-gated', async () => {
  // Non-owner (agentA) cannot list or create routing rules.
  const denied = await api('/api/routing-rules', { cookie: agentACookie });
  assert.equal(denied.status, 403);
  const list = await api('/api/routing-rules', { cookie: adminCookie });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data));
});

test('learnings: create own check-in, then read it back', async () => {
  const created = await api('/api/coaching/learnings', {
    method: 'POST', cookie: agentACookie,
    body: { learning: 'Slow down on pricing.', win: 'Booked a demo', challenge: 'Objections' },
  });
  assert.equal(created.status, 200);
  const mine = await api('/api/coaching/learnings', { cookie: agentACookie });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.some((l) => l.learning === 'Slow down on pricing.' && l.source === 'daily_check_in'));
});

test('learnings: an agent cannot read another user\'s learnings', async () => {
  const res = await api(`/api/coaching/learnings?user_id=1`, { cookie: agentACookie });
  assert.equal(res.status, 403);
  // Admin CAN read anyone's.
  const ok = await api(`/api/coaching/learnings?user_id=${agentA}`, { cookie: adminCookie });
  assert.equal(ok.status, 200);
});

test('coaching daily: agent restricted to self, admin can read anyone', async () => {
  const self = await api('/api/coaching/daily', { cookie: agentACookie });
  assert.equal(self.status, 200);
  assert.equal(self.data.user_id, agentA);

  const other = await api(`/api/coaching/daily?user_id=1`, { cookie: agentACookie });
  assert.equal(other.status, 403);

  const adminView = await api(`/api/coaching/daily?user_id=${agentA}&date=${DATE}`, { cookie: adminCookie });
  assert.equal(adminView.status, 200);
  assert.equal(adminView.data.user_id, agentA);
});

test('leaderboard is admin-tier only and sorted by avg rating', async () => {
  const denied = await api('/api/coaching/leaderboard', { cookie: agentACookie });
  assert.equal(denied.status, 403);
  const board = await api(`/api/coaching/leaderboard?date=${DATE}`, { cookie: adminCookie });
  assert.equal(board.status, 200);
  assert.ok(Array.isArray(board.data.leaderboard));
  // Sorted best-first: each entry's avgRating >= the next (nulls last).
  const rs = board.data.leaderboard.map((m) => m.avgRating ?? -1);
  for (let i = 1; i < rs.length; i += 1) assert.ok(rs[i - 1] >= rs[i], 'sorted desc');
});
