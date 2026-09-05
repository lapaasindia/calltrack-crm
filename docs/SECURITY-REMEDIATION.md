# Security Remediation Log

Companion to [SECURITY-AUDIT.md](SECURITY-AUDIT.md) (the June 2026 audit of
v1.2.0). Tracks what was changed for each finding, and — since September 2026 —
what a re-audit found. Server changes are covered by the test suite
(`npm test`; `server/test/security.test.js`, `credentials.test.js`, `authz.test.js`,
`sync-hardening.test.js`, `mediaTicket.test.js`, `seed.test.js`, `ops.test.js` …).

> **Reading this file:** "Fixed in code" means the change is in the tree *and*
> the installed/locked dependency state matches. Two June rows (H-6, M-9) were
> recorded as fixed while the lockfile still shipped the old versions; they are
> corrected below and the September re-audit table records the true state.

## Fixed in code

| ID | Finding | What changed |
|----|---------|--------------|
| **H-1** | Default admin never rotated | New `must_change_password` column (`migrations/014`); bootstrap flags the default admin; `requirePasswordChanged` middleware locks the account to the change-password endpoint until rotated; `/change-password` clears it; new `ForcePasswordChange` client screen; `reset-admin.js` sets the flag. `CRM_ADMIN_PASSWORD` env provisions a real password with no forced change. **Sept 2026:** the `seed.js` / `npm run setup` path did not apply the flag (SEC-1) — now it does. |
| **H-2** | No login rate-limit | Per-IP + per-username lockout in `routes/auth.js`. **Sept 2026:** redesigned so a peer cannot lock other users out (SEC-3, see below). |
| **H-3** | Plaintext HTTP / insecure cookie | Opt-in TLS via `CRM_TLS_CERT`/`CRM_TLS_KEY` (`startServer` serves HTTPS); session cookie `secure` auto-enables under TLS or `CRM_SECURE_COOKIES=true`; pairing QR/urls use the real scheme (MOB-9). **Operational:** provision a LAN-trusted cert to actually encrypt the wire — the README now recommends it instead of calling it impractical. |
| **H-4** | Mobile WebView stored XSS | Every interpolated user value in `mobile/www/app.js` now `escapeHtml()`-escaped (incl. the admin-visible WhatsApp `lead_name` badge); strict CSP (`script-src 'self'`, no inline) added to `mobile/www/index.html`; inline `onclick` removed. |
| **H-5** | Electron `shell.openExternal` | `safeOpenExternal` scheme allow-list (`http(s)`/`mailto`/`tel` only) on both window-open and will-navigate; `sandbox:true` on the main window; `meeting_url` restricted to `http(s)` server-side (`routes/meetings.js`). Sept 2026 desktop pass extends this to subframes and permission requests (DESK-2/3). |
| **H-6** | Outdated runtimes | **Corrected history:** commit `4121fd7` (2026-06-17) set `electron ^42.4.1` / `electron-builder ^26.15.3` in `package.json` only; `37740a7` (2026-06-18) reverted both to `^36.9.5` / `^25.1.8` because the lockfile had never been regenerated and `npm ci` failed. Every 1.2.x installer therefore shipped **Electron 36.9.5 / Chromium 136 (EOL)**, and `client/package-lock.json` kept `xlsx 0.18.5` although `client/package.json` pointed at the SheetJS 0.20.3 tarball. **Sept 2026 (this pass):** `electron ^44.2.0`, `electron-builder ^26.15.3`, `better-sqlite3 ^13.0.3` (Electron 44 ABI) installed with a regenerated root lockfile and the desktop smoke test passing on Electron 44; the client lockfile regenerated so `xlsx 0.20.3` is what `npm ci` installs and what the bundle contains. `npm audit --omit=dev` = 0 findings (root); CI now fails on any High+ runtime advisory (SEC-2, DEP-1, DEP-2). Installers must be **rebuilt** for users to receive the new shell. |
| **H-7** | Fail-open `role==='caller'` scoping | `routes/leads.js`, `deals.js`, `ai.js` now scope with `canSeeAllLeads`/`isReadOnly` so agent/employee see only their own rows and read_only sees none. **Sept 2026:** every remaining literal role check (review, products, templates, today, reports, leadMatch …) replaced with `lib/permissions.js` helpers; `requireWriter` mounted globally for `read_only` (SCALE-9). |
| **H-8** | Manager→owner pairing escalation | `routes/devices.js` `/pairing-code` blocks a non-owner from pairing a phone to an owner account (mirrors `users.js`). |
| **M-1** | Tokens never expire | `device_tokens.expires_at` (90-day TTL set at pairing); `requireAuth` rejects expired tokens. **Sept 2026:** legacy NULL-expiry rows expire 90 days after last use (SEC-15). |
| **M-2 / L-1** | Long-lived bearer token in media URL | `lib/mediaTicket.js` mints HMAC-signed, ~10-min, single-recording tickets; `POST /api/review/audio/:id/ticket` hands one out; `mobile/www/app.js` uses `?ticket=`. **Sept 2026:** the legacy `?token=` branch is accepted **only** on `GET /api/review/audio/:id` — everywhere else the header is required (SEC-4). |
| **M-3** | Cloud-restore path traversal | `scripts/restore-cloud.js` confines every write with `safeJoin` (resolve + `startsWith(base+sep)`); temp path uses basename only. |
| **M-4** | Sarvam key plaintext at rest | Sealed with `sealSecret()` on write (`routes/settings.js`); unsealed on read (`routes/ai.js`), tolerating legacy plaintext. Non-admin roles no longer receive the settings payload at all (QA-18). |
| **M-5** | Weak backup passphrase floor | New passphrases require ≥12 chars + reject obvious weak forms (verification path unchanged so existing backups still open). |
| **M-6** | Money overflow | `deals.js`/`invoices.js` clamp values and assert `Number.isSafeInteger`. **Sept 2026:** one shared `MAX_PAISE` (₹100 crore — the June comment said ₹10 crore; the value was always 1e11 paise) exported from `routes/catalog.js` and used by products/catalog/deals/invoices (SEC-9). |
| **M-7** | CSV formula injection | `routes/reports.js` prefixes any cell starting with `= + - @ \t \r` with `'`. |
| **M-8** | All-Files-Access permission | `MANAGE_EXTERNAL_STORAGE` removed from the manifest; relies on SAF + `READ_MEDIA_AUDIO`. `docs/MOBILE.md` updated to stop telling users to toggle it. |
| **M-9** | `node-tar` in build tooling | **Corrected:** electron-builder 26 was *not* installed in June (see H-6). **Sept 2026:** `electron-builder 26.15.3` installed; the remaining `tar` advisory path is `@capacitor/cli 6` (build host only, fixed in Capacitor 8 — follow-up). |
| **L-2** | Task→project IDOR | `routes/tasks.js` enforces project-head access for non-admins on create + update. |
| **L-3** | `secret.key` perms not re-asserted | `app.js` + `secretBox.js` re-`chmod 0o600` on every boot. |
| **L-6** | Token in backup-able prefs | `android:allowBackup="false"` + `fullBackupContent="false"`. **Follow-up:** move the token to Keystore-backed `EncryptedSharedPreferences`. |
| **L-7** | Raw username logged on failed login | Username capped to 80 chars before use/logging. |
| **L-8** | `/api/health` leaks disk-free | `disk_free_gb` removed from the public payload. **Sept 2026:** it lives in the owner-only `GET /api/ops/health` instead. |
| Info | AI prompt injection | Transcript/lead-name fenced + sanitized before the Ollama prompt (`lib/ai.js`). |
| — | `form-data` CRLF advisory | `overrides: { "form-data": ">=4.0.6" }`. |
| — | Missing security headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, baseline CSP added globally (`app.js`). |

