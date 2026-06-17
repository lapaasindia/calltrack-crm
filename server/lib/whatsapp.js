// Phase 6A — WhatsApp two-way inbox, embedded in the existing server process.
//
// DESIGN RULES (read before editing):
//  * Baileys is an UNOFFICIAL WhatsApp Web client and an OPTIONAL dependency.
//    It is ONLY ever loaded via a lazy `await import('baileys')` inside a
//    try/catch, and ONLY when getSetting('whatsapp_enabled') is true. The server
//    boot, `npm test`, and the boot smoke MUST stay green even if baileys is not
//    installed (offline). Never import baileys at module top-level.
//  * The message-handling core (extractMessage / linkOrCreateContact /
//    ingestMessage / persistOutgoing) is PURE and DB-only: it takes plain
//    objects and a db handle, never touches the network, and is fully unit
//    tested with FAKE payloads + a fake sender. startWhatsApp() is the only
//    function that talks to real baileys.
//  * Lead linking uses server/lib/phone.js (the single normalizer) — never a
//    fuzzy LIKE. A chat is linked to an EXISTING lead by phone; it NEVER
//    auto-creates a lead (that's an explicit promote action in the route).

import { normalizePhone } from './phone.js';
import { nowUtc } from './istTime.js';
import { recalcLeadScore } from './scoring.js';

const SESSION_ID = 'default';
const AUTH_SUBDIR = '.whatsapp-auth';

// ---------------------------------------------------------------------------
// JID helpers (pure)
// ---------------------------------------------------------------------------

// Groups (@g.us) and the status broadcast feed are never tracked as contacts.
export function isIgnorableJid(jid) {
  if (!jid || typeof jid !== 'string') return true;
  if (jid.endsWith('@g.us')) return true;           // group chat
  if (jid === 'status@broadcast') return true;       // status updates
  if (jid.endsWith('@broadcast')) return true;       // broadcast lists
  return false;
}

// '<number>@s.whatsapp.net' → the bare number string (digits, may include cc).
export function jidToNumber(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const at = jid.indexOf('@');
  const left = at === -1 ? jid : jid.slice(0, at);
  // Baileys device-suffixed jids look like '<num>:<device>@...'; drop the device.
  const num = left.split(':')[0].replace(/\D/g, '');
  return num || null;
}

// Best-effort normalized 10-digit phone from a jid (via phone.js). null if not.
export function jidToPhone(jid) {
  const num = jidToNumber(jid);
  if (!num) return null;
  const norm = normalizePhone(num);
  return norm.ok ? norm.phone : null;
}

// ---------------------------------------------------------------------------
// Message extraction (pure) — turns a raw Baileys/WAMessage into our flat shape.
// ---------------------------------------------------------------------------

// Map a Baileys message.message object to {message_type, body}. Media types
// become a readable placeholder (captions kept when present). Returns null for
// unsupported/empty content (e.g. protocol/reaction messages we don't store).
export function describeContent(message) {
  if (!message || typeof message !== 'object') return null;
  const m = message;

  if (typeof m.conversation === 'string' && m.conversation.length) {
    return { message_type: 'text', body: m.conversation };
  }
  if (m.extendedTextMessage && typeof m.extendedTextMessage.text === 'string') {
    return { message_type: 'text', body: m.extendedTextMessage.text };
  }
  if (m.imageMessage) {
    const cap = m.imageMessage.caption ? `: ${m.imageMessage.caption}` : '';
    return { message_type: 'image', body: `[image]${cap}` };
  }
  if (m.videoMessage) {
    const cap = m.videoMessage.caption ? `: ${m.videoMessage.caption}` : '';
    return { message_type: 'video', body: `[video]${cap}` };
  }
  if (m.documentMessage) {
    const name = m.documentMessage.fileName || m.documentMessage.title || '';
    return { message_type: 'document', body: `[document]${name ? `: ${name}` : ''}` };
  }
  if (m.audioMessage) {
    return { message_type: 'audio', body: m.audioMessage.ptt ? '[voice note]' : '[audio]' };
  }
  if (m.stickerMessage) {
    return { message_type: 'sticker', body: '[sticker]' };
  }
  if (m.locationMessage) {
    const { degreesLatitude: lat, degreesLongitude: lng } = m.locationMessage;
    const coords = (lat != null && lng != null) ? `: ${lat}, ${lng}` : '';
    return { message_type: 'location', body: `[location]${coords}` };
  }
  return null;
}

