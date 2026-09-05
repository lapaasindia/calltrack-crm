// Wave 2 — leads: FTS5 search vs the old LIKE path on a seeded set (Hindi
// included), sanitising of FTS operators, digit queries staying on LIKE,
// exact-phone semantics widened to lead_phones (alt / previous), scoping and
// soft-delete respected, the LIKE fallback when the FTS table is gone, keyset
// cursors, and SCALE-18(b): a lead whose number was edited keeps receiving
// calls synced from the old number, review candidates say 'previous', and a
// soft delete ends the phone rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-wave2-leads-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let baseUrl;
let server;
let db;
let adminCookie;
let callerCookie;
let callerId;
let token;
let buildFtsQuery;
let findLeadCandidatesBatch;
const L = {};

const api = async (pathname, { method = 'GET', body, cookie, token: tok } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${baseUrl}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};
const login = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
};
const ids = (r) => r.data.leads.map((l) => l.id).sort((a, b) => a - b);
const search = (q, cookie = adminCookie) => api(`/api/leads?q=${encodeURIComponent(q)}&limit=500`, { cookie });

// The pre-018 LIKE search, run directly, as the oracle. `notes` is added
// because the FTS index covers notes (the old search never did) — for
// word-prefix queries the two must otherwise agree exactly.
function likeIds(q, { scopeUser = null, notes = true } = {}) {
  const like = `%${q}%`;
  const digits = q.replace(/\D/g, '');
  const rows = db.prepare(
    `SELECT id FROM leads l WHERE l.deleted_at IS NULL ${scopeUser ? 'AND l.assigned_to = ?' : ''}
       AND (l.name LIKE ? OR l.phone LIKE ? OR l.city LIKE ? OR l.email LIKE ? ${notes ? 'OR l.notes LIKE ?' : ''}) ORDER BY id`
  ).all(...(scopeUser ? [scopeUser] : []), like, digits ? `%${digits}%` : like, like, like, ...(notes ? [like] : []));
  return rows.map((r) => r.id);
}

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  ({ buildFtsQuery } = await import('../routes/leads.js'));
  ({ findLeadCandidatesBatch } = await import('../lib/leadMatch.js'));
  adminCookie = await login('admin', 'admin123');
  const u = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'w2caller', full_name: 'W2 Caller', password: 'callerpass1', role: 'caller' } });
  callerId = u.data.id;
  callerCookie = await login('w2caller', 'callerpass1');
  const code = await api('/api/devices/pairing-code', { method: 'POST', cookie: adminCookie, body: { user_id: callerId } });
  const pair = await api('/api/auth/pair', { method: 'POST', body: { code: code.data.code, device_name: 'W2 phone', android_id: 'W2_PHONE' } });
  token = pair.data.token;

  const seed = [
    ['rahul', { name: 'Rahul Sharma', phone: '9811100001', city: 'Delhi', email: 'rahul.sharma@example.com', notes: 'Asked about the advanced batch', assigned_to: callerId }],
    ['rahulH', { name: 'राहुल शर्मा', phone: '9811100002', city: 'दिल्ली', notes: 'कॉल वापस करें', assigned_to: 1 }],
    ['priya', { name: 'Priya Nair', phone: '9811100003', city: 'Bengaluru', email: 'priya@nair.in', assigned_to: callerId }],
    ['sharmaP', { name: 'Sharma Priyanka', phone: '9811100004', city: 'Bengaluru', alt_phone: '+91 98111 00099', assigned_to: 1 }],
    ['amit', { name: 'Amit Patel', phone: '9811100005', city: 'Pune', notes: 'Rahul referred him', assigned_to: 1 }],
    ['anjali', { name: 'Anjali Iyer', phone: '9811100006', city: 'Chennai', email: 'anjali@example.com', assigned_to: callerId }],
    ['deleted', { name: 'Rahul Deleted', phone: '9811100007', city: 'Delhi', assigned_to: 1 }],
    ['ops', { name: 'AND OR NOT NEAR "quoted" (paren) col:on', phone: '9811100008', city: 'Jaipur', assigned_to: 1 }],
  ];
  for (const [key, body] of seed) {
    const r = await api('/api/leads', { method: 'POST', cookie: adminCookie, body });
    assert.equal(r.status, 200, key);
    L[key] = r.data.id;
  }
  await api(`/api/leads/${L.deleted}`, { method: 'DELETE', cookie: adminCookie });
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('buildFtsQuery: tokens quoted + prefixed, operators stripped, digits-only → null', () => {
  assert.equal(buildFtsQuery('rahul sha'), '"rahul"* "sha"*');
  assert.equal(buildFtsQuery('  Rahul   '), '"Rahul"*');
  assert.equal(buildFtsQuery('AND OR NOT NEAR "x" (y) col:on'), '"AND"* "OR"* "NOT"* "NEAR"* "x"* "y"* "col"* "on"*', 'split where the tokenizer splits');
  assert.equal(buildFtsQuery('राहुल शर्मा'), '"राहुल"* "शर्मा"*');
  assert.equal(buildFtsQuery('rahul@example.com'), '"rahul"* "example"* "com"*');
  assert.equal(buildFtsQuery('-z'), '"z"*');
  assert.equal(buildFtsQuery('60000'), null, 'digits only → LIKE path');
  assert.equal(buildFtsQuery('***'), null);
  assert.equal(buildFtsQuery(''), null);
  assert.equal(buildFtsQuery('a b c d e f g h i j').split(' ').length, 8, 'capped at 8 tokens');
});

