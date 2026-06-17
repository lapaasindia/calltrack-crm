import { Router } from 'express';
import db from '../db.js';
import { requireOwner } from '../middleware/auth.js';

const router = Router();
router.use(requireOwner);

// GET /api/audit?limit=&offset= — latest entries, newest first, with the
// acting user's name joined in. Paginated (default 50, capped at 200).
router.get('/', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const rows = db.prepare(
    `SELECT a.id, a.action, a.user_id, a.user_email, a.entity_type, a.entity_id,
            a.details, a.ip, a.created_at, u.full_name AS user_name
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ? OFFSET ?`
  ).all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
  res.json({
    total,
    limit,
    offset,
    logs: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })),
  });
});

export default router;
