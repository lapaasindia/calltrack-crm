// Phase 3B — Persisted GST invoices. Runs against a real server on a throwaway
// database. No external services.
//   - create invoice from a lead → correct subtotal/tax(18%)/total in paise,
//     unique INV- number, items persisted
//   - GST uses the settings gst_percent when set (and a body override wins)
//   - access control: a caller can't read/create an invoice for a foreign lead
//   - GET :id/html returns 200 text/html containing the total
//   - status PATCH; DELETE is admin tier
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-invoices-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

const { ensureBootstrapped } = await import('../bootstrap.js');
ensureBootstrapped();
const db = (await import('../db.js')).default;
const { setSetting } = await import('../db.js');

let baseUrl;
let server;
let adminCookie;
let callerCookie;
let callerId;
let myLeadId;       // lead assigned to the caller
let foreignLeadId;  // lead assigned to admin only

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

  const bcrypt = (await import('bcryptjs')).default;
  callerId = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
     VALUES ('caller1', ?, 'Caller One', 'caller', 1, ?)`
  ).run(bcrypt.hashSync('pw12345', 8), new Date().toISOString()).lastInsertRowid;
  callerCookie = await loginCapture('caller1', 'pw12345');

  const mine = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'My Lead', phone: '9876500001', email: 'my@lead.test', city: 'Pune', assigned_to: callerId },
  });
  myLeadId = mine.data.id;

  const foreign = await api('/api/leads', {
    method: 'POST', cookie: adminCookie,
    body: { name: 'Foreign Lead', phone: '9876500002', assigned_to: 1 },
  });
  foreignLeadId = foreign.data.id;
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('create invoice from a lead → subtotal/tax(18%)/total in paise, items persisted', async () => {
  // Default gst_percent is 18.
  const res = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie,
    body: {
      lead_id: myLeadId,
      items: [
        { description: 'Consulting Services', qty: 2, unit_price_paise: 1500000 },
        { description: 'Onboarding', qty: 1, unit_price_paise: 500000 },
      ],
    },
  });
  assert.equal(res.status, 200);
  const inv = res.data;
  // subtotal = 2*1500000 + 500000 = 3500000
  assert.equal(inv.subtotal_paise, 3500000);
  assert.equal(inv.gst_percent, 18);
  // tax = round(3500000 * 18 / 100) = 630000
  assert.equal(inv.tax_paise, 630000);
  assert.equal(inv.total_paise, 4130000);
  assert.match(inv.invoice_number, /^INV-\d{5}$/);
  assert.equal(inv.items.length, 2);
  assert.equal(inv.items[0].amount_paise, 3000000, 'qty*unit persisted');
  // Bill-to defaulted from the lead.
  assert.equal(inv.bill_to_name, 'My Lead');
  assert.equal(inv.bill_to_email, 'my@lead.test');
  assert.equal(inv.bill_to_phone, '9876500001');
  assert.equal(inv.status, 'draft');

  // Persisted: re-fetch detail.
  const detail = await api(`/api/invoices/${inv.id}`, { cookie: callerCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.items.length, 2);
  assert.equal(detail.data.total_paise, 4130000);
});

test('invoice numbers are unique and sequential', async () => {
  const a = await api('/api/invoices', {
    method: 'POST', cookie: adminCookie,
    body: { lead_id: myLeadId, items: [{ description: 'X', qty: 1, unit_price_paise: 100 }] },
  });
  const b = await api('/api/invoices', {
    method: 'POST', cookie: adminCookie,
    body: { lead_id: myLeadId, items: [{ description: 'Y', qty: 1, unit_price_paise: 100 }] },
  });
  assert.notEqual(a.data.invoice_number, b.data.invoice_number);
  const na = parseInt(a.data.invoice_number.slice(4), 10);
  const nb = parseInt(b.data.invoice_number.slice(4), 10);
  assert.equal(nb, na + 1, 'sequential');
});

test('GST uses settings gst_percent when set; body override wins', async () => {
  setSetting('gst_percent', 5);
  const fromSetting = await api('/api/invoices', {
    method: 'POST', cookie: adminCookie,
    body: { lead_id: myLeadId, items: [{ description: 'Z', qty: 1, unit_price_paise: 1000000 }] },
  });
  assert.equal(fromSetting.data.gst_percent, 5);
  assert.equal(fromSetting.data.tax_paise, 50000); // 5% of 1,000,000
  assert.equal(fromSetting.data.total_paise, 1050000);

  // Explicit override in the body takes precedence over the setting.
  const override = await api('/api/invoices', {
    method: 'POST', cookie: adminCookie,
    body: { lead_id: myLeadId, gst_percent: 12, items: [{ description: 'Z', qty: 1, unit_price_paise: 1000000 }] },
  });
  assert.equal(override.data.gst_percent, 12);
  assert.equal(override.data.tax_paise, 120000);

  setSetting('gst_percent', 18); // restore for other tests
});

test('access control: caller cannot create/read an invoice for a foreign lead', async () => {
  const create = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie,
    body: { lead_id: foreignLeadId, items: [{ description: 'Nope', qty: 1, unit_price_paise: 1000 }] },
  });
  assert.equal(create.status, 403);

  // Admin makes one on the foreign lead; the caller must not be able to read it.
  const adminInv = await api('/api/invoices', {
    method: 'POST', cookie: adminCookie,
    body: { lead_id: foreignLeadId, items: [{ description: 'Admin only', qty: 1, unit_price_paise: 1000 }] },
  });
  assert.equal(adminInv.status, 200);
  const read = await api(`/api/invoices/${adminInv.data.id}`, { cookie: callerCookie });
  assert.equal(read.status, 403);
  const html = await fetch(`${baseUrl}/api/invoices/${adminInv.data.id}/html`, {
    headers: { Cookie: callerCookie },
  });
  assert.equal(html.status, 403);
});

test('list is scoped: caller sees own-lead invoices only; ?lead_id filter works', async () => {
  const mine = await api('/api/invoices', { cookie: callerCookie });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.length >= 1);
  assert.ok(mine.data.every((i) => i.lead_id === myLeadId), 'only own-lead invoices');

  const filtered = await api(`/api/invoices?lead_id=${myLeadId}`, { cookie: adminCookie });
  assert.ok(filtered.data.every((i) => i.lead_id === myLeadId));
});

test('GET :id/html returns 200 text/html containing the total', async () => {
  const inv = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie,
    body: { lead_id: myLeadId, items: [{ description: 'Consulting Services', qty: 1, unit_price_paise: 1000000 }] },
  });
  // total = 1,000,000 + 18% = 1,180,000 paise = ₹11,800.00
  const res = await fetch(`${baseUrl}/api/invoices/${inv.data.id}/html`, {
    headers: { Cookie: callerCookie },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('11,800.00'), 'total rendered in en-IN ₹ format');
  assert.ok(html.includes(inv.data.invoice_number), 'invoice number present');
  assert.ok(html.includes('window.print'), 'print button present');
});

test('status PATCH updates the invoice; invalid status rejected', async () => {
  const inv = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie,
    body: { lead_id: myLeadId, items: [{ description: 'X', qty: 1, unit_price_paise: 100 }] },
  });
  const sent = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: callerCookie, body: { status: 'sent' },
  });
  assert.equal(sent.status, 200);
  const after = await api(`/api/invoices/${inv.data.id}`, { cookie: callerCookie });
  assert.equal(after.data.status, 'sent');

  const bad = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: callerCookie, body: { status: 'nonsense' },
  });
  assert.equal(bad.status, 400);
});

test('DELETE is admin tier', async () => {
  const inv = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie,
    body: { lead_id: myLeadId, items: [{ description: 'X', qty: 1, unit_price_paise: 100 }] },
  });
  const denied = await api(`/api/invoices/${inv.data.id}`, { method: 'DELETE', cookie: callerCookie });
  assert.equal(denied.status, 403);
  const ok = await api(`/api/invoices/${inv.data.id}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(ok.status, 200);
  const gone = await api(`/api/invoices/${inv.data.id}`, { cookie: adminCookie });
  assert.equal(gone.status, 404);
});

