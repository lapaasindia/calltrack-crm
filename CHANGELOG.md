# Changelog

All notable changes to CallTrack CRM are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Write notes under **Unreleased** as
you go; `scripts/bump-version.mjs` turns that section into the next release.

## [Unreleased]

The September 2026 full-stack audit remediation (server security, server
performance/operability, web client, Android app, desktop shell, dependencies,
CI and docs). Finding ids (`SEC-`, `SCALE-`, `CLIENT-`, `MOB-`, `DESK-`, `DEP-`,
`QA-`) refer to the audit reports; the security ones are tracked in
[docs/SECURITY-REMEDIATION.md](docs/SECURITY-REMEDIATION.md).

### Security
- `npm run seed` / `npm run setup` now create the default admin with a **forced
  password change** (unless `CRM_ADMIN_PASSWORD` is set), matching the desktop
  first-run path; demo callers are labelled DEMO (SEC-1).
- Login throttling redesigned so a LAN peer cannot lock other users out: per-IP
  free failures then escalating lock, per-(IP, user) lock only for real users,
  constant-time response for unknown usernames, `Retry-After` on 429 (SEC-3, SEC-11).
- Paired-device tokens are accepted **only** in the `Authorization: Bearer`
  header; the `?token=` query form survives solely for `GET /api/review/audio/:id`
  (SEC-4). Legacy tokens without an expiry now expire 90 days after last use (SEC-15).
- Changing a password, an admin reset, or deactivating a user revokes that user's
  device tokens and other sessions (SEC-5). Deactivation reports open work
  (leads / follow-ups / tasks) to reassign.
- Recording uploads: clear 413/400 errors, per-device daily quota
  (`upload_daily_quota_mb`, default 2048 MB, owner-editable via `PUT /api/settings`), 1 GiB
  free-disk floor (507), `HEAD /api/sync/recordings/:sha256` pre-check (SEC-6, SCALE-18).
- A synced call on a lead assigned to someone else is recorded but no longer
  moves the lead's stage or score (SEC-7).
- Async route rejections become JSON 500s with a request id; process-level guards
  log and keep serving instead of exiting (SEC-8, SCALE-8).
- One shared money bound (`MAX_PAISE`, ₹100 crore) and safe-integer checks on
  products/catalog/deals/invoices (SEC-9); "ignore always" is team-wide only for
  the admin tier (SEC-10); pairing/backup limiter maps are bounded (SEC-13);
  Google Drive OAuth redirect host validated (SEC-12); device tokens exempt from
  the must-change-password gate so a reset admin's phone keeps syncing (SEC-16).
- All role checks go through `server/lib/permissions.js`; `read_only` is refused
  every write (`requireWriter`, 403); `GET /api/users` and `GET /api/settings`
  return a slim payload to non-admin roles (SCALE-9, CLIENT-8, CLIENT-29, QA-18).
- **Dependencies:** Electron 36 → **44** and electron-builder 25 → **26** (the
  H-6 bump that was reverted in June is now really applied, with `better-sqlite3`
  13 for the new ABI), `multer` 2.3, `qs` ≥ 6.16 via override (pre-auth DoS
  advisories), `baileys` pinned to the `legacy` 6.7 line; client `xlsx` lockfile
  regenerated so the maintained SheetJS 0.20.3 build is what ships.
  `npm audit --omit=dev` is now clean and gates CI (DEP-1, DEP-2, DEP-4, DEP-7, DEP-8).

### Server
- Collections page from ~14 s to ~35 ms, Today queue from ~3.8 s to ~130 ms on
  the 200k-call benchmark: pre-aggregated payment/installment joins, 13 new
  indexes + `ANALYZE`, new `GET /api/today/counts` for the 60 s badge poll
  (SCALE-1/2/3/5). Migration **017** (additive).
- Money definitions made exact everywhere: `Pending = deal value − payments
  received`; installments expose `due_paise`; *overdue* means money still owed;
  report rupee fields are exact decimals with `*_paise` siblings (SCALE-11, SCALE-21).
- Backups use SQLite's online backup API off the event loop, are verified with
  `quick_check` and renamed into place atomically; cloud backup streams and
  encrypts files asynchronously (SCALE-4, SCALE-14).
- Graceful shutdown: SIGTERM/SIGINT drains background jobs, checkpoints and closes
  the DB, exits 0; `npm start` exits cleanly when a CallTrack server already owns
  the port so `launchd` does not crash-loop (SCALE-8, DESK-5).
