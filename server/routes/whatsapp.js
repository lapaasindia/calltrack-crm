// Phase 6A — WhatsApp inbox API. Mounted at /api/whatsapp in server/app.js.
//
// Tiers (reusing the existing middleware/permissions):
//   * Session lifecycle (start / logout / reset) is OWNER only (super_admin|admin)
//     — it reconfigures an account-level integration.
//   * Reading the inbox + sending + promoting a chat to a lead is ADMIN tier
//     (super_admin|admin|manager): they run the team and handle conversations.
//   * status / unread are readable by any authenticated user (the mobile poll
//     and the nav gate need them) but reveal no message content beyond a latest
//     preview the user is allowed to see.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import db, { getSetting, setSetting } from '../db.js';
import { DATA_DIR } from '../db.js';
import { requireOwner, requireAdmin } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';
import { recalcLeadScore } from '../lib/scoring.js';
import { logAudit } from '../lib/audit.js';
import { isAdmin } from '../lib/permissions.js';
import {
  getSession, setSessionState, resetWhatsApp, startWhatsApp,
  logoutWhatsApp, sendText, jidToPhone, engineInstalled,
} from '../lib/whatsapp.js';

const router = Router();

const AUTH_DIR = path.join(DATA_DIR, '.whatsapp-auth');

// Shape a session row for the client (the QR is a data URL safe to render).
function sessionView(s) {
  return {
    status: s?.status || 'disconnected',
    qr_code: s?.status === 'qr_pending' ? (s.qr_code || null) : null,
    phone_number: s?.phone_number || null,
    display_name: s?.display_name || null,
    last_error: s?.last_error || null,
    connected_at: s?.connected_at || null,
    enabled: getSetting('whatsapp_enabled', false) === true,
    // Whether the optional WhatsApp engine is installed on this server. The web
    // UI uses this to show "install it on the office computer" instead of a Connect
    // button on machines that aren't the designated WhatsApp host.
    engine_installed: engineInstalled(),
  };
}

// ---------- STATUS (any authenticated user) ----------
router.get('/status', (req, res) => {
  res.json(sessionView(getSession(db)));
});

// ---------- START / ENABLE + begin pairing (owner) ----------
router.post('/start', requireOwner, async (req, res) => {
  // WhatsApp is installed only on the office "main" computer, on purpose. If the
  // engine isn't present, say so clearly instead of failing with a cryptic
  // "module not found" — and don't flip the flag on.
  if (!engineInstalled()) {
    return res.status(400).json({
      error: 'WhatsApp engine is not installed on this server. On the office computer, run: npm run whatsapp:install — then try Connect again.',
    });
  }
  setSetting('whatsapp_enabled', true);
  setSessionState(db, { status: 'connecting', last_error: null, qr_code: null });
  logAudit({ action: 'WHATSAPP_START', user: req.user, entity_type: 'whatsapp', entity_id: 'default', ip: req.ip });
  // Best-effort start; if baileys is absent this degrades to an 'error' status
  // (the helper never throws). Don't block the response on the socket handshake.
  startWhatsApp(db, { getSetting, dataDir: DATA_DIR })
    .catch((e) => console.error('[whatsapp] start error:', e.message));
  res.json(sessionView(getSession(db)));
});

// ---------- LOGOUT (owner) ----------
router.post('/logout', requireOwner, async (req, res) => {
  await logoutWhatsApp(db);
  setSetting('whatsapp_enabled', false);
  logAudit({ action: 'WHATSAPP_LOGOUT', user: req.user, entity_type: 'whatsapp', entity_id: 'default', ip: req.ip });
  res.json(sessionView(getSession(db)));
});

// ---------- RESET (owner): wipe contacts/messages + auth ----------
router.post('/reset', requireOwner, async (req, res) => {
  await logoutWhatsApp(db).catch(() => {});
  resetWhatsApp(db, {
    dataDir: AUTH_DIR,
    rmDir: (d) => fs.rmSync(d, { recursive: true, force: true }),
  });
  setSetting('whatsapp_enabled', false);
  logAudit({ action: 'WHATSAPP_RESET', user: req.user, entity_type: 'whatsapp', entity_id: 'default', ip: req.ip });
  res.json(sessionView(getSession(db)));
});