test('FTS search equals the LIKE search for word-prefix queries, including Hindi, and reports search_mode', async () => {
  for (const q of ['Rahul', 'rahul', 'Priya', 'Beng', 'nair', 'Delhi', 'anjali@example', 'राहुल', 'शर्मा', 'दिल्ली', 'Iyer']) {
    const r = await search(q);
    assert.equal(r.status, 200, q);
    assert.equal(r.data.search_mode, 'fts', q);
    assert.deepEqual(ids(r), likeIds(q), `q=${q}`);
    assert.ok(ids(r).length > 0, `q=${q} matched something`);
  }
  // Notes are searchable via FTS (LIKE never covered notes).
  const notes = await search('advanced');
  assert.deepEqual(ids(notes), [L.rahul]);
  const hindiNotes = await search('वापस');
  assert.deepEqual(ids(hindiNotes), [L.rahulH]);
  // Word order does not matter with FTS ("Sharma Rahul" finds "Rahul Sharma"), where LIKE would miss.
  const reversed = await search('Sharma Rahul');
  assert.deepEqual(ids(reversed), [L.rahul]);
  assert.deepEqual(likeIds('Sharma Rahul'), [], 'LIKE needed the exact substring');
  // Multi-token AND: "sharma pri" → only the lead carrying both.
  assert.deepEqual(ids(await search('sharma pri')), [L.sharmaP]);
});

test('FTS operators in the query are literal text; soft-deleted leads never appear', async () => {
  const r = await search('AND OR NOT NEAR "quoted" (paren) col:on');
  assert.equal(r.status, 200);
  assert.equal(r.data.search_mode, 'fts');
  assert.deepEqual(ids(r), [L.ops]);
  assert.deepEqual(ids(await search('(paren) col:on')), [L.ops]);
  const near = await search('NEAR');
  assert.deepEqual(ids(near), [L.ops]);
  const del = await search('Deleted');
  assert.deepEqual(ids(del), []);
  const rahul = await search('Rahul');
  assert.ok(!ids(rahul).includes(L.deleted));
});

test('scoping: a caller searching sees only their own leads (FTS path)', async () => {
  const r = await search('Rahul', callerCookie);
  assert.equal(r.data.search_mode, 'fts');
  assert.deepEqual(ids(r), [L.rahul], 'the Hindi Rahul (admin\'s) and Amit (notes) are hidden');
  assert.deepEqual(ids(r), likeIds('Rahul', { scopeUser: callerId }));
});

