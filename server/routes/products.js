import { Router } from 'express';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';

const router = Router();

// All logged-in users can list products (needed for the win-deal flow).
router.get('/', (req, res) => {
  const includeInactive = req.query.all === '1' && req.user.role === 'admin';
  const rows = db.prepare(
    `SELECT * FROM products ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY name`
  ).all();
  res.json(rows);
});

router.post('/', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const price = Math.round(Number(req.body.price_rupees) * 100);
  if (!name) return res.status(400).json({ error: 'Product name required' });
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Valid price required' });
  try {
    const info = db.prepare(
      'INSERT INTO products (name, price_paise, description, created_at) VALUES (?, ?, ?, ?)'
    ).run(name, price, req.body.description || null, nowUtc());
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A product with this name already exists' });
    }
    throw err;
  }
});

router.patch('/:id', requireAdmin, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const name = req.body.name !== undefined ? String(req.body.name).trim() : product.name;
  const price = req.body.price_rupees !== undefined
    ? Math.round(Number(req.body.price_rupees) * 100) : product.price_paise;
  const description = req.body.description !== undefined ? req.body.description : product.description;
  const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : product.is_active;
  if (!name) return res.status(400).json({ error: 'Product name required' });
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Valid price required' });
  db.prepare(
    'UPDATE products SET name = ?, price_paise = ?, description = ?, is_active = ? WHERE id = ?'
  ).run(name, price, description, isActive, product.id);
  res.json({ ok: true });
});

export default router;
