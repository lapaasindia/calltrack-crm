// Endpoints the mobile app talks to. Bearer-token (paired device) only.
import express, { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import db, { DATA_DIR, getSetting } from '../db.js';
import { requireDevice, requireWriter } from '../middleware/auth.js';
import { normalizePhone } from '../lib/phone.js';
import { nowUtc, todayIst, addDays, istDateOf, IST_OFFSET_MS } from '../lib/istTime.js';
import { matchRecording } from '../lib/recordingMatch.js';
import { changeStage } from '../lib/leadStage.js';
import { recalcLeadScore } from '../lib/scoring.js';
import { canSeeAllLeads } from '../lib/permissions.js';

const router = Router();
router.use(requireDevice);
router.use(requireWriter);
// Per-route body limit (SCALE-24): a call-log batch is ≤ 500 small rows, so
// 1 MB is generous. express.json is a no-op when app.js already parsed the
// body, so this only bites once the global 10 MB parser is narrowed there.
router.use(express.json({ limit: '1mb' }));

const RECORDINGS_DIR = process.env.CRM_RECORDINGS_DIR || path.join(DATA_DIR, 'recordings');
const ALLOWED_EXT = new Set(['m4a', 'mp3', 'amr', 'wav', 'ogg', 'aac', '3gp', 'opus']);
const DIRECTIONS = new Set(['incoming', 'outgoing', 'missed']);

// Upload guards (audit SEC-6). Per-file cap, a per-device daily byte quota
// (setting upload_daily_quota_mb, default 2 GB), and a free-disk floor below
// which uploads are refused rather than letting one phone wedge the host.
const MAX_RECORDING_BYTES = Number(process.env.CRM_MAX_RECORDING_BYTES) || 100 * 1024 * 1024;
const DEFAULT_DAILY_QUOTA_MB = 2048;
const DEFAULT_MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024;
// Read per request so ops (and tests) can tune it without a restart.
const minFreeDiskBytes = () => Number(process.env.CRM_MIN_FREE_DISK_BYTES) || DEFAULT_MIN_FREE_DISK_BYTES;
// last_modified_ms must be a real millisecond timestamp: not before 2010 and
// not more than a day in the future (a phone with a wrong clock). Anything
// else used to reach `new Date(x).toISOString()` and 500 (SEC-6/SEC-9 class).
const TS_MIN_MS = Date.UTC(2010, 0, 1);
const tsTooLate = () => Date.now() + 86400000;

function dailyQuotaBytes() {
  const mb = Number(getSetting('upload_daily_quota_mb', DEFAULT_DAILY_QUOTA_MB));
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_DAILY_QUOTA_MB) * 1024 * 1024;
}
// UTC instant of today's IST midnight (the quota day rolls over at IST midnight).
function istDayStartUtc(dateStr) {
  return new Date(Date.parse(`${dateStr}T00:00:00.000Z`) - IST_OFFSET_MS).toISOString();
}
function usedTodayBytes(deviceId) {
  return db.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS n FROM recordings WHERE device_id = ? AND created_at >= ?'
  ).get(deviceId, istDayStartUtc(todayIst())).n;
}
function secondsToIstMidnight() {
  const next = Date.parse(istDayStartUtc(addDays(todayIst(), 1)));
  return Math.max(60, Math.ceil((next - Date.now()) / 1000));
}
function freeDiskBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null; // unknown FS (e.g. exotic mount) — don't block uploads on it
  }
}
function quotaExceeded(res, used, quota) {
  res.set('Retry-After', String(secondsToIstMidnight()));
  return res.status(429).json({
    error: `Daily upload quota exceeded for this device (${Math.round(quota / 1024 / 1024)} MB/day) — uploads resume after midnight IST`,
    used_bytes: used,
    quota_bytes: quota,
  });
}

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
  // SCALE-18(a): the call-log entry (device, ts) for THIS phone number may
  // already be recorded on an earlier lead that carried the same number (a
  // soft-deleted lead re-created under a new id). Keyed on phone, not lead_id,
  // so a re-sync never backdates the new lead with the old lead's history.
  const priorByPhone = db.prepare(
    `SELECT c.id FROM calls c JOIN leads l ON l.id = c.lead_id
      WHERE c.device_id = ? AND c.user_id = ? AND c.call_log_ts = ? AND c.source = 'mobile'
        AND l.phone = ?`
  );
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
  const seesAll = canSeeAllLeads(req.user.role);

  const results = db.transaction(() => items.map((item) => {
    const ts = Number(item.call_log_ts);
    if (!Number.isInteger(ts) || ts < TS_MIN_MS || ts > tsTooLate()) {
      return { status: 'invalid', reason: 'bad_timestamp' };
    }
    const direction = DIRECTIONS.has(item.direction) ? item.direction : 'outgoing';
    const duration = Math.max(0, parseInt(item.duration_seconds, 10) || 0);
    const norm = normalizePhone(item.phone);
    if (!norm.ok) return { status: 'invalid', reason: norm.reason };
    if (isIgnored.get(norm.phone)) return { status: 'ignored' };

    const lead = findLead.get(norm.phone);
    if (lead) {
      if (priorByPhone.get(req.device.id, req.user.id, ts, norm.phone)) {
        return { status: 'duplicate', lead_id: lead.id };
      }
      const disposition = duration > 0 ? 'connected' : 'not_picked';
      const info = insertCall.run(
        lead.id, req.user.id, disposition, new Date(ts).toISOString(),
        direction, ts, req.device.id, duration
      );
      // The call is recorded regardless (append-only truth), but only the
      // lead's owner — or an admin-tier user — drives its pipeline: a call
      // from someone else's phone must not move the stage or rescore the
      // lead (audit SEC-7). Note: the attached/captured distinction is kept
      // because /api/leads/check-phone discloses existence by design anyway.
      const ownsLead = seesAll || lead.assigned_to === req.user.id;
      if (info.changes && ownsLead) {
        // Same automation as manual logging: a first real conversation moves
        // a fresh lead out of 'new'.
        if (disposition === 'connected' && lead.stage === 'new') {
          changeStage(lead.id, 'new', 'contacted', req.user.id);
          lead.stage = 'contacted';
        }
        // A newly-attached call changed this lead's engagement → rescore.
        recalcLeadScore(db, lead.id);
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
  limits: { fileSize: MAX_RECORDING_BYTES, files: 1 },
});

// Pre-flight before a single byte is spooled: disk floor + daily quota using
// the declared Content-Length (multipart overhead makes this conservative).
function uploadGuards(req, res, next) {
  fs.mkdirSync(path.join(RECORDINGS_DIR, 'tmp'), { recursive: true });
  const free = freeDiskBytes(RECORDINGS_DIR);
  if (free !== null && free < minFreeDiskBytes()) {
    return res.status(507).json({
      error: 'Server disk is almost full — recording uploads are paused until space is freed',
      free_bytes: free,
    });
  }
  const used = usedTodayBytes(req.device.id);
  const quota = dailyQuotaBytes();
  const declared = Number(req.headers['content-length']) || 0;
  if (used >= quota || used + declared > quota) return quotaExceeded(res, used, quota);
  next();
}

// Multer errors → clean JSON (a 100 MB+ file used to surface as a 500).
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large', max_bytes: MAX_RECORDING_BYTES });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload rejected: ${err.message}` });
    }
    next(err);
  });
}