// Convert a Baileys WAMessage envelope into our normalized record, or null if it
// should be skipped (group/status/broadcast, no usable content, or missing id).
// Shape in: { key:{ id, remoteJid, fromMe, participant }, message, messageTimestamp, pushName }
// Shape out: { wa_message_id, jid, direction, message_type, body, sent_at, display_name }
export function extractMessage(rawMsg) {
  if (!rawMsg || typeof rawMsg !== 'object') return null;
  const key = rawMsg.key || {};
  const jid = key.remoteJid;
  if (isIgnorableJid(jid)) return null;
  if (!key.id) return null;

  const content = describeContent(rawMsg.message);
  if (!content) {
    // Unknown but non-empty message object → store as an 'unknown' placeholder so
    // the thread shows *something* happened; truly empty envelopes are skipped.
    if (!rawMsg.message || typeof rawMsg.message !== 'object') return null;
    return finalize(rawMsg, jid, key, { message_type: 'unknown', body: '[unsupported message]' });
  }
  return finalize(rawMsg, jid, key, content);
}

function finalize(rawMsg, jid, key, content) {
  // messageTimestamp is seconds (number or {low}/Long). Fall back to now.
  let sentAt = nowUtc();
  const ts = rawMsg.messageTimestamp;
  const secs = typeof ts === 'number' ? ts
    : (ts && typeof ts.toNumber === 'function') ? ts.toNumber()
      : (ts && typeof ts.low === 'number') ? ts.low
        : Number(ts);
  if (Number.isFinite(secs) && secs > 0) sentAt = new Date(secs * 1000).toISOString();

  return {
    wa_message_id: String(key.id),
    jid,
    direction: key.fromMe ? 'outgoing' : 'incoming',
    message_type: content.message_type,
    body: content.body,
    sent_at: sentAt,
    display_name: typeof rawMsg.pushName === 'string' ? rawMsg.pushName : null,
  };
}

// ---------------------------------------------------------------------------
// Contact / lead linking (impure: DB only, no network) — all idempotent.
// ---------------------------------------------------------------------------

