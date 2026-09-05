// Review queues: captured unknown-number calls (create lead / ignore),
// recordings that couldn't be confidently matched, and auto-logged calls
// awaiting an outcome. Plus authenticated audio streaming.
import { Router } from 'express';
import path from 'node:path';
import db from '../db.js';
import { canAccessLead, requireWriter } from '../middleware/auth.js';
import { signMediaTicket } from '../lib/mediaTicket.js';
import { nowUtc } from '../lib/istTime.js';
import { findLeadCandidatesBatch } from '../lib/leadMatch.js';
import { recalcLeadScore } from '../lib/scoring.js';
import { isAdmin, canSeeAllLeads } from '../lib/permissions.js';
import { CALL_TYPES, OUTCOMES } from './calls.js';
import { RECORDINGS_BASE } from './sync.js';
import { playableInfo, contentTypeFor } from '../lib/transcode.js';
import { bump as bumpCache } from '../lib/cache.js';

const router = Router();
router.use(requireWriter);

// Admin tier (super_admin/admin/manager) reviews the whole team's queues;
// everyone else only their own captures/recordings/calls (SCALE-9: this used
// to test the literal 'admin', downgrading super_admin and manager).
const seesAll = (req) => canSeeAllLeads(req.user.role);
const scope = (req, col = 'user_id') =>
  seesAll(req) ? { clause: '', params: [] } : { clause: `AND ${col} = ?`, params: [req.user.id] };
const ownsRow = (req, row) => seesAll(req) || row.user_id === req.user.id;

// Move every pending captured call from `phone` onto `leadId` as real
// (auto-logged) call rows — dedup-safe via idx_calls_mobile_dedupe — and relink
// their recordings. Shared by "create lead" and "attach to existing lead".
function mergeCapturedIntoLead(leadId, phone) {
  const siblings = db.prepare(
    "SELECT * FROM captured_calls WHERE phone = ? AND status = 'pending'"
  ).all(phone);
  const insertCall = db.prepare(
    `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at,
                        source, direction, call_log_ts, device_id, auto_logged, duration_seconds)
     VALUES (?, ?, 'sales', ?, ?, 'mobile', ?, ?, ?, 1, ?)
     ON CONFLICT DO NOTHING`
  );
  for (const c of siblings) {
    insertCall.run(
      leadId, c.user_id, c.duration_seconds > 0 ? 'connected' : 'not_picked',
      new Date(c.call_log_ts).toISOString(), c.direction, c.call_log_ts, c.device_id,
      c.duration_seconds
    );
    const callRow = db.prepare(
      "SELECT id FROM calls WHERE device_id = ? AND user_id = ? AND call_log_ts = ? AND lead_id = ? AND source = 'mobile'"
    ).get(c.device_id, c.user_id, c.call_log_ts, leadId);
    db.prepare("UPDATE captured_calls SET status = 'lead_created', created_lead_id = ? WHERE id = ?")
      .run(leadId, c.id);
    if (callRow) {
      db.prepare(
        `UPDATE recordings SET call_id = ?, captured_call_id = NULL, match_status = 'matched'
         WHERE captured_call_id = ?`
      ).run(callRow.id, c.id);
    }
  }
}

// Badge counts for the nav.
router.get('/summary', (req, res) => {
  const s = scope(req);
  const captured = db.prepare(
    `SELECT COUNT(*) n FROM captured_calls WHERE status = 'pending' ${s.clause}`
  ).get(...s.params).n;
  const recordings = db.prepare(
    `SELECT COUNT(*) n FROM recordings WHERE match_status IN ('ambiguous','unmatched') ${s.clause}`
  ).get(...s.params).n;
  const untagged = db.prepare(
    `SELECT COUNT(*) n FROM calls
     WHERE auto_logged = 1 AND disposition = 'connected' AND outcome IS NULL ${s.clause}`
  ).get(...s.params).n;
  res.json({ captured, recordings, untagged, total: captured + recordings + untagged });
});