router.post('/recordings', uploadGuards, receiveFile, (req, res) => {
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

    // Post-flight quota check with the real file size (duplicates never count).
    const used = usedTodayBytes(req.device.id);
    const quota = dailyQuotaBytes();
    if (used + req.file.size > quota) return quotaExceeded(res, used, quota);

    let lastModifiedMs;
    const rawTs = req.body.last_modified_ms;
    if (rawTs === undefined || rawTs === null || String(rawTs).trim() === '') {
      lastModifiedMs = Date.now();
    } else {
      const n = Number(rawTs);
      if (!Number.isInteger(n) || n < TS_MIN_MS || n > tsTooLate()) {
        return res.status(400).json({ error: 'last_modified_ms must be a millisecond timestamp between 2010-01-01 and now' });
      }
      lastModifiedMs = n;
    }
    const rawDur = Number(req.body.duration_seconds);
    const durationSeconds = Number.isFinite(rawDur) && rawDur > 0 ? Math.round(rawDur) : null;

    // Folder by the IST month of the recording (SCALE-25) — a file recorded at
    // 00:30 IST on the 1st belongs to the new month, not the UTC previous one.
    const sub = istDateOf(new Date(lastModifiedMs)).slice(0, 7); // YYYY-MM
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

// Pre-upload existence check by content hash (SCALE-18c): the app hashes the
// file locally and asks before spending the bandwidth — a re-upload of an
// already-stored recording used to cost the full transfer before the server
// answered "duplicate".
//   HEAD /api/sync/recordings/:sha256        → 200 stored / 404 unknown (no body)
//   GET  /api/sync/recordings/:sha256/exists → { exists, recording_id, match_status }
const SHA_RE = /^[0-9a-f]{64}$/i;
const findBySha = db.prepare('SELECT id, match_status FROM recordings WHERE sha256 = ?');
router.head('/recordings/:sha256', (req, res) => {
  if (!SHA_RE.test(req.params.sha256)) return res.status(400).end();
  const row = findBySha.get(req.params.sha256.toLowerCase());
  res.status(row ? 200 : 404).end();
});
router.get('/recordings/:sha256/exists', (req, res) => {
  if (!SHA_RE.test(req.params.sha256)) return res.status(400).json({ error: 'sha256 must be 64 hex chars' });
  const row = findBySha.get(req.params.sha256.toLowerCase());
  res.json({ exists: !!row, recording_id: row?.id ?? null, match_status: row?.match_status ?? null });
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
    upload_quota: { used_bytes: usedTodayBytes(req.device.id), quota_bytes: dailyQuotaBytes() },
  });
});

export const RECORDINGS_BASE = RECORDINGS_DIR;
export default router;
