import { Router } from 'express';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';
import { isAdmin } from '../lib/permissions.js';
import { MAX_PAISE } from './catalog.js';

const router = Router();

// Same bound as deals/invoices/catalog (audit M-6 / SEC-9), and always a safe
// integer so SUM() rollups never lose precision.
const toPaise = (rupees) => {
  const paise = Math.round(Number(rupees) * 100);
  if (!Number.isSafeInteger(paise) || paise < 0 || paise > MAX_PAISE) return NaN;
  return paise;
};
const PRICE_ERROR = 'Valid price required (₹0 to ₹100 crore)';

// All logged-in users can list products (needed for the win-deal flow).
// `?all=1` (include inactive) is honoured for the admin tier (CLIENT-8).
router.get('/', (req, res) => {
  const includeInactive = req.query.all === '1' && isAdmin(req.user.role);
  const rows = db.prepare(
    `SELECT * FROM products ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY name`
  ).all();
  res.json(rows);
});

router.post('/', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const price = toPaise(req.body.price_rupees);
  if (!name) return res.status(400).json({ error: 'Product name required' });
  if (Number.isNaN(price)) return res.status(400).json({ error: PRICE_ERROR });
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
  const price = req.body.price_rupees !== undefined ? toPaise(req.body.price_rupees) : product.price_paise;
  const description = req.body.description !== undefined ? req.body.description : product.description;
  const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : product.is_active;
  if (!name) return res.status(400).json({ error: 'Product name required' });
  if (Number.isNaN(price)) return res.status(400).json({ error: PRICE_ERROR });
  db.prepare(
    'UPDATE products SET name = ?, price_paise = ?, description = ?, is_active = ? WHERE id = ?'
  ).run(name, price, description, isActive, product.id);
  res.json({ ok: true });
});

export default router;
