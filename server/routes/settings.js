import { Router } from 'express';
import db, { getSetting, setSetting } from '../db.js';
import { requireAdmin, requireOwner } from '../middleware/auth.js';
import { runBackup } from '../lib/backup.js';

const router = Router();

// Company name is needed by all users for WhatsApp template rendering. The
// invoice block + AI toggle feed later phases. The Sarvam key is write-only:
// it's NEVER echoed back — only a boolean has_sarvam_key tells the UI it's set.
router.get('/', (req, res) => {
  res.json({
    company_name: getSetting('company_name', 'Our Company'),
    last_backup: getSetting('last_backup', null),
    ai_cloud_enabled: getSetting('ai_cloud_enabled', false),
    has_sarvam_key: !!getSetting('sarvam_api_key', ''),
    company_legal_name: getSetting('company_legal_name', ''),
    company_address: getSetting('company_address', ''),
    company_gstin: getSetting('company_gstin', ''),
    gst_percent: getSetting('gst_percent', 18),
    whatsapp_enabled: getSetting('whatsapp_enabled', false) === true,
  });
});

router.put('/', requireOwner, (req, res) => {
  if (req.body.company_name !== undefined) {
    setSetting('company_name', String(req.body.company_name).trim() || 'Our Company');
  }
  if (req.body.ai_cloud_enabled !== undefined) {
    setSetting('ai_cloud_enabled', !!req.body.ai_cloud_enabled);
  }
  // Empty string clears the key; any non-empty value sets it. Never returned.
  if (req.body.sarvam_api_key !== undefined) {
    setSetting('sarvam_api_key', String(req.body.sarvam_api_key).trim());
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
  res.json({ ok: true });
});

router.post('/backup-now', requireAdmin, (req, res) => {
  try {
    const file = runBackup();
    res.json({ ok: true, file });
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