// ---------- captured (unknown-number) calls ----------
router.get('/captured', (req, res) => {
  const s = scope(req, 'c.user_id');
  const rows = db.prepare(
    `SELECT c.*, u.full_name AS user_name,
       (SELECT COUNT(*) FROM recordings r WHERE r.captured_call_id = c.id) AS recording_count,
       (SELECT COUNT(*) FROM captured_calls c2
         WHERE c2.phone = c.phone AND c2.status = 'pending') AS call_count
     FROM captured_calls c JOIN users u ON u.id = c.user_id
     WHERE c.status = 'pending' ${s.clause}
     ORDER BY c.call_log_ts DESC LIMIT 200`
  ).all(...s.params);
  // Surface existing leads this number may belong to, so the reviewer can
  // attach to the existing lead instead of creating a duplicate. One query for
  // the whole page (SCALE-15), not one LIKE scan per row.
  const candidates = findLeadCandidatesBatch(rows.map((r) => r.phone), req.user);
  for (const r of rows) r.lead_candidates = candidates.get(r.phone) || [];
  res.json(rows);
});

router.post('/captured/:id/create-lead', (req, res) => {
  const captured = db.prepare('SELECT * FROM captured_calls WHERE id = ?').get(req.params.id);
  if (!captured || captured.status !== 'pending') return res.status(404).json({ error: 'Not found' });
  if (!ownsRow(req, captured)) return res.status(403).json({ error: 'Not your captured call' });
  const name = String(req.body.name || '').trim() || `Unknown ${captured.phone}`;

  const leadId = db.transaction(() => {
    // The number may have become a lead since capture (e.g. via import).
    let lead = db.prepare('SELECT id FROM leads WHERE phone = ? AND deleted_at IS NULL')
      .get(captured.phone);
    if (!lead) {
      const info = db.prepare(
        `INSERT INTO leads (name, phone, phone_raw, source, assigned_to, created_at, updated_at)
         VALUES (?, ?, ?, 'call_capture', ?, ?, ?)`
      ).run(name, captured.phone, captured.phone, captured.user_id, nowUtc(), nowUtc());
      lead = { id: info.lastInsertRowid };
    }
    mergeCapturedIntoLead(lead.id, captured.phone);
    // Score the (possibly brand-new) lead now that its calls are attached, so
    // it is never left at score NULL (SCALE-10).
    recalcLeadScore(db, lead.id);
    return lead.id;
  })();
  bumpCache();

  res.json({ ok: true, lead_id: leadId });
});

