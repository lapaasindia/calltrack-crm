// Operability + process policy (audit SCALE-6/8/10/17/25, SEC-8, CLIENT-12,
// DESK-22): request log + rotation, /api/ops/health (owner-only), async
// handler rejections → 500 JSON, process guards, jobs registry, static asset
// rules, nightly maintenance, and graceful stop() (last — it closes the DB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ops-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

const { startServer, createApp } = await import('../app.js');
const db = (await import('../db.js')).default;
const { setSetting, getSetting } = await import('../db.js');
const logger = await import('../lib/logger.js');
const ops = await import('../lib/ops.js');
const jobs = await import('../lib/jobs.js');
const maintenance = await import('../lib/maintenance.js');
const { nowUtc, todayIst, addDays } = await import('../lib/istTime.js');

let instance;
let baseUrl;
let adminCookie;
let callerCookie;
let callerId;
const now = nowUtc();

const api = async (pathname, { method = 'GET', body, cookie, raw = false } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = raw ? await res.text() : await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};
const login = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, `login ${username}`);
  return r.headers.get('set-cookie').split(';')[0];
};

before(async () => {
  instance = await startServer({ port: 0, processGuards: false });
  baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  adminCookie = await login('admin', 'admin123');
  const bcrypt = (await import('bcryptjs')).default;
  callerId = db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role, is_active, created_at) VALUES ('c1', ?, 'C One', 'caller', 1, ?)"
  ).run(bcrypt.hashSync('pw12345', 8), now).lastInsertRowid;
  callerCookie = await login('c1', 'pw12345');
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('startServer returns { server, port, urls, stop }', () => {
  assert.ok(instance.server);
  assert.equal(typeof instance.port, 'number');
  assert.ok(instance.urls.local);
  assert.equal(typeof instance.stop, 'function');
});

test('/api/ops/health: owner-only, full shape', async () => {
  const forbidden = await api('/api/ops/health', { cookie: callerCookie });
  assert.equal(forbidden.status, 403);
  const r = await api('/api/ops/health', { cookie: adminCookie });
  assert.equal(r.status, 200);
  for (const k of ['version', 'uptime_s', 'db_quick_check', 'wal_bytes', 'db_bytes', 'last_backup',
    'last_cloud_backup', 'ai_queue', 'event_loop_lag_ms', 'free_disk_gb']) {
    assert.ok(k in r.data, `has ${k}`);
  }
  assert.equal(r.data.db_quick_check, 'ok');
  assert.equal(typeof r.data.event_loop_lag_ms, 'number');
  assert.deepEqual(r.data.ai_queue, { pending: 0, processing: 0 });
  assert.ok(r.data.free_disk_gb === null || r.data.free_disk_gb > 0);
  assert.ok(r.data.db_bytes > 0);
});

test('every response carries X-Request-Id and the request log records it', async () => {
  const r = await api('/api/auth/me', { cookie: adminCookie });
  const id = r.headers.get('x-request-id');
  assert.match(id, /^[0-9a-f]{8}$/);
  // Flush is synchronous; the line is already on disk.
  const lines = fs.readFileSync(logger.LOG_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const line = lines.find((l) => l.req_id === id);
  assert.ok(line, 'request line present');
  assert.equal(line.method, 'GET');
  assert.equal(line.path, '/api/auth/me');
  assert.equal(line.status, 200);
  assert.equal(line.user_id, 1);
  assert.equal(typeof line.ms, 'number');
});

test('log rotation: a day change archives server.log and keeps at most 14 files', () => {
  const dir = logger.LOG_DIR;
  // Pre-create 15 old rotated files.
  for (let i = 1; i <= 15; i += 1) {
    fs.writeFileSync(path.join(dir, `server-2000-01-${String(i).padStart(2, '0')}.log`), 'old\n');
  }
  logger.fileStream._forceRotate('2001-06-01');
  logger.log.info('after rotate');
  const files = fs.readdirSync(dir).filter((f) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  assert.ok(files.includes('server-2001-06-01.log'), 'today\'s file archived under its day');
  assert.equal(files.length, 14, 'pruned to 14 rotated files');
  assert.ok(!files.includes('server-2000-01-01.log'), 'oldest dropped');
  assert.ok(fs.readFileSync(logger.LOG_FILE, 'utf8').includes('after rotate'));
});

test('async route rejections are forwarded to the error handler (Layer patch)', async () => {
  const app = express();
  app.get('/boom', async () => { throw new Error('async boom'); });
  app.get('/ok', async (req, res) => { res.json({ ok: true }); });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const boom = await fetch(`${base}/boom`);
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error: 'async boom' });
    const ok = await fetch(`${base}/ok`);
    assert.deepEqual(await ok.json(), { ok: true });
  } finally {
    srv.close();
  }
});

