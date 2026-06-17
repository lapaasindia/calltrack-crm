-- Phase 6A — WhatsApp two-way inbox (Baileys, embedded in the server process).
-- Additive only. Three new STRICT tables + one additive column on leads.
--
-- Conventions (unchanged): *_at columns are UTC ISO-8601 instants written by the
-- app layer (nowUtc()); phones are the normalized 10-digit form from phone.js.
-- A single WhatsApp account only: wa_sessions holds exactly one row, id='default'.
--
-- wa_jid is the raw WhatsApp JID ('<number>@s.whatsapp.net'). We DON'T derive
-- leads by fuzzy match — wa_contacts.lead_id is set by phone.js-normalized lookup
-- against an existing lead; a chat NEVER auto-creates a lead (that's an explicit
-- "promote chat → lead" action).

CREATE TABLE wa_sessions (
  id            TEXT PRIMARY KEY,            -- single account: literal 'default'
  status        TEXT NOT NULL DEFAULT 'disconnected'
                  CHECK (status IN ('disconnected','qr_pending','connecting','connected','logged_out','error')),
  qr_code       TEXT,                        -- pairing QR as a data: URL (PNG)
  phone_number  TEXT,                        -- the connected account's own number
  display_name  TEXT,
  last_error    TEXT,
  connected_at  TEXT,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE TABLE wa_contacts (
  id              INTEGER PRIMARY KEY,
  wa_jid          TEXT NOT NULL UNIQUE,
  phone           TEXT,                      -- normalized 10-digit when derivable
  display_name    TEXT,
  lead_id         INTEGER REFERENCES leads(id),
  first_seen_at   TEXT NOT NULL,
  last_message_at TEXT
) STRICT;
CREATE INDEX idx_wa_contacts_last_msg ON wa_contacts(last_message_at);
CREATE INDEX idx_wa_contacts_lead ON wa_contacts(lead_id);

CREATE TABLE wa_messages (
  id            INTEGER PRIMARY KEY,
  contact_id    INTEGER NOT NULL REFERENCES wa_contacts(id),
  lead_id       INTEGER REFERENCES leads(id),
  wa_message_id TEXT NOT NULL UNIQUE,        -- idempotency key from WhatsApp
  direction     TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
  message_type  TEXT NOT NULL DEFAULT 'text'
                  CHECK (message_type IN ('text','image','audio','video','document','sticker','location','unknown')),
  body          TEXT,
  raw_payload   TEXT,                        -- JSON of the original message (debug/audit)
  sent_at       TEXT NOT NULL,               -- when WhatsApp says it was sent (UTC)
  created_at    TEXT NOT NULL                -- when we ingested it (UTC)
) STRICT;
CREATE INDEX idx_wa_messages_contact_time ON wa_messages(contact_id, sent_at);

-- Additive: when a lead was last contacted on ANY channel. Used by the score's
-- recency feed and surfaced in the UI. NULL = never contacted via tracked channels.
ALTER TABLE leads ADD COLUMN last_contacted TEXT;