- Structured request logging (`data/logs/server.log`, daily IST rotation,
  `X-Request-Id` on every response) and an owner-only `GET /api/ops/health`
  (integrity, WAL size, backup age, AI queue, event-loop lag, free disk) (SCALE-17).
- Nightly maintenance: lead-score recompute (recency decay), stale follow-up sweep
  on lost/deleted leads and deactivated users (never merely old ones), pruning,
  integrity check (SCALE-6, SCALE-10, SCALE-25).
- Migrations are recorded with the applying app version; an older build refuses
  to open a newer database (SCALE-14). Invoice numbers come from a counter and
  are never reused; deleting an invoice is a soft-cancel (SCALE-23, QA-4).
- Lead scoring: failed dials no longer raise the score (QA-11). An unanswered
  call keeps the follow-up pending instead of completing it (QA-5).
- Static serving hardened: immutable hashed assets, `index.html` never cached,
  unknown assets 404 instead of the SPA shell (CLIENT-12).
- Round-robin assignment (imports, bulk assign) includes agents and continues
  from a persistent cursor; reassigning moves pending tasks (SCALE-20).
- Pairing: QR/urls use `https://` on a TLS server (MOB-9); `/pair` validates
  `android_id`, accepts `device_model`, and successful pairings no longer count
  against the per-IP limit (MOB-20).

### Client (web)
- **Crashes / data bugs** — CLIENT-4/QA-1 closing the Project details modal no
  longer crashes the page (effect returned a Promise); CLIENT-5 cancelling the
  "Mark lost" reason no longer marks the lead Lost; CLIENT-3 every
  `window.prompt`/`window.confirm` (Kanban note, mark lost, WhatsApp create-lead,
  quote copy, every delete) replaced by real dialogs (`PromptModal`/`ConfirmModal`,
  work in the desktop shell and on phones); QA-6/CLIENT-25 lead search no longer
  reverts a filter picked during the debounce (functional `setParams`), toast
  timer cleared, Task detail keeps un-blurred edits across autosave, Today task
  checkbox rolls back on failure; CLIENT-20 double-tap guard (`useSubmit`) on
  every mutation button; CLIENT-19 logout stops the task timer, clears this
  user's localStorage keys (now namespaced per user) and the template cache;
  CLIENT-10 a `403 {must_change_password}` mid-session shows the change-password
  screen, other tabs are sent to login after a password change/reset; login
  429 shows a live "try again in N s" countdown; CLIENT-23 non-http(s) meeting
  links are not rendered as links; CLIENT-28 stable keys on EMI / invoice-line
  rows; CLIENT-26 hoisted meeting role picker, `.linklike`/`.menu-item` styles
  and `--card`/`--bg-soft` tokens added.
- **Roles** — CLIENT-8 all `'admin'`/`'caller'` literals replaced by the
  permissions mirror (`isAdmin/isOwner/isReadOnly/canSeeAllLeads/isAssignable`);
  super_admin/manager get reassign, bulk assign, team Today selector and
  `?all=1`; assignment pickers list every active non-read_only user (slim
  `/api/users` for non-admins); read_only users see no write controls; sidebar
  shows the real role label; deactivating a user surfaces `open_work` and offers
  a reassign flow (bulk-assign to one person or round-robin).
- **Mobile navigation & layout** — CLIENT-6/QA-2 bottom nav is now four
  role-aware slots (callers: Today, Leads, Payments, Review) plus a **More**
  sheet that reaches every remaining page with badges; QA-7 long names wrap and
  clamp instead of forcing a 2000px page; QA-14/CLIENT-27 ≥44px tap targets,
  `100dvh` with `100vh` fallback, iOS-safe scroll lock (body `position:fixed`),
  `viewport-fit=cover` + safe-area padding on the top bar (IOS-2) and
  bottom nav; IOS-1 inputs are 16px on phones so iOS Safari no longer zooms and
  hides the bottom nav; IOS-3 date/time inputs can no longer push the Log-call
  sheet into sideways scrolling; IOS-4 landscape phones keep the phone layout
  (`max-height: 500px` joins the phone breakpoint);
  CLIENT-16 an explicit "Move ▾" menu on every Kanban card and a Stage control
  on the lead page so touch users can move stages.