// Attach a captured (unknown-number) call to an EXISTING lead instead of
// creating a duplicate — optionally scheduling a follow-up on that lead.
router.post('/captured/:id/attach-existing', (req, res) => {
  const captured = db.prepare('SELECT * FROM captured_calls WHERE id = ?').get(req.params.id);
  if (!captured || captured.status !== 'pending') return res.status(404).json({ error: 'Not found' });
  if (!ownsRow(req, captured)) return res.status(403).json({ error: 'Not your captured call' });
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL')
    .get(Number(req.body.lead_id));
  if (!lead) return res.status(400).json({ error: 'Lead not found' });
  if (!canAccessLead(req.user, lead)) return res.status(403).json({ error: 'No access to that lead' });

  const asFollowUp = !!req.body.as_follow_up;
  let dueAt = null;
  if (asFollowUp) {
    const t = Date.parse(req.body.follow_up_at || '');
    dueAt = new Date(Number.isNaN(t) ? Date.now() + 86400000 : t).toISOString();
  }

  db.transaction(() => {
    mergeCapturedIntoLead(lead.id, captured.phone);
    recalcLeadScore(db, lead.id);
    if (asFollowUp) {
      // One pending follow-up per lead (idx_followups_one_pending): replace it.
      db.prepare("UPDATE follow_ups SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'")
        .run(lead.id);
      db.prepare(
        `INSERT INTO follow_ups (lead_id, assigned_to, due_at, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(lead.id, lead.assigned_to || req.user.id, dueAt, 'Repeat call — from synced number', nowUtc());
    }
  })();
  bumpCache();

  res.json({ ok: true, lead_id: lead.id });
});

router.post('/captured/:id/ignore', (req, res) => {
  const captured = db.prepare('SELECT * FROM captured_calls WHERE id = ?').get(req.params.id);
  if (!captured || captured.status !== 'pending') return res.status(404).json({ error: 'Not found' });
  if (!ownsRow(req, captured)) return res.status(403).json({ error: 'Not your captured call' });
  // "Ignore always" writes to the TEAM-WIDE ignored_numbers list, which
  // suppresses the number from ever being captured again on any device — so
  // it is admin-tier only (audit SEC-10). Others get the per-capture ignore
  // (status change) and a flag saying the block was not applied, instead of a
  // 403 that would break older APKs' ignore flow.
  const always = !!req.body.always && isAdmin(req.user.role);
  db.transaction(() => {
    db.prepare("UPDATE captured_calls SET status = 'ignored' WHERE phone = ? AND status = 'pending'")
      .run(captured.phone);
    if (always) {
      db.prepare(
        'INSERT INTO ignored_numbers (phone, added_by, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
      ).run(captured.phone, req.user.id, nowUtc());
    }
  })();
  res.json({
    ok: true,
    always,
    ...(req.body.always && !always ? { note: 'Only an admin can block a number for the whole team' } : {}),
  });
});

// ---------- recordings needing manual placement ----------
router.get('/recordings', (req, res) => {
  const s = scope(req, 'r.user_id');
  const rows = db.prepare(
    `SELECT r.id, r.original_filename, r.duration_seconds, r.rec_start_ts, r.match_status,
            r.created_at, r.file_path, r.playable_path, u.full_name AS user_name
     FROM recordings r JOIN users u ON u.id = r.user_id
     WHERE r.match_status IN ('ambiguous','unmatched') ${s.clause}
     ORDER BY r.created_at DESC LIMIT 100`
  ).all(...s.params);
  // MOB-22: can the browser play what /audio/:id will serve? (paths stay
  // server-side)
  for (const r of rows) {
    Object.assign(r, playableInfo(r.file_path, r.playable_path));
    delete r.file_path;
    delete r.playable_path;
  }

  // Nearby activity (±10 min) as attach candidates for each recording.
  const candidates = db.prepare(
    `SELECT c.id AS call_id, NULL AS captured_call_id, c.call_log_ts, c.duration_seconds,
            l.name AS label, l.phone
     FROM calls c JOIN leads l ON l.id = c.lead_id
     WHERE c.user_id = ? AND c.source = 'mobile' AND c.call_log_ts BETWEEN ? AND ?
     UNION ALL
     SELECT NULL, cc.id, cc.call_log_ts, cc.duration_seconds,
            'Unknown number' AS label, cc.phone
     FROM captured_calls cc
     WHERE cc.user_id = ? AND cc.status = 'pending' AND cc.call_log_ts BETWEEN ? AND ?
     ORDER BY call_log_ts`
  );
  for (const r of rows) {
    const ts = r.rec_start_ts || Date.parse(r.created_at);
    r.candidates = candidates.all(
      r.user_id ?? req.user.id, ts - 600000, ts + 600000,
      r.user_id ?? req.user.id, ts - 600000, ts + 600000
    ).slice(0, 8);
  }
  res.json(rows);
});

router.post('/recordings/:id/attach', (req, res) => {
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  if (!ownsRow(req, rec)) return res.status(403).json({ error: 'Not your recording' });
  if (req.body.call_id) {
    const call = db.prepare('SELECT id, user_id FROM calls WHERE id = ?').get(Number(req.body.call_id));
    if (!call) return res.status(400).json({ error: 'Invalid call' });
    db.prepare(
      "UPDATE recordings SET call_id = ?, captured_call_id = NULL, match_status = 'matched' WHERE id = ?"
    ).run(call.id, rec.id);
  } else if (req.body.captured_call_id) {
    const cc = db.prepare('SELECT id FROM captured_calls WHERE id = ?').get(Number(req.body.captured_call_id));
    if (!cc) return res.status(400).json({ error: 'Invalid captured call' });
    db.prepare(
      "UPDATE recordings SET captured_call_id = ?, call_id = NULL, match_status = 'matched' WHERE id = ?"
    ).run(cc.id, rec.id);
  } else {
    return res.status(400).json({ error: 'Pick a call to attach to' });
  }
  res.json({ ok: true });
});

// ---------- auto-logged calls awaiting an outcome ----------
router.get('/untagged', (req, res) => {
  const s = scope(req, 'c.user_id');
  const rows = db.prepare(
    `SELECT c.id, c.called_at, c.direction, c.duration_seconds, c.call_type,
            l.id AS lead_id, l.name, l.phone, l.stage,
            r.id AS recording_id, r.file_path AS rec_file_path, r.playable_path AS rec_playable_path
     FROM calls c JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
     LEFT JOIN recordings r ON r.id = (SELECT r2.id FROM recordings r2 WHERE r2.call_id = c.id ORDER BY r2.id LIMIT 1)
     WHERE c.auto_logged = 1 AND c.disposition = 'connected' AND c.outcome IS NULL ${s.clause}
     ORDER BY c.called_at DESC LIMIT 100`
  ).all(...s.params);
  // MOB-22: recording_playable / recording_playable_ext next to recording_id.
  for (const r of rows) {
    if (r.recording_id) {
      const p = playableInfo(r.rec_file_path, r.rec_playable_path);
      r.recording_playable = p.playable;
      r.recording_playable_ext = p.playable_ext;
    } else {
      r.recording_playable = null;
      r.recording_playable_ext = null;
    }
    delete r.rec_file_path;
    delete r.rec_playable_path;
  }
  res.json(rows);
});

// Enrich an auto-logged call with what actually happened.
router.patch('/calls/:id', (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call || !call.auto_logged) return res.status(404).json({ error: 'Call not found' });
  if (!ownsRow(req, call)) return res.status(403).json({ error: 'Not your call' });
  const callType = CALL_TYPES.includes(req.body.call_type) ? req.body.call_type : call.call_type;
  let outcome = call.outcome;
  if (req.body.outcome !== undefined) {
    if (req.body.outcome && !OUTCOMES[callType].includes(req.body.outcome)) {
      return res.status(400).json({ error: `Invalid outcome for ${callType} call` });
    }
    outcome = req.body.outcome || null;
  }
  db.prepare('UPDATE calls SET call_type = ?, outcome = ?, notes = COALESCE(?, notes) WHERE id = ?')
    .run(callType, outcome, req.body.notes ?? null, call.id);
  res.json({ ok: true });
});

// ---------- audio streaming (browser + app) ----------
// Access: your own upload, admin, or anyone who can access the linked lead.
function canAccessRecording(user, rec) {
  if (canSeeAllLeads(user.role) || rec.user_id === user.id) return true;
  if (rec.call_id) {
    const lead = db.prepare(
      'SELECT l.* FROM leads l JOIN calls c ON c.lead_id = l.id WHERE c.id = ?'
    ).get(rec.call_id);
    return canAccessLead(user, lead);
  }
  return false;
}

// Mint a short-lived, single-recording ticket (audit M-2/L-1). The mobile app
// calls this with its Authorization header, then puts the returned ticket in the
// <audio> URL — so the long-lived device token never lands in WebView history.
router.post('/audio/:id/ticket', (req, res) => {
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRecording(req.user, rec)) return res.status(403).json({ error: 'No access' });
  const ticket = signMediaTicket({ userId: req.user.id, recordingId: rec.id });
  res.json({ ticket });
});

router.get('/audio/:id', (req, res) => {
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  // A media ticket (set by requireAuth) authorizes ONLY the recording it was
  // minted for — re-scope it to this :id. Session/bearer requests fall through
  // to the normal per-recording access check.
  if (req.mediaTicket) {
    if (req.mediaTicket.recordingId !== rec.id) return res.status(403).json({ error: 'No access' });
  } else if (!canAccessRecording(req.user, rec)) {
    return res.status(403).json({ error: 'No access' });
  }
  // MOB-22: prefer the transcoded .m4a sibling (browser-playable) when the
  // worker has produced one; otherwise the original. Explicit Content-Type
  // per extension (audio/mp4, audio/amr, …) — express's guess for .m4a is
  // audio/x-m4a and for .3gp video/3gpp. Range requests are handled by
  // sendFile as before (Safari needs them). A purged file (retention) is a
  // clean 404 instead of a path.join(null) 500.
  const rel = rec.playable_path || rec.file_path;
  if (!rel) return res.status(404).json({ error: 'Recording audio is no longer stored (retention)' });
  const abs = path.join(RECORDINGS_BASE, rel);
  res.sendFile(abs, { headers: { 'Content-Type': contentTypeFor(rel) } }, (err) => {
    if (!err || res.headersSent) return;
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Recording file missing on server' });
    res.status(500).json({ error: 'Could not read recording' });
  });
});

export default router;
