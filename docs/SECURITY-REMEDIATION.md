# Security Remediation Log

Companion to [SECURITY-AUDIT.md](SECURITY-AUDIT.md). Tracks what was changed for
each finding. All server changes are covered by the test suite
(`npm test` → 172 passing, including `server/test/security.test.js` and
`server/test/mediaTicket.test.js`).

## Fixed in code

| ID | Finding | What changed |
|----|---------|--------------|
| **H-1** | Default admin never rotated | New `must_change_password` column (`migrations/014`); bootstrap flags the default admin; `requirePasswordChanged` middleware locks the account to the change-password endpoint until rotated; `/change-password` clears it; new `ForcePasswordChange` client screen; `reset-admin.js` sets the flag. `CRM_ADMIN_PASSWORD` env provisions a real password with no forced change. |
| **H-2** | No login rate-limit | Per-IP + per-username lockout with exponential backoff in `routes/auth.js` (5 fails → 15-min lock). |
| **H-3** | Plaintext HTTP / insecure cookie | Opt-in TLS via `CRM_TLS_CERT`/`CRM_TLS_KEY` (`startServer` serves HTTPS); session cookie `secure` auto-enables under TLS or `CRM_SECURE_COOKIES=true`. **Operational:** provision a LAN-trusted cert to actually encrypt the wire. |
| **H-4** | Mobile WebView stored XSS | Every interpolated user value in `mobile/www/app.js` now `escapeHtml()`-escaped (incl. the admin-visible WhatsApp `lead_name` badge); strict CSP (`script-src 'self'`, no inline) added to `mobile/www/index.html`; inline `onclick` removed. |
| **H-5** | Electron `shell.openExternal` | `safeOpenExternal` scheme allow-list (`http(s)`/`mailto`/`tel` only) on both window-open and will-navigate; `sandbox:true` on the main window; `meeting_url` restricted to `http(s)` server-side (`routes/meetings.js`). |
| **H-6** | Outdated runtimes | `electron ^42.4.1` + `electron-builder ^26.15.3`; client `xlsx` → maintained SheetJS CDN build `0.20.3`. **Needs `npm install` + `npm run app:rebuild` + desktop smoke test; `npm --prefix client install` + rebuild.** |
| **H-7** | Fail-open `role==='caller'` scoping | `routes/leads.js`, `deals.js`, `ai.js` now scope with `canSeeAllLeads`/`isReadOnly` so agent/employee see only their own rows and read_only sees none. |
| **H-8** | Manager→owner pairing escalation | `routes/devices.js` `/pairing-code` blocks a non-owner from pairing a phone to an owner account (mirrors `users.js`). |
| **M-1** | Tokens never expire | `device_tokens.expires_at` (90-day TTL set at pairing); `requireAuth` rejects expired tokens. |
| **M-2 / L-1** | Long-lived bearer token in media URL | New `lib/mediaTicket.js` mints HMAC-signed, ~10-min, single-recording tickets (keyed off `data/secret.key`). `POST /api/review/audio/:id/ticket` (behind `requireAuth`, same access check as the stream) hands one out; `requireAuth` accepts `?ticket=` **only** on the audio GET route and the route re-scopes it to the requested `:id`. `mobile/www/app.js` fetches a ticket via `api()` (Authorization header) and puts `?ticket=` in the `<audio>` src instead of the device token. The legacy `?token=` branch is kept for already-deployed APKs. |
| **M-3** | Cloud-restore path traversal | `scripts/restore-cloud.js` confines every write with `safeJoin` (resolve + `startsWith(base+sep)`); temp path uses basename only. |
| **M-4** | Sarvam key plaintext at rest | Sealed with `sealSecret()` on write (`routes/settings.js`); unsealed on read (`routes/ai.js`), tolerating legacy plaintext. |
| **M-5** | Weak backup passphrase floor | New passphrases require ≥12 chars + reject obvious weak forms (verification path unchanged so existing backups still open). |
| **M-6** | Money overflow | `deals.js`/`invoices.js` clamp values to ≤₹10 crore/line and assert `Number.isSafeInteger` on totals. |
| **M-7** | CSV formula injection | `routes/reports.js` prefixes any cell starting with `= + - @ \t \r` with `'`. |
| **M-8** | All-Files-Access permission | `MANAGE_EXTERNAL_STORAGE` removed from the manifest; relies on the existing SAF + `READ_MEDIA_AUDIO` channels (legacy folder scan degrades to empty). **Device-test recording sync.** |
| **M-9** | `node-tar` in build tooling | `electron-builder` bumped to 26.x (its `tar` path). Capacitor's path needs a full Cap 8 migration — see below. |
| **L-2** | Task→project IDOR | `routes/tasks.js` enforces project-head access for non-admins on create + update. |
| **L-3** | `secret.key` perms not re-asserted | `app.js` + `secretBox.js` re-`chmod 0o600` on every boot. |
| **L-6** | Token in backup-able prefs | `android:allowBackup="false"` + `fullBackupContent="false"`. **Follow-up:** move the token to Keystore-backed `EncryptedSharedPreferences`. |
| **L-7** | Raw username logged on failed login | Username capped to 80 chars before use/logging. |
| **L-8** | `/api/health` leaks disk-free | `disk_free_gb` removed from the public payload. |
| Info | AI prompt injection | Transcript/lead-name fenced + sanitized before the Ollama prompt (`lib/ai.js`). |
| — | `form-data` CRLF advisory | `overrides: { "form-data": ">=4.0.6" }`. |
| — | Missing security headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, baseline CSP added globally (`app.js`). |

## Partially mitigated

- **M-2 / L-1 — bearer token in `?token=` media URL.** *Resolved* — see the
  M-2 / L-1 row above. Short-lived, single-recording signed media tickets
  (`lib/mediaTicket.js`) replace the device token in the mobile `<audio>` URL,
  so the WebView-history leg no longer exposes a long-lived credential. Covered
  by `server/test/mediaTicket.test.js` (mint/verify + scoping/expiry over HTTP).
  *Residual:* the legacy `?token=` query-param branch in `requireAuth` is kept
  so already-deployed APKs keep working; drop it once all phones run a build
  with the ticket flow. **Device-test mobile audio playback after `cap sync`.**

## Operational follow-ups (not code — require provisioning / a build + test)

1. **TLS (H-3):** generate a LAN-trusted/self-signed cert (mkcert) or front with
   an HTTPS reverse proxy; set `CRM_TLS_CERT`/`CRM_TLS_KEY`. Then disable Capacitor
   `cleartext` and the Android `cleartextTrafficPermitted` base-config.
2. **Dependency installs (H-6):** `npm install` (root) + `npm run app:rebuild`
   and a desktop smoke test for Electron 42; `npm --prefix client install` +
   `npm --prefix client run build` for the new `xlsx`.
3. **Android (M-8, L-6):** device-test recording sync after dropping
   All-Files-Access; move the token to `EncryptedSharedPreferences`.
4. **Capacitor (M-9):** migrate the whole Capacitor stack (core/android/cli +
   plugins) to v8 to clear the build-host `node-tar` advisory.
5. **Installer signing (L-5):** Developer ID + notarization (macOS),
   Authenticode (Windows), and out-of-band checksums.

## Not changed (false-positives / fail-closed — see audit Disputed section)

SQLi (parameterized), CORS reflection (no credentials), `role==='admin'` *grant*
checks (fail-closed), public APK endpoint (by design), Drive OAuth CSRF (state
nonce), session fixation (regenerated). The `routes/review.js` audio access uses
a literal `'admin'` check — fail-closed (a manager reaches recordings via the
lead path), so left as-is.