// Find or create a wa_contacts row for a jid. Links to an EXISTING lead by phone
// (phone.js normalization), never creates a lead. Refreshes display_name/phone
// when we learn them. Returns the contact row.
export function linkOrCreateContact(db, jid, phone = null, displayName = null) {
  const now = nowUtc();
  const resolvedPhone = phone || jidToPhone(jid);

  let leadId = null;
  if (resolvedPhone) {
    const lead = db.prepare(
      'SELECT id FROM leads WHERE phone = ? AND deleted_at IS NULL'
    ).get(resolvedPhone);
    if (lead) leadId = lead.id;
  }

  const existing = db.prepare('SELECT * FROM wa_contacts WHERE wa_jid = ?').get(jid);
  if (existing) {
    // Backfill anything we didn't know before (phone, name, lead link) without
    // clobbering an already-set value.
    const phoneToSet = existing.phone || resolvedPhone || null;
    const nameToSet = displayName || existing.display_name || null;
    const leadToSet = existing.lead_id || leadId || null;
    if (phoneToSet !== existing.phone || nameToSet !== existing.display_name || leadToSet !== existing.lead_id) {
      db.prepare('UPDATE wa_contacts SET phone = ?, display_name = ?, lead_id = ? WHERE id = ?')
        .run(phoneToSet, nameToSet, leadToSet, existing.id);
    }
    return db.prepare('SELECT * FROM wa_contacts WHERE id = ?').get(existing.id);
  }

  const info = db.prepare(
    `INSERT INTO wa_contacts (wa_jid, phone, display_name, lead_id, first_seen_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(jid, resolvedPhone || null, displayName || null, leadId, now, null);
  return db.prepare('SELECT * FROM wa_contacts WHERE id = ?').get(info.lastInsertRowid);
}

// The calls table requires a non-null user_id. A WhatsApp event has no caller,
// so we attribute the mirrored note to the lead's owner, falling back to the
// lowest-id owner/admin (system) user. Returns a user id, or null if the DB has
// no users at all (in which case we skip the note rather than crash).
function attributionUser(db, lead) {
  if (lead?.assigned_to) return lead.assigned_to;
  const owner = db.prepare(
    "SELECT id FROM users WHERE role IN ('super_admin','admin') AND is_active = 1 ORDER BY id LIMIT 1"
  ).get();
  if (owner) return owner.id;
  const any = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  return any ? any.id : null;
}

// Mirror a WhatsApp message into the linked lead's timeline as a call_logs Note,
// matching how server/routes/calls.js writes a note row. disposition is required
// by the schema CHECK; we use 'connected' for a real contact event and tag the
// row source='whatsapp'. Also bumps leads.last_contacted + recomputes the score.
function mirrorToLead(db, leadId, msg, contact) {
  if (!leadId) return;
  const lead = db.prepare('SELECT id, assigned_to FROM leads WHERE id = ?').get(leadId);
  if (!lead) return;
  const userId = attributionUser(db, lead);
  const verb = msg.direction === 'incoming' ? 'incoming' : 'outgoing';
  const who = contact?.display_name || contact?.phone || jidToNumber(msg.jid) || 'contact';
  const note = `WhatsApp ${verb} (${who}): ${msg.body || `[${msg.message_type}]`}`;
  if (userId) {
    db.prepare(
      `INSERT INTO calls (lead_id, user_id, call_type, disposition, outcome, notes, duration_seconds, called_at, source, direction)
       VALUES (?, ?, 'support', 'connected', NULL, ?, NULL, ?, 'whatsapp', ?)`
    ).run(leadId, userId, note, msg.sent_at, msg.direction === 'incoming' ? 'incoming' : 'outgoing');
  }

  db.prepare('UPDATE leads SET last_contacted = ?, updated_at = ? WHERE id = ?')
    .run(msg.sent_at, nowUtc(), leadId);
  recalcLeadScore(db, leadId);
}

// Idempotent ingest of one extracted message. Upserts on wa_message_id, ensures
// a contact exists, links the lead, mirrors to the lead timeline (only for a
// linked lead), and bumps the contact's last_message_at. Returns
// { message, contact, created } — created=false means it was a duplicate no-op.
export function ingestMessage(db, extracted) {
  if (!extracted || !extracted.wa_message_id || !extracted.jid) {
    return { message: null, contact: null, created: false };
  }

  return db.transaction(() => {
    const contact = linkOrCreateContact(db, extracted.jid, null, extracted.display_name);

    const dup = db.prepare('SELECT * FROM wa_messages WHERE wa_message_id = ?')
      .get(extracted.wa_message_id);
    if (dup) {
      return { message: dup, contact, created: false };
    }

    const now = nowUtc();
    const info = db.prepare(
      `INSERT INTO wa_messages
         (contact_id, lead_id, wa_message_id, direction, message_type, body, raw_payload, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      contact.id, contact.lead_id || null, extracted.wa_message_id, extracted.direction,
      extracted.message_type, extracted.body || null,
      extracted.raw_payload != null ? extracted.raw_payload : null,
      extracted.sent_at, now
    );

    // Bump last_message_at (monotonic: never move it backwards on out-of-order history).
    if (!contact.last_message_at || extracted.sent_at > contact.last_message_at) {
      db.prepare('UPDATE wa_contacts SET last_message_at = ? WHERE id = ?')
        .run(extracted.sent_at, contact.id);
    }

    mirrorToLead(db, contact.lead_id, extracted, contact);

    const message = db.prepare('SELECT * FROM wa_messages WHERE id = ?').get(info.lastInsertRowid);
    const freshContact = db.prepare('SELECT * FROM wa_contacts WHERE id = ?').get(contact.id);
    return { message, contact: freshContact, created: true };
  })();
}

// Persist an outgoing message we are about to / just did send. Generates a local
// wa_message_id when the sender didn't return one. Mirrors to the lead the same
// way an inbound does. Returns { message, contact }.
export function persistOutgoing(db, contact, { body, wa_message_id, message_type = 'text', sent_at } = {}) {
  const now = nowUtc();
  const id = wa_message_id || `local:${SESSION_ID}:${now}:${Math.random().toString(36).slice(2, 10)}`;
  const when = sent_at || now;

  return db.transaction(() => {
    const dup = db.prepare('SELECT * FROM wa_messages WHERE wa_message_id = ?').get(id);
    if (dup) return { message: dup, contact };

    const info = db.prepare(
      `INSERT INTO wa_messages
         (contact_id, lead_id, wa_message_id, direction, message_type, body, raw_payload, sent_at, created_at)
       VALUES (?, ?, ?, 'outgoing', ?, ?, NULL, ?, ?)`
    ).run(contact.id, contact.lead_id || null, id, message_type, body || null, when, now);

    if (!contact.last_message_at || when > contact.last_message_at) {
      db.prepare('UPDATE wa_contacts SET last_message_at = ? WHERE id = ?').run(when, contact.id);
    }

    mirrorToLead(db, contact.lead_id, { direction: 'outgoing', body, message_type, sent_at: when, jid: contact.wa_jid }, contact);

    const message = db.prepare('SELECT * FROM wa_messages WHERE id = ?').get(info.lastInsertRowid);
    return { message, contact };
  })();
}

