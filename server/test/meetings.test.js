// Phase 5A — Meeting OS: meeting CRUD + scoping, start/end state machine, agenda
// add/reorder, roles upsert, decisions + actions, create-task-from-action (and
// from-decision), and timer-session stop adding elapsed seconds to an agenda
// item's time_spent. Runs against a real server on a throwaway database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-meetings-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

let baseUrl;
let server;
let adminCookie;
let aliceCookie; // a non-admin caller
let bobCookie; // another non-admin caller
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
  return { status: res.status, data, headers: res.headers };
};

const loginCookie = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, `login ${username} should succeed`);
  return r.headers.get('set-cookie').split(';')[0];
};

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await loginCookie('admin', 'admin123');

  const alice = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'alice_m', full_name: 'Alice Caller', password: 'secret9', role: 'caller' },
  });
  aliceId = alice.data.id;
  const bob = await api('/api/users', {
    method: 'POST', cookie: adminCookie,
    body: { username: 'bob_m', full_name: 'Bob Caller', password: 'secret9', role: 'caller' },
  });
  bobId = bob.data.id;
  aliceCookie = await loginCookie('alice_m', 'secret9');
  bobCookie = await loginCookie('bob_m', 'secret9');
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('create: defaults start to next-15 and end to start+30min', async () => {
  const r = await api('/api/meetings', {
    method: 'POST', cookie: adminCookie, body: { title: 'Defaults Meeting' },
  });
  assert.equal(r.status, 200);
  const m = await api(`/api/meetings/${r.data.id}`, { cookie: adminCookie });
  assert.equal(m.status, 200);
  const start = Date.parse(m.data.start_at);
  const end = Date.parse(m.data.end_at);
  assert.equal(end - start, 30 * 60 * 1000, 'end is 30 min after start');
  // start rounded to a 15-min boundary (in UTC the minutes are a multiple of 15).
  assert.equal(new Date(start).getUTCMinutes() % 15, 0, 'start on a 15-min boundary');
  assert.equal(new Date(start).getUTCSeconds(), 0);
  assert.equal(m.data.status, 'Scheduled');
});

test('scoping: a non-attendee cannot see or edit another owner\'s meeting', async () => {
  // Alice owns a meeting; Bob is NOT an attendee.
  const created = await api('/api/meetings', {
    method: 'POST', cookie: aliceCookie,
    body: { title: 'Alice Private', start_at: '2026-07-01T04:30:00.000Z', end_at: '2026-07-01T05:00:00.000Z' },
  });
  assert.equal(created.status, 200);
  const mid = created.data.id;

  // Alice sees it in her list; Bob does not.
  const aliceList = await api('/api/meetings', { cookie: aliceCookie });
  assert.ok(aliceList.data.some((m) => m.id === mid), 'owner sees own meeting');
  const bobList = await api('/api/meetings', { cookie: bobCookie });
  assert.ok(!bobList.data.some((m) => m.id === mid), 'non-attendee does not see it');

  // Bob is forbidden from GET / PATCH / DELETE.
  assert.equal((await api(`/api/meetings/${mid}`, { cookie: bobCookie })).status, 403);
  assert.equal((await api(`/api/meetings/${mid}`, {
    method: 'PATCH', cookie: bobCookie, body: { title: 'hijack' },
  })).status, 403);
  assert.equal((await api(`/api/meetings/${mid}`, { method: 'DELETE', cookie: bobCookie })).status, 403);

  // Admin sees + can edit everything.
  assert.equal((await api(`/api/meetings/${mid}`, { cookie: adminCookie })).status, 200);

  // Add Bob as attendee → now he can see + edit.
  const upd = await api(`/api/meetings/${mid}`, {
    method: 'PATCH', cookie: aliceCookie, body: { attendee_ids: [bobId] },
  });
  assert.equal(upd.status, 200);
  const bobNow = await api(`/api/meetings/${mid}`, { cookie: bobCookie });
  assert.equal(bobNow.status, 200, 'attendee can now see the meeting');
});

