// Phase 4A — Projects CRUD + scoping, Task Kanban board_status<->status sync,
// per-task time tracking, scheduled-window validation. Runs against a real
// server on a throwaway database. No external services.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-projects-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

const { ensureBootstrapped } = await import('../bootstrap.js');
ensureBootstrapped();
const db = (await import('../db.js')).default;

let baseUrl;
let server;
let adminCookie;
let headACookie;
let headBCookie;
let readOnlyCookie;
let headAId;
let headBId;
let leadId;

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

before(async () => {
  const { createApp } = await import('../app.js');
  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminCookie = await loginCapture('admin', 'admin123');

  headAId = makeUser('headA', 'agent');
  headBId = makeUser('headB', 'agent');
  makeUser('ro', 'read_only');
  headACookie = await loginCapture('headA', 'pw12345');
  headBCookie = await loginCapture('headB', 'pw12345');
  readOnlyCookie = await loginCapture('ro', 'pw12345');

  const lead = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Project Lead', phone: '9876500011', assigned_to: headAId },
  });
  leadId = lead.data.id;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('read_only cannot create a project', async () => {
  const res = await api('/api/projects', {
    method: 'POST', cookie: readOnlyCookie, body: { name: 'Nope' },
  });
  assert.equal(res.status, 403);
});

test('create a project, validate budget + progress bounds', async () => {
  const badBudget = await api('/api/projects', {
    method: 'POST', cookie: adminCookie, body: { name: 'X', budget_paise: -5 },
  });
  assert.equal(badBudget.status, 400);

  const badBudget2 = await api('/api/projects', {
    method: 'POST', cookie: adminCookie, body: { name: 'X', budget_paise: 10.5 },
  });
  assert.equal(badBudget2.status, 400);

  const ok = await api('/api/projects', {
    method: 'POST', cookie: adminCookie,
    body: {
      name: 'Website Revamp', lead_id: leadId, service_type: 'web',
      budget_paise: 25000000, assigned_head_id: headAId, status: 'Working',
      progress: 130, start_date: '2026-06-16',
    },
  });
  assert.equal(ok.status, 200);
  const got = await api(`/api/projects/${ok.data.id}`, { cookie: adminCookie });
  assert.equal(got.data.budget_paise, 25000000);
  assert.equal(got.data.progress, 100, 'progress clamps to 100');
  assert.equal(got.data.lead_name, 'Project Lead');
});

test('non-admin head sees only their own projects', async () => {
  const a = await api('/api/projects', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Head A Project', assigned_head_id: headAId },
  });
  const b = await api('/api/projects', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Head B Project', assigned_head_id: headBId },
  });

  const aList = await api('/api/projects', { cookie: headACookie });
  assert.ok(aList.data.every((p) => p.assigned_head_id === headAId), 'head A only sees own');
  assert.ok(aList.data.some((p) => p.id === a.data.id));

  // Head A cannot GET head B's project.
  const cross = await api(`/api/projects/${b.data.id}`, { cookie: headACookie });
  assert.equal(cross.status, 403);

  // Admin sees both.
  const adminList = await api('/api/projects', { cookie: adminCookie });
  assert.ok(adminList.data.some((p) => p.id === a.data.id));
  assert.ok(adminList.data.some((p) => p.id === b.data.id));
});

test('agent (CREATE_PROJECT) can create; delete is admin-tier only', async () => {
  const created = await api('/api/projects', {
    method: 'POST', cookie: headACookie, body: { name: 'Agent-made', assigned_head_id: headAId },
  });
  assert.equal(created.status, 200, 'agent may create a project');

  const delByAgent = await api(`/api/projects/${created.data.id}`, {
    method: 'DELETE', cookie: headACookie,
  });
  assert.equal(delByAgent.status, 403, 'agent cannot delete');

  const delByAdmin = await api(`/api/projects/${created.data.id}`, {
    method: 'DELETE', cookie: adminCookie,
  });
  assert.equal(delByAdmin.status, 200, 'admin can delete');
});