// ---------- SEND (admin tier) ----------
router.post('/send-message', requireAdmin, async (req, res) => {
  try {
    const { leadId, contactId, body } = req.body || {};
    if (!leadId && !contactId) return res.status(400).json({ error: 'leadId or contactId required' });
    const { message, contact } = await sendText(db, {
      leadId: leadId ? Number(leadId) : undefined,
      contactId: contactId ? Number(contactId) : undefined,
      body,
    });
    logAudit({
      action: 'WHATSAPP_SEND', user: req.user, entity_type: 'wa_contact', entity_id: contact.id,
      details: { lead_id: contact.lead_id || null }, ip: req.ip,
    });
    res.json({ ok: true, message, contact_id: contact.id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Send failed' });
  }
});

// ---------- INBOX LIST (admin tier) ----------
router.get('/contacts', requireAdmin, (req, res) => {
  const where = [];
  const params = [];
  const q = String(req.query.search || req.query.q || '').trim();
  if (q) {
    where.push('(c.display_name LIKE ? OR c.phone LIKE ? OR c.wa_jid LIKE ? OR l.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT c.*, l.name AS lead_name, l.stage AS lead_stage,
       (SELECT body FROM wa_messages m WHERE m.contact_id = c.id ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS last_body,
       (SELECT direction FROM wa_messages m WHERE m.contact_id = c.id ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS last_direction
     FROM wa_contacts c
     LEFT JOIN leads l ON l.id = c.lead_id
     ${whereSql}
     ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
     LIMIT 200`
  ).all(...params);
  res.json(rows);
});

// ---------- THREAD (admin tier) ----------
router.get('/contacts/:id/messages', requireAdmin, (req, res) => {
  const contact = db.prepare(
    `SELECT c.*, l.name AS lead_name, l.stage AS lead_stage, l.phone AS lead_phone,
            l.score AS lead_score, l.assigned_to AS lead_assigned_to
     FROM wa_contacts c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.id = ?`
  ).get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const messages = db.prepare(
    'SELECT id, direction, message_type, body, sent_at, created_at FROM wa_messages WHERE contact_id = ? ORDER BY sent_at, id'
  ).all(contact.id);
  res.json({ contact, messages });
});

// ---------- PROMOTE CHAT → LEAD (admin tier) ----------
router.post('/contacts/:id/create-lead', requireAdmin, (req, res) => {
  const contact = db.prepare('SELECT * FROM wa_contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (contact.lead_id) {
    const lead = db.prepare('SELECT id, name FROM leads WHERE id = ?').get(contact.lead_id);
    if (lead && !lead.deleted_at) return res.status(409).json({ error: 'Chat already linked to a lead', lead_id: contact.lead_id });
  }

  // Prefer the already-normalized contact phone; fall back to normalizing the jid
  // (phone.js) rather than the raw jid number, so a +91 number that wasn't
  // normalized at ingest can still be promoted consistently with lead linking.
  const phone = contact.phone || jidToPhone(contact.wa_jid);
  if (!phone || phone.length !== 10) {
    return res.status(400).json({ error: 'This chat has no valid Indian phone to create a lead from' });
  }

  // If a live lead already has this phone, just link to it (don't create a dup).
  const existing = db.prepare('SELECT id, name FROM leads WHERE phone = ? AND deleted_at IS NULL').get(phone);

  const now = nowUtc();
  const result = db.transaction(() => {
    let leadId;
    let created = false;
    if (existing) {
      leadId = existing.id;
    } else {
      const name = String(req.body?.name || contact.display_name || `WhatsApp ${phone}`).trim().slice(0, 120) || `WhatsApp ${phone}`;
      // Seed notes with the first inbound message so context isn't lost.
      const firstInbound = db.prepare(
        "SELECT body, sent_at FROM wa_messages WHERE contact_id = ? AND direction = 'incoming' ORDER BY sent_at, id LIMIT 1"
      ).get(contact.id);
      const notes = firstInbound?.body ? `First WhatsApp message: ${firstInbound.body}` : 'Created from a WhatsApp chat.';
      const info = db.prepare(
        `INSERT INTO leads (name, phone, phone_raw, source, stage, score, assigned_to, notes, last_contacted, created_at, updated_at)
         VALUES (?, ?, ?, 'WhatsApp', 'new', 50, ?, ?, ?, ?, ?)`
      ).run(name, phone, contact.wa_jid, req.user.id, notes, contact.last_message_at || now, now, now);
      leadId = info.lastInsertRowid;
      created = true;
    }
    // Back-link the contact + all its messages to the lead.
    db.prepare('UPDATE wa_contacts SET lead_id = ? WHERE id = ?').run(leadId, contact.id);
    db.prepare('UPDATE wa_messages SET lead_id = ? WHERE contact_id = ?').run(leadId, contact.id);
    recalcLeadScore(db, leadId);
    return { leadId, created };
  })();

  logAudit({
    action: result.created ? 'WHATSAPP_LEAD_CREATED' : 'WHATSAPP_LEAD_LINKED',
    user: req.user, entity_type: 'lead', entity_id: result.leadId,
    details: { contact_id: contact.id, phone }, ip: req.ip,
  });
  res.json({ ok: true, lead_id: result.leadId, created: result.created });
});

// ---------- UNREAD (any authenticated user; used by the mobile poll) ----------
// "Unread" here = inbound messages newer than this user's last poll watermark,
// which the client stores; server returns the latest inbound + a recent count so
// the mobile foreground service can fire a local notification. Scoping: admin
// tier sees all; others see only inbound on leads assigned to them.
router.get('/unread', (req, res) => {
  if (getSetting('whatsapp_enabled', false) !== true) {
    return res.json({ enabled: false, count: 0, latest: null });
  }
  const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : null;
  const params = [];
  const conds = ["m.direction = 'incoming'"];
  if (since) { conds.push('m.sent_at > ?'); params.push(since); }
  if (!isAdmin(req.user.role)) {
    conds.push('l.assigned_to = ?');
    params.push(req.user.id);
  }
  const whereSql = `WHERE ${conds.join(' AND ')}`;
  const count = db.prepare(
    `SELECT COUNT(*) AS n FROM wa_messages m
     LEFT JOIN leads l ON l.id = m.lead_id ${whereSql}`
  ).get(...params).n;
  const latest = db.prepare(
    `SELECT m.id, m.contact_id, m.body, m.sent_at, c.display_name, c.phone
     FROM wa_messages m
     JOIN wa_contacts c ON c.id = m.contact_id
     LEFT JOIN leads l ON l.id = m.lead_id
     ${whereSql}
     ORDER BY m.sent_at DESC, m.id DESC LIMIT 1`
  ).get(...params) || null;
  res.json({ enabled: true, count, latest });
});

export default router;
