import { Router } from 'express';
import db, { getSetting, setSetting } from '../db.js';
import { requireAdmin, canAccessLead } from '../middleware/auth.js';
import { isOwner, isReadOnly, canSeeAllLeads } from '../lib/permissions.js';
import { openSecret } from '../lib/secretBox.js';
import { nowUtc } from '../lib/istTime.js';
import { changeStage } from '../lib/leadStage.js';
import { aiStatus, runAiQueueOnce, analyzeRecordingTranscript } from '../lib/ai.js';
import { transcribeWithSarvam } from '../lib/sarvam.js';
import { RECORDINGS_BASE } from './sync.js';
import path from 'node:path';

const router = Router();

// Read the Sarvam key, transparently unsealing a sealed value (audit M-4) while
// still accepting a legacy plaintext key from installs predating the sealing.
const SEALED_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;
export function readSarvamKey() {
  const raw = getSetting('sarvam_api_key', '');
  if (!raw) return '';
  if (SEALED_RE.test(raw)) {
    try { return openSecret(raw); } catch { return ''; }
  }
  return raw;
}

router.get('/status', (req, res) => {
  const pending = db.prepare("SELECT COUNT(*) n FROM recordings WHERE ai_status = 'pending'").get().n;
  const processing = db.prepare("SELECT COUNT(*) n FROM recordings WHERE ai_status = 'processing'").get().n;
  res.json({ ...aiStatus(), queue: { pending, processing } });
});

router.put('/settings', requireAdmin, (req, res) => {
  if (req.body.enabled !== undefined) setSetting('ai_enabled', !!req.body.enabled);
  if (req.body.language !== undefined) setSetting('ai_language', String(req.body.language));
  if (req.body.enabled) runAiQueueOnce().catch(() => {});
  res.json({ ok: true });
});

// Suggestions for a lead (for the lead detail page) or all pending (review).
router.get('/suggestions', (req, res) => {
  const where = ["s.status = 'pending'"];
  const params = [];
  if (req.query.lead_id) { where.push('s.lead_id = ?'); params.push(Number(req.query.lead_id)); }
  // Scope non-admin roles to their own leads' suggestions (audit H-7 — was
  // `role==='caller'`, which leaked all pending suggestions to agent/employee).
  if (!canSeeAllLeads(req.user.role)) {
    if (isReadOnly(req.user.role)) {
      where.push('1 = 0');
    } else {
      where.push('l.assigned_to = ?');
      params.push(req.user.id);
    }
  }
  const rows = db.prepare(
    `SELECT s.*, r.summary FROM ai_suggestions s
     LEFT JOIN leads l ON l.id = s.lead_id
     LEFT JOIN recordings r ON r.id = s.recording_id
     WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 200`
  ).all(...params);
  res.json(rows);
});

function loadSuggestion(req, res) {
  const s = db.prepare('SELECT * FROM ai_suggestions WHERE id = ?').get(req.params.id);
  if (!s || s.status !== 'pending') { res.status(404).json({ error: 'Not found' }); return null; }
  const lead = s.lead_id ? db.prepare('SELECT * FROM leads WHERE id = ?').get(s.lead_id) : null;
  if (lead && !canAccessLead(req.user, lead)) { res.status(403).json({ error: 'Not your lead' }); return null; }
  return { s, lead };
}

