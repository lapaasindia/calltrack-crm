// Phase 3B — Persisted GST invoices.
//
// Money is INTEGER paise everywhere. tax_paise = round(subtotal * gst / 100).
// Invoices are persisted in the DB and rendered as a clean, self-contained,
// print-ready HTML document (GET :id/html) — the user gets a real PDF via the
// browser's Print → Save as PDF. No PDF library, no new deps.
//
// Access mirrors leads: a caller sees / acts on invoices for leads they can
// access; admin tier (super_admin|admin|manager) sees all. DELETE is admin tier.
import { Router } from 'express';
import db, { getSetting } from '../db.js';
import { requireAdmin, canAccessLead } from '../middleware/auth.js';
import { nowUtc, todayIst, addDays } from '../lib/istTime.js';
import { logAudit } from '../lib/audit.js';
import { isAdmin } from '../lib/permissions.js';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['draft', 'sent', 'paid', 'cancelled'];
// Final states an invoice can't transition out of (only re-set to itself).
const TERMINAL_STATUSES = ['paid', 'cancelled'];

// Parse an integer-paise line value. Returns null when not a finite integer.
// Negative is ALLOWED at the line level so a discount can be expressed as a
// negative line (e.g. a billing-term discount from the price builder); the
// computed subtotal is still guarded to be non-negative.
// ±10 crore rupees per line — far above any real invoice line, and small
// enough that summed totals stay well inside Number.MAX_SAFE_INTEGER paise so
// integer math never silently loses precision (audit M-6).
const MAX_LINE_PAISE = 100_00_00_000 * 100;
function toLinePaise(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (Math.abs(n) > MAX_LINE_PAISE) return null;
  return n;
}