test('board_status Done syncs legacy status to done (still complete in Today logic)', async () => {
  const t = await api('/api/tasks', {
    method: 'POST', cookie: headACookie, body: { title: 'Kanban task', lead_id: leadId },
  });
  const taskId = t.data.id;

  // Moving to Done must flip the legacy status + stamp completed_at.
  const done = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH', cookie: headACookie, body: { board_status: 'Done' },
  });
  assert.equal(done.status, 200);
  const row = db.prepare('SELECT status, board_status, completed_at FROM tasks WHERE id = ?').get(taskId);
  assert.equal(row.status, 'done');
  assert.equal(row.board_status, 'Done');
  assert.ok(row.completed_at, 'completed_at stamped');

  // Today queue (which filters status='pending') must NOT include a Done task.
  const today = await api('/api/today', { cookie: headACookie });
  assert.ok(!today.data.tasks.some((x) => x.id === taskId), 'Done task drops out of Today');

  // Drop syncs to cancelled; To Do/Doing/Review back to pending.
  const drop = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH', cookie: headACookie, body: { board_status: 'Drop' },
  });
  assert.equal(drop.status, 200);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status, 'cancelled');

  const reopen = await api(`/api/tasks/${taskId}`, {
    method: 'PATCH', cookie: headACookie, body: { board_status: 'Doing' },
  });
  assert.equal(reopen.status, 200);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status, 'pending');
});