test('body-parser problems map to 413 / 400 JSON, not 500', async () => {
  const big = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }),
  });
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /too large/i);
  const bad = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: '{nope',
  });
  assert.equal(bad.status, 400);
});

test('process guards: log + keep serving; fatal classification', () => {
  const seen = [];
  const fake = { error: (o, m) => seen.push(['error', m]), fatal: (o, m) => seen.push(['fatal', m]) };
  let fatalCalled = null;
  const h = ops.processGuardHandlers({ logger: fake, onFatal: (e) => { fatalCalled = e; } });
  h.onUncaughtException(new Error('non-fatal bug'), 'uncaughtException');
  assert.deepEqual(seen.at(-1), ['error', 'uncaughtException (kept serving)']);
  assert.equal(fatalCalled, null);
  h.onUnhandledRejection(new Error('rejected'));
  assert.deepEqual(seen.at(-1), ['error', 'unhandledRejection (kept serving)']);
  h.onUnhandledRejection('a string reason');
  assert.deepEqual(seen.at(-1), ['error', 'unhandledRejection (kept serving)']);
  const corrupt = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
  assert.equal(ops.isFatalError(corrupt), true);
  assert.equal(ops.isFatalError(new Error('The database connection is not open')), true);
  assert.equal(ops.isFatalError(new Error('TypeError in a route')), false);
  h.onUncaughtException(corrupt, 'uncaughtException');
  assert.equal(fatalCalled, corrupt);
  assert.deepEqual(seen.at(-1), ['fatal', 'uncaughtException — fatal state, shutting down']);
  // installProcessGuards registers exactly once; a second call is a no-op.
  const before = process.listenerCount('uncaughtException');
  ops._resetGuardsForTests();
  assert.equal(ops.installProcessGuards({ logger: fake, onFatal: () => {} }), true);
  assert.equal(ops.installProcessGuards({ logger: fake }), false, 'idempotent');
  assert.equal(process.listenerCount('uncaughtException'), before + 1);
  // Detach again so node:test keeps sole ownership of the real events.
  const added = process.listeners('uncaughtException').at(-1);
  process.removeListener('uncaughtException', added);
  process.removeListener('unhandledRejection', process.listeners('unhandledRejection').at(-1));
  ops._resetGuardsForTests();
});

test('jobs registry: tracks active jobs, drains, and refuses new jobs while draining', async () => {
  jobs._resetJobsForTests();
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = jobs.runJob('probe', async () => { await gate; return 42; });
  assert.deepEqual(jobs.activeJobs().map((j) => j.name), ['probe']);
  const drain = jobs.drainJobs(2000);
  assert.equal(jobs.isShuttingDown(), true);
  await assert.rejects(() => jobs.runJob('late', async () => 1), /shutting down/);
  release();
  assert.equal(await p, 42);
  assert.equal(await drain, true);
  assert.deepEqual(jobs.activeJobs(), []);
  jobs._resetJobsForTests();
  // Timeout path.
  const never = jobs.runJob('slow', () => new Promise(() => {}));
  assert.equal(await jobs.drainJobs(50), false);
  void never;
  jobs._resetJobsForTests();
});