// Resolve the GST percent: an explicit integer in the body wins, else the
// 'gst_percent' setting (default 18). Always an integer (the schema is INTEGER).
function resolveGstPercent(body) {
  if (body && body.gst_percent !== undefined) {
    const n = Number(body.gst_percent);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  const setting = Number(getSetting('gst_percent', 18));
  return Number.isFinite(setting) && setting >= 0 ? Math.round(setting) : 18;
}

// Next 'INV-NNNNN' number from a sequence: highest existing numeric suffix + 1,
// zero-padded to 5. Stable and unique (the column is UNIQUE); never random.
function nextInvoiceNumber() {
  const row = db.prepare(
    `SELECT invoice_number FROM invoices
     WHERE invoice_number LIKE 'INV-%'
     ORDER BY CAST(SUBSTR(invoice_number, 5) AS INTEGER) DESC LIMIT 1`
  ).get();
  let next = 1;
  if (row) {
    const n = parseInt(String(row.invoice_number).slice(4), 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `INV-${String(next).padStart(5, '0')}`;
}

function loadInvoiceItems(invoiceId) {
  return db.prepare(
    'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id'
  ).all(invoiceId);
}

// An invoice is accessible if it's tied to a lead the caller can access, OR the
// caller is admin tier, OR (no lead) the caller created it.
function canAccessInvoice(user, invoice) {
  if (isAdmin(user.role)) return true;
  if (invoice.lead_id) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(invoice.lead_id);
    return canAccessLead(user, lead);
  }
  return invoice.created_by === user.id;
}

// ---------- CREATE ----------
router.post('/', (req, res) => {
  const body = req.body || {};

  // Resolve + access-check the lead (if any). Non-admins MUST scope to a lead
  // they can access; admins may create lead-less invoices.
  let lead = null;
  if (body.lead_id) {
    lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(body.lead_id));
    if (!lead || lead.deleted_at) return res.status(404).json({ error: 'Lead not found' });
    if (!canAccessLead(req.user, lead)) return res.status(403).json({ error: 'Not your lead' });
  } else if (!isAdmin(req.user.role)) {
    return res.status(403).json({ error: 'Pick a lead you can access' });
  }

  // Optional deal: must belong to the lead.
  let deal = null;
  if (body.deal_id) {
    deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(Number(body.deal_id));
    if (!deal) return res.status(400).json({ error: 'Invalid deal' });
    if (lead && deal.lead_id !== lead.id) return res.status(400).json({ error: 'Deal does not belong to this lead' });
    if (!lead) {
      // deal given without a lead: pull + access-check the deal's lead.
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(deal.lead_id);
      if (!canAccessLead(req.user, lead)) return res.status(403).json({ error: 'Not your lead' });
    }
  }

  // Line items.
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i] || {};
    const description = String(it.description ?? it.name ?? '').trim();
    if (!description) return res.status(400).json({ error: `Item ${i + 1}: description required` });
    const qty = Number(it.qty);
    if (Number.isInteger(qty) && qty > 100000) {
      return res.status(400).json({ error: `Item ${i + 1}: quantity is too large` });
    }
    const cleanQty = Number.isInteger(qty) && qty > 0 ? qty : 1;
    const unit = toLinePaise(it.unit_price_paise ?? it.unit_paise);
    if (unit === null) return res.status(400).json({ error: `Item ${i + 1}: unit_price_paise must be an integer (paise) within range` });
    const amount = cleanQty * unit;
    if (Math.abs(amount) > MAX_LINE_PAISE) {
      return res.status(400).json({ error: `Item ${i + 1}: line amount is out of range` });
    }
    items.push({
      description,
      qty: cleanQty,
      unit_price_paise: unit,
      amount_paise: amount,
      sort_order: i,
    });
  }
  if (!items.length) return res.status(400).json({ error: 'At least one line item is required' });

  const subtotal = items.reduce((s, it) => s + it.amount_paise, 0);
  if (subtotal < 0) return res.status(400).json({ error: 'Invoice subtotal cannot be negative' });
  const gstPercent = resolveGstPercent(body);
  const tax = Math.round((subtotal * gstPercent) / 100);
  const total = subtotal + tax;
  if (!Number.isSafeInteger(total)) {
    return res.status(400).json({ error: 'Invoice total is out of range' });
  }

  const issueDate = todayIst();
  const dueDate = DATE_RE.test(body.due_date || '') ? body.due_date : addDays(issueDate, 14);

  // Bill-to defaults from the lead when omitted. Leads have no address column;
  // fall back to the lead's city.
  const billToName = (body.bill_to_name ?? lead?.name) || null;
  const billToEmail = (body.bill_to_email ?? lead?.email) || null;
  const billToPhone = (body.bill_to_phone ?? lead?.phone) || null;
  const billToAddress = (body.bill_to_address ?? lead?.city) || null;

  const now = nowUtc();
  const invoiceId = db.transaction(() => {
    const number = nextInvoiceNumber();
    const info = db.prepare(
      `INSERT INTO invoices
         (invoice_number, lead_id, deal_id, bill_to_name, bill_to_email, bill_to_phone,
          bill_to_address, issue_date, due_date, subtotal_paise, gst_percent, tax_paise,
          total_paise, status, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
    ).run(
      number, lead?.id ?? null, deal?.id ?? null, billToName, billToEmail, billToPhone,
      billToAddress, issueDate, dueDate, subtotal, gstPercent, tax, total,
      body.notes ? String(body.notes) : null, req.user.id, now,
    );
    const id = info.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO invoice_items (invoice_id, description, qty, unit_price_paise, amount_paise, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const it of items) {
      insertItem.run(id, it.description, it.qty, it.unit_price_paise, it.amount_paise, it.sort_order);
    }
    return id;
  })();

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  logAudit({
    action: 'INVOICE_CREATED', user: req.user, entity_type: 'invoice', entity_id: invoiceId,
    details: { invoice_number: invoice.invoice_number, total_paise: total, lead_id: lead?.id ?? null }, ip: req.ip,
  });
  res.json({ id: invoiceId, invoice_number: invoice.invoice_number, ...invoice, items: loadInvoiceItems(invoiceId) });
});

// ---------- LIST ----------
router.get('/', (req, res) => {
  const where = [];
  const params = [];
  // Non-admins are hard-scoped to invoices they may see: leads assigned to them
  // (and not soft-deleted, to match the GET :id / :id/html access rule) OR
  // lead-less invoices they created.
  if (!isAdmin(req.user.role)) {
    where.push('((l.assigned_to = ? AND l.deleted_at IS NULL) OR (i.lead_id IS NULL AND i.created_by = ?))');
    params.push(req.user.id, req.user.id);
  }
  if (req.query.lead_id) {
    where.push('i.lead_id = ?');
    params.push(Number(req.query.lead_id));
  }
  if (req.query.status && STATUSES.includes(req.query.status)) {
    where.push('i.status = ?');
    params.push(req.query.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT i.*, l.name AS lead_name
     FROM invoices i
     LEFT JOIN leads l ON l.id = i.lead_id
     ${whereSql}
     ORDER BY i.created_at DESC, i.id DESC`
  ).all(...params);
  res.json(rows);
});

// ---------- DETAIL ----------
router.get('/:id', (req, res) => {
  const invoice = db.prepare(
    `SELECT i.*, l.name AS lead_name FROM invoices i
     LEFT JOIN leads l ON l.id = i.lead_id WHERE i.id = ?`
  ).get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!canAccessInvoice(req.user, invoice)) return res.status(403).json({ error: 'Not allowed' });
  res.json({ ...invoice, items: loadInvoiceItems(invoice.id) });
});

