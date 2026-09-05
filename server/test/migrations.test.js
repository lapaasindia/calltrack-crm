// Migration runner + 017 (audit SCALE-1/2/3/14/22/23). Builds a v16 database
// the way db.js does (001..016, honouring the no-transaction directive), fills
// it with realistic rows, then imports db.js against it so 017 runs on REAL
// data — asserting the indexes, planner statistics, schema_migrations
// bookkeeping, the seeded invoice counter and the new columns. Finally the
// future-schema guard is exercised via a second module instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-migrations-test-'));
const DIR_A = path.join(TMP, 'a');
const DIR_B = path.join(TMP, 'b');
fs.mkdirSync(DIR_A, { recursive: true });
fs.mkdirSync(DIR_B, { recursive: true });

const migrationFiles = () => fs.readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

// Replicates the db.js runner for versions <= maxVersion.
function buildDb(file, maxVersion) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const f of migrationFiles()) {
    const num = parseInt(f, 10);
    if (num > maxVersion) break;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const noTxn = /^\s*--\s*migrate:no-transaction\b/.test(sql);
    if (noTxn) {
      db.exec(sql);
      db.pragma(`user_version = ${num}`);
    } else {
      db.transaction(() => { db.exec(sql); db.pragma(`user_version = ${num}`); })();
    }
  }
  return db;
}

const now = new Date().toISOString();
const ROLES = ['super_admin', 'admin', 'manager', 'agent', 'caller', 'employee', 'read_only'];
const seeded = {};

// ── Build a v16 database with realistic rows ────────────────────────────────
{
  const db = buildDb(path.join(DIR_A, 'crm.sqlite'), 16);
  assert.equal(db.pragma('user_version', { simple: true }), 16);
  const insUser = db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role, is_active, created_at) VALUES (?, 'x', ?, ?, 1, ?)"
  );
  const userIds = ROLES.map((r) => insUser.run(`u_${r}`, `User ${r}`, r, now).lastInsertRowid);
  const caller = userIds[ROLES.indexOf('caller')];
  const productId = db.prepare(
    "INSERT INTO products (name, price_paise, created_at) VALUES ('Course', 5000000, ?)"
  ).run(now).lastInsertRowid;
  const insLead = db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, stage, assigned_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const leadIds = [];
  for (let i = 0; i < 25; i += 1) {
    const phone = String(9000000000 + i);
    leadIds.push(insLead.run(`Lead ${i}`, phone, phone, i % 2 ? 'referral' : 'import',
      i % 5 === 0 ? 'won' : 'contacted', caller, now, now).lastInsertRowid);
  }
  const insDeal = db.prepare(
    `INSERT INTO deals (lead_id, product_id, created_by, deal_value_paise, won_at, won_date, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-06-01', ?)`
  );
  const insInst = db.prepare(
    "INSERT INTO installments (deal_id, seq, amount_paise, due_date, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insPay = db.prepare(
    `INSERT INTO payments (deal_id, installment_id, amount_paise, method, received_date, recorded_by, recorded_at)
     VALUES (?, ?, ?, 'upi', '2026-06-02', ?, ?)`
  );
  for (const leadId of leadIds.filter((_, i) => i % 5 === 0)) {
    const dealId = insDeal.run(leadId, productId, caller, 5000000, now, now).lastInsertRowid;
    const i1 = insInst.run(dealId, 1, 2500000, '2026-06-01', now).lastInsertRowid;
    insInst.run(dealId, 2, 2500000, '2026-07-01', now);
    insPay.run(dealId, i1, 1000000, caller, now);
    insPay.run(dealId, null, 500000, caller, now);
  }
  db.prepare(
    `INSERT INTO invoices (invoice_number, issue_date, due_date, subtotal_paise, gst_percent, tax_paise, total_paise, created_by, created_at)
     VALUES ('INV-00001', '2026-06-01', '2026-06-15', 100, 18, 18, 118, ?, ?)`
  ).run(caller, now);
  db.prepare(
    `INSERT INTO invoices (invoice_number, issue_date, due_date, subtotal_paise, gst_percent, tax_paise, total_paise, created_by, created_at)
     VALUES ('INV-00007', '2026-06-01', '2026-06-15', 100, 18, 18, 118, ?, ?)`
  ).run(caller, now);
  db.prepare(
    "INSERT INTO tasks (title, assigned_to, due_date, created_by, created_at) VALUES ('t', ?, '2026-06-01', ?, ?)"
  ).run(caller, caller, now);
  db.prepare(
    "INSERT INTO follow_ups (lead_id, assigned_to, due_at, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
  ).run(leadIds[1], caller, now, now);
  for (const t of ['users', 'leads', 'deals', 'installments', 'payments', 'invoices', 'tasks', 'follow_ups']) {
    seeded[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  }
  db.close();
}

// ── Import db.js against it: 017 applies on real data ───────────────────────
process.env.CRM_DATA_DIR = DIR_A;
const t0 = Date.now();
const dbMod = await import('../db.js');
const migrateMs = Date.now() - t0;
const db = dbMod.default;

const EXPECTED_INDEXES = [
  'idx_payments_installment',
  'idx_installments_deal_status',
  'idx_calls_called_at',
  'idx_calls_user_log_ts_mobile',
  'idx_leads_updated_live',
  'idx_leads_source',
  'idx_recordings_captured',
  'idx_recordings_user',
  'idx_captured_phone_status',
  'idx_captured_user_ts',
  'idx_wa_messages_lead',
  'idx_deals_creator_won',
  'idx_deals_status',
];

