// Phase 6A — WhatsApp two-way inbox. Runs against a real server on a throwaway DB.
// NO real baileys, NO network: every payload + socket is FAKE. The Baileys lazy
// import is never exercised — we test the PURE core (extractMessage,
// ingestMessage, persistOutgoing) and the route layer directly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-whatsapp-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

const { ensureBootstrapped } = await import('../bootstrap.js');
ensureBootstrapped();
const db = (await import('../db.js')).default;
const { setSetting } = await import('../db.js');
const wa = await import('../lib/whatsapp.js');

let baseUrl;
let server;
let adminCookie;
let managerCookie;
let callerCookie;
let callerId;
let managerId;

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

// Build a fake Baileys WAMessage envelope.
function fakeMsg({ id, jid = '919876512345@s.whatsapp.net', fromMe = false, text, message, ts = 1700000000, pushName = 'Test User' }) {
  return {
    key: { id, remoteJid: jid, fromMe },
    message: message ?? (text != null ? { conversation: text } : undefined),
    messageTimestamp: ts,
    pushName,
  };
}

before(async () => {
  const { createApp } = await import('../app.js');
  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await loginCapture('admin', 'admin123');

  const bcrypt = (await import('bcryptjs')).default;
  const now = new Date().toISOString();
  managerId = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
     VALUES ('mgr1', ?, 'Manager One', 'manager', 1, ?)`
  ).run(bcrypt.hashSync('pw12345', 8), now).lastInsertRowid;
  managerCookie = await loginCapture('mgr1', 'pw12345');

  callerId = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
     VALUES ('caller1', ?, 'Caller One', 'caller', 1, ?)`
  ).run(bcrypt.hashSync('pw12345', 8), now).lastInsertRowid;
  callerCookie = await loginCapture('caller1', 'pw12345');

  setSetting('whatsapp_enabled', true);
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PURE helpers
// ---------------------------------------------------------------------------

test('extractMessage parses text, a media placeholder, and skips group/status', () => {
  const txt = wa.extractMessage(fakeMsg({ id: 'm1', text: 'Hello there' }));
  assert.equal(txt.message_type, 'text');
  assert.equal(txt.body, 'Hello there');
  assert.equal(txt.direction, 'incoming');
  assert.equal(txt.wa_message_id, 'm1');

  const img = wa.extractMessage(fakeMsg({
    id: 'm2', message: { imageMessage: { caption: 'see this' } },
  }));
  assert.equal(img.message_type, 'image');
  assert.match(img.body, /\[image\]: see this/);

  const doc = wa.extractMessage(fakeMsg({
    id: 'm3', message: { documentMessage: { fileName: 'quote.pdf' } },
  }));
  assert.equal(doc.message_type, 'document');
  assert.match(doc.body, /quote\.pdf/);

  // Groups + status broadcast are skipped.
  assert.equal(wa.extractMessage(fakeMsg({ id: 'g1', jid: '12345@g.us', text: 'hi group' })), null);
  assert.equal(wa.extractMessage(fakeMsg({ id: 's1', jid: 'status@broadcast', text: 'status' })), null);

  // Outgoing direction from fromMe.
  const out = wa.extractMessage(fakeMsg({ id: 'm4', fromMe: true, text: 'reply' }));
  assert.equal(out.direction, 'outgoing');
});

test('ingestMessage is idempotent on wa_message_id', () => {
  const extracted = wa.extractMessage(fakeMsg({ id: 'dup1', jid: '919811111111@s.whatsapp.net', text: 'first' }));
  const a = wa.ingestMessage(db, extracted);
  assert.equal(a.created, true);
  const b = wa.ingestMessage(db, extracted);
  assert.equal(b.created, false, 'second ingest of the same wa_message_id is a no-op');

  const count = db.prepare('SELECT COUNT(*) AS n FROM wa_messages WHERE wa_message_id = ?').get('dup1').n;
  assert.equal(count, 1);
});

test('ingestMessage links to an existing lead by phone, writes a call note + recomputes score', () => {
  // A lead exists with phone 9876543210; an inbound from that number must link.
  const now = new Date().toISOString();
  const leadId = db.prepare(
    `INSERT INTO leads (name, phone, source, assigned_to, created_at, updated_at)
     VALUES ('Phone Lead', '9876543210', 'manual', ?, ?, ?)`
  ).run(callerId, now, now).lastInsertRowid;
  const beforeScore = db.prepare('SELECT score FROM leads WHERE id = ?').get(leadId).score;

  const extracted = wa.extractMessage(fakeMsg({ id: 'link1', jid: '919876543210@s.whatsapp.net', text: 'I am interested' }));
  const r = wa.ingestMessage(db, extracted);
  assert.equal(r.created, true);
  assert.equal(r.contact.lead_id, leadId, 'contact linked to the matching lead by normalized phone');
  assert.equal(r.message.lead_id, leadId);

  // A call_logs Note was mirrored, attributed to the lead owner, source whatsapp.
  const note = db.prepare(
    "SELECT * FROM calls WHERE lead_id = ? AND source = 'whatsapp' ORDER BY id DESC LIMIT 1"
  ).get(leadId);
  assert.ok(note, 'mirrored call note exists');
  assert.equal(note.user_id, callerId, 'attributed to the lead owner');
  assert.match(note.notes, /WhatsApp incoming/);
  assert.match(note.notes, /I am interested/);

  // last_contacted bumped + score recomputed (engagement makes it non-decreasing).
  const lead = db.prepare('SELECT score, last_contacted FROM leads WHERE id = ?').get(leadId);
  assert.ok(lead.last_contacted, 'last_contacted bumped');
  assert.ok(lead.score >= beforeScore, 'score recomputed (not lower)');
});

test('ingestMessage does NOT auto-create a lead for an unknown number', () => {
  const extracted = wa.extractMessage(fakeMsg({ id: 'nolead1', jid: '919800000000@s.whatsapp.net', text: 'random' }));
  const r = wa.ingestMessage(db, extracted);
  assert.equal(r.created, true);
  assert.equal(r.contact.lead_id, null, 'no lead auto-created');
  const leadByPhone = db.prepare("SELECT id FROM leads WHERE phone = '9800000000'").get();
  assert.equal(leadByPhone, undefined, 'no lead row materialized');
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('status endpoint returns the session shape', async () => {
  const res = await api('/api/whatsapp/status', { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.ok('status' in res.data);
  assert.equal(res.data.enabled, true);
  assert.ok(['disconnected', 'qr_pending', 'connecting', 'connected', 'logged_out', 'error'].includes(res.data.status));
});

test('inbox list is admin tier; caller is 403', async () => {
  const denied = await api('/api/whatsapp/contacts', { cookie: callerCookie });
  assert.equal(denied.status, 403);

  const ok = await api('/api/whatsapp/contacts', { cookie: managerCookie });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.data));
  assert.ok(ok.data.length >= 1, 'contacts from earlier ingests are listed');
});

test('send-message gating: caller 403; admin requires connected (409 when not)', async () => {
  // Find a contact id to send to.
  const contacts = await api('/api/whatsapp/contacts', { cookie: adminCookie });
  const contactId = contacts.data[0].id;

  const denied = await api('/api/whatsapp/send-message', {
    method: 'POST', cookie: callerCookie, body: { contactId, body: 'hi' },
  });
  assert.equal(denied.status, 403, 'caller cannot send');

  // Session is not 'connected' (no live socket) → 409.
  const notConnected = await api('/api/whatsapp/send-message', {
    method: 'POST', cookie: adminCookie, body: { contactId, body: 'hi' },
  });
  assert.equal(notConnected.status, 409, 'send requires a connected session');
});

test('sendText persists an outgoing message + note when a fake sender is injected', async () => {
  const now = new Date().toISOString();
  const leadId = db.prepare(
    `INSERT INTO leads (name, phone, source, assigned_to, created_at, updated_at)
     VALUES ('Send Lead', '9123456780', 'manual', ?, ?, ?)`
  ).run(callerId, now, now).lastInsertRowid;
  // Seed a contact for the lead via an inbound ingest.
  wa.ingestMessage(db, wa.extractMessage(fakeMsg({ id: 'send-in1', jid: '919123456780@s.whatsapp.net', text: 'hi' })));

  let sentTo = null;
  const fakeSender = async (jid, text) => { sentTo = { jid, text }; return { key: { id: 'sent-server-1' } }; };
  const { message, contact } = await wa.sendText(db, { leadId, body: 'Thanks for reaching out' }, { sender: fakeSender });

  assert.equal(message.direction, 'outgoing');
  assert.equal(message.wa_message_id, 'sent-server-1');
  assert.equal(sentTo.jid, '919123456780@s.whatsapp.net');
  assert.equal(sentTo.text, 'Thanks for reaching out');
  assert.equal(contact.lead_id, leadId);

  const note = db.prepare(
    "SELECT * FROM calls WHERE lead_id = ? AND source = 'whatsapp' AND direction = 'outgoing' ORDER BY id DESC LIMIT 1"
  ).get(leadId);
  assert.ok(note, 'outgoing mirrored as a call note');
  assert.match(note.notes, /WhatsApp outgoing/);
});

test('create-lead promotes a chat + back-links contact and messages', async () => {
  // Unknown-number chat with an inbound message.
  wa.ingestMessage(db, wa.extractMessage(fakeMsg({
    id: 'promote-in1', jid: '919765432100@s.whatsapp.net', text: 'I want a demo', pushName: 'Demo Prospect',
  })));
  const contact = db.prepare("SELECT * FROM wa_contacts WHERE wa_jid = '919765432100@s.whatsapp.net'").get();
  assert.equal(contact.lead_id, null, 'not linked yet');

  const denied = await api(`/api/whatsapp/contacts/${contact.id}/create-lead`, {
    method: 'POST', cookie: callerCookie, body: {},
  });
  assert.equal(denied.status, 403, 'promote is admin tier');

  const res = await api(`/api/whatsapp/contacts/${contact.id}/create-lead`, {
    method: 'POST', cookie: adminCookie, body: { name: 'Demo Prospect' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.created, true);
  const leadId = res.data.lead_id;

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  assert.equal(lead.source, 'WhatsApp');
  assert.equal(lead.stage, 'new');
  // Seeded at 50, then recalcLeadScore runs — score is a valid 0..100 number.
  assert.ok(Number.isInteger(lead.score) && lead.score >= 0 && lead.score <= 100, 'score is valid after recalc');
  assert.equal(lead.assigned_to, 1, 'owner = the promoting admin (user id 1)');
  assert.match(lead.notes, /First WhatsApp message: I want a demo/);

  // Back-links.
  const relinked = db.prepare('SELECT lead_id FROM wa_contacts WHERE id = ?').get(contact.id);
  assert.equal(relinked.lead_id, leadId);
  const msgs = db.prepare('SELECT lead_id FROM wa_messages WHERE contact_id = ?').all(contact.id);
  assert.ok(msgs.every((m) => m.lead_id === leadId), 'all messages back-linked');

  // Re-promoting the same chat is a 409 (already linked).
  const again = await api(`/api/whatsapp/contacts/${contact.id}/create-lead`, {
    method: 'POST', cookie: adminCookie, body: {},
  });
  assert.equal(again.status, 409);
});

test('thread endpoint returns contact + ordered messages', async () => {
  const contact = db.prepare("SELECT * FROM wa_contacts WHERE wa_jid = '919876543210@s.whatsapp.net'").get();
  const res = await api(`/api/whatsapp/contacts/${contact.id}/messages`, { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.contact.id, contact.id);
  assert.ok(Array.isArray(res.data.messages));
  assert.ok(res.data.messages.length >= 1);
});

test('unread endpoint counts inbound and scopes for non-admins', async () => {
  // Admin sees all inbound.
  const all = await api('/api/whatsapp/unread', { cookie: adminCookie });
  assert.equal(all.status, 200);
  assert.equal(all.data.enabled, true);
  assert.ok(all.data.count >= 1);

  // Caller sees only inbound on their own leads (lead 9876543210 is caller1's).
  const mine = await api('/api/whatsapp/unread', { cookie: callerCookie });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.count >= 1, 'caller sees inbound on their assigned lead');

  // since= filter excludes everything in the far future.
  const none = await api(`/api/whatsapp/unread?since=${encodeURIComponent('2999-01-01T00:00:00.000Z')}`, { cookie: adminCookie });
  assert.equal(none.data.count, 0);
});

test('startWhatsApp stays safe when the baileys factory throws (offline)', async () => {
  wa._resetRuntimeForTests();
  const r = await wa.startWhatsApp(db, {
    getSetting: () => true,
    dataDir: process.env.CRM_DATA_DIR,
    baileysFactory: async () => { throw new Error('module not found'); },
  });
  assert.equal(r.started, false);
  assert.equal(r.reason, 'library_unavailable');
  const session = db.prepare("SELECT * FROM wa_sessions WHERE id = 'default'").get();
  assert.equal(session.status, 'error');
  assert.match(session.last_error, /unavailable/);
});

test('startWhatsApp is a no-op when whatsapp_enabled is false', async () => {
  wa._resetRuntimeForTests();
  const r = await wa.startWhatsApp(db, { getSetting: () => false, dataDir: process.env.CRM_DATA_DIR });
  assert.equal(r.started, false);
  assert.equal(r.reason, 'disabled');
});