test('digit fragments use the substring LIKE path; a full phone matches current, alt and previous numbers exactly', async () => {
  const frag = await search('00005');
  assert.equal(frag.data.search_mode, 'like');
  assert.deepEqual(ids(frag), [L.amit]);
  assert.deepEqual(ids(frag), likeIds('00005', { notes: false }));
  const full = await search('9811100003');
  assert.equal(full.data.search_mode, 'phone');
  assert.deepEqual(ids(full), [L.priya]);
  // alt_phone (normalised into lead_phones) is now findable by exact number.
  const alt = await search('+91 98111 00099');
  assert.deepEqual(ids(alt), [L.sharmaP]);
  // A previous number (after a phone edit) still finds the lead.
  const edit = await api(`/api/leads/${L.anjali}`, { method: 'PATCH', cookie: adminCookie, body: { phone: '9811100066' } });
  assert.equal(edit.status, 200);
  assert.deepEqual(ids(await search('9811100006')), [L.anjali], 'old number → same lead');
  assert.deepEqual(ids(await search('9811100066')), [L.anjali]);
  const rows = db.prepare('SELECT phone, kind, valid_to IS NULL AS open FROM lead_phones WHERE lead_id = ? ORDER BY id').all(L.anjali);
  assert.deepEqual(rows.map((r) => [r.phone, r.kind, r.open]), [['9811100006', 'previous', 0], ['9811100066', 'primary', 1]]);
});

