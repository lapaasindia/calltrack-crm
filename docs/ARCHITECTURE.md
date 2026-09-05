# CallTrack CRM — architecture

The working model for anyone changing the code. Decisions with trade-offs are
recorded in [adr/](adr/); this page describes how the pieces fit *today*.

```
                     office Wi-Fi (LAN only — nothing is reachable from the internet)
   ┌───────────────┐   ┌──────────────┐   ┌──────────────────┐   ┌───────────────────┐
   │ browser / PWA │   │ desktop app  │   │ desktop app      │   │ Android app       │
   │ (any device)  │   │ (join mode)  │   │ (host mode)      │   │ (Capacitor WebView│
   └───────┬───────┘   └──────┬───────┘   │  embeds server ──┼─┐ │  + Kotlin plugins)│
           │ http(s)          │ http(s)   └──────────────────┘ │ └────────┬──────────┘
           ▼                  ▼                                 │          │ Bearer token
   ┌────────────────────────────────────────────────────────────┴──────────▼──────────┐
   │  ONE Node.js process — server/app.js (Express)                                    │
   │   /api/*  JSON API · /assets, index.html (client/dist) · /download/calltrack.apk  │
   │   schedulers: backup · cloud backup · recordings retention · AI worker ·          │
   │               nightly maintenance · WhatsApp engine (opt-in)                      │
   │   SQLite (WAL) data/crm.sqlite · data/sessions.sqlite · data/recordings/ · logs/  │
   └───────────────────────────────────────────────────────────────────────────────────┘
```

## Process model

**One process, one database.** `server/app.js` `createApp()` builds the Express
app; `startServer()` bootstraps the first admin (`server/bootstrap.js`), binds
`0.0.0.0:<port>` (HTTP, or HTTPS when `CRM_TLS_CERT`/`CRM_TLS_KEY` are set),
installs the process guards (`server/lib/ops.js`: log unhandled rejections /
uncaught exceptions and keep serving; only a closed or corrupt DB / OOM exits),
and starts the schedulers. `stop()` is the graceful shutdown: stop accepting,
drain tracked background jobs (`server/lib/jobs.js`), stop WhatsApp, checkpoint
and close SQLite — within 10 s.

Three entry points wrap that same function:

| Entry | Used by | Notes |
|---|---|---|
| `server/index.js` (`npm start`) | headless host, the macOS LaunchAgent | prints LAN URLs + QR; if :3000 already answers as CallTrack it exits 0 so `launchd` does not crash-loop |
| `desktop/main.js` **host mode** | the office computer running the desktop app | imports `server/app.js` in the Electron main process, data under the app's userData; if a CallTrack server already owns the port (e.g. the LaunchAgent) it **attaches** instead of starting a second one |
| `desktop/main.js` **join mode** | every other computer | a hardened `BrowserWindow` pointed at the host URL; download handler, navigation allow-list, no server |

Requests: `requestLogger` (structured JSON lines to `data/logs/server.log`,
rotated by IST day, `X-Request-Id` on every response) → security headers →
body parser (1 MB default; imports 10 MB, mobile sync 1 MB per router) →
session (`express-session` + SQLite store) → `/api/auth/*` public → `requireAuth`
(session cookie **or** paired-device bearer token) → `requirePasswordChanged`
(a still-default admin can only change its password) → `requireWriter`
(`read_only` gets 403 on writes) → routers. Async handlers are wrapped
(`server/lib/asyncRoutes.js`) so a rejection becomes a JSON 500 with the request
id instead of a hung request.

Background work runs on timers inside the same process and is registered with
`jobs.js` so shutdown can wait for it:

| Job | Where | Cadence |
|---|---|---|
| Local backup | `lib/backup.js` | every 30 min tick; one snapshot per IST day, 30 kept |
| Cloud backup (Drive, encrypted) | `lib/cloudBackup.js` | after the local backup, once per day, opt-in |
| Recordings retention | `lib/recordingsRetention.js` | purges audio older than `recording_retention_days` (default 90) once transcribed; transcripts stay |
| Local AI worker | `lib/ai.js` | polls for untranscribed recordings; whisper.cpp + local LLM, opt-in |
| Nightly maintenance | `lib/maintenance.js` | recompute lead scores in 5k-row chunks, sweep follow-ups on lost/deleted leads or deactivated users, integrity checks |
| WhatsApp engine | `lib/whatsapp.js` (Baileys) | inert until an owner clicks Connect; see [ADR 0004](adr/0004-whatsapp-bundled.md) |

## Data model and its invariants

SQLite, WAL mode, foreign keys on. Schema = numbered migrations in
`server/migrations/` (`001_init` … `017_perf_indexes`), applied in order and
tracked in `PRAGMA user_version`; the applying build's version is recorded in
`schema_migrations`. **An older build refuses to open a newer database.**