- **Errors & resilience** — CLIENT-14/QA-24/QA-17 shared `useRequest` hook +
  `<ErrorState onRetry>` on every page (Collections, Leads list/board,
  Price builder, Review, Settings, Today, Dashboard, Reports, Invoices, Tasks,
  Projects, Meetings, Calendar, Coaching…); network failures read "Can't reach
  the office computer" with a global banner that polls `/api/health` every 10 s;
  403 → "You don't have access"; 500s show the server `request_id`; a loading
  splash instead of a blank page while `/api/auth/me` is in flight; forbidden
  routes show a message instead of a silent bounce (QA-13).
- **Performance** — CLIENT-11 Reports (recharts), Import (SheetJS loaded only
  when an Excel file is chosen), Settings (qrcode), WhatsApp, Coaching, Price
  builder, Invoices and the Audit log are lazy chunks; react/router in vendor
  chunks; the caller path is ≈340 KB raw / 100 KB gzip instead of one 1.2 MB
  bundle. CLIENT-18/QA-16 badge poll uses `GET /api/today/counts` (falls back to
  `/api/today` on older servers), no longer re-fires on every navigation, and
  every poll (badges, current-work 60 s, WhatsApp, pairing QR, task/meeting
  tickers) pauses while the tab is hidden; mutations trigger a badge refresh.
  CLIENT-9 WhatsApp badge uses a per-user `since` watermark and clears when the
  inbox is opened; CLIENT-24 Calendar sends `from/to`, WhatsApp threads are
  windowed (last 50 + "Show earlier") and contact search is debounced;
  CLIENT-29 admin-only fetches are gated; CLIENT-31 Reports date range is
  debounced, the agent-daily table can show all rows, the import file input
  resets so the same file can be re-picked, `.wa-lead` is visible on phones.
- **Money / UI correctness** — CLIENT-17/QA-3 `rupees()` prints paise
  (₹58,998.82) whenever an amount has them, everywhere incl. Reports (which
  prefers the new `*_paise` fields); QA-20 Price builder refuses a ₹0 invoice;
  CLIENT-21 non-admins must pick a lead; CLIENT-7 searchable lead picker
  (`/api/leads?q=&limit=`) in Projects/Meetings/Price builder and Kanban
  columns show "showing N of total"; QA-8 lead name/phone/alt phone/email/city/
  source/notes are editable (duplicate phone → link to the other lead); QA-10
  "Cancel follow-up"; QA-9 a column named "Notes" auto-maps on import; QA-19
  "+ New task" on the Work board; QA-22 project status/progress editable in the
  details modal, meetings can be cancelled/re-scheduled; QA-12 "Add lead" is
  disabled while the live phone check says invalid; QA-13 owner **Audit log**
  page (`/audit`, paginated); QA-21 "Overdue EMIs (still owed)" vs "Overdue
  deals" labelled distinctly; Settings gained the `upload_daily_quota_mb`
  field and an owner "Ops health" card (`GET /api/ops/health`); invoices print
  through a same-origin iframe (works in the desktop shell) and deleted
  invoices are listed under a "Deleted" chip; CLIENT-22 new-member password is
  a `type=password autoComplete=new-password` field with a show/hide toggle.
- **PWA & accessibility** — CLIENT-13 `manifest.webmanifest`, 192/512/maskable
  icons + apple-touch-icon + favicon, `apple-mobile-web-app-capable`; every
  detail page has an in-app Back control (standalone mode has no browser
  back); CLIENT-15 labels wired to inputs (`<Field>`), lead rows/cards expose a
  real link, dialogs have `role="dialog" aria-modal`, a focus trap, focus
  return and Escape, the toast is an `aria-live` region, `--ink-faint` and all
  badge colours now clear 4.5:1.
- **Tooling** — CLIENT-30 `eslint.config.js` (react + react-hooks incl.
  exhaustive-deps) with `npm --prefix client run lint` at zero errors; vitest +
  Testing Library (`npm --prefix client test`, 44 tests: api helpers incl. paise
  and IST dates, request error mapping, permissions mirror, Prompt/Confirm/Modal,
  `useRequest`/`useSubmit`, import auto-map); `build.sourcemap: 'hidden'`;
  `<React.StrictMode>`; `client/package-lock.json` regenerated so SheetJS
  0.20.3 is actually installed (CLIENT-1); `react-router-dom` 6.30.6.