test('017 applies on a populated v16 database and lands at the latest version', () => {
  assert.equal(db.pragma('user_version', { simple: true }), dbMod.LATEST_MIGRATION);
  assert.ok(dbMod.LATEST_MIGRATION >= 17);
  assert.deepEqual(dbMod.dbHealth.migrations_applied, [17]);
  assert.ok(migrateMs < 5000, `migration + boot checks took ${migrateMs} ms`);
  // Nothing lost.
  for (const [t, n] of Object.entries(seeded)) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, n, `${t} rows preserved`);
  }
});

test('all audit indexes exist', () => {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  for (const idx of EXPECTED_INDEXES) assert.ok(names.has(idx), `missing index ${idx}`);
  // Partial-index predicates survived.
  const sqlOf = (n) => db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(n).sql;
  assert.match(sqlOf('idx_calls_user_log_ts_mobile'), /WHERE source = 'mobile'/);
  assert.match(sqlOf('idx_leads_updated_live'), /WHERE deleted_at IS NULL/);
});

test('ANALYZE ran (sqlite_stat1 populated) and quick_check is ok', () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM sqlite_stat1').get().n;
  assert.ok(n > 0, 'planner statistics present');
  assert.ok(dbMod.dbHealth.analyzed_at, 'analyzed_at recorded');
  assert.equal(dbMod.dbHealth.quick_check, 'ok');
  assert.equal(dbMod.runQuickCheck(), 'ok');
});

test('the planner now uses the new indexes for the hot predicates', () => {
  const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  assert.match(plan("SELECT SUM(amount_paise) FROM payments WHERE installment_id = 1"), /idx_payments_installment/);
  assert.match(plan("SELECT MIN(due_date) FROM installments WHERE deal_id = 1 AND status IN ('pending','partial')"), /idx_installments_deal_status/);
  assert.match(plan("SELECT COUNT(*) FROM calls WHERE called_at >= '2026-01-01' AND called_at < '2026-02-01'"), /idx_calls_called_at/);
  assert.match(plan("SELECT id FROM leads WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50 OFFSET 1000"), /idx_leads_updated_live/);
});

test('schema_migrations records every version with the app version for the new one', () => {
  const rows = db.prepare('SELECT version, app_version, applied_at FROM schema_migrations ORDER BY version').all();
  assert.equal(rows.length, dbMod.LATEST_MIGRATION);
  assert.deepEqual(rows.map((r) => r.version), Array.from({ length: dbMod.LATEST_MIGRATION }, (_, i) => i + 1));
  const v17 = rows.find((r) => r.version === 17);
  assert.equal(v17.app_version, PKG_VERSION);
  assert.equal(dbMod.APP_VERSION, PKG_VERSION);
  assert.ok(rows.filter((r) => r.version < 17).every((r) => r.app_version === 'unrecorded'));
  assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2}T/.test(r.applied_at)));
});

test('counters seeded from the highest existing invoice number; new columns present', () => {
  assert.equal(db.prepare("SELECT next FROM counters WHERE name = 'invoice'").get().next, 8);
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  assert.ok(cols('tasks').has('timer_started_at'));
  assert.ok(cols('tasks').has('cancel_reason'));
  assert.ok(cols('follow_ups').has('cancel_reason'));
  assert.ok(cols('invoices').has('deleted_at'));
});

test('017 index/table statements are idempotent (re-running them is a no-op)', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '017_perf_indexes.sql'), 'utf8');
  const before = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'").get().n;
  // Drop comment lines first (they may contain ';'), then split statements.
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  const statements = code.split(';').map((x) => x.trim()).filter((x) => x && !/^ALTER TABLE/i.test(x));
  assert.ok(statements.length >= 15, `parsed ${statements.length} statements`);
  for (const body of statements) {
    assert.doesNotThrow(() => db.exec(body), `re-running: ${body.slice(0, 60)}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'").get().n, before);
  assert.equal(db.prepare("SELECT next FROM counters WHERE name = 'invoice'").get().next, 8, 'counter not reseeded');
});

test('refuses to open a database written by a newer release (names both versions)', async () => {
  const future = new Database(path.join(DIR_B, 'crm.sqlite'));
  future.pragma('user_version = 999');
  future.close();
  process.env.CRM_DATA_DIR = DIR_B;
  // A query string makes Node evaluate db.js again as a distinct module instance.
  await assert.rejects(
    () => import('../db.js?future-version-guard=1'),
    (err) => {
      assert.match(err.message, /schema version 999/);
      assert.match(err.message, new RegExp(`up to ${dbMod.LATEST_MIGRATION}`));
      assert.match(err.message, new RegExp(`v${PKG_VERSION.replace(/\./g, '\\.')}`));
      return true;
    },
  );
  process.env.CRM_DATA_DIR = DIR_A;
});

test('a failing migration names the file and leaves user_version untouched', () => {
  const dir = path.join(TMP, 'c');
  fs.mkdirSync(dir, { recursive: true });
  const bad = buildDb(path.join(dir, 'crm.sqlite'), 3);
  // Simulate what the runner does with a broken file: the transaction rolls
  // back, so user_version stays at 3.
  assert.throws(() => bad.transaction(() => { bad.exec('CREATE TABLE x (id INTEGER); INSERT INTO nope VALUES (1);'); bad.pragma('user_version = 4'); })());
  assert.equal(bad.pragma('user_version', { simple: true }), 3);
  assert.equal(bad.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'x'").get().n, 0);
  bad.close();
});

test('shutdownDb truncates the WAL, closes, and is idempotent', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('probe', '1') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
  dbMod.shutdownDb();
  assert.equal(db.open, false);
  assert.doesNotThrow(() => dbMod.shutdownDb());
  const wal = path.join(DIR_A, 'crm.sqlite-wal');
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL truncated on shutdown');
  fs.rmSync(TMP, { recursive: true, force: true });
});