// ---------- PRINT-READY HTML (the real-PDF path) ----------
router.get('/:id/html', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!canAccessInvoice(req.user, invoice)) return res.status(403).json({ error: 'Not allowed' });
  const items = loadInvoiceItems(invoice.id);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderInvoiceHtml(invoice, items));
});

// ---------- STATUS / EDIT ----------
router.patch('/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!canAccessInvoice(req.user, invoice)) return res.status(403).json({ error: 'Not allowed' });
  if (req.body.status === undefined) return res.status(400).json({ error: 'Nothing to update' });
  if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  // Terminal states ('paid'/'cancelled') are final: once an invoice settles or is
  // voided it can't be moved to a different status (re-setting the same status is a
  // harmless no-op), preventing contradictory audit trails like paid → draft.
  if (TERMINAL_STATUSES.includes(invoice.status) && req.body.status !== invoice.status) {
    return res.status(409).json({ error: `Invoice is ${invoice.status}; status can no longer change` });
  }
  // Settling ('paid') or voiding ('cancelled') an invoice is a money-significant
  // action reserved for the admin tier. draft<->sent stays open to anyone who can
  // access the invoice. (Re-setting the same terminal status is already short-
  // circuited above, so this only gates a genuine TRANSITION into a terminal state.)
  if (TERMINAL_STATUSES.includes(req.body.status)
      && req.body.status !== invoice.status
      && !isAdmin(req.user.role)) {
    return res.status(403).json({ error: `Only an admin can mark an invoice ${req.body.status}` });
  }
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(req.body.status, invoice.id);
  logAudit({
    action: 'INVOICE_STATUS', user: req.user, entity_type: 'invoice', entity_id: invoice.id,
    details: { from: invoice.status, to: req.body.status }, ip: req.ip,
  });
  res.json({ ok: true });
});

// ---------- DELETE (admin tier) ----------
router.delete('/:id', requireAdmin, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoice.id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(invoice.id);
  })();
  logAudit({
    action: 'INVOICE_DELETED', user: req.user, entity_type: 'invoice', entity_id: invoice.id,
    details: { invoice_number: invoice.invoice_number }, ip: req.ip,
  });
  res.json({ ok: true });
});

// ---------- HTML rendering ----------
const escapeHtml = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// en-IN ₹ formatting from integer paise (no float math: split rupees/paise).
function inr(paise) {
  const n = Math.round(Number(paise) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const rupeesPart = Math.floor(abs / 100);
  const paisePart = abs % 100;
  const grouped = rupeesPart.toLocaleString('en-IN');
  return `${sign}₹${grouped}.${String(paisePart).padStart(2, '0')}`;
}

// IST business date 'YYYY-MM-DD' → '15 Jun 2026' without timezone drift.
function fmtDate(dateStr) {
  if (!DATE_RE.test(dateStr || '')) return escapeHtml(dateStr || '');
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
  });
}