test('SCALE-18(b): calls synced from the old number attach to the same lead; a live lead with that number as current wins', async () => {
  const ts = Date.now() - 600000;
  const r = await api('/api/sync/calls', { method: 'POST', token, body: { calls: [{ call_log_ts: ts, phone: '9811100006', direction: 'incoming', duration_seconds: 20 }] } });
  assert.deepEqual(r.data.results[0], { status: 'attached', lead_id: L.anjali });
  // Replay → duplicate (priorByPhone via lead_phones), never a second row.
  const again = await api('/api/sync/calls', { method: 'POST', token, body: { calls: [{ call_log_ts: ts, phone: '9811100006', direction: 'incoming', duration_seconds: 20 }] } });
  assert.equal(again.data.results[0].status, 'duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls WHERE lead_id = ? AND call_log_ts = ?').get(L.anjali, ts).n, 1);
  // Review candidates for the old number name the lead as a 'previous' holder.
  const cands = findLeadCandidatesBatch(['9811100006', '9811100099', '9811100066'], { id: 1, role: 'admin' });
  assert.deepEqual(cands.get('9811100006').map((c) => [c.id, c.match]), [[L.anjali, 'previous']]);
  assert.deepEqual(cands.get('9811100099').map((c) => [c.id, c.match]), [[L.sharmaP, 'alt_phone']]);
  assert.deepEqual(cands.get('9811100066').map((c) => [c.id, c.match]), [[L.anjali, 'phone']]);
  // Someone else now gets the old number as THEIR current phone: they win.
  const newcomer = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'New Owner Of 06', phone: '9811100006', assigned_to: callerId } });
  assert.equal(newcomer.status, 200);
  const fresh = await api('/api/sync/calls', { method: 'POST', token, body: { calls: [{ call_log_ts: ts + 60000, phone: '9811100006', direction: 'outgoing', duration_seconds: 5 }] } });
  assert.deepEqual(fresh.data.results[0], { status: 'attached', lead_id: newcomer.data.id });
  const both = findLeadCandidatesBatch(['9811100006'], { id: 1, role: 'admin' });
  assert.deepEqual(both.get('9811100006').map((c) => [c.id, c.match]), [[newcomer.data.id, 'phone'], [L.anjali, 'previous']], 'current holder first');
  // Soft-deleting the newcomer ends its phone rows → the previous holder is found again.
  await api(`/api/leads/${newcomer.data.id}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_phones WHERE lead_id = ? AND valid_to IS NULL').get(newcomer.data.id).n, 0);
  const later = await api('/api/sync/calls', { method: 'POST', token, body: { calls: [{ call_log_ts: ts + 120000, phone: '9811100006', direction: 'outgoing', duration_seconds: 5 }] } });
  assert.deepEqual(later.data.results[0], { status: 'attached', lead_id: L.anjali });
});

test('keyset cursor: pages are contiguous, stable, and agree with offset paging; bad cursor → 400', async () => {
  // Bulk leads so there are several pages.
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO leads (name, phone, phone_raw, source, assigned_to, created_at, updated_at) VALUES (?, ?, ?, 'import', 1, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < 37; i += 1) {
      // Several leads share an updated_at to exercise the (updated_at, id) tie-break.
      const u = new Date(Date.parse(now) - (i % 5) * 1000).toISOString();
      ins.run(`Bulk ${i}`, String(9700000000 + i), String(9700000000 + i), now, u);
    }
  })();
  const all = await api('/api/leads?limit=500', { cookie: adminCookie });
  const expected = all.data.leads.map((l) => l.id);
  assert.equal(all.data.next_cursor, null);
  let cursor = null;
  const seen = [];
  let pages = 0;
  do {
    const r = await api(`/api/leads?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal(r.data.total, expected.length, 'total is the whole filtered set');
    assert.equal(r.data.page, cursor ? null : 1);
    seen.push(...r.data.leads.map((l) => l.id));
    cursor = r.data.next_cursor;
    pages += 1;
  } while (cursor);
  assert.deepEqual(seen, expected, 'cursor walk == one big page, no gaps or repeats');
  assert.equal(pages, Math.ceil(expected.length / 10));
  // Offset paging still works and agrees.
  const p2 = await api('/api/leads?limit=10&page=2', { cookie: adminCookie });
  assert.deepEqual(p2.data.leads.map((l) => l.id), expected.slice(10, 20));
  assert.ok(p2.data.next_cursor, 'offset pages also hand out a cursor');
  // A lead updated between pages does not shift the walk of the remaining pages.
  const first = await api('/api/leads?limit=10', { cookie: adminCookie });
  db.prepare("UPDATE leads SET updated_at = ? WHERE id = ?").run(new Date(Date.now() + 5000).toISOString(), expected[expected.length - 1]);
  const second = await api(`/api/leads?limit=10&cursor=${encodeURIComponent(first.data.next_cursor)}`, { cookie: adminCookie });
  assert.deepEqual(second.data.leads.map((l) => l.id), expected.slice(10, 20), 'keyset page unaffected by a row that moved to the top');
  const bad = await api('/api/leads?cursor=not-a-cursor', { cookie: adminCookie });
  assert.equal(bad.status, 400);
});

test('without the FTS table the search falls back to LIKE with the same results (then the index is rebuilt)', async () => {
  const before = ids(await search('Priya'));
  db.exec('DROP TRIGGER trg_leads_fts_ai; DROP TRIGGER trg_leads_fts_ad; DROP TRIGGER trg_leads_fts_au; DROP TABLE leads_fts;');
  const r = await search('Priya');
  assert.equal(r.status, 200);
  assert.equal(r.data.search_mode, 'like');
  assert.deepEqual(ids(r), before);
  // Recreate exactly as the migration does (its FTS section) and confirm FTS is back.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '018_wave2.sql'), 'utf8');
  const start = sql.indexOf('CREATE VIRTUAL TABLE');
  const end = sql.indexOf('-- ── SCALE-12');
  db.exec(sql.slice(start, end));
  const back = await search('Priya');
  assert.equal(back.data.search_mode, 'fts');
  assert.deepEqual(ids(back), before);
});