Core tables: `users` · `leads` (+ `lead_events`) · `calls` · `follow_ups` ·
`deals` → `installments` → `payments` · `products`/`services`/`invoices` ·
`tasks`/`projects`/`time_blocks`/`meetings` · `device_tokens`/`pairing_codes` ·
`captured_calls`/`recordings`/`ignored_numbers` · `ai_suggestions` ·
`wa_sessions`/`wa_contacts`/`wa_messages` · `settings` · `audit_logs` ·
`notifications`.

The invariants every route and report relies on (see [ADR 0002](adr/0002-money-in-paise-ist-dates.md)):

1. **Money is integer paise** everywhere; `Number.isSafeInteger` and one shared
   `MAX_PAISE` bound on every money route. *Pending* = deal value − payments
   received, never derived from installment status (`lib/installmentDues.js`).
2. **Instants are UTC ISO; business dates are IST `YYYY-MM-DD`**, computed only
   in `lib/istTime.js`. SQL receives UTC bounds, never `date('now')`.
3. **One phone normalizer** — `lib/phone.js` (`normalizePhone` → 10 digits,
   6–9 first; Excel-mangled numbers rejected with a reason). Leads are matched
   and deduplicated on that canonical form; the client mirrors it for display.
4. **One pending follow-up per lead.** Logging a call or changing stage
   resolves the previous one; closing a lead (won/lost) cancels it; *overdue
   never silently disappears* — the nightly sweep only touches lost/deleted
   leads and deactivated users.
5. **Append-only history.** `calls`, `payments`, `lead_events`, `audit_logs`
   are never updated in place. Stage changes go through `lib/leadStage.js
   changeStage()` so the funnel counts real transitions.
6. **Authorization comes from `lib/permissions.js`** — `isOwner` (super_admin,
   admin), `isAdmin` (+ manager), `canSeeAllLeads` (= isAdmin), `isReadOnly`.
   Legacy `admin`/`caller` rows keep their powers. Routes never compare role
   strings directly.
7. **Idempotent mobile sync.** A synced call is keyed by
   `(device_id, user_id, call_log_ts, source='mobile')`; recordings are
   content-addressed by SHA-256, uploaded once, deduplicated server-side.
8. **Migrations are additive and idempotent** (`IF NOT EXISTS`), so a partially
   applied file or a hand-made index never wedges boot.

## Deployment topologies

| Topology | How it runs | Data lives in | Notes |
|---|---|---|---|
| **LaunchAgent host** (the office Mac today) | `npm run install-autostart` → `~/Library/LaunchAgents/com.calltrack.crm.plist` runs `node server/index.js` from this checkout at login, `KeepAlive` | `<checkout>/data/`, `<checkout>/backups/` | Restart with `launchctl kickstart -k gui/$(id -u)/com.calltrack.crm`. Never run `npm run dist`/`app:rebuild` in this checkout — it swaps the native SQLite binary the live server loads. |
| **Desktop host** | first-run wizard → "This is the MAIN computer" | Electron userData (`~/Library/Application Support/CallTrack CRM/data`, `%APPDATA%\CallTrack CRM\data`) | Keeps serving with the window closed (tray); attaches to an existing CallTrack server on the port instead of starting a second one. |
| **Desktop join** | wizard → "Connect to the main computer" + host address | none | Just a browser shell with the download/navigation policy. |
| **Headless (any OS)** | `npm ci && npm --prefix client ci && npm --prefix client run build && npm start` | `data/`, `backups/` beside the checkout (override with `CRM_DATA_DIR`, `CRM_BACKUP_DIR`) | Windows autostart equivalent is a follow-up. |
| **Phones** | browser/PWA at the host URL, or the Android app paired by QR | — | Android app also serves as the call-capture agent. |

Only one topology may own a given database. Attach mode exists precisely so a
desktop app started on the LaunchAgent Mac does not create a second, empty host.

## Sync protocol (Android ↔ server)

1. **Pairing.** Owner/admin creates a one-time code (`POST /api/devices/pairing-code`;
   a manager cannot pair a phone to an owner). The QR carries the server URL
   (real scheme, http or https) + code. The phone calls `POST /api/auth/pair`
   with the code, its `android_id` and model; the server stores only the
   **SHA-256 of the token** in `device_tokens` (90-day TTL, sliding for legacy
   rows), reusing the device row for a reinstall of the same phone.
2. **Auth.** Every device request sends `Authorization: Bearer <token>`. The
   query-string form is accepted only for `GET /api/review/audio/:id` with a
   short-lived signed **media ticket** (`lib/mediaTicket.js`), never the device
   token.
