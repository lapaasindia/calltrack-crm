// POST /api/imports — the server is the authority on validation, dedupe and
// assignment. Covers: phone normalisation, in-file + in-DB dedupe, nothing
// silently dropped, fair persistent round-robin (7 leads / 3 callers → 3/2/2
// and the next batch continues where the last stopped), the 20k cap, file
// type gate, and role gating (read_only / caller → 403).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-imports-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
let db;
let adminCookie;
const callers = [];

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
const login = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, `login ${username}`);
  return r.headers.get('set-cookie').split(';')[0];
};
const importRows = (rows, extra = {}) => api('/api/imports', {
  method: 'POST', cookie: adminCookie, body: { filename: 'leads.csv', rows, ...extra },
});
const ownerCounts = (batchId) => {
  const rows = db.prepare('SELECT assigned_to a, COUNT(*) n FROM leads WHERE import_batch_id = ? GROUP BY assigned_to').all(batchId);
  return Object.fromEntries(rows.map((r) => [r.a, r.n]));
};

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  adminCookie = await login('admin', 'admin123');
  for (const u of ['imp_c1', 'imp_c2', 'imp_c3']) {
    const r = await api('/api/users', {
      method: 'POST', cookie: adminCookie, body: { username: u, full_name: u, password: 'callerpass1', role: 'caller' },
    });
    assert.equal(r.status, 200);
    callers.push(r.data.id);
  }
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('normalises phones, dedupes against the DB and within the file, drops nothing silently', async () => {
  const existing = await api('/api/leads', {
    method: 'POST', cookie: adminCookie, body: { name: 'Already Here', phone: '9876500010', assigned_to: callers[0] },
  });
  assert.equal(existing.status, 200);

  const rows = [
    { name: 'Dup In DB', phone: '+91 98765 00010' },        // → 9876500010, exists → in_db
    { name: 'Meta Export', phone: 'p:+919876500011' },      // → 9876500011 (imported)
    { name: 'Dup In File', phone: '98765 00011' },          // same as previous row → in_file
    { name: '', phone: '9876500012' },                      // missing_name
    { name: 'Short', phone: '12345' },                      // wrong_length
    { name: 'Excel', phone: '9.8765E+09' },                 // excel_mangled (expands to ...00)
    { name: 'Leading Zero', phone: '09876500013' },         // → 9876500013 (imported)
    { name: 'Landline', phone: '01126543210' },             // bad_prefix (after 0-strip: 1126543210)
  ];
  const r = await importRows(rows, { default_source: 'expo' });
  assert.equal(r.status, 200);
  assert.equal(r.data.total, rows.length);
  assert.equal(r.data.imported, 2);
  assert.equal(r.data.duplicates.length, 2);
  assert.equal(r.data.invalid.length, 4);
  assert.equal(r.data.imported + r.data.duplicates.length + r.data.invalid.length, rows.length, 'every row accounted for');

  const dupDb = r.data.duplicates.find((d) => d.kind === 'in_db');
  assert.equal(dupDb.row, 1);
  assert.equal(dupDb.phone, '9876500010');
  assert.equal(dupDb.existing_id, existing.data.id);
  assert.equal(dupDb.existing_name, 'Already Here');
  const dupFile = r.data.duplicates.find((d) => d.kind === 'in_file');
  assert.equal(dupFile.row, 3);
  assert.equal(dupFile.first_row, 2);

  assert.deepEqual(r.data.invalid.map((i) => [i.row, i.reason]), [
    [4, 'missing_name'], [5, 'wrong_length'], [6, 'excel_mangled'], [8, 'bad_prefix'],
  ]);

  const imported = db.prepare('SELECT name, phone, phone_raw, source FROM leads WHERE import_batch_id = ? ORDER BY id').all(r.data.batch_id);
  assert.deepEqual(imported, [
    { name: 'Meta Export', phone: '9876500011', phone_raw: 'p:+919876500011', source: 'expo' },
    { name: 'Leading Zero', phone: '9876500013', phone_raw: '09876500013', source: 'expo' },
  ]);
  // SCALE-10: imported leads carry an initial score instead of NULL.
  assert.ok(db.prepare('SELECT score FROM leads WHERE import_batch_id = ?').all(r.data.batch_id).every((x) => Number.isInteger(x.score)),
    'every imported lead is scored');
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(r.data.batch_id);
  assert.equal(batch.total_rows, rows.length);
  assert.equal(batch.imported_count, 2);
  assert.equal(batch.duplicate_count, 2);
  assert.equal(batch.invalid_count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE phone = '9876500010'").get().n, 1, 'no duplicate lead created');
});

test('round-robin is fair (7 leads / 3 callers → 3/2/2) and the next batch continues from the cursor', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ name: `RR ${i}`, phone: `98770000${String(i).padStart(2, '0')}` }));
  const r = await importRows(rows, { round_robin: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.imported, 7);
  const counts = ownerCounts(r.data.batch_id);
  assert.deepEqual(Object.keys(counts).map(Number).sort((a, b) => a - b), [...callers].sort((a, b) => a - b), 'only the 3 callers received leads');
  assert.deepEqual(Object.values(counts).sort((a, b) => b - a), [3, 2, 2]);
  // Rotation order is by user id; the first caller got the extra one this time...
  assert.equal(counts[callers[0]], 3);

  // ...so the NEXT batch must start with the second caller (persistent cursor),
  // rather than the first caller collecting the extra lead of every import.
  const rows2 = Array.from({ length: 3 }, (_, i) => ({ name: `RR2 ${i}`, phone: `98771000${String(i).padStart(2, '0')}` }));
  const r2 = await importRows(rows2, { round_robin: true });
  assert.equal(r2.data.imported, 3);
  const order = db.prepare('SELECT assigned_to a FROM leads WHERE import_batch_id = ? ORDER BY id').all(r2.data.batch_id).map((x) => x.a);
  assert.deepEqual(order, [callers[1], callers[2], callers[0]]);

  // A third 7-lead batch: the extra lead now lands on the second caller, not the first.
  const rows3 = Array.from({ length: 7 }, (_, i) => ({ name: `RR3 ${i}`, phone: `98772000${String(i).padStart(2, '0')}` }));
  const r3 = await importRows(rows3, { round_robin: true });
  const counts3 = ownerCounts(r3.data.batch_id);
  assert.equal(counts3[callers[1]], 3);
  assert.equal(counts3[callers[0]], 2);
  assert.equal(counts3[callers[2]], 2);
});

