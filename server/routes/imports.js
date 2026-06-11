import { Router } from 'express';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { normalizePhone } from '../lib/phone.js';
import { nowUtc } from '../lib/istTime.js';

const router = Router();
router.use(requireAdmin);

// The client parses CSV/XLSX and posts mapped rows; the server is the
// authority on validation and dedupe (in-file AND against the DB).
// Body: { filename, preset, default_source, assigned_to | round_robin, rows: [{name, phone, ...}] }
router.post('/', (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 20000) return res.status(400).json({ error: 'Too many rows (max 20,000 per import)' });

  const defaultSource = String(req.body.default_source || 'import').trim() || 'import';

  let assignees = [];
  if (req.body.round_robin) {
    assignees = db.prepare(
      "SELECT id FROM users WHERE role = 'caller' AND is_active = 1 ORDER BY id"
    ).all().map((u) => u.id);
  } else if (req.body.assigned_to) {
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1')
      .get(Number(req.body.assigned_to));
    if (!u) return res.status(400).json({ error: 'Invalid assignee' });
    assignees = [u.id];
  }

  const existsStmt = db.prepare(
    'SELECT id, name FROM leads WHERE phone = ? AND deleted_at IS NULL'
  );
  const insertStmt = db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, alt_phone, email, city, source, assigned_to,
                        notes, extra_json, import_batch_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const invalid = [];
  const duplicates = [];
  let imported = 0;

  const batchId = db.transaction(() => {
    const batchInfo = db.prepare(
      `INSERT INTO import_batches (filename, preset, imported_by, total_rows, imported_count, duplicate_count, invalid_count, created_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?)`
    ).run(String(req.body.filename || 'upload'), req.body.preset || null, req.user.id, rows.length, nowUtc());
    const id = batchInfo.lastInsertRowid;

    const seenInFile = new Map(); // phone -> row number
    let assignIdx = 0;

    rows.forEach((row, idx) => {
      const rowNum = idx + 1;
      const name = String(row.name || '').trim();
      const norm = normalizePhone(row.phone);

      if (!norm.ok) {
        invalid.push({ row: rowNum, name, phone: row.phone ?? '', reason: norm.reason });
        return;
      }
      if (!name) {
        invalid.push({ row: rowNum, name: '', phone: norm.phone, reason: 'missing_name' });
        return;
      }
      if (seenInFile.has(norm.phone)) {
        duplicates.push({
          row: rowNum, name, phone: norm.phone,
          kind: 'in_file', first_row: seenInFile.get(norm.phone),
        });
        return;
      }
      const existing = existsStmt.get(norm.phone);
      if (existing) {
        duplicates.push({
          row: rowNum, name, phone: norm.phone,
          kind: 'in_db', existing_id: existing.id, existing_name: existing.name,
        });
        return;
      }

      seenInFile.set(norm.phone, rowNum);
      const assignedTo = assignees.length ? assignees[assignIdx++ % assignees.length] : null;
      const now = nowUtc();
      insertStmt.run(
        name, norm.phone, String(row.phone ?? ''), row.alt_phone || null,
        row.email || null, row.city || null,
        String(row.source || defaultSource).trim() || defaultSource,
        assignedTo, row.notes || null,
        row.extra && Object.keys(row.extra).length ? JSON.stringify(row.extra) : null,
        id, now, now
      );
      imported++;
    });

    db.prepare(
      'UPDATE import_batches SET imported_count = ?, duplicate_count = ?, invalid_count = ? WHERE id = ?'
    ).run(imported, duplicates.length, invalid.length, id);
    return id;
  })();

  res.json({
    batch_id: batchId,
    total: rows.length,
    imported,
    duplicates,
    invalid,
  });
});

// Append a note to an existing lead from a duplicate import row.
router.post('/merge-note', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL')
    .get(Number(req.body.lead_id));
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const note = String(req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Note required' });
  const merged = lead.notes ? `${lead.notes}\n${note}` : note;
  db.prepare('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?')
    .run(merged, nowUtc(), lead.id);
  res.json({ ok: true });
});

router.get('/', (req, res) => {
  const batches = db.prepare(
    `SELECT b.*, u.full_name AS imported_by_name FROM import_batches b
     JOIN users u ON u.id = b.imported_by ORDER BY b.created_at DESC LIMIT 50`
  ).all();
  res.json(batches);
});

export default router;