// ---------------------------------------------------------------------------
// Session state persistence (impure: DB only)
// ---------------------------------------------------------------------------

export function getSession(db) {
  ensureSessionRow(db);
  return db.prepare('SELECT * FROM wa_sessions WHERE id = ?').get(SESSION_ID);
}

function ensureSessionRow(db) {
  const row = db.prepare('SELECT id FROM wa_sessions WHERE id = ?').get(SESSION_ID);
  if (!row) {
    db.prepare(
      "INSERT INTO wa_sessions (id, status, updated_at) VALUES (?, 'disconnected', ?)"
    ).run(SESSION_ID, nowUtc());
  }
}

export function setSessionState(db, patch = {}) {
  ensureSessionRow(db);
  const allowed = ['status', 'qr_code', 'phone_number', 'display_name', 'last_error', 'connected_at'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in patch) { sets.push(`${k} = ?`); vals.push(patch[k]); }
  }
  sets.push('updated_at = ?');
  vals.push(nowUtc());
  db.prepare(`UPDATE wa_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, SESSION_ID);
  return db.prepare('SELECT * FROM wa_sessions WHERE id = ?').get(SESSION_ID);
}

// Wipe contacts + messages + auth (the owner "Reset" action). Auth dir removal is
// best-effort and injectable for tests.
export function resetWhatsApp(db, { dataDir, rmDir } = {}) {
  db.transaction(() => {
    db.prepare('DELETE FROM wa_messages').run();
    db.prepare('DELETE FROM wa_contacts').run();
    setSessionState(db, { status: 'disconnected', qr_code: null, phone_number: null, display_name: null, last_error: null, connected_at: null });
  })();
  if (dataDir && typeof rmDir === 'function') {
    try { rmDir(dataDir); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Live Baileys runtime (impure, network) — the ONLY part that touches baileys.
// ---------------------------------------------------------------------------

// Module-level handle so routes can call into the live socket (send / logout).
let runtime = null; // { sock, stopping }

export function getRuntime() {
  return runtime;
}

// Start (or no-op). Guard: only runs when whatsapp_enabled. Lazy-imports baileys
// in a try/catch — a missing/broken module sets an 'error' status and returns
// rather than crashing the server. `deps` is injectable for tests so we can drive
// the connection/message handlers with a fake socket and NEVER load real baileys.
export async function startWhatsApp(db, {
  getSetting,
  dataDir,
  baileysFactory,   // optional: async () => baileys module (tests inject a fake)
  qrToDataUrl,      // optional: async (str) => dataUrl (tests inject a fake)
  logger,
} = {}) {
  const log = logger || console;
  if (!getSetting || getSetting('whatsapp_enabled') !== true) {
    return { started: false, reason: 'disabled' };
  }
  if (runtime && runtime.sock) {
    return { started: false, reason: 'already_running' };
  }

  let baileys;
  let qrcode;
  // Baileys requires a pino-compatible logger (it calls logger.child()). Create a
  // silent one lazily; fall back to a console shim with a no-op child().
  let waLogger = makeConsoleLogger(log);
  try {
    baileys = baileysFactory ? await baileysFactory() : await import('baileys');
    if (!qrToDataUrl) {
      const mod = await import('qrcode');
      qrcode = mod.default || mod;
    }
    try {
      const pinoMod = await import('pino');
      const pino = pinoMod.default || pinoMod;
      waLogger = pino({ level: 'silent' });
    } catch { /* keep the console shim */ }
  } catch (err) {
    // Offline / dependency missing: degrade gracefully, never crash the boot.
    setSessionState(db, { status: 'error', last_error: `WhatsApp library unavailable: ${err.message}` });
    log.warn?.('[whatsapp] baileys/qrcode not available — staying disconnected:', err.message);
    return { started: false, reason: 'library_unavailable', error: err.message };
  }

  const renderQr = qrToDataUrl || ((s) => qrcode.toDataURL(s, { width: 260, margin: 1 }));

  const makeWASocket = baileys.makeWASocket || baileys.default;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

  let authDir;
  try {
    const path = await import('node:path');
    authDir = path.join(dataDir, AUTH_SUBDIR);
    const fs = await import('node:fs');
    fs.mkdirSync(authDir, { recursive: true });
  } catch (err) {
    setSessionState(db, { status: 'error', last_error: `auth dir: ${err.message}` });
    return { started: false, reason: 'auth_dir_failed', error: err.message };
  }

  setSessionState(db, { status: 'connecting', last_error: null, qr_code: null });

  let reconnectDelay = 2000;
  const MAX_DELAY = 60000;

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use lib default */ }

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger: waLogger,
      browser: ['CallTrack CRM', 'Chrome', '1.0'],
    });
    runtime = { sock, stopping: false };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      try {
        if (qr) {
          const dataUrl = await renderQr(qr);
          setSessionState(db, { status: 'qr_pending', qr_code: dataUrl });
        }
        if (connection === 'open') {
          reconnectDelay = 2000;
          const me = sock.user || {};
          setSessionState(db, {
            status: 'connected',
            qr_code: null,
            last_error: null,
            phone_number: jidToNumber(me.id) || null,
            display_name: me.name || me.verifiedName || null,
            connected_at: nowUtc(),
          });
        }
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === (DisconnectReason?.loggedOut ?? 401);
          if (loggedOut) {
            setSessionState(db, { status: 'logged_out', qr_code: null, last_error: 'Logged out on the phone' });
            runtime = null;
          } else if (!runtime?.stopping) {
            setSessionState(db, { status: 'connecting', last_error: lastDisconnect?.error?.message || null });
            const delay = reconnectDelay;
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
            setTimeout(() => { connect().catch((e) => log.error?.('[whatsapp] reconnect failed:', e.message)); }, delay).unref?.();
          }
        }
      } catch (err) {
        log.error?.('[whatsapp] connection.update handler error:', err.message);
      }
    });

    sock.ev.on('messages.upsert', (payload) => {
      try {
        if (!payload || (payload.type !== 'notify' && payload.type !== 'append')) return;
        for (const raw of payload.messages || []) {
          const extracted = extractMessage(raw);
          if (!extracted) continue;
          extracted.raw_payload = safeStringify(raw);
          ingestMessage(db, extracted);
        }
      } catch (err) {
        log.error?.('[whatsapp] messages.upsert handler error:', err.message);
      }
    });

    return sock;
  }

  try {
    await connect();
    return { started: true };
  } catch (err) {
    setSessionState(db, { status: 'error', last_error: err.message });
    log.error?.('[whatsapp] failed to start:', err.message);
    return { started: false, reason: 'connect_failed', error: err.message };
  }
}

function safeStringify(obj) {
  try { return JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v)); }
  catch { return null; }
}

// A minimal pino-shaped logger backed by console, including a child() that
// returns itself — Baileys calls logger.child() and the level methods.
function makeConsoleLogger(base = console) {
  const noop = () => {};
  const shim = {
    level: 'silent',
    trace: noop, debug: noop, info: noop,
    warn: (...a) => base.warn?.(...a),
    error: (...a) => base.error?.(...a),
    fatal: (...a) => base.error?.(...a),
    child() { return shim; },
  };
  return shim;
}

// Send a text to a contact/lead and persist it. `sender` is injectable for tests
// (default uses the live runtime socket). Requires a connected session unless a
// sender is injected. Throws on bad input / not-connected.
export async function sendText(db, { leadId, contactId, body } = {}, { sender } = {}) {
  const text = String(body ?? '').trim();
  if (!text) { const e = new Error('Message body required'); e.status = 400; throw e; }

  let contact = null;
  if (contactId) {
    contact = db.prepare('SELECT * FROM wa_contacts WHERE id = ?').get(Number(contactId));
  } else if (leadId) {
    contact = db.prepare('SELECT * FROM wa_contacts WHERE lead_id = ? ORDER BY last_message_at DESC, id DESC LIMIT 1')
      .get(Number(leadId));
  }
  if (!contact) { const e = new Error('No WhatsApp contact for that target'); e.status = 404; throw e; }

  // Resolve the send function: injected sender (tests) or the live socket.
  const send = sender || (async (jid, msg) => {
    const live = runtime?.sock;
    const session = getSession(db);
    if (!live || session.status !== 'connected') {
      const e = new Error('WhatsApp is not connected'); e.status = 409; throw e;
    }
    return live.sendMessage(jid, { text: msg });
  });

  const result = await send(contact.wa_jid, text);
  const waId = result?.key?.id || result?.id || null;
  return persistOutgoing(db, contact, { body: text, wa_message_id: waId, message_type: 'text' });
}

// Logout the live session (best-effort) and mark logged_out.
export async function logoutWhatsApp(db) {
  try {
    if (runtime?.sock?.logout) { runtime.stopping = true; await runtime.sock.logout(); }
  } catch { /* ignore */ }
  runtime = null;
  setSessionState(db, { status: 'logged_out', qr_code: null });
}

// Test hook: clear the module-level runtime so the next start is clean.
export function _resetRuntimeForTests() {
  runtime = null;
}
