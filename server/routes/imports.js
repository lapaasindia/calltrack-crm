import express, { Router } from 'express';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { normalizePhone } from '../lib/phone.js';
import { nowUtc } from '../lib/istTime.js';
import { assignRoundRobin } from '../lib/assignment.js';
import { recalcLeadScore } from '../lib/scoring.js';

const router = Router();
router.use(requireAdmin);
// Imports are the one endpoint that legitimately carries a big JSON body
// (20k mapped rows). Per-route limit (SCALE-24); no-op until app.js narrows
// its global parser.
router.use(express.json({ limit: '10mb' }));

// The client parses CSV/XLSX and posts mapped rows; the server is the
// authority on validation and dedupe (in-file AND against the DB).
// Body: { filename, preset, default_source, assigned_to | round_robin, rows: [{name, phone, ...}] }
router.post('/', (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 20000) return res.status(400).json({ error: 'Too many rows (max 20,000 per import)' });
  // Only lead spreadsheets — reject anything else (the client gates too, but the
  // API must not trust a hand-crafted request).
  const ext = String(req.body.filename || '').split('.').pop().toLowerCase();
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    return res.status(400).json({ error: 'Unsupported file type — only CSV/Excel imports are allowed' });
  }

  const defaultSource = String(req.body.default_source || 'import').trim() || 'import';

  let fixedAssignee = null;
  const roundRobin = !!req.body.round_robin;
  if (!roundRobin && req.body.assigned_to) {
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1')
      .get(Number(req.body.assigned_to));
    if (!u) return res.status(400).json({ error: 'Invalid assignee' });
    fixedAssignee = u.id;
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

    // Pass 1: validate + dedupe (in-file, then against the DB). Every row ends
    // up in exactly one of accepted / duplicates / invalid — nothing is dropped.
    const seenInFile = new Map(); // phone -> row number
    const accepted = [];
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
      accepted.push({ row, name, phone: norm.phone });
    });

    // Pass 2: assign. Round-robin uses the shared persistent-cursor helper
    // (agents AND callers, fair across batches — SCALE-20), sized to the rows
    // that will actually be inserted.
    const rrAssignees = roundRobin ? assignRoundRobin(db, accepted.length) : [];

    accepted.forEach(({ row, name, phone }, i) => {
      const assignedTo = roundRobin ? (rrAssignees[i] ?? null) : fixedAssignee;
      const now = nowUtc();
      const ins = insertStmt.run(
        name, phone, String(row.phone ?? ''), row.alt_phone || null,
        row.email || null, row.city || null,
        String(row.source || defaultSource).trim() || defaultSource,
        assignedTo, row.notes || null,
        row.extra && Object.keys(row.extra).length ? JSON.stringify(row.extra) : null,
        id, now, now
      );
      // Initial score so imported leads are not NULL-scored (SCALE-10).
      recalcLeadScore(db, ins.lastInsertRowid);
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
