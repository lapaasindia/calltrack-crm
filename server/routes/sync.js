// Endpoints the mobile app talks to. Bearer-token (paired device) only.
import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import db, { DATA_DIR } from '../db.js';
import { requireDevice } from '../middleware/auth.js';
import { normalizePhone } from '../lib/phone.js';
import { nowUtc } from '../lib/istTime.js';
import { matchRecording } from '../lib/recordingMatch.js';
import { changeStage } from '../lib/leadStage.js';

const router = Router();
router.use(requireDevice);

const RECORDINGS_DIR = process.env.CRM_RECORDINGS_DIR || path.join(DATA_DIR, 'recordings');
const ALLOWED_EXT = new Set(['m4a', 'mp3', 'amr', 'wav', 'ogg', 'aac', '3gp', 'opus']);
const DIRECTIONS = new Set(['incoming', 'outgoing', 'missed']);

// Batched call-log sync. Dedupe is enforced by partial unique indexes —
// re-syncing after a reinstall can never create duplicates.
router.post('/calls', (req, res) => {
  const items = Array.isArray(req.body.calls) ? req.body.calls : [];
  if (!items.length) return res.status(400).json({ error: 'No calls in batch' });
  if (items.length > 500) return res.status(400).json({ error: 'Batch too large (max 500)' });

  const findLead = db.prepare(
    'SELECT id, assigned_to, stage FROM leads WHERE phone = ? AND deleted_at IS NULL'
  );
  const isIgnored = db.prepare('SELECT 1 FROM ignored_numbers WHERE phone = ?');
  const insertCall = db.prepare(
    `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at,
                        source, direction, call_log_ts, device_id, auto_logged, duration_seconds)
     VALUES (?, ?, 'sales', ?, ?, 'mobile', ?, ?, ?, 1, ?)
     ON CONFLICT DO NOTHING`
  );
  const insertCaptured = db.prepare(
    `INSERT INTO captured_calls (user_id, device_id, phone, direction, duration_seconds, call_log_ts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`
  );

  const results = db.transaction(() => items.map((item) => {
    const ts = Number(item.call_log_ts);
    if (!Number.isInteger(ts) || ts < 1262304000000 || ts > Date.now() + 86400000) {
      return { status: 'invalid', reason: 'bad_timestamp' };
    }
    const direction = DIRECTIONS.has(item.direction) ? item.direction : 'outgoing';
    const duration = Math.max(0, parseInt(item.duration_seconds, 10) || 0);
    const norm = normalizePhone(item.phone);
    if (!norm.ok) return { status: 'invalid', reason: norm.reason };
    if (isIgnored.get(norm.phone)) return { status: 'ignored' };

    const lead = findLead.get(norm.phone);
    if (lead) {
      const disposition = duration > 0 ? 'connected' : 'not_picked';
      const info = insertCall.run(
        lead.id, req.user.id, disposition, new Date(ts).toISOString(),
        direction, ts, req.device.id, duration
      );
      // Same automation as manual logging: a first real conversation moves
      // a fresh lead out of 'new'.
      if (info.changes && disposition === 'connected' && lead.stage === 'new') {
        changeStage(lead.id, 'new', 'contacted', req.user.id);
        lead.stage = 'contacted';
      }
      return info.changes
        ? { status: 'attached', lead_id: lead.id }
        : { status: 'duplicate', lead_id: lead.id };
    }
    const info = insertCaptured.run(
      req.user.id, req.device.id, norm.phone, direction, duration, ts, nowUtc()
    );
    return info.changes ? { status: 'captured' } : { status: 'duplicate' };
  }))();

  res.json({ results });
});

// Recording upload: multipart, hashed for dedupe, matched server-side.
const upload = multer({
  dest: path.join(RECORDINGS_DIR, 'tmp'),
  limits: { fileSize: 100 * 1024 * 1024 },
});

router.post('/recordings', (req, res, next) => {
  fs.mkdirSync(path.join(RECORDINGS_DIR, 'tmp'), { recursive: true });
  next();
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const tmpPath = req.file.path;
  try {
    const originalName = String(req.body.filename || req.file.originalname || 'recording');
    const ext = originalName.split('.').pop().toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return res.status(400).json({ error: `Unsupported audio type .${ext}` });
    }

    const sha = crypto.createHash('sha256').update(fs.readFileSync(tmpPath)).digest('hex');
    const existing = db.prepare('SELECT id, match_status, call_id FROM recordings WHERE sha256 = ?').get(sha);
    if (existing) {
      return res.json({ status: 'duplicate', recording_id: existing.id, match_status: existing.match_status });
    }

    const lastModifiedMs = Number(req.body.last_modified_ms) || Date.now();
    const durationSeconds = Number(req.body.duration_seconds) || null;

    const sub = new Date(lastModifiedMs).toISOString().slice(0, 7); // YYYY-MM
    const destDir = path.join(RECORDINGS_DIR, sub);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, `${sha}.${ext}`);
    fs.renameSync(tmpPath, destPath);

    const match = matchRecording({
      userId: req.user.id,
      filename: originalName,
      lastModifiedMs,
      durationSeconds,
    });

    const info = db.prepare(
      `INSERT INTO recordings (user_id, device_id, call_id, captured_call_id, file_path, sha256,
                               original_filename, size_bytes, duration_seconds, rec_start_ts,
                               match_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user.id, req.device.id, match.callId, match.capturedCallId,
      path.relative(RECORDINGS_DIR, destPath), sha, originalName,
      req.file.size, durationSeconds, lastModifiedMs, match.status, nowUtc()
    );

    res.json({
      status: 'stored',
      recording_id: info.lastInsertRowid,
      match_status: match.status,
      call_id: match.callId,
    });
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});

// Sync status for the app's home screen.
router.get('/status', (req, res) => {
  const captured = db.prepare(
    "SELECT COUNT(*) n FROM captured_calls WHERE user_id = ? AND status = 'pending'"
  ).get(req.user.id).n;
  const untagged = db.prepare(
    `SELECT COUNT(*) n FROM calls
     WHERE user_id = ? AND auto_logged = 1 AND disposition = 'connected' AND outcome IS NULL`
  ).get(req.user.id).n;
  res.json({
    server_time: nowUtc(),
    user: { id: req.user.id, full_name: req.user.full_name },
    pending_review: { captured, untagged },
  });
});

export const RECORDINGS_BASE = RECORDINGS_DIR;
export default router;
