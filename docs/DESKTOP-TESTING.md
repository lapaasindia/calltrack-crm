# Desktop testing (Windows + Mac)

The desktop app is an Electron shell (`desktop/main.js`) around the same web UI.
It runs in one of three states:

| State | What runs where | How you get there |
|---|---|---|
| **host (embedded)** | Express + SQLite inside the Electron main process; data under the OS app-data folder (`userData/data`) | Setup → "This is the MAIN computer" on a machine **without** the background service |
| **host (attached)** | The app is a window onto the CallTrack background service (`npm run install-autostart`, port 3000). The app never starts a second server on that machine | Setup → "MAIN computer" on the office Mac; if the service is still starting the app shows "CallTrack service is starting…" and polls for up to 60 s |
| **join** | Window onto another computer's server over the office LAN | Setup → "Connect to the main computer" |

Several things behave differently inside the packaged app than in a plain
browser, so they have dedicated tests:

1. **Downloads** — the client downloads report CSVs via `fetch → Blob →
   a[download].click()`. Electron routes that through a `will-download` handler
   (`desktop/main.js`). Allow-listed document/data/media types (`csv xlsx xls
   pdf sqlite json zip txt png jpg jpeg webp m4a mp3 wav amr 3gp opus ogg`) are
   saved to the OS **Downloads** folder with a cross-platform-safe,
   de-duplicated name and revealed; **anything else** (`.exe`, `.lnk`, `.dmg`,
   `.js`, …) goes through the OS Save dialog and is never auto-revealed.
2. **Navigation / popups / redirects / subframes** — `will-navigate`,
   `will-redirect`, `will-frame-navigate` and the window-open handler (attached
   to *every* webContents via `web-contents-created`, so child windows inherit
   them) decide what stays in-app. Same-origin popups (print-ready invoice,
   weekly report) open in a child window that shares the session cookie;
   off-app `http(s)/mailto/tel` links open in the OS browser; unsafe schemes
   (`file:`, `smb:`, `javascript:`, `ms-msdt:` …) are dropped everywhere —
   including inside `<iframe>`s and server-side 302s. The ErrorBoundary's
   recovery buttons (`location.assign('/')`, `reload()`) stay allowed.
3. **Web permissions** — deny-by-default (`session.setPermissionRequestHandler`
   / `setPermissionCheckHandler`). Only `notifications`,
   `clipboard-sanitized-write` and `fullscreen` are granted, and only to the
   configured in-app origin. Camera/microphone/geolocation/clipboard-read/
   display-capture are never granted; `openExternal` is never granted as a
   permission (links are routed through `safeOpenExternal`).
4. **Offline / retry** — if the host cannot be reached the window shows a
   local "Can't reach the main computer" page and polls `/api/health` every 5 s,
   reloading the app when it answers. "Change setup…" is the only way back to
   the wizard; a configured joiner has to confirm before it can become a host.
5. **Restore** — the wizard's restore checks the SQLite header, size, free
   space, copies WAL/SHM sidecars of a live copy, and runs `PRAGMA quick_check`
   + `SELECT count(*) FROM users` in a separate utility process before moving
   the file into place. If the first boot after a restore fails, the file is
   moved to `crm.sqlite.bad-<timestamp>` and the wizard reopens.

## What runs where

| Test | Command | Where | Electron? |
|------|---------|-------|-----------|
| Policy + filename + restore + plist + update logic (pure) | `npm test` (`desktop/lib/*.test.js`, `scripts/*.test.mjs`) | every push/PR (Linux, Node 22 + 24) | no |
| Real downloads + navigation/permission guards in the app | `npm run test:desktop` | Mac + Windows runners | yes |
| Native SQLite binding loads in the installed Electron | `npm run native` | before every `dist` (and in the release workflow) | yes (ELECTRON_RUN_AS_NODE) |

The pure logic lives in `desktop/lib/` (no Electron import):

| Module | Covers |
|---|---|
| `navigation.js` | in-app origin check, will-navigate / will-redirect / will-frame-navigate / window-open decisions, permission allow-list |
| `downloads.js` | Windows-safe filenames, dedupe, silent-save allow-list, `.crdownload` partial detection |
| `restore.js` | SQLite header / WAL / size / free-space checks, interpretation of the integrity probe |
| `sqlite-check.js` | the integrity probe itself (forked as a utility process; runnable with plain `node` in tests) |
| `service.js` | LaunchAgent plist parsing, install marker path, service data/backup folders, LAN addresses |
| `logfile.js` | `userData/logs/main.log` with size rotation |
| `updates.js` | version compare, GitHub `releases/latest` parsing, once-a-day gate |
| `native.js` | where the Electron-side `better_sqlite3.node` lives |

`scripts/lib/launchagent.js` (plist generation, XML escaping, TCC path check)
is covered by `scripts/launchagent.test.mjs`; `install-autostart` /
`uninstall-autostart` / `doctor` are thin wrappers around it and are **not**
run by tests (they would touch a real LaunchAgent).

## The desktop smoke test

`npm run test:desktop` (script: `scripts/desktop-smoke.mjs`) launches the **real**
app and asserts, in one Electron process:

- starts a tiny local web server (no database — never loads `better-sqlite3`
  inside Electron), serving a page, an attachment CSV, a same-origin
  `/popup.html` and a `/redirect` → `http://example.invalid/`;
- launches `electron .` pointed at it, with the download folder redirected to a
  temp dir (`CALLTRACK_SMOKE_DOWNLOAD_DIR`) and its own `CALLTRACK_USERDATA`;
- the app triggers a main-process `downloadURL` **and** the exact client
  `fetch → Blob → a[download].click()` path, and waits for each download
  item's `done` event with `state === 'completed'` (this is what fixed the
  Windows CI job: Chromium writes `*.crdownload` partials first, and a
  directory prefix match used to see them, exit, and lose the files);
