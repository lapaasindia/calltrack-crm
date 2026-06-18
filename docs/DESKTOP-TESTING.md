# Desktop testing (Windows + Mac)

The desktop app is an Electron shell (`desktop/main.js`) around the same web UI.
Two things behave differently inside the packaged app than in a plain browser,
so they have dedicated tests:

1. **Report CSV export** — the client downloads via `fetch → Blob →
   a[download].click()`. Electron routes that through a `will-download` handler
   (`desktop/main.js`), which saves the file to the OS **Downloads** folder with
   a cross-platform-safe, de-duplicated name and reveals it. Without the
   handler, Electron's default behavior is version-dependent (a Save dialog, or
   nothing).
2. **Navigation / external links** — `will-navigate` and the window-open handler
   decide what opens in-window vs. in the OS browser, and block unsafe schemes
   (`file:`, `smb:`, `javascript:`, `ms-msdt:` …, audit H-5). The
   ErrorBoundary's recovery buttons (`location.assign('/')`, `reload()`) must
   stay allowed so a user is never stuck on the error screen.

## What runs where

| Test | Command | Where | Electron? |
|------|---------|-------|-----------|
| Navigation policy + filename rules (pure logic) | `npm test` | every push/PR (Linux) | no |
| Real download in the app on each OS | `npm run test:desktop` | Mac + Windows runners | yes |

The pure logic lives in `desktop/lib/navigation.js` and `desktop/lib/downloads.js`
(no Electron import) and is covered by `desktop/lib/*.test.js` — those run as
part of the normal `npm test` on Linux. The cross-platform filename rules
(Windows illegal chars `<>:"/\|?*`, reserved device names like `CON.csv`,
trailing dot/space, dedupe) are validated there, so Windows correctness is
checked even on the Linux job.

## The desktop smoke test

`npm run test:desktop` (script: `scripts/desktop-smoke.mjs`) launches the **real**
app and verifies an actual download lands on disk:

- starts a tiny local web server (no database — never loads `better-sqlite3`
  inside Electron, avoiding the Node-vs-Electron ABI crash);
- launches `electron .` pointed at it, with the download folder redirected to a
  temp dir (`CALLTRACK_SMOKE_DOWNLOAD_DIR`);
- the app triggers both a main-process `downloadURL` **and** the exact client
  `fetch → Blob → a[download].click()` path;
- asserts both files appear, then exits 0 / 1.

Run it locally on a Mac or a Windows machine:

```bash
npm install        # or npm ci
npm run test:desktop
```

It is intentionally **not** part of `npm test` (that stays fast and headless).
CI runs it on `macos-latest` and `windows-latest` via `.github/workflows/ci.yml`.

> Note: on Windows the OS Downloads folder is resolved via the Known Folders
> API, not `HOME`, so the smoke test overrides the folder with an explicit env
> var (`CALLTRACK_SMOKE_DOWNLOAD_DIR`) rather than relying on a `HOME` override.
