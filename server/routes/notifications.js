import { Router } from 'express';
import db from '../db.js';
import { nowUtc } from '../lib/istTime.js';

const router = Router();

// GET /api/notifications — latest 20 for the current user (newest first) plus
// the unread count. The client bell polls this on the existing 60s tick.
router.get('/', (req, res) => {
  const list = db.prepare(
    `SELECT id, title, body, type, read, created_at
     FROM notifications WHERE user_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 20`
  ).all(req.user.id);
  const unread = db.prepare(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0'
  ).get(req.user.id).n;
  res.json({ notifications: list, unread });
});

// POST /api/notifications/read-all — mark this user's unread notifications read.
router.post('/read-all', (req, res) => {
  const info = db.prepare(
    'UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0'
  ).run(req.user.id);
  res.json({ ok: true, marked: info.changes });
});

export default router;