// Accept = apply the change AND mark accepted, atomically.
router.post('/suggestions/:id/accept', (req, res) => {
  const ctx = loadSuggestion(req, res);
  if (!ctx) return;
  const { s, lead } = ctx;
  if (!lead) return res.status(400).json({ error: 'Suggestion has no lead' });

  db.transaction(() => {
    if (s.kind === 'field') {
      if (s.field === 'notes') {
        const merged = lead.notes ? `${lead.notes}\n${s.value}` : s.value;
        db.prepare('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?').run(merged, nowUtc(), lead.id);
      } else if (['city', 'email'].includes(s.field)) {
        db.prepare(`UPDATE leads SET ${s.field} = ?, updated_at = ? WHERE id = ?`).run(s.value, nowUtc(), lead.id);
      }
    } else if (s.kind === 'follow_up') {
      // field = IST date; schedule at 11:00 IST → UTC instant.
      const [y, m, d] = s.field.split('-').map(Number);
      const dueAt = new Date(Date.UTC(y, m - 1, d, 11, 0) - 330 * 60000).toISOString();
      // One pending follow-up per lead: replace any existing.
      db.prepare("UPDATE follow_ups SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'").run(lead.id);
      db.prepare(
        `INSERT INTO follow_ups (lead_id, assigned_to, due_at, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(lead.id, lead.assigned_to || req.user.id, dueAt, s.value, nowUtc());
      if (!['won', 'lost'].includes(lead.stage)) changeStage(lead.id, lead.stage, 'follow_up', req.user.id);
    } else if (s.kind === 'task') {
      // field = IST due date, value = task title.
      db.prepare(
        `INSERT INTO tasks (title, lead_id, assigned_to, due_date, source, created_by, created_at)
         VALUES (?, ?, ?, ?, 'ai', ?, ?)`
      ).run(s.value, lead.id, lead.assigned_to || req.user.id, s.field, req.user.id, nowUtc());
    }
    db.prepare("UPDATE ai_suggestions SET status = 'accepted', acted_by = ?, acted_at = ? WHERE id = ?")
      .run(req.user.id, nowUtc(), s.id);
  })();
  res.json({ ok: true });
});

router.post('/suggestions/:id/dismiss', (req, res) => {
  const ctx = loadSuggestion(req, res);
  if (!ctx) return;
  db.prepare("UPDATE ai_suggestions SET status = 'dismissed', acted_by = ?, acted_at = ? WHERE id = ?")
    .run(req.user.id, nowUtc(), ctx.s.id);
  res.json({ ok: true });
});

// Recordings router (mounted at /api/recordings). The hybrid cloud-transcription
// opt-in. Injectable transcribe/analyze fns let tests run the gating + plumbing
// with NO ffmpeg, NO network and NO Ollama.
export function recordingsRouter({
  transcribeFn = transcribeWithSarvam,
  analyzeFn = analyzeRecordingTranscript,
} = {}) {
  const r = Router();

  // POST /api/recordings/:id/transcribe-cloud — send THIS one file to Sarvam.
  r.post('/:id/transcribe-cloud', async (req, res) => {
    const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Recording not found' });

    // Gating: cloud must be enabled AND a key configured.
    if (!getSetting('ai_cloud_enabled', false)) {
      return res.status(400).json({ error: 'Cloud AI is disabled. Enable it in Settings first.' });
    }
    const apiKey = readSarvamKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'No Sarvam API key configured.' });
    }

    // Access: owner tier, the uploader, or the linked lead's assignee.
    let allowed = isOwner(req.user.role) || rec.user_id === req.user.id;
    let lead = null;
    if (rec.call_id) {
      lead = db.prepare(
        'SELECT l.* FROM leads l JOIN calls c ON c.lead_id = l.id WHERE c.id = ?'
      ).get(rec.call_id);
      if (lead && canAccessLead(req.user, lead)) allowed = true;
    }
    if (!allowed) return res.status(403).json({ error: 'No access to this recording' });

    const fileAbs = path.join(RECORDINGS_BASE, rec.file_path);
    let result;
    try {
      result = await transcribeFn(fileAbs, { apiKey });
    } catch (err) {
      return res.status(502).json({ error: `Sarvam transcription failed: ${err.message}` });
    }

    // Store the cloud transcript + English translation, tag the provider.
    db.prepare(
      "UPDATE recordings SET transcript = ?, translation = ?, provider = 'sarvam', ai_status = 'done' WHERE id = ?"
    ).run(result.transcript || '', result.translation || null, rec.id);

    // Re-run extraction → suggestions + derived lead AI fields on the new text.
    const analysis = await analyzeFn(rec.id, result.transcript || result.translation || '');

    res.json({
      ok: true,
      provider: 'sarvam',
      language: result.language,
      transcript: result.transcript,
      translation: result.translation,
      analysis,
    });
  });

  return r;
}

export default router;