test('state machine: Scheduled → In Progress → Completed; bad transitions 409', async () => {
  const created = await api('/api/meetings', {
    method: 'POST', cookie: adminCookie, body: { title: 'Standup' },
  });
  const mid = created.data.id;

  // Cannot end a Scheduled meeting.
  assert.equal((await api(`/api/meetings/${mid}/end`, { method: 'POST', cookie: adminCookie })).status, 409);

  const start = await api(`/api/meetings/${mid}/start`, { method: 'POST', cookie: adminCookie });
  assert.equal(start.status, 200);
  assert.equal(start.data.status, 'In Progress');

  // Cannot start again.
  assert.equal((await api(`/api/meetings/${mid}/start`, { method: 'POST', cookie: adminCookie })).status, 409);

  const end = await api(`/api/meetings/${mid}/end`, { method: 'POST', cookie: adminCookie });
  assert.equal(end.status, 200);
  assert.equal(end.data.status, 'Completed');
});

test('agenda: add, then reorder by id list', async () => {
  const created = await api('/api/meetings', {
    method: 'POST', cookie: adminCookie, body: { title: 'Planning' },
  });
  const mid = created.data.id;

  const a = await api(`/api/meetings/${mid}/agenda`, {
    method: 'POST', cookie: adminCookie, body: { title: 'Intro', duration: 5 },
  });
  const b = await api(`/api/meetings/${mid}/agenda`, {
    method: 'POST', cookie: adminCookie, body: { title: 'Deep dive', duration: 20 },
  });
  const c = await api(`/api/meetings/${mid}/agenda`, {
    method: 'POST', cookie: adminCookie, body: { title: 'Wrap', duration: 10 },
  });
  assert.ok(a.data.id && b.data.id && c.data.id);

  let detail = await api(`/api/meetings/${mid}`, { cookie: adminCookie });
  assert.deepEqual(detail.data.agenda.map((x) => x.title), ['Intro', 'Deep dive', 'Wrap']);

  // Reverse order.
  const reorder = await api(`/api/meetings/${mid}/agenda/reorder`, {
    method: 'POST', cookie: adminCookie, body: { order: [c.data.id, b.data.id, a.data.id] },
  });
  assert.equal(reorder.status, 200);
  detail = await api(`/api/meetings/${mid}`, { cookie: adminCookie });
  assert.deepEqual(detail.data.agenda.map((x) => x.title), ['Wrap', 'Deep dive', 'Intro']);
});

test('roles: upsert is one row per meeting', async () => {
  const created = await api('/api/meetings', {
    method: 'POST', cookie: adminCookie, body: { title: 'Roles Meeting', attendee_ids: [aliceId, bobId] },
  });
  const mid = created.data.id;
  await api(`/api/meetings/${mid}/roles`, {
    method: 'PUT', cookie: adminCookie, body: { facilitator_id: aliceId, scribe_id: bobId },
  });
  await api(`/api/meetings/${mid}/roles`, {
    method: 'PUT', cookie: adminCookie, body: { decision_maker_id: aliceId },
  });
  const detail = await api(`/api/meetings/${mid}`, { cookie: adminCookie });
  assert.ok(detail.data.roles, 'roles row exists');
  assert.equal(detail.data.roles.facilitator_id, aliceId, 'facilitator preserved across upsert');
  assert.equal(detail.data.roles.scribe_id, bobId);
  assert.equal(detail.data.roles.decision_maker_id, aliceId);
});

