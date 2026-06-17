import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '..', 'data');
export const DB_PATH = path.join(DATA_DIR, 'crm.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// Migrations: numbered .sql files applied in order, tracked via PRAGMA user_version.
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
let version = db.pragma('user_version', { simple: true });
for (const file of files) {
  const num = parseInt(file, 10);
  if (num <= version) continue;
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  // A migration whose FIRST line is the directive `-- migrate:no-transaction`
  // runs WITHOUT the wrapping db.transaction(). Some rebuilds (e.g. swapping a
  // table to widen a CHECK) need to toggle `PRAGMA foreign_keys` — which is a
  // silent no-op inside a transaction — so such files manage their own atomicity.
  const noTxn = /^\s*--\s*migrate:no-transaction\b/.test(sql);
  if (noTxn) {
    db.exec(sql);
    db.pragma(`user_version = ${num}`);
  } else {
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${num}`);
    })();
  }
  version = num;
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

export default db;