## September 2026 re-audit (v1.2.2 tree) — status

Findings from the full re-audit (`SEC-1` … `SEC-16`) and what this pass did.
"Fixed" = in the tree with tests; "Deferred" = tracked in CHANGELOG "Known follow-ups".

| ID | Severity | Finding | Status | Where |
|----|----------|---------|--------|-------|
| SEC-1 | High | `seed.js` / `npm run setup` created `admin/admin123` with no forced change | **Fixed** — seed mirrors bootstrap (`must_change_password = 1` unless `CRM_ADMIN_PASSWORD`), demo callers labelled DEMO, only seeds when `users` is empty | `server/seed.js`, `test/seed.test.js` |
| SEC-2 | High | Electron 36 / electron-builder 25 / client xlsx 0.18.5 still shipped while the log claimed 42/26/0.20.3 | **Fixed in the tree** — Electron 44.2, electron-builder 26.15, better-sqlite3 13, client lockfile regenerated (xlsx 0.20.3); `npm audit --omit=dev` 0; CI gate. **Installers must be rebuilt** (next release) for users to get it | `package.json`, `package-lock.json`, `client/package-lock.json`, `.github/workflows/ci.yml` |
| SEC-3 | High | Login lockout was a DoS primitive (anyone could lock any user / shared IP) | **Fixed** — per-IP: 5 free failures / 15 min then escalating lock (30 s → 15 min); per-(IP, user) lock only for usernames that exist; success clears; 429 carries `Retry-After`; maps bounded | `server/routes/auth.js` |
| SEC-4 | Medium | Device bearer token accepted as `?token=` on every route | **Fixed** — query form only on `GET /api/review/audio/:id`; header required elsewhere; `last_seen_at` writes throttled | `server/middleware/auth.js` |
| SEC-5 | Medium | Password change did not revoke device tokens / other sessions | **Fixed** — `revokeUserCredentials()` on change-password (keeps own session), admin reset, deactivation, delete; session store `destroyByUserId` | `middleware/auth.js`, `lib/sessionStore.js`, `routes/auth.js`, `routes/users.js` |
| SEC-6 | Medium | No upload quota / bad error codes on recording upload | **Fixed** — 413 on size, 400 on bad `last_modified_ms`, per-device daily quota (`upload_daily_quota_mb`, owner-editable via `PUT /api/settings`; not yet in the Settings UI), 507 below 1 GiB free, quota in `/api/sync/status` | `server/routes/sync.js`, `routes/settings.js` |
| SEC-7 | Medium | Mobile sync drove stage/score of other callers' leads; lead-existence oracle | **Fixed** — call recorded (append-only) but no stage/score change on foreign leads; oracle accepted by design (`/api/leads/check-phone` already discloses) | `server/routes/sync.js` |
| SEC-8 | Medium | No unhandled-rejection / uncaught-exception policy; async route could kill the process | **Fixed** — `lib/asyncRoutes.js` (rejections → `next(err)` → JSON 500 + request id), `lib/ops.js installProcessGuards()` (log and keep serving; graceful exit only on corrupt/closed DB or OOM) | `server/lib/asyncRoutes.js`, `server/lib/ops.js`, `server/app.js`, `server/index.js` |
| SEC-9 | Medium | Products/catalog accepted non-safe-integer paise | **Fixed** — shared `MAX_PAISE` + `Number.isSafeInteger` on products, catalog, deals, invoices | `routes/catalog.js`, `routes/products.js`, `routes/deals.js`, `routes/invoices.js` |
| SEC-10 | Low | Any caller could blacklist a number team-wide | **Fixed** — `always:true` honoured only for the admin tier; others get per-capture ignore + `{always:false, note}` | `server/routes/review.js` |
| SEC-11 | Low | Username enumeration via bcrypt timing | **Fixed** — dummy bcrypt compare for unknown users | `server/routes/auth.js` |
| SEC-12 | Low | OAuth redirect reflected the `Host` header | **Fixed** — `isOwnHost()` allow-list (localhost, `.local`, LAN IPv4s, `CRM_OAUTH_REDIRECT_HOST`); spoofed host → 400 | `server/routes/backup.js` |
| SEC-13 | Low | `pairAttempts` map never pruned | **Fixed** — pruned on insert (>500) and by the 5-min sweep; successful pairings refund their slot | `server/routes/auth.js` |
| SEC-14 | Low | `secret.key` roots session signing, secret box and media tickets (single point of compromise) | **Deferred** — accepted for now: derive per-purpose subkeys (HKDF) in a later release; documented in SECURITY.md ("back up `secret.key` separately") | — |
| SEC-15 | Low | Legacy device tokens never expire | **Fixed** — NULL-expiry rows expire 90 days after the later of `paired_at` / `last_seen_at` | `server/middleware/auth.js` |
| SEC-16 | Low | `must_change_password` gate stranded paired phones after an admin reset | **Fixed** — device-token requests exempt from the gate; browser sessions still gated. (Admin reset revokes the phone anyway — re-pair once.) | `server/middleware/auth.js` |