test('legacy {status:done} PATCH still works and maps onto a board lane', async () => {
  const t = await api('/api/tasks', {
    method: 'POST', cookie: adminCookie, body: { title: 'Legacy flow' },
  });
  const done = await api(`/api/tasks/${t.data.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { status: 'done' },
  });
  assert.equal(done.status, 200);
  const row = db.prepare('SELECT status, board_status FROM tasks WHERE id = ?').get(t.data.id);
  assert.equal(row.status, 'done');
  assert.equal(row.board_status, 'Done', 'legacy done maps to the Done lane');
});

test('subtasks add / toggle / delete via PATCH', async () => {
  const t = await api('/api/tasks', { method: 'POST', cookie: headACookie, body: { title: 'With subtasks' } });
  const id = t.data.id;

  await api(`/api/tasks/${id}`, { method: 'PATCH', cookie: headACookie, body: { subtask_action: 'add', subtask_title: 'Step 1' } });
  await api(`/api/tasks/${id}`, { method: 'PATCH', cookie: headACookie, body: { subtask_action: 'add', subtask_title: 'Step 2' } });
  let got = await api(`/api/tasks/${id}`, { cookie: headACookie });
  let subs = JSON.parse(got.data.subtasks);
  assert.equal(subs.length, 2);

  await api(`/api/tasks/${id}`, { method: 'PATCH', cookie: headACookie, body: { subtask_action: 'toggle', subtask_id: subs[0].id } });
  got = await api(`/api/tasks/${id}`, { cookie: headACookie });
  subs = JSON.parse(got.data.subtasks);
  assert.equal(subs[0].completed, true);

  await api(`/api/tasks/${id}`, { method: 'PATCH', cookie: headACookie, body: { subtask_action: 'delete', subtask_id: subs[1].id } });
  got = await api(`/api/tasks/${id}`, { cookie: headACookie });
  assert.equal(JSON.parse(got.data.subtasks).length, 1);
});

test('timer start moves To Do→Doing; stop appends a time_entry and increments time_tracked', async () => {
  const t = await api('/api/tasks', { method: 'POST', cookie: headACookie, body: { title: 'Timed task' } });
  const id = t.data.id;

  const start = await api(`/api/tasks/${id}/timer/start`, { method: 'POST', cookie: headACookie });
  assert.equal(start.status, 200);
  assert.equal(start.data.board_status, 'Doing');
  assert.equal(db.prepare('SELECT board_status FROM tasks WHERE id = ?').get(id).board_status, 'Doing');

  // Stop with a start 90s in the past → a ~90s entry.
  const startIso = new Date(Date.now() - 90000).toISOString();
  const stop = await api(`/api/tasks/${id}/timer/stop`, {
    method: 'POST', cookie: headACookie, body: { start_iso: startIso },
  });
  assert.equal(stop.status, 200);
  assert.ok(stop.data.duration >= 89 && stop.data.duration <= 95, `~90s, got ${stop.data.duration}`);
  const row = db.prepare('SELECT time_tracked, time_entries FROM tasks WHERE id = ?').get(id);
  assert.equal(row.time_tracked, stop.data.duration);
  assert.equal(JSON.parse(row.time_entries).length, 1);

  // A non-positive duration (start in the future) is ignored — no new entry.
  const ignored = await api(`/api/tasks/${id}/timer/stop`, {
    method: 'POST', cookie: headACookie, body: { start_iso: new Date(Date.now() + 60000).toISOString() },
  });
  assert.equal(ignored.data.duration, 0);
  assert.equal(JSON.parse(db.prepare('SELECT time_entries FROM tasks WHERE id = ?').get(id).time_entries).length, 1);
});

test('manual time entry appends and increments', async () => {
  const t = await api('/api/tasks', { method: 'POST', cookie: headACookie, body: { title: 'Manual time' } });
  const id = t.data.id;
  const res = await api(`/api/tasks/${id}/time`, { method: 'POST', cookie: headACookie, body: { minutes: 30 } });
  assert.equal(res.status, 200);
  assert.equal(res.data.time_tracked, 1800);
  const bad = await api(`/api/tasks/${id}/time`, { method: 'POST', cookie: headACookie, body: { minutes: -5 } });
  assert.equal(bad.status, 400);
});

test('scheduled window: start must be before end', async () => {
  const t = await api('/api/tasks', { method: 'POST', cookie: headACookie, body: { title: 'Scheduled' } });
  const id = t.data.id;
  const bad = await api(`/api/tasks/${id}`, {
    method: 'PATCH', cookie: headACookie,
    body: { scheduled_start_at: '2026-06-16T12:00:00.000Z', scheduled_end_at: '2026-06-16T11:00:00.000Z' },
  });
  assert.equal(bad.status, 400);

  const ok = await api(`/api/tasks/${id}`, {
    method: 'PATCH', cookie: headACookie,
    body: { scheduled_start_at: '2026-06-16T11:00:00.000Z', scheduled_end_at: '2026-06-16T12:00:00.000Z' },
  });
  assert.equal(ok.status, 200);
});

test('non-admin cannot PATCH or time-track another user\'s task', async () => {
  const t = await api('/api/tasks', { method: 'POST', cookie: headACookie, body: { title: 'A-owned' } });
  const id = t.data.id;
  const patch = await api(`/api/tasks/${id}`, { method: 'PATCH', cookie: headBCookie, body: { board_status: 'Done' } });
  assert.equal(patch.status, 403);
  const timer = await api(`/api/tasks/${id}/timer/start`, { method: 'POST', cookie: headBCookie });
  assert.equal(timer.status, 403);
});

test('task list filters by project_id and priority', async () => {
  const proj = await api('/api/projects', {
    method: 'POST', cookie: adminCookie, body: { name: 'Filter Project', assigned_head_id: headAId },
  });
  await api('/api/tasks', {
    method: 'POST', cookie: headACookie, body: { title: 'High in project', project_id: proj.data.id, priority: 'High' },
  });
  const byProject = await api(`/api/tasks?project_id=${proj.data.id}`, { cookie: headACookie });
  assert.ok(byProject.data.length >= 1);
  assert.ok(byProject.data.every((x) => x.project_id === proj.data.id));
  const byPriority = await api(`/api/tasks?project_id=${proj.data.id}&priority=High`, { cookie: headACookie });
  assert.ok(byPriority.data.every((x) => x.priority === 'High'));
});
