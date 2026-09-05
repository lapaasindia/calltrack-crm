// SqliteSessionStore (SCALE-16 / SEC-5): expiry index, touch() throttling,
// per-user destroy, and graceful close().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sessionstore-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

let SqliteSessionStore;
let destroySessionsForUser;
let closeSessionStore;
let store;

const DAY = 24 * 60 * 60 * 1000;
const sess = (userId, maxAge = 30 * DAY) => ({ cookie: { maxAge }, userId });
const p = (fn) => new Promise((resolve, reject) => fn((err, val) => (err ? reject(err) : resolve(val))));
const expiresOf = (sid) => store.db.prepare('SELECT expires_ms FROM sessions WHERE sid = ?').get(sid)?.expires_ms;

before(async () => {
  ({ SqliteSessionStore, destroySessionsForUser, closeSessionStore } = await import('../lib/sessionStore.js'));
  store = new SqliteSessionStore();
});

after(() => {
  try { store.close(); } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('creates the expires_ms index used by the hourly sweep', () => {
  const idx = store.db.prepare('PRAGMA index_list(sessions)').all().map((i) => i.name);
  assert.ok(idx.includes('idx_sessions_expires'));
  assert.ok(fs.existsSync(path.join(TMP, 'data', 'sessions.sqlite')));
});

test('set / get round-trip and expiry', async () => {
  await p((cb) => store.set('s1', sess(7), cb));
  const got = await p((cb) => store.get('s1', cb));
  assert.equal(got.userId, 7);
  assert.equal(await p((cb) => store.get('nope', cb)), null);
  const before = Date.now() + 30 * DAY - 5000;
  assert.ok(expiresOf('s1') >= before, 'expiry ≈ now + maxAge');
  // An expired row reads as null.
  store.db.prepare('UPDATE sessions SET expires_ms = ? WHERE sid = ?').run(Date.now() - 1, 's1');
  assert.equal(await p((cb) => store.get('s1', cb)), null);
  await p((cb) => store.set('s1', sess(7), cb));
});

test('touch() is throttled: no rewrite when the stored expiry is within 5 minutes of the new one', async () => {
  const stored = expiresOf('s1');
  await new Promise((r) => setTimeout(r, 20));
  await p((cb) => store.touch('s1', sess(7), cb));
  assert.equal(expiresOf('s1'), stored, 'touch 20 ms later leaves expires_ms untouched');

  // Pretend the last write was 10 minutes ago → touch must refresh.
  store.db.prepare('UPDATE sessions SET expires_ms = ? WHERE sid = ?').run(stored - 10 * 60 * 1000, 's1');
  await p((cb) => store.touch('s1', sess(7), cb));
  assert.ok(expiresOf('s1') >= stored, 'stale expiry refreshed');

  // touch on an unknown sid is a harmless no-op.
  await p((cb) => store.touch('ghost', sess(1), cb));
});

test('destroyByUserId removes that user\'s sessions except the one to keep', async () => {
  await p((cb) => store.set('s2', sess(7), cb));
  await p((cb) => store.set('s3', sess(8), cb));
  store.db.prepare("INSERT INTO sessions (sid, sess, expires_ms) VALUES ('junk', 'not json', ?)").run(Date.now() + DAY);
  assert.equal(store.destroyByUserId(7, 's1'), 1, 'only s2 removed');
  assert.ok(await p((cb) => store.get('s1', cb)), 's1 kept');
  assert.equal(await p((cb) => store.get('s2', cb)), null);
  assert.ok(await p((cb) => store.get('s3', cb)), 'other user untouched');
  assert.equal(destroySessionsForUser(7), 1, 'module-level helper hits the active store');
  assert.equal(await p((cb) => store.get('s1', cb)), null);
  assert.equal(destroySessionsForUser(7), 0);
});

test('close() checkpoints and closes; idempotent; module helper is safe afterwards', async () => {
  await p((cb) => store.set('s9', sess(9), cb));
  store.close();
  assert.equal(store.db.open, false);
  store.close(); // second close is a no-op
  await assert.rejects(p((cb) => store.get('s9', cb)), 'operations after close surface an error');
  closeSessionStore(); // no active store any more — must not throw
  // The data survived the checkpoint: reopen and read.
  const again = new SqliteSessionStore();
  assert.equal((await p((cb) => again.get('s9', cb))).userId, 9);
  assert.ok(!fs.existsSync(path.join(TMP, 'data', 'sessions.sqlite-wal')) || fs.statSync(path.join(TMP, 'data', 'sessions.sqlite-wal')).size === 0, 'WAL truncated on close');
  again.close();
});
