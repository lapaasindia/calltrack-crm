-- Phase 3B — Persisted GST invoices. Additive only: two new STRICT tables.
--
-- Money is INTEGER paise EVERYWHERE (subtotal/tax/total + every line item).
-- tax_paise = round(subtotal_paise * gst_percent / 100), computed in app code.
-- issue_date / due_date are IST business dates ('YYYY-MM-DD'); created_at is a
-- UTC ISO instant. invoice_number is a stable, human-facing 'INV-NNNNN' string
-- derived from a sequential counter (unique), never random.

CREATE TABLE invoices (
  id              INTEGER PRIMARY KEY,
  invoice_number  TEXT NOT NULL UNIQUE,
  lead_id         INTEGER REFERENCES leads(id),
  deal_id         INTEGER REFERENCES deals(id),
  bill_to_name    TEXT,
  bill_to_email   TEXT,
  bill_to_phone   TEXT,
  bill_to_address TEXT,
  issue_date      TEXT NOT NULL,
  due_date        TEXT NOT NULL,
  subtotal_paise  INTEGER NOT NULL,
  gst_percent     INTEGER NOT NULL,
  tax_paise       INTEGER NOT NULL,
  total_paise     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'paid', 'cancelled')),
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX idx_invoices_lead ON invoices(lead_id);
CREATE INDEX idx_invoices_created ON invoices(created_at);

CREATE TABLE invoice_items (
  id               INTEGER PRIMARY KEY,
  invoice_id       INTEGER NOT NULL REFERENCES invoices(id),
  description      TEXT NOT NULL,
  qty              INTEGER NOT NULL DEFAULT 1,
  unit_price_paise INTEGER NOT NULL,
  amount_paise     INTEGER NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
