// Phase 4B — scheduling: detectConflicts unit cases + time-block/task conflict
// 409s + GET /api/current-work. Real server on a throwaway DB. No externals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-schedule-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

const { ensureBootstrapped } = await import('../bootstrap.js');
ensureBootstrapped();
const db = (await import('../db.js')).default;
const { detectConflicts, intervalsOverlap } = await import('../lib/schedule.js');
const { nowUtc, IST_OFFSET_MS } = await import('../lib/istTime.js');

let baseUrl;
let server;
let adminCookie;
let aliceCookie;
let bobCookie;
let aliceId;
let bobId;

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

async function loginCapture(username, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  return res.headers.get('set-cookie').split(';')[0];
}

function makeUser(username, role) {
  const bcrypt = require('bcryptjs');
  return db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(username, bcrypt.hashSync('pw12345', 8), username, role, new Date().toISOString()).lastInsertRowid;
}

// Insert a time block directly (bypasses the conflict-checked route).
function insertBlock(ownerId, blockDate, startAt, endAt, blockType = 'Deep Work') {
  return db.prepare(
    `INSERT INTO time_blocks (title, block_date, start_at, end_at, block_type, owner_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('Block', blockDate, startAt, endAt, blockType, ownerId, nowUtc()).lastInsertRowid;
}

before(async () => {
  const { createApp } = await import('../app.js');
  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminCookie = await loginCapture('admin', 'admin123');
  aliceId = makeUser('alice', 'agent');
  bobId = makeUser('bob', 'agent');
  aliceCookie = await loginCapture('alice', 'pw12345');
  bobCookie = await loginCapture('bob', 'pw12345');
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- pure interval helper ----
test('intervalsOverlap: half-open, touching edges do not overlap', () => {
  assert.equal(intervalsOverlap('2026-06-16T10:00:00Z', '2026-06-16T11:00:00Z',
    '2026-06-16T10:30:00Z', '2026-06-16T11:30:00Z'), true);
  // touching: A ends exactly when B starts
  assert.equal(intervalsOverlap('2026-06-16T10:00:00Z', '2026-06-16T11:00:00Z',
    '2026-06-16T11:00:00Z', '2026-06-16T12:00:00Z'), false);
});

// ---- detectConflicts unit cases (against time_blocks) ----
test('detectConflicts: overlap vs non-overlap vs different-day vs owner vs exclude-self', () => {
  // Alice has a block 10:00-11:00 UTC on 2026-06-16 (IST 2026-06-16).
  const blockId = insertBlock(aliceId, '2026-06-16',
    '2026-06-16T10:00:00.000Z', '2026-06-16T11:00:00.000Z');

  // Overlapping candidate → conflict.
  let c = detectConflicts(db, {
    ownerId: aliceId, startAt: '2026-06-16T10:30:00.000Z', endAt: '2026-06-16T11:30:00.000Z',
  });
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'time_block');
  assert.equal(c[0].id, blockId);

  // Non-overlapping (after) → no conflict.
  c = detectConflicts(db, {
    ownerId: aliceId, startAt: '2026-06-16T11:00:00.000Z', endAt: '2026-06-16T12:00:00.000Z',
  });
  assert.equal(c.length, 0);

  // Different IST day → no conflict.
  c = detectConflicts(db, {
    ownerId: aliceId, startAt: '2026-06-17T10:30:00.000Z', endAt: '2026-06-17T11:30:00.000Z',
  });
  assert.equal(c.length, 0);

  // Different owner (Bob) → no conflict.
  c = detectConflicts(db, {
    ownerId: bobId, startAt: '2026-06-16T10:30:00.000Z', endAt: '2026-06-16T11:30:00.000Z',
  });
  assert.equal(c.length, 0);

  // Exclude self (editing the same block) → no conflict.
  c = detectConflicts(db, {
    ownerId: aliceId, startAt: '2026-06-16T10:30:00.000Z', endAt: '2026-06-16T11:30:00.000Z',
    excludeBlockId: blockId,
  });
  assert.equal(c.length, 0);
});

// ---- cross-IST-midnight overlap (regression): a window that STARTS on the
// previous IST day but ENDS inside the candidate's IST day must still conflict.
test('detectConflicts: cross-IST-midnight block is not silently skipped', () => {
  // Carol has a block IST 2026-07-01 23:30 → 2026-07-02 00:30.
  // IST 23:30 on 2026-07-01 == 18:00:00Z; IST 00:30 on 2026-07-02 == 19:00:00Z.
  const carolId = makeUser('carol', 'agent');
  const blockId = insertBlock(carolId, '2026-07-01',
    '2026-07-01T18:00:00.000Z', '2026-07-01T19:00:00.000Z');

  // Candidate IST 2026-07-02 00:00 → 01:00 (18:30:00Z → 19:30:00Z). Its IST day
  // is 2026-07-02; the block's start instant is on IST 2026-07-01, so the old
  // start-instant day filter would have skipped it. The windows overlap.
  const c = detectConflicts(db, {
    ownerId: carolId,
    startAt: '2026-07-01T18:30:00.000Z',
    endAt: '2026-07-01T19:30:00.000Z',
  });
  assert.equal(c.length, 1, 'cross-midnight block must conflict');
  assert.equal(c[0].kind, 'time_block');
  assert.equal(c[0].id, blockId);
});

// Same cross-midnight case but for a SCHEDULED TASK window.
test('detectConflicts: cross-IST-midnight task window is not silently skipped', () => {
  const daveId = makeUser('dave', 'agent');
  // Task scheduled IST 2026-07-03 23:30 → 2026-07-04 00:30 (18:00Z → 19:00Z).
  const taskId = db.prepare(
    `INSERT INTO tasks (title, status, board_status, assigned_to, created_by,
                        due_date, scheduled_start_at, scheduled_end_at, created_at)
     VALUES (?, 'pending', 'To Do', ?, ?, ?, ?, ?, ?)`
  ).run('Overnight task', daveId, daveId, '2026-07-04',
    '2026-07-03T18:00:00.000Z', '2026-07-03T19:00:00.000Z', nowUtc()).lastInsertRowid;

  // Candidate on the NEXT IST day overlapping the tail of that window.
  const c = detectConflicts(db, {
    ownerId: daveId,
    startAt: '2026-07-03T18:30:00.000Z',
    endAt: '2026-07-03T19:30:00.000Z',
  });
  assert.equal(c.length, 1, 'cross-midnight task must conflict');
  assert.equal(c[0].kind, 'task');
  assert.equal(c[0].id, taskId);
});

// ---- time-block create 409 / 200 ----
test('time block create: 409 on conflict, 200 otherwise', async () => {
  // Alice books a clean afternoon block.
  const first = await api('/api/time-blocks', {
    method: 'POST', cookie: aliceCookie,
    body: {
      title: 'Deep work', block_type: 'Deep Work',
      start_at: '2026-06-20T08:00:00.000Z', end_at: '2026-06-20T09:00:00.000Z',
    },
  });
  assert.equal(first.status, 200);

  // Overlapping second block → 409 with a message.
  const clash = await api('/api/time-blocks', {
    method: 'POST', cookie: aliceCookie,
    body: {
      title: 'Calls', start_at: '2026-06-20T08:30:00.000Z', end_at: '2026-06-20T09:30:00.000Z',
    },
  });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /Conflict/i);

  // Adjacent (touching) block → fine.
  const ok = await api('/api/time-blocks', {
    method: 'POST', cookie: aliceCookie,
    body: {
      title: 'Next', start_at: '2026-06-20T09:00:00.000Z', end_at: '2026-06-20T10:00:00.000Z',
    },
  });
  assert.equal(ok.status, 200);

  // Bob booking the same wall-clock window → no conflict (different owner).
  const bobOk = await api('/api/time-blocks', {
    method: 'POST', cookie: bobCookie,
    body: {
      title: 'Bob deep work', start_at: '2026-06-20T08:30:00.000Z', end_at: '2026-06-20T09:30:00.000Z',
    },
  });
  assert.equal(bobOk.status, 200);
});

// ---- task scheduled-window conflict vs a time block ----
test('task scheduled window conflicting with a block is rejected (409)', async () => {
  // Alice has a block 2026-06-21 06:00-07:00 UTC.
  await api('/api/time-blocks', {
    method: 'POST', cookie: aliceCookie,
    body: { title: 'Morning block', start_at: '2026-06-21T06:00:00.000Z', end_at: '2026-06-21T07:00:00.000Z' },
  });
  const t = await api('/api/tasks', { method: 'POST', cookie: aliceCookie, body: { title: 'Schedule me' } });

  const clash = await api(`/api/tasks/${t.data.id}`, {
    method: 'PATCH', cookie: aliceCookie,
    body: { scheduled_start_at: '2026-06-21T06:30:00.000Z', scheduled_end_at: '2026-06-21T07:30:00.000Z' },
  });
  assert.equal(clash.status, 409);

  // A free window → accepted.
  const ok = await api(`/api/tasks/${t.data.id}`, {
    method: 'PATCH', cookie: aliceCookie,
    body: { scheduled_start_at: '2026-06-21T09:00:00.000Z', scheduled_end_at: '2026-06-21T10:00:00.000Z' },
  });
  assert.equal(ok.status, 200);
});

// ---- current-work ----
test('GET /api/current-work returns the active scheduled task', async () => {
  const now = Date.now();
  const startAt = new Date(now - 5 * 60 * 1000).toISOString(); // started 5m ago
  const endAt = new Date(now + 55 * 60 * 1000).toISOString(); // ends in 55m

  const t = await api('/api/tasks', { method: 'POST', cookie: bobCookie, body: { title: 'Live task' } });
  const sched = await api(`/api/tasks/${t.data.id}`, {
    method: 'PATCH', cookie: bobCookie,
    body: { scheduled_start_at: startAt, scheduled_end_at: endAt, board_status: 'Doing' },
  });
  assert.equal(sched.status, 200);

  const cw = await api('/api/current-work', { cookie: bobCookie });
  assert.equal(cw.status, 200);
  assert.ok(cw.data.current, 'a current item exists');
  assert.equal(cw.data.current.kind, 'task');
  assert.equal(cw.data.current.id, t.data.id);

  // Alice (no live item right now) gets null.
  const aliceCw = await api('/api/current-work', { cookie: aliceCookie });
  assert.equal(aliceCw.status, 200);
  // Alice may or may not have a live item depending on wall clock; just assert shape.
  assert.ok('current' in aliceCw.data);
});

test('GET /api/current-work surfaces an active overnight block that started before today (IST)', async () => {
  // Item 3a regression: a block whose start_at is BEFORE today's IST midnight but
  // is genuinely active now (start_at <= now < end_at) must still surface. We tag
  // its block_date as YESTERDAY (IST) so any stale "start within today's IST day"
  // bound would have wrongly excluded it.
  const now = Date.now();
  const startAt = new Date(now - 3 * 60 * 60 * 1000).toISOString(); // started 3h ago
  const endAt = new Date(now + 3 * 60 * 60 * 1000).toISOString(); // ends in 3h
  const istYesterday = new Date(now + IST_OFFSET_MS - 86_400_000).toISOString().slice(0, 10);

  // Use a fresh owner with no other live items so `current` is unambiguous.
  const owlId = makeUser('owl', 'agent');
  const owlCookie = await loginCapture('owl', 'pw12345');
  const blockId = insertBlock(owlId, istYesterday, startAt, endAt, 'Out of Office');

  const cw = await api('/api/current-work', { cookie: owlCookie });
  assert.equal(cw.status, 200);
  assert.ok(cw.data.current, 'the active overnight block is current');
  assert.equal(cw.data.current.kind, 'time_block');
  assert.equal(cw.data.current.id, blockId);
  assert.equal(cw.data.active_count, 1, 'exactly one active item, and the field is named active_count');
});