function renderInvoiceHtml(invoice, items) {
  const companyName = getSetting('company_legal_name', '') || getSetting('company_name', 'Our Company');
  const companyAddress = getSetting('company_address', '');
  const companyGstin = getSetting('company_gstin', '');

  const itemRows = items.map((it) => `
        <tr>
          <td>${escapeHtml(it.description)}</td>
          <td class="num">${it.qty}</td>
          <td class="num">${inr(it.unit_price_paise)}</td>
          <td class="num">${inr(it.amount_paise)}</td>
        </tr>`).join('');

  const billTo = [
    invoice.bill_to_name,
    invoice.bill_to_address,
    invoice.bill_to_phone ? `Phone: ${invoice.bill_to_phone}` : '',
    invoice.bill_to_email ? `Email: ${invoice.bill_to_email}` : '',
  ].filter(Boolean).map((l) => `<div>${escapeHtml(l)}</div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice ${escapeHtml(invoice.invoice_number)}</title>
  <style>
    :root { --ink: #1f2937; --soft: #6b7280; --line: #e5e7eb; --brand: #4f46e5; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      color: var(--ink); margin: 0; background: #f3f4f6; }
    .sheet { max-width: 800px; margin: 24px auto; background: #fff; padding: 40px;
      border-radius: 10px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px;
      border-bottom: 2px solid var(--brand); padding-bottom: 18px; margin-bottom: 22px; }
    .company-name { font-size: 22px; font-weight: 800; }
    .muted { color: var(--soft); font-size: 13px; line-height: 1.6; white-space: pre-line; }
    .inv-title { text-align: right; }
    .inv-title h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: 1px; }
    .inv-meta { font-size: 13px; color: var(--soft); line-height: 1.7; }
    .inv-meta b { color: var(--ink); }
    .parties { display: flex; gap: 40px; margin-bottom: 24px; }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--soft);
      font-weight: 700; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
    thead th { background: #f9fafb; text-align: left; font-size: 12px; text-transform: uppercase;
      letter-spacing: .04em; color: var(--soft); padding: 10px 12px; border-bottom: 1px solid var(--line); }
    tbody td { padding: 11px 12px; border-bottom: 1px solid var(--line); font-size: 14px; }
    .num { text-align: right; white-space: nowrap; }
    .totals { width: 320px; margin-left: auto; }
    .totals .row { display: flex; justify-content: space-between; padding: 7px 0; font-size: 14px; }
    .totals .grand { border-top: 2px solid var(--ink); margin-top: 6px; padding-top: 12px;
      font-size: 18px; font-weight: 800; }
    .notes { margin-top: 28px; font-size: 13px; color: var(--soft); white-space: pre-line; }
    .pay-bar { position: sticky; bottom: 0; text-align: center; padding: 14px; }
    .btn { background: var(--brand); color: #fff; border: 0; padding: 11px 22px; border-radius: 8px;
      font-size: 15px; font-weight: 600; cursor: pointer; }
    .status { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .05em; padding: 3px 10px; border-radius: 999px; background: #eef2ff; color: var(--brand); }
    @media print {
      body { background: #fff; }
      .sheet { box-shadow: none; margin: 0; max-width: none; border-radius: 0; padding: 0; }
      .no-print { display: none !important; }
      @page { margin: 16mm; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="top">
      <div>
        <div class="company-name">${escapeHtml(companyName)}</div>
        ${companyAddress ? `<div class="muted">${escapeHtml(companyAddress)}</div>` : ''}
        ${companyGstin ? `<div class="muted">GSTIN: ${escapeHtml(companyGstin)}</div>` : ''}
      </div>
      <div class="inv-title">
        <h1>INVOICE</h1>
        <div class="inv-meta">
          <div><b>${escapeHtml(invoice.invoice_number)}</b></div>
          <div>Issue date: <b>${fmtDate(invoice.issue_date)}</b></div>
          <div>Due date: <b>${fmtDate(invoice.due_date)}</b></div>
          <div><span class="status">${escapeHtml(invoice.status)}</span></div>
        </div>
      </div>
    </div>

    <div class="parties">
      <div>
        <div class="label">Bill to</div>
        <div class="muted" style="color:var(--ink)">${billTo || '<div>—</div>'}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>

    <div class="totals">
      <div class="row"><span>Subtotal</span><span>${inr(invoice.subtotal_paise)}</span></div>
      <div class="row"><span>GST (${invoice.gst_percent}%)</span><span>${inr(invoice.tax_paise)}</span></div>
      <div class="row grand"><span>Total Due</span><span>${inr(invoice.total_paise)}</span></div>
    </div>

    ${invoice.notes ? `<div class="notes"><b>Notes:</b> ${escapeHtml(invoice.notes)}</div>` : ''}
  </div>

  <div class="pay-bar no-print">
    <button class="btn" onclick="window.print()">Print / Save as PDF</button>
  </div>
</body>
</html>`;
}

export default router;