3. **Calls.** `POST /api/sync/calls` (batches ≤ 200 rows, 1 MB) — each row is
   matched to a lead by normalized phone; known numbers attach, unknown numbers
   land in `captured_calls` for one-tap lead creation; duplicates are answered
   `duplicate`. A call on a lead not assigned to the device's user is recorded
   but does not move stage or score.
4. **Recordings.** `HEAD /api/sync/recordings/:sha256` (already stored?) then
   `POST /api/sync/recordings` (multipart, ≤ 100 MB/file, per-device daily
   quota `upload_daily_quota_mb`, free-disk floor 1 GiB → 413/429/507 with
   `Retry-After`). Files are stored content-addressed under `data/recordings/`.
5. **Status.** `GET /api/sync/status` returns counts, quota usage and the
   server version; `GET /api/app-version` (public) + `GET /download/calltrack.apk`
   are the LAN update channel, written by `scripts/publish-apk.js`.
6. **Credential events.** Password change, admin reset, deactivation revoke the
   user's device tokens and sessions — the phone must be re-paired.

The Kotlin side (`mobile/android/app/src/main/java/com/calltrack/mobile/`):
`CallObserverService` watches the call log, `SyncEngine` batches and retries,
`SyncWorker` (WorkManager) runs it in the background, `CallSyncPlugin` bridges
to the WebView (`mobile/www/app.js`).

## Backup and restore

- **Local:** `lib/backup.js` uses SQLite's online backup API (page-stepped on a
  worker thread, so the server keeps serving) into `backups/crm-<IST date>.sqlite.tmp`,
  runs `quick_check`, then renames into place. 30 daily files kept. "Back up
  now" in Settings runs the same code. Recordings are **not** in the DB backup.
- **Cloud (opt-in):** `lib/cloudBackup.js` encrypts the newest verified snapshot
  plus `data/recordings/**` and `data/invoices/**` with AES-256-GCM under the
  operator's passphrase and uploads to the operator's own Google Drive
  (`drive.file` scope). Content-addressed, so each recording uploads once; 30
  daily DB snapshots retained in Drive. Restore: `npm run restore-cloud`
  ([GOOGLE-DRIVE-BACKUP.md](GOOGLE-DRIVE-BACKUP.md)).
- **Restore locally:** stop the server, replace `data/crm.sqlite` (delete any
  `-wal`/`-shm` sidecars), start. The desktop wizard's "I have a backup file"
  does the same.
- **`data/secret.key`** (0600) roots session signing, the secret box for
  stored API keys/OAuth tokens and media tickets. Back it up separately; without
  it the stored Drive refresh token cannot be decrypted.

## Where each version string lives

Single source of truth: **root `package.json` `version`**. Everything else is
derived or written by `scripts/bump-version.mjs`:

| Consumer | Mechanism |
|---|---|
| `/api/health` `{app, version}`, `schema_migrations.app_version` | `server/db.js` reads `package.json` at load |
| Web bundle (login screen, sidebar) | `client/vite.config.js` bakes `__APP_VERSION__` |
| Desktop shell `app.getVersion()`, installer file names `CallTrack-CRM-<v>-…` | electron-builder reads `package.json` |
| `client/package.json` | written by the bump script (version field only) |
| Android `versionCode` = `major*10000 + minor*100 + patch`, `versionName` = version | derived from `package.json` by the Android build; the bump script prints the expected code |
| README download block, `CHANGELOG.md` section, git tag `v<v>`, GitHub release | bump script + `git tag` + `release.yml` (which refuses a tag that differs from `package.json`) |
| LAN APK channel `data/apk/version.json` | `scripts/publish-apk.js` reads the APK's badging |

## Repository map

```
server/     app.js (Express app + startServer) · index.js (CLI) · db.js (SQLite + migrations)
            bootstrap.js · seed.js · routes/ · middleware/ · lib/ · migrations/ · test/
client/     React 18 + Vite SPA (src/pages, src/components, src/permissions.js mirror)
desktop/    Electron main process (host/join/attach, tray, setup wizard) · lib/ (pure logic + tests)
mobile/     www/ (Capacitor WebView UI) · android/ (Gradle project, Kotlin plugins)
scripts/    bump-version · publish-apk · third-party-notices · install-autostart · restore-cloud ·
            reset-admin · desktop-smoke · fetch-electron-sqlite (Electron-ABI sqlite prebuilds → build/native) ·
            afterpack-sign · screenshots
docs/       operator + developer docs, adr/, screenshots/
.github/    ci.yml (unit ×2 Node, client, lint, audit+SBOM, android, desktop smoke) ·
            release.yml (tag → installers + APK + SHA256SUMS + provenance → draft release) · dependabot.yml
```
