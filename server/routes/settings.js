import { Router } from 'express';
import path from 'node:path';
import db, { getSetting, setSetting, DATA_DIR } from '../db.js';
import { requireAdmin, requireOwner } from '../middleware/auth.js';
import { runBackup, BACKUP_DIR } from '../lib/backup.js';
import { sealSecret } from '../lib/secretBox.js';
import { isAdmin } from '../lib/permissions.js';
import { RECORDINGS_BASE } from './sync.js';

const router = Router();

const DEFAULT_UPLOAD_QUOTA_MB = 2048;
const QUOTA_MIN_MB = 100;
const QUOTA_MAX_MB = 100000;

// What every logged-in user may see: the company name (WhatsApp template
// rendering), the WhatsApp toggle (nav gate) and the GST % (price builder).
function publicSettings() {
  return {
    company_name: getSetting('company_name', 'Our Company'),
    whatsapp_enabled: getSetting('whatsapp_enabled', false) === true,
    gst_percent: getSetting('gst_percent', 18),
  };
}

// Admin tier additionally sees the invoice block, the AI/backup state and the
// upload quota. Non-admin roles get ONLY the public subset (QA-18): GSTIN,
// legal address, whether a Sarvam key exists, cloud-AI state and backup state
// are not for callers. The Sarvam key itself is write-only and never echoed —
// only the boolean has_sarvam_key tells the UI it's set.
router.get('/', (req, res) => {
  if (!isAdmin(req.user.role)) return res.json(publicSettings());
  res.json({
    ...publicSettings(),
    last_backup: getSetting('last_backup', null),
    ai_cloud_enabled: getSetting('ai_cloud_enabled', false),
    has_sarvam_key: !!getSetting('sarvam_api_key', ''),
    company_legal_name: getSetting('company_legal_name', ''),
    company_address: getSetting('company_address', ''),
    company_gstin: getSetting('company_gstin', ''),
    upload_daily_quota_mb: getSetting('upload_daily_quota_mb', DEFAULT_UPLOAD_QUOTA_MB),
  });
});

// Where this server keeps its files — the desktop app in "attached" mode uses
// it to open the right folders. Owner-only: filesystem layout is operator info.
router.get('/paths', requireOwner, async (req, res) => {
  let logsDir = process.env.CRM_LOG_DIR || path.join(DATA_DIR, 'logs');
  try {
    const { LOG_DIR } = await import('../lib/logger.js');
    if (LOG_DIR) logsDir = LOG_DIR;
  } catch { /* logger module optional — same default it uses */ }
  res.json({
    data_dir: path.resolve(DATA_DIR),
    backup_dir: path.resolve(BACKUP_DIR),
    recordings_dir: path.resolve(RECORDINGS_BASE),
    logs_dir: path.resolve(logsDir),
  });
});

router.put('/', requireOwner, (req, res) => {
  if (req.body.company_name !== undefined) {
    setSetting('company_name', String(req.body.company_name).trim() || 'Our Company');
  }
  if (req.body.ai_cloud_enabled !== undefined) {
    setSetting('ai_cloud_enabled', !!req.body.ai_cloud_enabled);
  }
  // Empty string clears the key; any non-empty value is sealed at rest (audit
  // M-4) so it never sits in plaintext in crm.sqlite or its backups. Never returned.
  if (req.body.sarvam_api_key !== undefined) {
    const key = String(req.body.sarvam_api_key).trim();
    setSetting('sarvam_api_key', key ? sealSecret(key) : '');
  }
  if (req.body.company_legal_name !== undefined) {
    setSetting('company_legal_name', String(req.body.company_legal_name).trim());
  }
  if (req.body.company_address !== undefined) {
    setSetting('company_address', String(req.body.company_address).trim());
  }
  if (req.body.company_gstin !== undefined) {
    setSetting('company_gstin', String(req.body.company_gstin).trim().toUpperCase());
  }
  if (req.body.gst_percent !== undefined) {
    const pct = Number(req.body.gst_percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'GST % must be between 0 and 100' });
    }
    setSetting('gst_percent', pct);
  }
  // Per-device daily recording upload quota (audit SEC-6), whole MB.
  if (req.body.upload_daily_quota_mb !== undefined) {
    const mb = Number(req.body.upload_daily_quota_mb);
    if (!Number.isInteger(mb) || mb < QUOTA_MIN_MB || mb > QUOTA_MAX_MB) {
      return res.status(400).json({
        error: `Upload quota must be a whole number of MB between ${QUOTA_MIN_MB} and ${QUOTA_MAX_MB}`,
      });
    }
    setSetting('upload_daily_quota_mb', mb);
  }
  res.json({ ok: true });
});

// runBackup() is async (non-blocking better-sqlite3 db.backup → verify →
// rename); await it so the response carries the real file path and a failure
// surfaces as a 500 instead of a resolved-looking `file: {}`.
router.post('/backup-now', requireAdmin, async (req, res) => {
  try {
    const file = await runBackup();
    res.json({ ok: true, file, last_backup: getSetting('last_backup', null) });
  } catch (err) {
    res.status(500).json({ error: `Backup failed: ${err.message}` });
  }
});

// Remove seeded demo data (leads with source 'demo' and everything hanging off them).
router.post('/clear-demo-data', requireAdmin, (req, res) => {
  const demoLeads = db.prepare("SELECT id FROM leads WHERE source = 'demo'").all().map((l) => l.id);
  if (!demoLeads.length) return res.json({ ok: true, removed: 0 });
  const inList = demoLeads.join(',');
  db.transaction(() => {
    db.exec(`
      DELETE FROM payments WHERE deal_id IN (SELECT id FROM deals WHERE lead_id IN (${inList}));
      DELETE FROM installments WHERE deal_id IN (SELECT id FROM deals WHERE lead_id IN (${inList}));
      DELETE FROM deals WHERE lead_id IN (${inList});
      DELETE FROM follow_ups WHERE lead_id IN (${inList});
      DELETE FROM lead_events WHERE lead_id IN (${inList});
      DELETE FROM calls WHERE lead_id IN (${inList});
      DELETE FROM leads WHERE id IN (${inList});
    `);
  })();
  res.json({ ok: true, removed: demoLeads.length });
});

export default router;
