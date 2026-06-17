-- Security hardening (audit remediation).
--   * users.must_change_password — forces the bootstrap admin (and any reset
--     account) to set a new password before it can do anything else. Closes the
--     "default admin/admin123 stays forever" hole (H-1).
--   * device_tokens.expires_at — paired-device bearer tokens now expire instead
--     of being valid forever until manual revocation (M-1). NULL = legacy token
--     with no expiry; new pairings always set it.

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

ALTER TABLE device_tokens ADD COLUMN expires_at TEXT;