### Mobile (Android)
- **Data loss fixed (MOB-1/EMU-1):** the sync watermark (`pairedAt`) was rewritten to "now" on every app launch, so calls and recordings made while the app was closed were silently skipped forever. It is now written once at pairing, the catch-up window is bounded to 30 days, and the cursor only advances to rows the server accepted. Regression covered by a new end-to-end scenario (call → force-stop → relaunch → still synced).
- Sync engine hardening: ≤200-row call batches (halving on 400), a sync lock so the plugin thread, periodic and expedited workers never overlap, fixed-length streaming uploads (no more whole-file buffering / OOM), sha256 + `HEAD /api/sync/recordings/:sha` pre-check, 80 MB cap, correct handling of 401/413/429/507/5xx, bounded retries, `Throwable` guards, and a 30 s modification-time + length-stability check so half-written recordings are not uploaded twice.
- Errors are now visible on the phone: native `lastError`/`lastSuccessMs`, the sync chip turns green only after a real success, real pending-upload count, Settings shows the last error.
- Revoke/expiry (401) now returns the phone to the pairing screen with an explanation, clears the Keystore token, stops the foreground service, its notification and scheduled work (was a "Something went wrong" crash screen with the service left running).
- QR pairing: `ensureScannerModule` no longer throws on Capacitor 6 (`addListener` returns a handle, not a promise); pairing URLs must be LAN/private addresses and are confirmed before the one-time code is spent; user-installed CAs are trusted so a TLS office server can be adopted without a rebuild.
- Foreground-service starts are guarded (Android 12+/14 background-start rules) and background entry points only start it when battery optimisation is off.
- Recording discovery applies the call-recording name filter to every channel (file, SAF, MediaStore), caps SAF recursion, refuses a whole-storage folder pick, and the dead "All files access" setup step is gone; the checklist refreshes when returning from system dialogs and shows "Not needed on this phone" for steps that do not apply.
- Device token stored in `EncryptedSharedPreferences` (Android Keystore); never in Capacitor Preferences.
- Version single-sourced from the root `package.json` (`versionName` 1.2.2, `versionCode` = major*10000 + minor*100 + patch = 10202); daily update check on open.
- WhatsApp tab only for admin-tier phones, badge and poll fixed, no background polling; Review badge counts what the tab lists; a sync runs right after pairing; media tickets minted on play (re-minted on expiry); manifest/gradle cleanup (READ_PHONE_STATE, REQUEST_INSTALL_PACKAGES, FileProvider, mixed content, JitPack/google-services removed; `assembleRelease` fails fast without a keystore); device model sent at pairing; blocked/voicemail call types ignored.
- The emulator e2e runner refuses to run against anything but an emulator, no longer kills unrelated processes, seeds into a media directory, and the debug seeder rejects instead of crashing the app.

### Desktop
- Electron 44.2 / electron-builder 26 (was the end-of-life Electron 36 that the June remediation recorded as upgraded but never landed).
- Deny-by-default web permissions (only notifications, sanitized clipboard write and fullscreen for the in-app origin), `will-frame-navigate` and `will-redirect` guards, same-origin popups open in a sandboxed child window that shares the session (invoice/weekly-report printing works in the app again), setup window hardened (CSP, external script, IPC sender/payload validation), dev/test hooks and DevTools gated on unpackaged builds.
- Native module: `npm run native` stages SHA-256-pinned better-sqlite3 prebuilds into `build/native/` (shipped as `Resources/native`); the app loads them via `CRM_SQLITE_NATIVE_BINDING`, so `dist` never touches the repo's `node_modules` binary and the office LaunchAgent can no longer be broken by a build. `app:rebuild` and `fetch-win-sqlite.js` removed; `electronFuses` enabled.
- Host mode never self-hosts when the CallTrack service is installed (waits for it), never hops ports, boots once, shows an offline page with health polling instead of the setup wizard on transient load failures, and asks before turning a joiner into a host. Attached mode gets real Connection Info, correct folder actions and an honest Quit label; graceful `stop()` on quit.
- Downloads: allow-listed types save silently, everything else goes through the OS Save dialog; the Windows smoke test waits for completed downloads (fixes the red CI job).
- Restore validates the SQLite header, size, free space and WAL sidecars and runs `quick_check` in a utility process before accepting a file.
- LaunchAgent installer rewritten (escaped plist, PATH, `KeepAlive{SuccessfulExit:false}`, throttle, TCC warning) plus `uninstall-autostart` and `doctor` scripts; main-process log file with rotation and crash handlers; daily fail-silent update check with a menu item.

