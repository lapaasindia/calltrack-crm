// Phase 3A — Service catalog + pricing config.
// GET /api/catalog is readable by ALL authed users (the price builder needs it).
// Writes (services / addons / pricing-config) are owner-only (requireOwner).
//
// Money is INTEGER paise everywhere. A ₹0 row is explicitly allowed (price >= 0,
// never blocked) — that was a documented bug in the source project we avoid here.
import { Router } from 'express';
import db, { getSetting, setSetting } from '../db.js';
import { requireOwner } from '../middleware/auth.js';
import { nowUtc } from '../lib/istTime.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

// Default pricing config — platform tiers (name + price in paise), the weekly
// bandwidth rate (paise per hour), and the default billing-term multipliers.
// Stored as one JSON 'pricing_config' setting; this is the fallback shape.
export const DEFAULT_PRICING_CONFIG = {
  platform_tiers: [
    { key: 'base', name: 'Base', price_paise: 0 },
    { key: 'pro', name: 'Pro', price_paise: 0 },
  ],
  bandwidth_rate_paise: 0, // per bandwidth-hour
  term_multipliers: { monthly: 1, quarterly: 0.94, annual: 0.86 },
};

function getPricingConfig() {
  const cfg = getSetting('pricing_config', null);
  if (!cfg || typeof cfg !== 'object') return DEFAULT_PRICING_CONFIG;
  return {
    platform_tiers: Array.isArray(cfg.platform_tiers) ? cfg.platform_tiers : DEFAULT_PRICING_CONFIG.platform_tiers,
    bandwidth_rate_paise: Number.isFinite(cfg.bandwidth_rate_paise) ? cfg.bandwidth_rate_paise : 0,
    term_multipliers: (cfg.term_multipliers && typeof cfg.term_multipliers === 'object')
      ? cfg.term_multipliers : DEFAULT_PRICING_CONFIG.term_multipliers,
  };
}