test('create-task-from-action: inserts task with origin + meeting_id, shows for assignee + Today', async () => {
  // Alice owns a meeting due today (IST) with an action assigned to her.
  const todayIstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const dueAt = new Date(`${todayIstDate}T08:00:00.000Z`).toISOString(); // mid-IST-day instant
  const created = await api('/api/meetings', {
    method: 'POST', cookie: aliceCookie, body: { title: 'Action Meeting', end_at: dueAt, start_at: new Date(Date.parse(dueAt) - 1800000).toISOString() },
  });
  const mid = created.data.id;
  const act = await api(`/api/meetings/${mid}/actions`, {
    method: 'POST', cookie: aliceCookie,
    body: { title: 'Email the deck', owner_id: aliceId, due_at: dueAt },
  });
  assert.equal(act.status, 200);

  const conv = await api(`/api/meetings/${mid}/actions/${act.data.id}/to-task`, {
    method: 'POST', cookie: aliceCookie,
  });
  assert.equal(conv.status, 200);
  assert.ok(conv.data.task_id, 'task created');

  // The action is now linked to the task.
  const detail = await api(`/api/meetings/${mid}`, { cookie: aliceCookie });
  assert.equal(detail.data.actions.find((x) => x.id === act.data.id).task_id, conv.data.task_id);

  // The task carries origin + meeting_id and is assigned to Alice.
  const task = await api(`/api/tasks/${conv.data.task_id}`, { cookie: aliceCookie });
  assert.equal(task.status, 200);
  assert.equal(task.data.origin, 'meeting_action');
  assert.equal(task.data.meeting_id, mid);
  assert.equal(task.data.assigned_to, aliceId);
  assert.equal(task.data.board_status, 'To Do');
  assert.equal(task.data.status, 'pending');
  assert.equal(task.data.due_date, todayIstDate, 'due_date is the IST date of due_at');

  // Shows in Alice's task list and Today queue.
  const list = await api('/api/tasks', { cookie: aliceCookie });
  assert.ok(list.data.some((t) => t.id === conv.data.task_id), 'in assignee task list');
  const today = await api('/api/today', { cookie: aliceCookie });
  assert.ok(today.data.tasks.some((t) => t.id === conv.data.task_id), 'in assignee Today queue');

  // Re-converting is idempotent (returns the same task).
  const again = await api(`/api/meetings/${mid}/actions/${act.data.id}/to-task`, {
    method: 'POST', cookie: aliceCookie,
  });
  assert.equal(again.data.task_id, conv.data.task_id);
  assert.equal(again.data.already, true);
});