### Build, CI, docs
- **Release process:** `scripts/bump-version.mjs <x.y.z>` is the single source of
  truth for version strings (package.json + lockfile, client/package.json, README
  download block, this changelog; prints the Android versionCode). README links
  now use `releases/download/v<x.y.z>/…` instead of `latest/download/<versioned
  file>` (DEP-9).
- `scripts/publish-apk.js` reads the version from the APK (`aapt2`), refuses
  debug-signed builds (`apksigner`) and downgrades, has `--dry-run`/`--out` (DEP-3).
- CI rebuilt: unit tests on Node 22 + 24 with `npm ci --ignore-scripts`, client
  build from the client lockfile, lint, **runtime dependency audit gate** + SBOM,
  Android debug build with wrapper validation, desktop smoke on macOS + Windows;
  `permissions: contents: read`, concurrency groups (DEP-5, DEP-11, DEP-15).
- New tag-driven `release.yml` (tag must equal package.json; DMG/EXE on macOS,
  release-signed APK from a base64 keystore secret, `SHA256SUMS.txt`, build
  provenance attestations, draft GitHub release with these notes) and
  `dependabot.yml` (npm root + client, GitHub Actions, Gradle; weekly, grouped
  minor/patch), `CODEOWNERS`.
- `engines` `>=22.12 <25` enforced by `.npmrc` (`engine-strict`); Capacitor
  packages moved to `devDependencies` so installers and server installs stop
  carrying the Android toolchain (DEP-12, DEP-13).
- Repo hygiene: `.gitignore` covers `*.jks`, `*.p12`, `.env*`,
  `google-services.json`, `.claude/`; `.claude/launch.json` untracked; personal
  e-mail removed from docs (DEP-16).
- New docs: `SECURITY.md`, `CONTRIBUTING.md`, this `CHANGELOG.md`,
  `THIRD-PARTY-NOTICES.md` (generated; calls out GPL-3.0 `libsignal`),
  `docs/ARCHITECTURE.md`, `docs/adr/0001–0004`. README corrected (TLS is
  supported and recommended, 7-role table, forced password change, `npm run
  icons`, updating the office computer, security section);
  `docs/SECURITY-REMEDIATION.md` now states the true H-6/M-9 status and carries
  the September 2026 re-audit table; `docs/SECURITY-AUDIT.md` marked historical (DEP-10).

### Known follow-ups (deliberately not in this release)
- **Major upgrades:** Express 5, react-router 7 (clears two remaining moderate
  client advisories), Vite 7/8 + `@vitejs/plugin-react` 5+, React 19, recharts 3,
  Capacitor 8 (with AGP 8.13 / Gradle 8.14 / JDK 21 / compileSdk 36 — also clears
  the `tar` advisory in `@capacitor/cli`), baileys 7 once GA.
- **Signing:** Apple Developer ID + notarization, Windows Authenticode; until
  then installers are ad-hoc signed and users see the one-time OS prompts.
- **Repo settings (GitHub UI):** branch protection on `main` requiring the
  `unit`, `client`, `lint`, `audit`, `android` checks and code-owner review;
  Dependabot alerts + security updates; private vulnerability reporting.
- Pin GitHub Actions to commit SHAs (Dependabot keeps them current).
- Vendor `libsignal` as a tarball with an integrity hash (offline `npm ci`).
- Windows autostart equivalent of the macOS LaunchAgent; desktop in-app update check.
- `lead_phones` history on phone edits; keyset pagination for the remaining list endpoints.

## [1.2.2] - 2026-06-19

Version bumped in `package.json` (reported by `/api/health` and the UI) but **no
installers or tag were published** — these fixes ship with the next release.

### Fixed
- Multi-device sync: calls from a second phone paired to the same user were
  silently dropped (dedupe rekeyed on `device_id`, migration 015; reinstalls keep
  their device row).
- Closing a lead (won/lost) cancels its pending follow-up so it leaves the Today
  queue (migration 016 backfills); the reschedule modal pre-fills date/reason.
- Deleting a project or task no longer errors on attached meetings/time blocks;
  foreign-key conflicts return a clear 409. Project progress derives from task counts.
- Lead import rejects non-CSV/Excel files; the add-member role dropdown hides
  owner-tier roles from non-owners.
- App version shown on the login screen, sidebar, desktop and mobile; server
  and web bundle read it from `package.json` (so `/api/health` stops drifting).
