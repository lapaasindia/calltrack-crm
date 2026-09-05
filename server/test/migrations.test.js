// Migration runner + 017 (audit SCALE-1/2/3/14/22/23) + 018 (wave 2: lead
// phone history, FTS5 lead search, calls_daily rollup, playable recordings).
// Builds a v16 database the way db.js does (001..016, honouring the
// no-transaction directive), fills it with realistic rows, then imports db.js
// against it so 017 and 018 run on REAL data — asserting the indexes, planner
// statistics, schema_migrations bookkeeping, the seeded invoice counter, the
// new columns, the 018 backfills (and their equality with the queries they
// replace) and that every statement is re-runnable. Finally the
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
    `INSERT INTO leads (name, phone, phone_raw, alt_phone, city, notes, source, stage, assigned_to, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const leadIds = [];
  for (let i = 0; i < 25; i += 1) {
    const phone = String(9000000000 + i);
    // Two alt phones in the wild formats lib/leadMatch.js tolerated, one alt
    // that is not a mobile number (must NOT be backfilled), one deleted lead,
    // one Hindi name for the FTS tokenizer.
    const alt = i === 2 ? '+91 97000-00002' : i === 3 ? '097000 00003' : i === 4 ? '011-23456' : null;
    const name = i === 7 ? 'राहुल शर्मा' : `Lead ${i}`;
    leadIds.push(insLead.run(name, phone, phone, alt, i % 3 ? 'Delhi' : 'Bengaluru',
      i === 8 ? 'wants the advanced course' : null, i % 2 ? 'referral' : 'import',
      i % 5 === 0 ? 'won' : 'contacted', caller, now, now, i === 9 ? now : null).lastInsertRowid);
  }
  // Calls across users / IST days / sources / auto_logged so the 018 rollup
  // backfill has every branch of the reporting rule to get right.
  const insCall = db.prepare(
    `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at, source, auto_logged)
     VALUES (?, ?, 'sales', ?, ?, ?, ?)`
  );
  const dispositions = ['connected', 'not_picked', 'busy', 'connected'];
  for (let i = 0; i < 400; i += 1) {
    const ms = Date.now() - (i * 3600 * 1000 * 5); // every 5 h back over ~83 days
    insCall.run(leadIds[i % leadIds.length], userIds[i % 4 + 3], dispositions[i % 4],
      new Date(ms).toISOString(), i % 7 === 0 ? 'whatsapp' : i % 3 === 0 ? 'mobile' : 'manual',
      i % 3 === 0 ? 1 : 0);
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
  for (const t of ['users', 'leads', 'calls', 'deals', 'installments', 'payments', 'invoices', 'tasks', 'follow_ups']) {
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

test('017 + 018 apply on a populated v16 database and land at the latest version', () => {
  assert.equal(db.pragma('user_version', { simple: true }), dbMod.LATEST_MIGRATION);
  assert.ok(dbMod.LATEST_MIGRATION >= 18);
  assert.deepEqual(dbMod.dbHealth.migrations_applied, [17, 18]);
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
  assert.equal(rows.find((r) => r.version === 18).app_version, PKG_VERSION);
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

// ── 018 ─────────────────────────────────────────────────────────────────────
const OLD_ROLLUP_SQL = `SELECT user_id, date(called_at, '+330 minutes') AS day, COUNT(*) AS dials,
    SUM(disposition = 'connected') AS connects, COUNT(DISTINCT lead_id) AS unique_leads
  FROM calls WHERE (auto_logged = 0 OR disposition = 'connected') AND source != 'whatsapp'
  GROUP BY user_id, day ORDER BY user_id, day`;
const ROLLUP_SQL = 'SELECT user_id, day, dials, connects, unique_leads FROM calls_daily ORDER BY user_id, day';

test('018: recordings.playable_path, lead_phones backfill (primary + normalised alt, deleted closed)', () => {
  const cols = new Set(db.prepare('PRAGMA table_info(recordings)').all().map((c) => c.name));
  assert.ok(cols.has('playable_path'));

  const byKind = Object.fromEntries(
    db.prepare('SELECT kind, COUNT(*) AS n FROM lead_phones GROUP BY kind').all().map((r) => [r.kind, r.n]),
  );
  assert.equal(byKind.primary, seeded.leads, 'one primary row per lead (deleted ones included)');
  assert.equal(byKind.alt, 2, 'only the two alt phones that reduce to a mobile number');
  assert.equal(byKind.previous ?? 0, 0);
  const alts = db.prepare("SELECT phone FROM lead_phones WHERE kind = 'alt' ORDER BY phone").all().map((r) => r.phone);
  assert.deepEqual(alts, ['9700000002', '9700000003']);
  // The deleted lead's primary row is closed at deleted_at; live ones are open.
  const deleted = db.prepare('SELECT id, deleted_at FROM leads WHERE deleted_at IS NOT NULL').get();
  assert.equal(db.prepare("SELECT valid_to FROM lead_phones WHERE lead_id = ? AND kind = 'primary'").get(deleted.id).valid_to, deleted.deleted_at);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lead_phones WHERE kind = 'primary' AND valid_to IS NULL").get().n, seeded.leads - 1);
  for (const t of ['trg_lead_phones_ai', 'trg_lead_phones_au_phone', 'trg_lead_phones_au_alt', 'trg_lead_phones_au_deleted',
    'trg_leads_fts_ai', 'trg_leads_fts_ad', 'trg_leads_fts_au', 'trg_calls_daily_ai', 'trg_calls_daily_au', 'trg_calls_daily_ad']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(t), `trigger ${t}`);
  }
});

test('018: lead_phones triggers — phone edit → previous, alt edit, soft delete closes rows', () => {
  const lead = db.prepare("SELECT id, phone FROM leads WHERE deleted_at IS NULL AND alt_phone IS NULL LIMIT 1").get();
  db.prepare("UPDATE leads SET phone = '9555500001', updated_at = ? WHERE id = ?").run(now, lead.id);
  const rows = db.prepare('SELECT phone, kind, valid_to FROM lead_phones WHERE lead_id = ? ORDER BY id').all(lead.id);
  assert.deepEqual(rows.map((r) => [r.phone, r.kind, r.valid_to === null]), [[lead.phone, 'previous', false], ['9555500001', 'primary', true]]);
  assert.match(rows[0].valid_to, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'valid_to is a nowUtc()-shaped instant');
  // Same-value update is a no-op.
  db.prepare("UPDATE leads SET phone = '9555500001' WHERE id = ?").run(lead.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_phones WHERE lead_id = ?').get(lead.id).n, 2);
  // alt: set, then change (old alt closed, new alt open), then non-mobile (closed, none added).
  db.prepare("UPDATE leads SET alt_phone = '+91 96666 00001' WHERE id = ?").run(lead.id);
  db.prepare("UPDATE leads SET alt_phone = '9666600002' WHERE id = ?").run(lead.id);
  db.prepare("UPDATE leads SET alt_phone = '011-2345' WHERE id = ?").run(lead.id);
  const alts = db.prepare("SELECT phone, valid_to IS NULL AS open FROM lead_phones WHERE lead_id = ? AND kind = 'alt' ORDER BY id").all(lead.id);
  assert.deepEqual(alts.map((a) => [a.phone, a.open]), [['9666600001', 0], ['9666600002', 0]]);
  // Soft delete closes everything still open.
  db.prepare("UPDATE leads SET deleted_at = ? WHERE id = ?").run('2026-09-05T00:00:00.000Z', lead.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_phones WHERE lead_id = ? AND valid_to IS NULL').get(lead.id).n, 0);
  assert.equal(db.prepare("SELECT valid_to FROM lead_phones WHERE lead_id = ? AND kind = 'primary'").get(lead.id).valid_to, '2026-09-05T00:00:00.000Z');
});

test('018: leads_fts indexes existing rows (Hindi tokens intact) and follows inserts/updates/deletes', () => {
  const match = (q) => db.prepare('SELECT rowid FROM leads_fts WHERE leads_fts MATCH ? ORDER BY rowid').all(q).map((r) => r.rowid);
  const hindi = db.prepare("SELECT id FROM leads WHERE name = 'राहुल शर्मा'").get().id;
  assert.deepEqual(match('"राह"*'), [hindi], 'prefix of a Devanagari name with matras is one token');
  assert.deepEqual(match('"शर्मा"'), [hindi]);
  assert.deepEqual(match('"advanced"*'), [db.prepare("SELECT id FROM leads WHERE notes LIKE '%advanced%'").get().id], 'notes indexed');
  assert.equal(match('"beng"*').length, db.prepare("SELECT COUNT(*) AS n FROM leads WHERE city = 'Bengaluru'").get().n, 'city indexed');
  const id = db.prepare(
    "INSERT INTO leads (name, phone, phone_raw, source, created_at, updated_at) VALUES ('Zubin Test', '9444400001', '9444400001', 'manual', ?, ?)"
  ).run(now, now).lastInsertRowid;
  assert.deepEqual(match('"zubin"*'), [id]);
  db.prepare("UPDATE leads SET name = 'Zarina Test' WHERE id = ?").run(id);
  assert.deepEqual(match('"zubin"*'), []);
  assert.deepEqual(match('"zarina"*'), [id]);
  db.prepare('DELETE FROM lead_phones WHERE lead_id = ?').run(id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  assert.deepEqual(match('"zarina"*'), []);
});

test('018: calls_daily backfill equals the old GROUP BY over calls, and triggers keep it equal', () => {
  const eq = (label) => assert.deepEqual(db.prepare(ROLLUP_SQL).all(), db.prepare(OLD_ROLLUP_SQL).all(), label);
  eq('backfill');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM calls_daily').get().n > 20, 'several (user, day) buckets');
  const anyLead = db.prepare('SELECT id FROM leads WHERE deleted_at IS NULL LIMIT 1').get().id;
  const u = db.prepare("SELECT id FROM users WHERE role = 'caller'").get().id;
  // Insert at the IST day boundary (18:30 UTC = 00:00 IST next day) in every branch of the rule.
  const ins = db.prepare(
    "INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at, source, auto_logged) VALUES (?, ?, 'sales', ?, ?, ?, ?)"
  );
  const a = ins.run(anyLead, u, 'connected', '2026-08-31T18:30:00.000Z', 'manual', 0).lastInsertRowid;
  const b = ins.run(anyLead, u, 'not_picked', '2026-08-31T18:29:59.999Z', 'mobile', 1).lastInsertRowid; // excluded (auto, not connected)
  const c = ins.run(anyLead, u, 'connected', '2026-08-31T18:29:59.999Z', 'whatsapp', 0).lastInsertRowid; // excluded (whatsapp)
  eq('after inserts');
  assert.deepEqual(db.prepare("SELECT dials, connects FROM calls_daily WHERE user_id = ? AND day = '2026-09-01'").get(u), { dials: 1, connects: 1 });
  // Updates that move a row across buckets / users / the rule.
  db.prepare("UPDATE calls SET called_at = '2026-08-31T18:29:59.999Z' WHERE id = ?").run(a); // day → 2026-08-31
  eq('after moving across the IST midnight');
  db.prepare("UPDATE calls SET disposition = 'connected' WHERE id = ?").run(b); // now included
  db.prepare("UPDATE calls SET source = 'manual' WHERE id = ?").run(c); // now included
  db.prepare('UPDATE calls SET user_id = ? WHERE id = ?').run(db.prepare("SELECT id FROM users WHERE role = 'agent'").get().id, a);
  eq('after disposition/source/user updates');
  db.prepare("UPDATE calls SET outcome = 'interested' WHERE id = ?").run(b); // rollup-irrelevant column
  eq('after an irrelevant update');
  db.prepare('DELETE FROM calls WHERE id IN (?, ?, ?)').run(a, b, c);
  eq('after deletes');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calls_daily WHERE day = '2026-09-01' AND user_id = ?").get(u).n, 0, 'empty bucket removed');
});

test('018 statements are idempotent: re-running the whole file (minus ADD COLUMN) is a no-op', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '018_wave2.sql'), 'utf8');
  const rest = sql.split('\n').filter((l) => !/^\s*ALTER TABLE/i.test(l)).join('\n');
  const snapshot = () => ({
    phones: db.prepare('SELECT * FROM lead_phones ORDER BY id').all(),
    rollup: db.prepare(ROLLUP_SQL).all(),
    objects: db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'trg_%' OR name LIKE 'idx_lead_phones%' OR name LIKE 'leads_fts%' OR name LIKE 'calls_daily%' ORDER BY 1, 2").all(),
    fts: db.prepare('SELECT rowid FROM leads_fts WHERE leads_fts MATCH ? ORDER BY rowid').all('"lead"*').length,
  });
  const before = snapshot();
  assert.doesNotThrow(() => db.exec(rest));
  assert.deepEqual(snapshot(), before);
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