test('create-task-from-decision: inserts a meeting_action-origin task', async () => {
  const created = await api('/api/meetings', {
    method: 'POST', cookie: adminCookie, body: { title: 'Decision Meeting' },
  });
  const mid = created.data.id;
  const dec = await api(`/api/meetings/${mid}/decisions`, {
    method: 'POST', cookie: adminCookie,
    body: { title: 'Adopt new pricing', rationale: 'margins', owner_id: aliceId },
  });
  assert.equal(dec.status, 200);
  const conv = await api(`/api/meetings/${mid}/decisions/${dec.data.id}/to-task`, {
    method: 'POST', cookie: adminCookie,
  });
  assert.equal(conv.status, 200);
  const task = await api(`/api/tasks/${conv.data.task_id}`, { cookie: aliceCookie });
  assert.equal(task.data.origin, 'meeting_action');
  assert.equal(task.data.meeting_id, mid);
  assert.match(task.data.title, /^Decision: /);

  // Idempotent: a repeat click/retry reuses the same task instead of duplicating.
  const again = await api(`/api/meetings/${mid}/decisions/${dec.data.id}/to-task`, {
    method: 'POST', cookie: adminCookie,
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.task_id, conv.data.task_id);
  assert.equal(again.data.already, true);
});

test('timer session stop adds elapsed seconds to the agenda item time_spent', async () => {
  const created = await api('/api/meetings', {
    method: 'POST', cookie: adminCookie, body: { title: 'Timed Meeting' },
  });
  const mid = created.data.id;
  const item = await api(`/api/meetings/${mid}/agenda`, {
    method: 'POST', cookie: adminCookie, body: { title: 'Topic', duration: 10 },
  });
  const sess = await api(`/api/meetings/${mid}/timer/start`, {
    method: 'POST', cookie: adminCookie, body: { agenda_item_id: item.data.id },
  });
  assert.equal(sess.status, 200);

  const stop = await api(`/api/meetings/${mid}/timer/${sess.data.id}/stop`, {
    method: 'POST', cookie: adminCookie, body: { elapsed_seconds: 125 },
  });
  assert.equal(stop.status, 200);
  assert.equal(stop.data.duration, 125);
  assert.equal(stop.data.agenda_time_spent, 125, 'agenda time_spent bumped by elapsed');

  // A second session adds on top.
  const sess2 = await api(`/api/meetings/${mid}/timer/start`, {
    method: 'POST', cookie: adminCookie, body: { agenda_item_id: item.data.id },
  });
  const stop2 = await api(`/api/meetings/${mid}/timer/${sess2.data.id}/stop`, {
    method: 'POST', cookie: adminCookie, body: { elapsed_seconds: 75 },
  });
  assert.equal(stop2.data.agenda_time_spent, 200, 'accumulates across sessions');

  // Idempotent stop: re-stopping an already-Stopped session must NOT re-add time.
  const restop = await api(`/api/meetings/${mid}/timer/${sess2.data.id}/stop`, {
    method: 'POST', cookie: adminCookie, body: { elapsed_seconds: 75 },
  });
  assert.equal(restop.status, 200);
  assert.equal(restop.data.already, true);
  assert.equal(restop.data.agenda_time_spent, 200, 're-stop does not double-count');

  // Persisted on the agenda item.
  const detail = await api(`/api/meetings/${mid}`, { cookie: adminCookie });
  assert.equal(detail.data.agenda.find((x) => x.id === item.data.id).time_spent, 200);
  assert.ok(detail.data.timer_sessions.length >= 2);
});

test('delete cascades agenda / roles / decisions / actions / timer sessions', async () => {
  const created = await api('/api/meetings', {
    method: 'POST', cookie: adminCookie, body: { title: 'Doomed', attendee_ids: [aliceId] },
  });
  const mid = created.data.id;
  await api(`/api/meetings/${mid}/agenda`, { method: 'POST', cookie: adminCookie, body: { title: 'X' } });
  await api(`/api/meetings/${mid}/roles`, { method: 'PUT', cookie: adminCookie, body: { facilitator_id: aliceId } });
  await api(`/api/meetings/${mid}/decisions`, { method: 'POST', cookie: adminCookie, body: { title: 'D' } });
  await api(`/api/meetings/${mid}/actions`, { method: 'POST', cookie: adminCookie, body: { title: 'A' } });

  const del = await api(`/api/meetings/${mid}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(del.status, 200);
  assert.equal((await api(`/api/meetings/${mid}`, { cookie: adminCookie })).status, 404);

  // Child rows gone (verified via the DB directly).
  const dbMod = (await import('../db.js')).default;
  for (const tbl of ['meeting_agenda', 'meeting_roles', 'meeting_decisions', 'meeting_actions', 'meeting_timer_sessions']) {
    const n = dbMod.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE meeting_id = ?`).get(mid).n;
    assert.equal(n, 0, `${tbl} rows cascaded`);
  }
});

test('current-work surfaces an active meeting for owner and attendee', async () => {
  // A meeting whose window contains now, owned by Alice with Bob as attendee.
  const now = Date.now();
  const created = await api('/api/meetings', {
    method: 'POST', cookie: aliceCookie,
    body: {
      title: 'Live Now',
      start_at: new Date(now - 5 * 60 * 1000).toISOString(),
      end_at: new Date(now + 25 * 60 * 1000).toISOString(),
      attendee_ids: [bobId],
    },
  });
  assert.equal(created.status, 200);
  await api(`/api/meetings/${created.data.id}/start`, { method: 'POST', cookie: aliceCookie });

  // These fresh users have no other active scheduled items, so the soonest-
  // ending active candidate is this meeting.
  const ownerCw = await api('/api/current-work', { cookie: aliceCookie });
  assert.ok(ownerCw.data.active_count >= 1, 'owner has an active item');
  assert.equal(ownerCw.data.current.kind, 'meeting');
  assert.equal(ownerCw.data.current.id, created.data.id);
  assert.equal(ownerCw.data.current.link, `/meetings/${created.data.id}`);

  const attendeeCw = await api('/api/current-work', { cookie: bobCookie });
  assert.ok(attendeeCw.data.active_count >= 1, 'attendee has an active item');
  assert.equal(attendeeCw.data.current.kind, 'meeting');
  assert.equal(attendeeCw.data.current.id, created.data.id);
});