test('price-builder annual quote: persisted invoice subtotal === full-term total', async () => {
  // Mirror PriceBuilder.jsx exactly for an annual plan with a discount, then
  // assert the persisted invoice covers the FULL TERM (12 months), not one month.
  const monthlyBasePaise = 100000;        // ₹1,000/mo base (sum of line items)
  const multiplier = 0.86;                // annual 14% off
  const months = 12;
  const monthlyPaise = Math.round(monthlyBasePaise * multiplier); // effective per-month
  const termTotalPaise = monthlyPaise * months;                   // on-screen total

  // Client line items: each monthly line billed qty = months; discount scaled by months.
  const items = [
    { description: 'Platform — Base', qty: months, unit_price_paise: monthlyBasePaise },
    { description: 'Annual discount (14% off)', qty: 1, unit_price_paise: (monthlyPaise - monthlyBasePaise) * months },
  ];

  const res = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie, body: { lead_id: myLeadId, items },
  });
  assert.equal(res.status, 200);
  // The defect was: subtotal == one month (~86,000) instead of the full year.
  assert.equal(res.data.subtotal_paise, termTotalPaise, 'invoice subtotal covers the full term');
  assert.equal(res.data.subtotal_paise, 1032000, 'annual base 100000/mo, 14% off → 1,032,000 paise');
  // GST is then charged on the correct, full-term base.
  assert.equal(res.data.tax_paise, Math.round(termTotalPaise * 18 / 100));
  assert.equal(res.data.total_paise, termTotalPaise + res.data.tax_paise);
});

