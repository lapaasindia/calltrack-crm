// Phase 3A — Service catalog + pricing config + Kanban stage-move note.
// Runs against a real server on a throwaway database. No external services.
//   - catalog CRUD incl. a ₹0 service/addon (must succeed)
//   - GET /api/catalog readable by a non-owner; writes 403 for non-owner
//   - pricing_config round-trip
//   - a Kanban stage-move PATCH carrying a note writes a lead_event + rescores
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-catalog-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

const { ensureBootstrapped } = await import('../bootstrap.js');
ensureBootstrapped();
const db = (await import('../db.js')).default;

let baseUrl;
let server;
let adminCookie;
let agentCookie;
let agentId;
let leadId;

const api = async (pathname, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

// Login capturing the set-cookie header for session-based requests.
async function loginCapture(username, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  return res.headers.get('set-cookie').split(';')[0];
}

before(async () => {
  const { createApp } = await import('../app.js');
  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminCookie = await loginCapture('admin', 'admin123');

  // A non-owner agent (read catalog yes, write no) + a lead for the Kanban test.
  const bcrypt = (await import('bcryptjs')).default;
  agentId = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
     VALUES ('agent1', ?, 'Agent One', 'agent', 1, ?)`
  ).run(bcrypt.hashSync('pw12345', 8), new Date().toISOString()).lastInsertRowid;
  agentCookie = await loginCapture('agent1', 'pw12345');

  const lead = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Kanban Lead', phone: '9876543210', assigned_to: agentId },
  });
  leadId = lead.data.id;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET /api/catalog is readable by a non-owner', async () => {
  const res = await api('/api/catalog', { cookie: agentCookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.services));
  assert.ok(Array.isArray(res.data.addons));
  assert.ok(res.data.pricing_config && typeof res.data.pricing_config === 'object');
  assert.ok(res.data.pricing_config.term_multipliers.monthly === 1);
});

test('catalog writes are 403 for a non-owner', async () => {
  const svc = await api('/api/catalog/services', {
    method: 'POST', cookie: agentCookie, body: { name: 'Nope', base_price_paise: 1000 },
  });
  assert.equal(svc.status, 403);
  const cfg = await api('/api/catalog/pricing-config', {
    method: 'PUT', cookie: agentCookie, body: { platform_tiers: [] },
  });
  assert.equal(cfg.status, 403);
});

test('owner can CRUD a service', async () => {
  const created = await api('/api/catalog/services', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'SEO Retainer', category: 'marketing', base_price_paise: 5000000,
      term_multipliers: { monthly: 1, quarterly: 0.9, annual: 0.8 } },
  });
  assert.equal(created.status, 200);
  const id = created.data.id;

  const updated = await api(`/api/catalog/services/${id}`, {
    method: 'PUT', cookie: adminCookie, body: { base_price_paise: 6000000, is_active: 0 },
  });
  assert.equal(updated.status, 200);

  const list = await api('/api/catalog', { cookie: adminCookie });
  const svc = list.data.services.find((s) => s.id === id);
  assert.equal(svc.base_price_paise, 6000000);
  assert.equal(svc.is_active, 0);
  assert.equal(svc.term_multipliers.quarterly, 0.9, 'multipliers persisted as parsed JSON');

  const del = await api(`/api/catalog/services/${id}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(del.status, 200);
  const after2 = await api('/api/catalog', { cookie: adminCookie });
  assert.ok(!after2.data.services.some((s) => s.id === id), 'service removed');
});

test('a ₹0 service and a ₹0 addon both save (0-price not blocked)', async () => {
  const freeSvc = await api('/api/catalog/services', {
    method: 'POST', cookie: adminCookie, body: { name: 'Free Onboarding', base_price_paise: 0 },
  });
  assert.equal(freeSvc.status, 200, 'a ₹0 service must save');

  const freeAddon = await api('/api/catalog/addons', {
    method: 'POST', cookie: adminCookie, body: { name: 'Welcome Kit', price_paise: 0 },
  });
  assert.equal(freeAddon.status, 200, 'a ₹0 add-on must save');

  const list = await api('/api/catalog', { cookie: adminCookie });
  assert.ok(list.data.services.some((s) => s.id === freeSvc.data.id && s.base_price_paise === 0));
  assert.ok(list.data.addons.some((a) => a.id === freeAddon.data.id && a.price_paise === 0));
});

test('a negative / non-integer price is rejected', async () => {
  const neg = await api('/api/catalog/services', {
    method: 'POST', cookie: adminCookie, body: { name: 'Bad', base_price_paise: -100 },
  });
  assert.equal(neg.status, 400);
  const frac = await api('/api/catalog/addons', {
    method: 'POST', cookie: adminCookie, body: { name: 'Bad', price_paise: 12.5 },
  });
  assert.equal(frac.status, 400);
});

test('addon CRUD round-trip', async () => {
  const created = await api('/api/catalog/addons', {
    method: 'POST', cookie: adminCookie, body: { name: 'Priority Support', price_paise: 250000, icon: '⚡' },
  });
  assert.equal(created.status, 200);
  const id = created.data.id;
  const upd = await api(`/api/catalog/addons/${id}`, {
    method: 'PUT', cookie: adminCookie, body: { price_paise: 300000 },
  });
  assert.equal(upd.status, 200);
  const list = await api('/api/catalog', { cookie: adminCookie });
  assert.equal(list.data.addons.find((a) => a.id === id).price_paise, 300000);
  await api(`/api/catalog/addons/${id}`, { method: 'DELETE', cookie: adminCookie });
});

test('pricing_config round-trips (paise integers preserved)', async () => {
  const cfg = {
    platform_tiers: [
      { key: 'base', name: 'Base', price_paise: 1500000 },
      { key: 'pro', name: 'Pro', price_paise: 4500000 },
    ],
    bandwidth_rate_paise: 50000,
    term_multipliers: { monthly: 1, quarterly: 0.92, annual: 0.84 },
  };
  const put = await api('/api/catalog/pricing-config', {
    method: 'PUT', cookie: adminCookie, body: cfg,
  });
  assert.equal(put.status, 200);

  const list = await api('/api/catalog', { cookie: agentCookie });
  const got = list.data.pricing_config;
  assert.equal(got.platform_tiers.length, 2);
  assert.equal(got.platform_tiers[1].name, 'Pro');
  assert.equal(got.platform_tiers[1].price_paise, 4500000);
  assert.equal(got.bandwidth_rate_paise, 50000);
  assert.equal(got.term_multipliers.annual, 0.84);
});

test('pricing-config rejects a non-integer tier price', async () => {
  const bad = await api('/api/catalog/pricing-config', {
    method: 'PUT', cookie: adminCookie,
    body: { platform_tiers: [{ name: 'X', price_paise: 10.5 }], bandwidth_rate_paise: 0 },
  });
  assert.equal(bad.status, 400);
});

test('Kanban stage-move PATCH with a note writes a lead_event and rescores', async () => {
  const before2 = db.prepare(
    'SELECT COUNT(*) AS n FROM lead_events WHERE lead_id = ?'
  ).get(leadId).n;
  const scoreBefore = db.prepare('SELECT score FROM leads WHERE id = ?').get(leadId).score;

  const res = await api(`/api/leads/${leadId}`, {
    method: 'PATCH', cookie: agentCookie,
    body: { stage: 'interested', note: 'Asked for a demo next week.' },
  });
  assert.equal(res.status, 200);

  const events = db.prepare(
    'SELECT * FROM lead_events WHERE lead_id = ? ORDER BY id DESC'
  ).all(leadId);
  assert.equal(events.length, before2 + 1, 'exactly one new lead_event');
  assert.equal(events[0].to_stage, 'interested');

  const lead = db.prepare('SELECT stage, score, notes FROM leads WHERE id = ?').get(leadId);
  assert.equal(lead.stage, 'interested');
  assert.ok(lead.notes.includes('Asked for a demo next week.'), 'note appended to lead notes');
  // 'interested' carries a stage boost → score must be (re)computed, not null.
  assert.ok(lead.score != null, 'score recalculated');
  assert.ok(lead.score >= (scoreBefore || 0), 'interested boost does not lower the score');
});

test('moving a lead to "won" via PATCH is rejected (use Win Deal flow)', async () => {
  const res = await api(`/api/leads/${leadId}`, {
    method: 'PATCH', cookie: agentCookie, body: { stage: 'won', note: 'closed' },
  });
  assert.equal(res.status, 400);
});