- Android: QR pairing scan fixed (ML Kit code-scanner module installed first);
  white-screen guard.

## [1.2.1] - 2026-06-18

### Fixed
- White-screen crashes in the desktop app and report CSV downloads that never
  landed: cross-platform download handler (`will-download`, de-duplicated safe
  filenames, reveal in folder) and a navigation policy that keeps error-recovery
  buttons working while blocking unsafe schemes.
- Rebuilt Mac (arm64 + x64) and Windows installers.

### Added
- Desktop pure-logic tests (`desktop/lib/*.test.js`) in `npm test`; real-Electron
  smoke test (`npm run test:desktop`) on macOS + Windows in CI.

### Changed
- `electron`/`electron-builder` reverted to 36 / 25 to match the lockfile after
  the security-remediation commit bumped only `package.json` (see the September
  2026 notes above — the bump is now applied properly).

## [1.2.0] - 2026-06-17

### Added
- LapaasOS feature set ported in six phases: roles (`super_admin`, `manager`,
  `agent`, `employee`, `read_only`), lead scoring and routing rules, coaching
  report cards, product/service catalog with an internal price builder, GST
  invoices, projects/tasks/time blocks/current-work, meetings, notifications,
  audit log, admin dashboard.
- Encrypted off-site backup to the operator's own Google Drive
  (`docs/GOOGLE-DRIVE-BACKUP.md`) and `npm run restore-cloud`.
- Sarvam cloud transcription (opt-in per recording) alongside local whisper.cpp.
- WhatsApp inbox (Baileys) bundled in the app — an admin clicks Connect; Android
  Chats tab + local notifications.
- In-app step-by-step setup guide for Drive + WhatsApp; `scripts/reset-admin.js`.
- Android: free Google ML Kit QR scanner replaces the JitPack one (no token needed).

### Security
- Remediation of the June 2026 audit (8 High, 9 Medium, 7 Low): forced rotation
  of the default admin, login lockout, opt-in TLS + secure cookies, mobile
  WebView XSS + CSP, Electron `openExternal` allow-list + sandbox, fail-closed
  role scoping, pairing privilege-escalation fix, device-token expiry, signed
  media tickets instead of tokens in URLs, restore path confinement, sealed API
  keys, backup-passphrase policy, money overflow clamps, CSV formula-injection
  guard, All-Files-Access permission removed, security headers. Full log in
  `docs/SECURITY-REMEDIATION.md`.

### Fixed
- Lead → deal on fresh installs; repeat-caller "attach to existing lead" chooser;
  in-app recording playback.

## [1.1.1] - 2026-06-15

### Fixed
- Phone-pairing QR on some devices; ad-hoc signing of the packaged Mac app so
  Apple Silicon no longer reports it "damaged" (one `xattr -cr` still needed).

### Added
- `docs/TROUBLESHOOTING.md`; README documents all default logins with a
  change-immediately warning.

## [1.1.0] - 2026-06-12

### Added
- Android call-capture app (Capacitor + Kotlin): device pairing by QR, call and
  recording sync, captured-call review, unknown numbers → leads in one tap.
- Local AI worker: whisper.cpp transcription + local LLM suggestions.
- Tasks module; recordings retention job; mobile onboarding guide (`docs/MOBILE.md`).

## [1.0.1] - 2026-06-12

### Fixed
- Electron host-mode crash on `better-sqlite3` ABI mismatch.

## [1.0.0] - 2026-06-12

### Added
- First public release: leads pipeline, Today queue, call logging, follow-ups,
  deals with EMI/installments and payments in paise, imports (CSV/XLSX with
  phone normalization + duplicate detection), reports with CSV export, WhatsApp
  templates, daily targets, roles (`admin`/`caller`), daily backups, desktop app
  (host/join) for macOS + Windows, MIT license.

[Unreleased]: https://github.com/lapaasindia/calltrack-crm/compare/v1.2.1...HEAD
[1.2.2]: https://github.com/lapaasindia/calltrack-crm/compare/v1.2.1...3e775ab
[1.2.1]: https://github.com/lapaasindia/calltrack-crm/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/lapaasindia/calltrack-crm/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/lapaasindia/calltrack-crm/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/lapaasindia/calltrack-crm/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/lapaasindia/calltrack-crm/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/lapaasindia/calltrack-crm/releases/tag/v1.0.0