test('terminal invoice status (paid/cancelled) cannot transition out', async () => {
  const inv = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie,
    body: { lead_id: myLeadId, items: [{ description: 'X', qty: 1, unit_price_paise: 100 }] },
  });
  // Settle it (admin tier is required to reach a terminal state).
  const paid = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { status: 'paid' },
  });
  assert.equal(paid.status, 200);
  // Re-setting the same terminal status is a harmless no-op (and not a transition,
  // so it isn't admin-gated — the caller who owns the lead may re-PATCH it).
  const same = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: callerCookie, body: { status: 'paid' },
  });
  assert.equal(same.status, 200);
  // But moving paid → draft (or any other) is rejected.
  const revert = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { status: 'draft' },
  });
  assert.equal(revert.status, 409);
  const still = await api(`/api/invoices/${inv.data.id}`, { cookie: callerCookie });
  assert.equal(still.data.status, 'paid', 'status unchanged after rejected transition');
});

test('reaching a terminal status (paid/cancelled) requires admin tier', async () => {
  // A plain caller may move draft <-> sent on a lead they own...
  const inv = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie,
    body: { lead_id: myLeadId, items: [{ description: 'X', qty: 1, unit_price_paise: 100 }] },
  });
  const sent = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: callerCookie, body: { status: 'sent' },
  });
  assert.equal(sent.status, 200);
  const backToDraft = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: callerCookie, body: { status: 'draft' },
  });
  assert.equal(backToDraft.status, 200, 'draft <-> sent stays open to the caller');

  // ...but a caller cannot mark it paid or cancelled.
  const callerPaid = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: callerCookie, body: { status: 'paid' },
  });
  assert.equal(callerPaid.status, 403, 'caller cannot settle an invoice');
  const callerCancel = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: callerCookie, body: { status: 'cancelled' },
  });
  assert.equal(callerCancel.status, 403, 'caller cannot void an invoice');
  const unchanged = await api(`/api/invoices/${inv.data.id}`, { cookie: callerCookie });
  assert.equal(unchanged.data.status, 'draft', 'status untouched after denied transitions');

  // Admin CAN settle it.
  const adminPaid = await api(`/api/invoices/${inv.data.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { status: 'paid' },
  });
  assert.equal(adminPaid.status, 200, 'admin may mark paid');
  const final = await api(`/api/invoices/${inv.data.id}`, { cookie: callerCookie });
  assert.equal(final.data.status, 'paid');
});

test('empty items / no lead for a caller are rejected', async () => {
  const noItems = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie, body: { lead_id: myLeadId, items: [] },
  });
  assert.equal(noItems.status, 400);

  const noLead = await api('/api/invoices', {
    method: 'POST', cookie: callerCookie,
    body: { items: [{ description: 'X', qty: 1, unit_price_paise: 100 }] },
  });
  assert.equal(noLead.status, 403, 'a caller must scope an invoice to a lead they can access');
});