test('round-robin only counts rows that will actually be inserted (duplicates do not consume a turn)', async () => {
  const rows = [
    { name: 'A', phone: '9878000001' },
    { name: 'A again', phone: '9878000001' }, // in-file dup
    { name: 'B', phone: '9878000002' },
    { name: 'bad', phone: '1' },              // invalid
    { name: 'C', phone: '9878000003' },
  ];
  const r = await importRows(rows, { round_robin: true });
  assert.equal(r.data.imported, 3);
  const owners = db.prepare('SELECT assigned_to a FROM leads WHERE import_batch_id = ? ORDER BY id').all(r.data.batch_id).map((x) => x.a);
  assert.equal(new Set(owners).size, 3, 'three inserted rows → three different callers');
});

test('a fixed assignee is honoured; an invalid one is refused', async () => {
  const r = await importRows([{ name: 'Fixed', phone: '9879000001' }], { assigned_to: callers[2] });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT assigned_to a FROM leads WHERE import_batch_id = ?').get(r.data.batch_id).a, callers[2]);
  const bad = await importRows([{ name: 'Fixed', phone: '9879000002' }], { assigned_to: 999999 });
  assert.equal(bad.status, 400);
  const none = await importRows([{ name: 'Unassigned', phone: '9879000003' }]);
  assert.equal(none.status, 200);
  assert.equal(db.prepare('SELECT assigned_to a FROM leads WHERE import_batch_id = ?').get(none.data.batch_id).a, null);
});

test('caps at 20,000 rows and only accepts spreadsheet file types', async () => {
  const tooMany = Array.from({ length: 20001 }, (_, i) => ({ name: 'x', phone: String(9000000000 + i) }));
  const r = await importRows(tooMany);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /20,000/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE name = 'x'").get().n, 0, 'nothing inserted');

  const empty = await importRows([]);
  assert.equal(empty.status, 400);
  const txt = await api('/api/imports', {
    method: 'POST', cookie: adminCookie, body: { filename: 'leads.txt', rows: [{ name: 'T', phone: '9879000009' }] },
  });
  assert.equal(txt.status, 400);
});

test('import is admin-tier only: read_only and caller are refused', async () => {
  for (const [u, role] of [['imp_ro', 'read_only'], ['imp_cal', 'caller']]) {
    const c = await api('/api/users', {
      method: 'POST', cookie: adminCookie, body: { username: u, full_name: u, password: 'somepass123', role },
    });
    assert.equal(c.status, 200);
    const cookie = await login(u, 'somepass123');
    const r = await api('/api/imports', {
      method: 'POST', cookie, body: { filename: 'leads.csv', rows: [{ name: 'Nope', phone: '9879000010' }] },
    });
    assert.equal(r.status, 403, `${role} cannot import`);
    assert.equal((await api('/api/imports', { cookie })).status, 403, `${role} cannot list batches`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE phone = '9879000010'").get().n, 0);

  const list = await api('/api/imports', { cookie: adminCookie });
  assert.equal(list.status, 200);
  assert.ok(list.data.length >= 4);
});