Related non-`SEC` hardening in the same pass: global JSON body limit 1 MB with
per-router limits (SCALE-24), bounded list endpoints (SCALE-5), Drive/cloud
backup streaming and verified snapshots (SCALE-4/14), structured request logs
with request ids (SCALE-17), Electron subframe/permission hardening and the
desktop CI smoke fix (DESK-*), `.gitignore`/secrets hygiene and dependency
automation (DEP-*). The full list is in `CHANGELOG.md` → Unreleased.

## Partially mitigated

- **M-2 / L-1 — bearer token in `?token=` media URL.** *Resolved* for the
  mobile player via signed media tickets; the legacy `?token=` branch is now
  confined to the one audio route (SEC-4). Drop it entirely once every phone
  runs a build with the ticket flow.

## Operational follow-ups (not code — require provisioning / a build + test)

1. **TLS (H-3):** generate a LAN-trusted/self-signed cert (mkcert) or front with
   an HTTPS reverse proxy; set `CRM_TLS_CERT`/`CRM_TLS_KEY`. Then disable Capacitor
   `cleartext` and the Android `cleartextTrafficPermitted` base-config.
2. **Ship the new runtimes (H-6 / SEC-2):** cut the next release with
   `scripts/bump-version.mjs` so users receive Electron 44 installers; publish the
   release-signed APK to the LAN channel with `scripts/publish-apk.js`.
3. **Android (M-8, L-6):** device-test recording sync after dropping
   All-Files-Access; move the token to `EncryptedSharedPreferences`.
4. **Capacitor (M-9):** migrate the whole Capacitor stack (core/android/cli +
   plugins) to v8 to clear the build-host `node-tar` advisory (JDK 21, AGP 8.13).
5. **Installer signing (L-5):** Developer ID + notarization (macOS),
   Authenticode (Windows). `SHA256SUMS.txt` and provenance attestations are
   produced by `release.yml` from the next release on.
6. **GitHub settings:** enable Dependabot alerts + security updates, private
   vulnerability reporting, and branch protection on `main` (see CHANGELOG
   "Known follow-ups" and `SECURITY.md`).

## Not changed (false-positives / fail-closed — see audit Disputed section)

SQLi (parameterized), CORS reflection (no credentials), `role==='admin'` *grant*
checks (fail-closed), public APK endpoint (by design), Drive OAuth CSRF (state
nonce), session fixation (regenerated).