// Parse + validate an integer-paise value. Returns null when invalid; 0 is OK.
function toPaise(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function safeJson(s, fallback) {
  if (s == null) return fallback;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

// Normalize a term_multipliers payload (monthly/quarterly/annual → finite >0
// numbers). Falls back to defaults for any missing/invalid key.
function normMultipliers(input) {
  const d = DEFAULT_PRICING_CONFIG.term_multipliers;
  const src = (input && typeof input === 'object') ? input : {};
  const out = {};
  for (const k of ['monthly', 'quarterly', 'annual']) {
    const n = Number(src[k]);
    out[k] = Number.isFinite(n) && n > 0 ? n : d[k];
  }
  return out;
}

// ---------- READ (all authed users) ----------
router.get('/', (req, res) => {
  const services = db.prepare(
    'SELECT * FROM services ORDER BY sort_order, lower(name)'
  ).all().map((s) => ({ ...s, term_multipliers: safeJson(s.term_multipliers, DEFAULT_PRICING_CONFIG.term_multipliers) }));
  const addons = db.prepare(
    'SELECT * FROM service_addons ORDER BY sort_order, lower(name)'
  ).all();
  res.json({ services, addons, pricing_config: getPricingConfig() });
});

// ---------- everything below is owner-only ----------
router.use(requireOwner);

// --- services ---
router.post('/services', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Service name required' });
  const price = toPaise(req.body.base_price_paise ?? 0);
  if (price === null) return res.status(400).json({ error: 'base_price_paise must be a non-negative integer (paise)' });
  const info = db.prepare(
    `INSERT INTO services (name, slug, category, base_price_paise, term_multipliers, is_active, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name,
    req.body.slug ? String(req.body.slug).trim() : null,
    req.body.category ? String(req.body.category).trim() : null,
    price,
    JSON.stringify(normMultipliers(req.body.term_multipliers)),
    req.body.is_active === undefined ? 1 : (req.body.is_active ? 1 : 0),
    Number.isFinite(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0,
    nowUtc(),
  );
  logAudit({ action: 'SERVICE_CREATE', user: req.user, entity_type: 'service',
    entity_id: info.lastInsertRowid, details: { name, base_price_paise: price }, ip: req.ip });
  res.json({ id: info.lastInsertRowid });
});

router.put('/services/:id', (req, res) => {
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  const name = req.body.name !== undefined ? String(req.body.name).trim() : svc.name;
  if (!name) return res.status(400).json({ error: 'Service name required' });
  let price = svc.base_price_paise;
  if (req.body.base_price_paise !== undefined) {
    price = toPaise(req.body.base_price_paise);
    if (price === null) return res.status(400).json({ error: 'base_price_paise must be a non-negative integer (paise)' });
  }
  const slug = req.body.slug !== undefined ? (String(req.body.slug).trim() || null) : svc.slug;
  const category = req.body.category !== undefined ? (String(req.body.category).trim() || null) : svc.category;
  const multipliers = req.body.term_multipliers !== undefined
    ? JSON.stringify(normMultipliers(req.body.term_multipliers)) : svc.term_multipliers;
  const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : svc.is_active;
  const sortOrder = req.body.sort_order !== undefined && Number.isFinite(Number(req.body.sort_order))
    ? Number(req.body.sort_order) : svc.sort_order;
  db.prepare(
    `UPDATE services SET name = ?, slug = ?, category = ?, base_price_paise = ?,
       term_multipliers = ?, is_active = ?, sort_order = ? WHERE id = ?`
  ).run(name, slug, category, price, multipliers, isActive, sortOrder, svc.id);
  logAudit({ action: 'SERVICE_UPDATE', user: req.user, entity_type: 'service',
    entity_id: svc.id, details: { name, base_price_paise: price }, ip: req.ip });
  res.json({ ok: true });
});

router.delete('/services/:id', (req, res) => {
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  db.prepare('DELETE FROM services WHERE id = ?').run(svc.id);
  logAudit({ action: 'SERVICE_DELETE', user: req.user, entity_type: 'service',
    entity_id: svc.id, details: { name: svc.name }, ip: req.ip });
  res.json({ ok: true });
});

// --- add-ons ---
router.post('/addons', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Add-on name required' });
  const price = toPaise(req.body.price_paise ?? 0);
  if (price === null) return res.status(400).json({ error: 'price_paise must be a non-negative integer (paise)' });
  const info = db.prepare(
    `INSERT INTO service_addons (name, slug, price_paise, icon, is_active, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name,
    req.body.slug ? String(req.body.slug).trim() : null,
    price,
    req.body.icon ? String(req.body.icon).trim() : null,
    req.body.is_active === undefined ? 1 : (req.body.is_active ? 1 : 0),
    Number.isFinite(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0,
    nowUtc(),
  );
  logAudit({ action: 'ADDON_CREATE', user: req.user, entity_type: 'service_addon',
    entity_id: info.lastInsertRowid, details: { name, price_paise: price }, ip: req.ip });
  res.json({ id: info.lastInsertRowid });
});

router.put('/addons/:id', (req, res) => {
  const addon = db.prepare('SELECT * FROM service_addons WHERE id = ?').get(req.params.id);
  if (!addon) return res.status(404).json({ error: 'Add-on not found' });
  const name = req.body.name !== undefined ? String(req.body.name).trim() : addon.name;
  if (!name) return res.status(400).json({ error: 'Add-on name required' });
  let price = addon.price_paise;
  if (req.body.price_paise !== undefined) {
    price = toPaise(req.body.price_paise);
    if (price === null) return res.status(400).json({ error: 'price_paise must be a non-negative integer (paise)' });
  }
  const slug = req.body.slug !== undefined ? (String(req.body.slug).trim() || null) : addon.slug;
  const icon = req.body.icon !== undefined ? (String(req.body.icon).trim() || null) : addon.icon;
  const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : addon.is_active;
  const sortOrder = req.body.sort_order !== undefined && Number.isFinite(Number(req.body.sort_order))
    ? Number(req.body.sort_order) : addon.sort_order;
  db.prepare(
    `UPDATE service_addons SET name = ?, slug = ?, price_paise = ?, icon = ?, is_active = ?, sort_order = ? WHERE id = ?`
  ).run(name, slug, price, icon, isActive, sortOrder, addon.id);
  logAudit({ action: 'ADDON_UPDATE', user: req.user, entity_type: 'service_addon',
    entity_id: addon.id, details: { name, price_paise: price }, ip: req.ip });
  res.json({ ok: true });
});

router.delete('/addons/:id', (req, res) => {
  const addon = db.prepare('SELECT * FROM service_addons WHERE id = ?').get(req.params.id);
  if (!addon) return res.status(404).json({ error: 'Add-on not found' });
  db.prepare('DELETE FROM service_addons WHERE id = ?').run(addon.id);
  logAudit({ action: 'ADDON_DELETE', user: req.user, entity_type: 'service_addon',
    entity_id: addon.id, details: { name: addon.name }, ip: req.ip });
  res.json({ ok: true });
});

// --- pricing config ---
router.put('/pricing-config', (req, res) => {
  const body = req.body || {};
  const tiers = Array.isArray(body.platform_tiers) ? body.platform_tiers : [];
  const cleanTiers = [];
  for (const t of tiers) {
    const name = String(t?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Each platform tier needs a name' });
    const price = toPaise(t?.price_paise ?? 0);
    if (price === null) return res.status(400).json({ error: `Tier "${name}": price_paise must be a non-negative integer (paise)` });
    cleanTiers.push({
      key: t.key ? String(t.key).trim() : name.toLowerCase().replace(/\s+/g, '_'),
      name,
      price_paise: price,
    });
  }
  const rate = toPaise(body.bandwidth_rate_paise ?? 0);
  if (rate === null) return res.status(400).json({ error: 'bandwidth_rate_paise must be a non-negative integer (paise)' });

  const cfg = {
    platform_tiers: cleanTiers.length ? cleanTiers : DEFAULT_PRICING_CONFIG.platform_tiers,
    bandwidth_rate_paise: rate,
    term_multipliers: normMultipliers(body.term_multipliers),
  };
  setSetting('pricing_config', cfg);
  logAudit({ action: 'PRICING_CONFIG_UPDATE', user: req.user, entity_type: 'pricing_config',
    entity_id: null, details: { tiers: cfg.platform_tiers.length }, ip: req.ip });
  res.json({ ok: true, pricing_config: cfg });
});

export default router;
