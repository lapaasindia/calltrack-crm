import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  hasSqliteHeader, isWalMode, sidecarNames, checkRestoreCandidate, interpretCheck, SQLITE_HEADER_LEN,
} from './restore.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A realistic 100-byte header: magic + page size 4096 + WAL (2/2) versions.
function header({ wal = true } = {}) {
  const b = Buffer.alloc(SQLITE_HEADER_LEN);
  b.write('SQLite format 3', 0, 'ascii');
  b[15] = 0;
  b.writeUInt16BE(4096, 16);
  b[18] = wal ? 2 : 1;
  b[19] = wal ? 2 : 1;
  return b;
}

test('recognises the SQLite magic (NUL-terminated) and rejects everything else', () => {
  assert.equal(hasSqliteHeader(header()), true);
  const notNul = header(); notNul[15] = 0x20;
  assert.equal(hasSqliteHeader(notNul), false);
  assert.equal(hasSqliteHeader(Buffer.from('SQLite format 3')), false); // only 15 bytes
  assert.equal(hasSqliteHeader(Buffer.from('<!doctype html><html>....')), false);
  assert.equal(hasSqliteHeader(Buffer.from('PK zip file .................')), false);
  assert.equal(hasSqliteHeader(Buffer.alloc(0)), false);
  assert.equal(hasSqliteHeader(null), false);
});

test('WAL mode is read from header bytes 18/19; sidecar names', () => {
  assert.equal(isWalMode(header({ wal: true })), true);
  assert.equal(isWalMode(header({ wal: false })), false);
  assert.deepEqual(sidecarNames('/x/crm.sqlite'), { wal: '/x/crm.sqlite-wal', shm: '/x/crm.sqlite-shm' });
});

test('checkRestoreCandidate: empty, non-sqlite, too big, ok, live copy', () => {
  assert.match(checkRestoreCandidate({ headerBytes: header(), size: 0 }).error, /empty/);
  assert.match(checkRestoreCandidate({ headerBytes: Buffer.from('garbage'), size: 10 }).error, /not a SQLite/);
  const big = checkRestoreCandidate({ headerBytes: header(), size: 600 * 1048576, freeBytes: 1000 * 1048576 });
  assert.match(big.error, /free disk space/);
  assert.deepEqual(
    checkRestoreCandidate({ headerBytes: header(), size: 5 * 1048576, freeBytes: 100 * 1048576, walSize: 0 }),
    { ok: true, wal: true, liveCopy: false },
  );
  assert.deepEqual(
    checkRestoreCandidate({ headerBytes: header(), size: 5 * 1048576, freeBytes: null, walSize: 4096 }),
    { ok: true, wal: true, liveCopy: true },
  );
});

test('interpretCheck maps the child-process result to a user message', () => {
  assert.equal(interpretCheck(null).ok, false);
  assert.deepEqual(interpretCheck({ skipped: true, reason: 'abi' }), { ok: true, skipped: true, reason: 'abi' });
  assert.match(interpretCheck({ error: 'file is not a database' }).error, /could not be opened/);
  assert.match(interpretCheck({ quick_check: '*** in database main ***\nPage 3 is never used', users: 1 }).error, /damaged/);
  assert.match(interpretCheck({ quick_check: 'ok', users: 0 }).error, /no CallTrack users/);
  assert.deepEqual(interpretCheck({ quick_check: 'ok', users: 3, user_version: 17 }), { ok: true, users: 3, userVersion: 17 });
});

// The forked probe, run under plain Node (the Node-ABI binding in node_modules
// is exactly what `node` loads; Electron uses the fetched prebuild instead).
test('sqlite-check.js reports quick_check + users for a real database, errors for junk', (t) => {
  let Database;
  try { Database = require('better-sqlite3'); } catch { t.skip('better-sqlite3 not loadable under this node'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-restore-'));
  const good = path.join(dir, 'good.sqlite');
  const db = new Database(good);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users (username) VALUES (\'admin\'), (\'a\'); PRAGMA user_version = 17;');
  db.close();
  fs.writeFileSync(path.join(dir, 'junk.sqlite'), 'not a database at all, just text ...........');
  const script = path.join(__dirname, 'sqlite-check.js');
  const run = (f) => JSON.parse(execFileSync(process.execPath, [script, f], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(run(good), { quick_check: 'ok', users: 2, user_version: 17 });
  const bad = run(path.join(dir, 'junk.sqlite'));
  assert.ok(bad.error, `expected error for junk, got ${JSON.stringify(bad)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