- an `<iframe src="x-calltrack-probe://sub">` must be cancelled by
  `will-frame-navigate`; `location.href = '/redirect'` must be cancelled by
  `will-redirect` with the window still on the in-app origin;
  `window.open('/popup.html')` must produce a child `BrowserWindow`;
  `navigator.permissions.query` must report camera/microphone/geolocation
  **denied** and notifications **granted**;
- prints one `[smoke] result {...}` JSON line and exits 0 / 1; the parent
  script additionally checks both files are complete on disk.

Run it locally on a Mac or a Windows machine:

```bash
npm ci
npm run test:desktop
```

It is intentionally **not** part of `npm test` (that stays fast and headless).
CI runs it on `macos-latest` and `windows-latest` via `.github/workflows/ci.yml`.
Finder/Explorer reveals and dialogs are suppressed while `CALLTRACK_SMOKE_URL`
is set. All `CALLTRACK_*` test hooks (`SMOKE_URL`, `SMOKE_DOWNLOAD_DIR`,
`USERDATA`, `AUTOSETUP`, `ALLOW_SELF_HOST`) and the DevTools menu only exist
when `app.isPackaged` is false.

> Note: on Windows the OS Downloads folder is resolved via the Known Folders
> API, not `HOME`, so the smoke test overrides the folder with an explicit env
> var (`CALLTRACK_SMOKE_DOWNLOAD_DIR`) rather than relying on a `HOME` override.

## Host-mode boot test (manual, any machine)

Proves the embedded server boots inside Electron with the fetched native
binding, without touching an installed service or its data:

```bash
npm run native                                   # build/native/<platform>-<arch>/better_sqlite3.node
UD=$(mktemp -d) && echo '{"mode":"host","port":3195}' > "$UD/config.json"
CALLTRACK_ALLOW_SELF_HOST=1 CALLTRACK_USERDATA="$UD" npx electron .
curl http://127.0.0.1:3195/api/health           # → {"app":"calltrack-crm","version":"…"}
```

`CALLTRACK_ALLOW_SELF_HOST=1` (dev builds only) bypasses the "a service is
installed here → attach, never self-host" rule so the test can run on the
office Mac. Quit with ⌘Q / SIGTERM: the log shows `quit: stopping the embedded
server` and the WAL is checkpointed. Data lives under `$UD/data`.

## Native module (`better-sqlite3`) and the LaunchAgent

Three runtimes used to share one `node_modules/better-sqlite3` binary (the
LaunchAgent's Node, `electron .`, and the packaged apps), and every build
"flipped" it — an interrupted `dist` could take the office server down.
Now:

- `npm run native` (`scripts/fetch-electron-sqlite.js`) prepares
  `build/native/<platform>-<arch>/better_sqlite3.node` for `darwin-arm64`,
  `darwin-x64` and `win32-x64`, verifies the magic bytes (Mach-O / MZ) in JS,
  load-tests the host platform's copy inside the installed Electron, and
  writes/verifies SHA-256s in `build/native/native.lock.json`. With
  better-sqlite3 ≥ 13 the binaries are the **N-API prebuilds bundled in the npm
  package** (ABI-stable across Node and Electron — nothing is downloaded);
  older versions fall back to `prebuild-install` / a direct GitHub release
  download for the installed Electron ABI. `node_modules` is never modified —
  the script fails if the repo's binaries change under it.
- `desktop/main.js` sets `CRM_SQLITE_NATIVE_BINDING` to that file
  (`Resources/native/…` when packaged, `build/native/…` in dev) before
  importing the server; `server/db.js` passes it as `nativeBinding`.
- electron-builder ships `build/native` as `Resources/native`
  (`extraResources`) with `npmRebuild: false`. `app:rebuild`,
  `fetch-win-sqlite.js` and the trailing `npm rebuild` are gone.
- Commit `build/native/native.lock.json`; ignore the binaries
  (`build/native/*/`). On a clean runner `npm run dist` re-creates them and
  fails if a binary's SHA-256 differs from the lock for the same versions
  (`--update-lock` after an intentional bump).

## Release procedure

```bash
npm ci && npm --prefix client ci
npm run icons        # once per clone (build/icon.* is gitignored)
npm run dist         # = client build → npm run native → electron-builder --mac --win
```

`.github/workflows/release.yml` runs exactly this on a tag. Never run `dist`
in the checkout the LaunchAgent serves from — not because it breaks anything
any more, but because it is the production machine.

## Follow-ups (not done — need money / accounts)

- **Code signing + notarization.** macOS builds are ad-hoc signed
  (`scripts/afterpack-sign.cjs`; `electronFuses.resetAdHocDarwinSignature`
  re-signs after the fuse flip), Windows builds are unsigned. Buy an Apple
  Developer ID (`mac.identity`, `hardenedRuntime: true`, `notarize: true`) and
  a Windows certificate / Azure Trusted Signing to remove the "damaged" /
  SmartScreen prompts.
- **Auto-update.** Not enabled: Squirrel.Mac refuses unsigned updates. The app
  only *checks* once a day (host `/api/health.version` + GitHub
  `releases/latest`, fail-silent; `"updateCheck": false` in `config.json`
  disables it) and shows a menu item / notification with the download link.
  Once signing exists, add `electron-updater` with `publish: [{ provider:
  'github' }]` (Windows first).
- **Electron fuses** are enabled (`runAsNode` off, cookie encryption on,
  `NODE_OPTIONS` / `--inspect` off, asar integrity + only-load-from-asar on).
  They are applied by electron-builder 26 after `afterPack`; verify a packaged
  build still launches after any electron-builder upgrade.
