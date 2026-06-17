-- Phase 3A — Service catalog for the internal price builder + (future) invoice
-- line items. Additive only: two new STRICT tables. The existing `products`
-- table is untouched and still powers deals/win-deal.
--
-- IMPORTANT: base_price_paise / price_paise allow 0 (CHECK >= 0, not > 0). A
-- ₹0 service or add-on is a valid catalog row (e.g. a free onboarding add-on);
-- the source project had a bug that blocked saving a 0-priced row — we don't.
--
-- term_multipliers is a JSON string ('{"monthly":1,"quarterly":0.94,"annual":0.86}')
-- read by the price builder; not money, so JSON is fine. Platform tiers, the
-- weekly bandwidth rate and the default term multipliers live in a single
-- 'pricing_config' settings row (getSetting/setSetting) — no table needed.

CREATE TABLE services (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  slug             TEXT,
  category         TEXT,
  base_price_paise INTEGER NOT NULL DEFAULT 0 CHECK (base_price_paise >= 0),
  term_multipliers TEXT NOT NULL DEFAULT '{"monthly":1,"quarterly":0.94,"annual":0.86}',
  is_active        INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
) STRICT;
CREATE INDEX idx_services_active ON services(is_active, sort_order);

CREATE TABLE service_addons (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT,
  price_paise INTEGER NOT NULL DEFAULT 0 CHECK (price_paise >= 0),
  icon        TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX idx_service_addons_active ON service_addons(is_active, sort_order);
