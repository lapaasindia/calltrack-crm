// Wave 2 — list contracts that had to stay backward compatible:
//   * WhatsApp thread paging (?before&limit → has_more/next_before; legacy
//     no-param call = full thread up to 500, else newest 500 + has_more)
//   * /api/invoices and /api/tasks ?limit&offset → { rows, total, … } while
//     the bare array shape (and X-Total-Count) survives for old clients
//   * async bcrypt (SCALE-4): login / change-password / user create + reset
//     still work, including concurrently, and unknown users still pay the
//     dummy compare.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-wave2-lists-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
let db;
let adminCookie;
let callerCookie;
let callerId;
let leadId;

const api = async (pathname, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};
const login = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.data)}`);
  return r.headers.get('set-cookie').split(';')[0];
};

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  adminCookie = await login('admin', 'admin123');
  const u = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'w2lists', full_name: 'W2 Lists', password: 'callerpass1', role: 'caller' } });
  callerId = u.data.id;
  callerCookie = await login('w2lists', 'callerpass1');
  const lead = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'Lists Lead', phone: '9744400001', assigned_to: callerId } });
  leadId = lead.data.id;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── WhatsApp thread paging ──────────────────────────────────────────────────
function seedThread(jid, n, { shuffleIds = false } = {}) {
  const now = new Date().toISOString();
  const cid = db.prepare(
    "INSERT INTO wa_contacts (wa_jid, phone, display_name, first_seen_at, last_message_at) VALUES (?, ?, ?, ?, ?)"
  ).run(jid, jid.slice(2, 12), `Contact ${jid}`, now, now).lastInsertRowid;
  const ins = db.prepare(
    "INSERT INTO wa_messages (contact_id, wa_message_id, direction, message_type, body, sent_at, created_at) VALUES (?, ?, ?, 'text', ?, ?, ?)"
  );
  const order = [...Array(n).keys()];
  if (shuffleIds) order.reverse(); // ids descend while sent_at ascends (history sync)
  db.transaction(() => {
    for (const i of order) {
      const sentAt = new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 60000).toISOString();
      ins.run(cid, `${jid}-${i}`, i % 2 ? 'incoming' : 'outgoing', `msg ${i}`, sentAt, now);
    }
  })();
  return cid;
}

test('thread: legacy call returns the whole thread when ≤ 500 messages, newest 500 + has_more otherwise', async () => {
  const small = seedThread('919700000101@s.whatsapp.net', 120);
  const r = await api(`/api/whatsapp/contacts/${small}/messages`, { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.messages.length, 120);
  assert.equal(r.data.has_more, false);
  assert.equal(r.data.next_before, null);
  assert.equal(r.data.total, 120);
  assert.deepEqual(r.data.messages.map((m) => m.body).slice(0, 3), ['msg 0', 'msg 1', 'msg 2'], 'chronological');
  assert.ok(r.data.contact && r.data.contact.id === small);

  const big = seedThread('919700000102@s.whatsapp.net', 1200);
  const b = await api(`/api/whatsapp/contacts/${big}/messages`, { cookie: adminCookie });
  assert.equal(b.data.messages.length, 500);
  assert.equal(b.data.has_more, true);
  assert.equal(b.data.messages[0].body, 'msg 700');
  assert.equal(b.data.messages[499].body, 'msg 1199');
  assert.equal(b.data.next_before, b.data.messages[0].id);
});

test('thread: ?before&limit walks backwards in contiguous pages; limits clamped; bad params rejected', async () => {
  const big = db.prepare("SELECT id FROM wa_contacts WHERE wa_jid = '919700000102@s.whatsapp.net'").get().id;
  const first = await api(`/api/whatsapp/contacts/${big}/messages?limit=50`, { cookie: adminCookie });
  assert.equal(first.data.messages.length, 50);
  assert.equal(first.data.limit, 50);
  assert.equal(first.data.messages[49].body, 'msg 1199');
  assert.equal(first.data.messages[0].body, 'msg 1150');
  assert.equal(first.data.has_more, true);
  assert.equal(first.data.next_before, first.data.messages[0].id);
  // Walk the whole thread.
  const bodies = [...first.data.messages.map((m) => m.body)];
  let before = first.data.next_before;
  let pages = 1;
  while (before) {
    const r = await api(`/api/whatsapp/contacts/${big}/messages?before=${before}&limit=200`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.ok(r.data.messages.length <= 200);
    bodies.unshift(...r.data.messages.map((m) => m.body));
    before = r.data.next_before;
    pages += 1;
  }
  assert.equal(bodies.length, 1200);
  assert.deepEqual(bodies, Array.from({ length: 1200 }, (_, i) => `msg ${i}`), 'every message exactly once, in order');
  assert.equal(pages, 1 + Math.ceil(1150 / 200));
  // Default limit 50, max 200, floor 1.
  const def = await api(`/api/whatsapp/contacts/${big}/messages?before=${first.data.next_before}`, { cookie: adminCookie });
  assert.equal(def.data.messages.length, 50);
  const clamp = await api(`/api/whatsapp/contacts/${big}/messages?limit=999`, { cookie: adminCookie });
  assert.equal(clamp.data.messages.length, 200);
  assert.equal(clamp.data.limit, 200);
  const floor = await api(`/api/whatsapp/contacts/${big}/messages?limit=0`, { cookie: adminCookie });
  assert.equal(floor.data.messages.length, 50, 'invalid limit → default');
  // Bad / foreign anchors.
  assert.equal((await api(`/api/whatsapp/contacts/${big}/messages?before=abc`, { cookie: adminCookie })).status, 400);
  const other = db.prepare("SELECT id FROM wa_messages WHERE contact_id != ? LIMIT 1").get(big).id;
  assert.equal((await api(`/api/whatsapp/contacts/${big}/messages?before=${other}`, { cookie: adminCookie })).status, 404);
  assert.equal((await api(`/api/whatsapp/contacts/${big}/messages`, { cookie: callerCookie })).status, 403, 'still admin tier');
});

test('thread: paging orders by (sent_at, id) so a history sync with descending ids still pages correctly', async () => {
  const cid = seedThread('919700000103@s.whatsapp.net', 130, { shuffleIds: true });
  const p1 = await api(`/api/whatsapp/contacts/${cid}/messages?limit=50`, { cookie: adminCookie });
  assert.deepEqual([p1.data.messages[0].body, p1.data.messages[49].body], ['msg 80', 'msg 129']);
  const p2 = await api(`/api/whatsapp/contacts/${cid}/messages?limit=50&before=${p1.data.next_before}`, { cookie: adminCookie });
  assert.deepEqual([p2.data.messages[0].body, p2.data.messages[49].body], ['msg 30', 'msg 79']);
  const p3 = await api(`/api/whatsapp/contacts/${cid}/messages?limit=50&before=${p2.data.next_before}`, { cookie: adminCookie });
  assert.deepEqual([p3.data.messages[0].body, p3.data.messages.length, p3.data.has_more], ['msg 0', 30, false]);
});

// ── invoices / tasks paging ─────────────────────────────────────────────────
test('invoices: bare array without paging params (+ X-Total-Count); {rows,total,limit,offset} with them', async () => {
  for (let i = 0; i < 7; i += 1) {
    const r = await api('/api/invoices', { method: 'POST', cookie: adminCookie, body: { lead_id: leadId, items: [{ description: `Item ${i}`, qty: 1, unit_price_paise: 10000 * (i + 1) }] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const legacy = await api('/api/invoices', { cookie: adminCookie });
  assert.ok(Array.isArray(legacy.data));
  assert.equal(legacy.data.length, 7);
  assert.equal(legacy.headers.get('x-total-count'), '7');
  const page = await api('/api/invoices?limit=3&offset=3', { cookie: adminCookie });
  assert.equal(page.status, 200);
  assert.deepEqual(Object.keys(page.data).sort(), ['limit', 'offset', 'rows', 'total']);
  assert.equal(page.data.total, 7);
  assert.equal(page.data.rows.length, 3);
  assert.deepEqual(page.data.rows.map((r) => r.id), legacy.data.slice(3, 6).map((r) => r.id), 'same order as the legacy list');
  const tail = await api('/api/invoices?limit=3&offset=6', { cookie: adminCookie });
  assert.equal(tail.data.rows.length, 1);
  const onlyLimit = await api('/api/invoices?limit=2', { cookie: adminCookie });
  assert.deepEqual([onlyLimit.data.rows.length, onlyLimit.data.offset, onlyLimit.data.total], [2, 0, 7]);
  const junk = await api('/api/invoices?limit=-5&offset=abc', { cookie: adminCookie });
  assert.deepEqual([junk.data.limit, junk.data.offset, junk.data.rows.length], [500, 0, 7]);
  const clamp = await api('/api/invoices?limit=9999', { cookie: adminCookie });
  assert.equal(clamp.data.limit, 500);
  // Scoping unchanged: the caller sees its lead's invoices, total scoped too.
  const mine = await api('/api/invoices?limit=100', { cookie: callerCookie });
  assert.equal(mine.data.total, 7);
  const filtered = await api('/api/invoices?status=draft&limit=2', { cookie: adminCookie });
  assert.equal(filtered.data.total, 7);
  assert.equal(filtered.data.rows.length, 2);
});

test('tasks: same contract — legacy array (first 500) vs {rows,total,limit,offset}; scoped totals', async () => {
  for (let i = 0; i < 12; i += 1) {
    const r = await api('/api/tasks', { method: 'POST', cookie: adminCookie, body: { title: `T${i}`, assigned_to: i % 3 ? 1 : callerId, due_date: `2026-10-${String(i + 1).padStart(2, '0')}` } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const legacy = await api('/api/tasks', { cookie: adminCookie });
  assert.ok(Array.isArray(legacy.data));
  assert.equal(legacy.data.length, 12);
  assert.equal(legacy.headers.get('x-total-count'), '12');
  const p = await api('/api/tasks?limit=5&offset=5', { cookie: adminCookie });
  assert.deepEqual([p.data.total, p.data.rows.length, p.data.limit, p.data.offset], [12, 5, 5, 5]);
  assert.deepEqual(p.data.rows.map((t) => t.id), legacy.data.slice(5, 10).map((t) => t.id));
  const mine = await api('/api/tasks?limit=50', { cookie: callerCookie });
  assert.equal(mine.data.total, 4);
  assert.ok(mine.data.rows.every((t) => t.assigned_to === callerId));
  const all = await api('/api/tasks?status=all&limit=3', { cookie: adminCookie });
  assert.equal(all.data.total, 12);
  assert.equal(all.data.rows.length, 3);
});

// ── async bcrypt ────────────────────────────────────────────────────────────
test('async bcrypt: concurrent logins, wrong password, unknown user, change-password, admin reset all behave', async () => {
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 8 }, () => api('/api/auth/login', { method: 'POST', body: { username: 'w2lists', password: 'callerpass1' } })));
  assert.ok(results.every((r) => r.status === 200));
  // Serial-blocking would take ≥ 8 × ~60 ms; async overlaps but still finishes.
  assert.ok(Date.now() - t0 < 5000);
  const wrong = await api('/api/auth/login', { method: 'POST', body: { username: 'w2lists', password: 'nope-nope' } });
  assert.equal(wrong.status, 401);
  const unknown = await api('/api/auth/login', { method: 'POST', body: { username: 'ghost', password: 'whatever1' } });
  assert.equal(unknown.status, 401);
  // change-password (async compare + hash) and the new hash logs in.
  const cookie = await login('w2lists', 'callerpass1');
  const bad = await api('/api/auth/change-password', { method: 'POST', cookie, body: { current_password: 'wrong', new_password: 'freshpass22' } });
  assert.equal(bad.status, 401);
  const ok = await api('/api/auth/change-password', { method: 'POST', cookie, body: { current_password: 'callerpass1', new_password: 'freshpass22' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  await login('w2lists', 'freshpass22');
  const hash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(callerId).password_hash;
  assert.match(hash, /^\$2[aby]\$10\$/, 'bcrypt cost 10 preserved');
  // Admin reset (async hash) → must_change_password.
  const reset = await api(`/api/users/${callerId}`, { method: 'PATCH', cookie: adminCookie, body: { new_password: 'resetpass33' } });
  assert.equal(reset.status, 200);
  const after = await api('/api/auth/login', { method: 'POST', body: { username: 'w2lists', password: 'resetpass33' } });
  assert.equal(after.status, 200);
  assert.equal(after.data.must_change_password, true);
  // User create still validates the policy before hashing.
  const weak = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'weak1', full_name: 'Weak', password: 'admin123', role: 'caller' } });
  assert.equal(weak.status, 400);
  const created = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'strong1', full_name: 'Strong', password: 'strongpass44', role: 'caller' } });
  assert.equal(created.status, 200);
  await login('strong1', 'strongpass44');
});