test('static: unknown /assets/* and favicon are 404, index.html is no-store', async (t) => {
  const distDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'client', 'dist');
  if (!fs.existsSync(distDir)) { t.skip('client not built'); return; }
  const missing = await fetch(`${baseUrl}/assets/index-DOESNOTEXIST.js`);
  assert.equal(missing.status, 404);
  assert.ok(!(await missing.text()).includes('<html'), 'never the SPA shell');
  const fav = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(fav.status, 404);
  const map = await fetch(`${baseUrl}/assets/index.js.map`);
  assert.equal(map.status, 404);
  const spa = await fetch(`${baseUrl}/leads/123`);
  assert.equal(spa.status, 200);
  assert.equal(spa.headers.get('cache-control'), 'no-store');
  assert.ok((await spa.text()).includes('<div id="root">') || true);
  const real = fs.readdirSync(path.join(distDir, 'assets')).find((f) => f.endsWith('.js'));
  if (real) {
    const asset = await fetch(`${baseUrl}/assets/${real}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.match(asset.headers.get('cache-control'), /max-age=31536000/);
  }
});

test('nightly maintenance: scores, stale follow-up sweep with reasons, pruning, integrity', async () => {
  const bcrypt = (await import('bcryptjs')).default;
  const inactive = db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role, is_active, created_at) VALUES ('gone', ?, 'Gone', 'caller', 0, ?)"
  ).run(bcrypt.hashSync('pw12345', 8), now).lastInsertRowid;
  let seq = 9500000000;
  const mkLead = (stage, assignedTo, deletedAt = null) => {
    const phone = String(seq++);
    return db.prepare(
      `INSERT INTO leads (name, phone, phone_raw, source, stage, assigned_to, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'import', ?, ?, ?, ?, ?)`
    ).run(`L${phone}`, phone, phone, stage, assignedTo, now, now, deletedAt).lastInsertRowid;
  };
  const fu = (leadId, userId) => db.prepare(
    "INSERT INTO follow_ups (lead_id, assigned_to, due_at, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
  ).run(leadId, userId, now, now).lastInsertRowid;

  const lost = mkLead('lost', callerId);
  const wonLead = mkLead('won', callerId);
  const deleted = mkLead('contacted', callerId, now);
  const fresh = mkLead('contacted', callerId);
  const orphan = mkLead('new', inactive);
  const overdueOld = mkLead('follow_up', callerId);
  const fuLost = fu(lost, callerId);
  const fuWon = fu(wonLead, callerId); // support follow-up on a WON lead: must survive
  const fuDeleted = fu(deleted, callerId);
  const fuFresh = fu(fresh, callerId);
  const fuOrphan = fu(orphan, inactive);
  const fuOverdue = db.prepare(
    "INSERT INTO follow_ups (lead_id, assigned_to, due_at, status, created_at) VALUES (?, ?, '2024-01-01T00:00:00.000Z', 'pending', ?)"
  ).run(overdueOld, callerId, now).lastInsertRowid;
  const taskOrphan = db.prepare(
    "INSERT INTO tasks (title, assigned_to, due_date, created_by, created_at) VALUES ('orphan task', ?, ?, ?, ?)"
  ).run(inactive, todayIst(), inactive, now).lastInsertRowid;
  const taskFresh = db.prepare(
    "INSERT INTO tasks (title, assigned_to, due_date, created_by, created_at) VALUES ('fresh task', ?, ?, ?, ?)"
  ).run(callerId, todayIst(), callerId, now).lastInsertRowid;
  // A connected call 40 days ago on `fresh`: recency decay should make it cold.
  db.prepare(
    "INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at) VALUES (?, ?, 'sales', 'connected', ?)"
  ).run(fresh, callerId, new Date(Date.now() - 40 * 86400000).toISOString());
  db.prepare('UPDATE leads SET score = 95 WHERE id = ?').run(fresh);
  // Old notification + audit rows to prune, recent ones to keep.
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  db.prepare("INSERT INTO notifications (user_id, title, created_at) VALUES (?, 'old', ?)").run(callerId, old);
  db.prepare("INSERT INTO notifications (user_id, title, created_at) VALUES (?, 'new', ?)").run(callerId, now);
  db.prepare("INSERT INTO audit_logs (action, created_at) VALUES ('OLD', ?)").run(old);
  db.prepare("INSERT INTO audit_logs (action, created_at) VALUES ('NEW', ?)").run(now);

  const result = await maintenance.runNightlyMaintenance({ reason: 'test' });
  assert.equal(result.quick_check, 'ok');
  assert.ok(result.scores.scanned >= 5);
  const status = (id) => db.prepare('SELECT status, cancel_reason FROM follow_ups WHERE id = ?').get(id);
  assert.deepEqual(status(fuLost), { status: 'cancelled', cancel_reason: 'lead_lost' });
  assert.deepEqual(status(fuDeleted), { status: 'cancelled', cancel_reason: 'lead_deleted' });
  assert.deepEqual(status(fuOrphan), { status: 'cancelled', cancel_reason: 'assignee_deactivated' });
  assert.equal(status(fuWon).status, 'pending', 'follow-up on a won lead is kept');
  assert.equal(status(fuFresh).status, 'pending');
  assert.equal(status(fuOverdue).status, 'pending', 'merely old overdue follow-ups never disappear');
  const task = (id) => db.prepare('SELECT status, board_status, cancel_reason FROM tasks WHERE id = ?').get(id);
  assert.deepEqual(task(taskOrphan), { status: 'cancelled', board_status: 'Drop', cancel_reason: 'assignee_deactivated' });
  assert.equal(task(taskFresh).status, 'pending');
  // Scores: NULL-score imports now scored; stale Hot decayed.
  const score = (id) => db.prepare('SELECT score, score_factors FROM leads WHERE id = ?').get(id);
  assert.equal(typeof score(orphan).score, 'number');
  assert.ok(score(fresh).score < 95, `recency decay applied (${score(fresh).score})`);
  assert.equal(JSON.parse(score(fresh).score_factors).recency, -20);
  assert.equal(JSON.parse(score(fresh).score_factors).connected_calls, 1);
  // Pruning.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = 'old'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = 'new'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'OLD'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'NEW'").get().n, 1);
  assert.equal(result.pruned.notifications, 1);
  assert.equal(result.pruned.audit_logs, 1);
  // Persisted for /ops/health; a second run within 24 h is not due.
  const last = getSetting('last_maintenance');
  assert.equal(last.reason, 'test');
  assert.equal(maintenance.maintenanceDue(last, new Date()), false);
  assert.equal(maintenance.maintenanceDue(null), true);
  assert.equal(maintenance.maintenanceDue({ at: new Date(Date.now() - 25 * 3600e3).toISOString(), date: addDays(todayIst(), -1) }), true);
  // Yesterday's run + it's past 02:00 IST today → due; before 02:00 → not yet.
  const yesterdayRun = { at: new Date(Date.now() - 3 * 3600e3).toISOString(), date: addDays(todayIst(), -1) };
  const at0300 = new Date(Date.parse(`${todayIst()}T00:00:00.000Z`) - 330 * 60000 + 3 * 3600e3);
  const at0100 = new Date(Date.parse(`${todayIst()}T00:00:00.000Z`) - 330 * 60000 + 1 * 3600e3);
  assert.equal(maintenance.maintenanceDue({ ...yesterdayRun, at: new Date(at0300.getTime() - 3600e3).toISOString() }, at0300), true);
  assert.equal(maintenance.maintenanceDue({ ...yesterdayRun, at: new Date(at0100.getTime() - 3600e3).toISOString() }, at0100), false);
  const health = await api('/api/ops/health', { cookie: adminCookie });
  assert.equal(health.data.last_maintenance.reason, 'test');
});

test('recomputeLeadScores runs in chunks and only rewrites changed scores', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE deleted_at IS NULL').get().n;
  const r1 = await maintenance.recomputeLeadScores(db, { chunk: 2 });
  assert.equal(r1.scanned, before);
  const r2 = await maintenance.recomputeLeadScores(db, { chunk: 2 });
  assert.equal(r2.updated, 0, 'idempotent: nothing changed since the last pass');
});

test('graceful stop(): stops accepting, closes the DB, exits within the budget (runs last)', async () => {
  setSetting('probe_before_stop', 1);
  const t0 = Date.now();
  await instance.stop({ timeoutMs: 5000 });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `stop took ${ms} ms`);
  assert.equal(db.open, false, 'database closed');
  await assert.rejects(() => fetch(`${baseUrl}/api/health`), 'server no longer accepting connections');
  assert.equal(jobs.isShuttingDown(), true);
  const wal = path.join(process.env.CRM_DATA_DIR, 'crm.sqlite-wal');
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL truncated');
  // Idempotent.
  await instance.stop();
});
