import { Router } from 'express';
import db, { getSetting, setSetting } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { runBackup } from '../lib/backup.js';

const router = Router();

// Company name is needed by all users for WhatsApp template rendering.
router.get('/', (req, res) => {
  res.json({
    company_name: getSetting('company_name', 'Our Company'),
    last_backup: getSetting('last_backup', null),
  });
});

router.put('/', requireAdmin, (req, res) => {
  if (req.body.company_name !== undefined) {
    setSetting('company_name', String(req.body.company_name).trim() || 'Our Company');
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
