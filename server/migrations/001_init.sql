-- CallTrack CRM initial schema.
-- Conventions: *_at columns = UTC ISO-8601 instants written by the app layer;
-- *_date / effective_from columns = IST calendar dates as 'YYYY-MM-DD';
-- all money = INTEGER paise.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','caller')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_users_username ON users(username);

CREATE TABLE products (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE import_batches (
  id              INTEGER PRIMARY KEY,
  filename        TEXT NOT NULL,
  preset          TEXT,
  imported_by     INTEGER NOT NULL REFERENCES users(id),
  total_rows      INTEGER NOT NULL,
  imported_count  INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  invalid_count   INTEGER NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;

CREATE TABLE leads (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL CHECK (length(phone) = 10),
  phone_raw       TEXT,
  alt_phone       TEXT,
  email           TEXT,
  city            TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',
  stage           TEXT NOT NULL DEFAULT 'new'
                  CHECK (stage IN ('new','contacted','interested','follow_up','won','lost')),
  lost_reason     TEXT,
  assigned_to     INTEGER REFERENCES users(id),
  notes           TEXT,
  extra_json      TEXT,
  import_batch_id INTEGER REFERENCES import_batches(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
) STRICT;
CREATE UNIQUE INDEX idx_leads_phone_live ON leads(phone) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_assigned_stage ON leads(assigned_to, stage);
CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_created ON leads(created_at);

CREATE TABLE lead_events (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id),
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_lead_events_lead ON lead_events(lead_id, changed_at);
CREATE INDEX idx_lead_events_changed ON lead_events(changed_at);

CREATE TABLE calls (
  id               INTEGER PRIMARY KEY,
  lead_id          INTEGER NOT NULL REFERENCES leads(id),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  call_type        TEXT NOT NULL DEFAULT 'sales'
                   CHECK (call_type IN ('sales','follow_up','collection','support')),
  disposition      TEXT NOT NULL
                   CHECK (disposition IN ('connected','not_picked','busy','switched_off','wrong_number')),
  outcome          TEXT,
  notes            TEXT,
  duration_seconds INTEGER,
  called_at        TEXT NOT NULL
) STRICT;
CREATE INDEX idx_calls_user_time ON calls(user_id, called_at);
CREATE INDEX idx_calls_lead_time ON calls(lead_id, called_at);

CREATE TABLE follow_ups (
  id                   INTEGER PRIMARY KEY,
  lead_id              INTEGER NOT NULL REFERENCES leads(id),
  assigned_to          INTEGER NOT NULL REFERENCES users(id),
  due_at               TEXT NOT NULL,
  reason               TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','done','cancelled')),
  created_by_call_id   INTEGER REFERENCES calls(id),
  completed_by_call_id INTEGER REFERENCES calls(id),
  completed_at         TEXT,
  created_at           TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_followups_one_pending ON follow_ups(lead_id) WHERE status = 'pending';
CREATE INDEX idx_followups_queue ON follow_ups(assigned_to, status, due_at);

CREATE TABLE deals (
  id               INTEGER PRIMARY KEY,
  lead_id          INTEGER NOT NULL REFERENCES leads(id),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  deal_value_paise INTEGER NOT NULL CHECK (deal_value_paise > 0),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','completed','cancelled')),
  won_at           TEXT NOT NULL,
  won_date         TEXT NOT NULL,
  notes            TEXT,
  created_at       TEXT NOT NULL
) STRICT;
CREATE INDEX idx_deals_lead ON deals(lead_id);
CREATE INDEX idx_deals_product ON deals(product_id);
CREATE INDEX idx_deals_won_date ON deals(won_date);

CREATE TABLE installments (
  id           INTEGER PRIMARY KEY,
  deal_id      INTEGER NOT NULL REFERENCES deals(id),
  seq          INTEGER NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  due_date     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','partial','paid','waived')),
  created_at   TEXT NOT NULL,
  UNIQUE (deal_id, seq)
) STRICT;
CREATE INDEX idx_installments_due ON installments(status, due_date);

CREATE TABLE payments (
  id             INTEGER PRIMARY KEY,
  deal_id        INTEGER NOT NULL REFERENCES deals(id),
  installment_id INTEGER REFERENCES installments(id),
  amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
  method         TEXT NOT NULL
                 CHECK (method IN ('upi','cash','bank_transfer','card','cheque','other')),
  reference      TEXT,
  received_date  TEXT NOT NULL,
  recorded_by    INTEGER NOT NULL REFERENCES users(id),
  recorded_at    TEXT NOT NULL,
  notes          TEXT
) STRICT;
CREATE INDEX idx_payments_deal ON payments(deal_id);
CREATE INDEX idx_payments_received ON payments(received_date);

CREATE TABLE message_templates (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL
             CHECK (category IN ('intro','follow_up','payment_reminder','support','custom')),
  body       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE targets (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  calls_target    INTEGER NOT NULL DEFAULT 0,
  connects_target INTEGER NOT NULL DEFAULT 0,
  deals_target    INTEGER NOT NULL DEFAULT 0,
  effective_from  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (user_id, effective_from)
) STRICT;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
