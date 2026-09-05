# Contributing to CallTrack CRM

Thanks for helping. This page is the developer's map: how to set up, test,
build each target, and cut a release. Product/architecture background lives in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the decision records in
[docs/adr/](docs/adr/).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **22 LTS (22.23 or newer) or 24** — `engines` is `>=22.12 <25` and `.npmrc` sets `engine-strict` | `.nvmrc` says `22`; `nvm use` |
| npm | 10+ (ships with Node) | |
| git | any recent | `baileys` pulls `libsignal` from GitHub at install time, so the machine needs git + network for `npm ci` |
| Android (optional) | Android Studio/SDK build-tools, **JDK 17** (Gradle 8.2.1 does not run on 21+) | see [docs/ANDROID-APK.md](docs/ANDROID-APK.md) |
| Desktop packaging (optional) | macOS to build both DMGs and cross-build the Windows installer | see "Desktop" below |

## Set up a working copy

```bash
git clone https://github.com/lapaasindia/calltrack-crm.git
cd calltrack-crm
npm ci                       # root: server + desktop shell + Android toolchain (npm side)
npm --prefix client ci       # web client
npm --prefix client run build
npm run seed                 # optional demo data (2 callers, 30 leads). Forces the admin
                             # to change admin123 on first login unless CRM_ADMIN_PASSWORD is set
npm start                    # http://localhost:3000 — prints LAN URLs + a QR code
```

Use `npm ci`, not `npm install`, unless you are deliberately changing
dependencies: `npm ci` fails when a lockfile is out of sync with its manifest,
which is exactly the drift CI guards against (a stale `client/package-lock.json`
once shipped a vulnerable `xlsx` for eleven weeks).

For UI work run `npm --prefix client run dev` (Vite dev server on :5173,
proxies `/api` to :3000).

**If this checkout also runs the office server** (LaunchAgent on :3000): never
run `npm run dist`, `npm run app:rebuild` or an `electron-rebuild` here — they
swap the `better-sqlite3` native binary the live server loads. Build releases in
CI or from a separate clone.

## Tests and checks

| Command | What it proves | Where it runs |
|---|---|---|
| `npm test` | Server suite (`server/test/*.test.js`) + desktop pure-logic libs (`desktop/lib/*.test.js`). `node --test`, each file boots the app on a temp `CRM_DATA_DIR` and a random port — never touches `data/`. | every push/PR, Node 22 + 24 |
| `npm --prefix client run build` | The web bundle compiles from a lockfile-consistent tree | every push/PR |
| `npm --prefix client run lint` | ESLint (flat config in `client/eslint.config.js`) | every push/PR |
| `npm audit --omit=dev --audit-level=high` (root and `--prefix client`) | Runtime dependencies carry no High/Critical advisories | every push/PR — **gate** |
| `node scripts/third-party-notices.mjs --check` | `THIRD-PARTY-NOTICES.md` matches the installed prod tree | every push/PR |
| `npm run test:desktop` | Real Electron on this OS: a report download lands on disk (`scripts/desktop-smoke.mjs`; no database, ABI-safe) | macOS + Windows runners; run locally on a Mac/PC |
| Android `assembleDebug` | The tracked Android project still builds; the APK is inspected with `scripts/publish-apk.js --dry-run` | every push/PR |

Add a test next to the code you change: server behaviour in `server/test/`,
desktop shell logic in `desktop/lib/*.test.js`. Tests run against a fresh
database each time, so they double as migration checks.

## Conventions that are not negotiable

These are enforced by review because every report and every sync depends on them
(details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#data-model-invariants)):

- **Money is integer paise.** Never floats, never rupees in the database.
- **Instants are UTC ISO strings; business dates are IST `YYYY-MM-DD`** computed
  in `server/lib/istTime.js`. Never `date('now')` in SQL for business logic.
- **One phone normalizer** — `server/lib/phone.js` (mirrored on the client). Ten
  digits, first digit 6–9; everything else is rejected with a reason, never guessed.
- **Calls, payments and lead events are append-only.** Stage changes go through
  `changeStage()` so the funnel reflects real transitions.
- **Roles come from `server/lib/permissions.js`** (`isAdmin`, `isOwner`,
  `canSeeAllLeads`, `isReadOnly`). Do not compare `role === 'admin'` in a route.
- **Schema changes are numbered SQL migrations** in `server/migrations/`, additive
  and idempotent (`IF NOT EXISTS`), never edited after they ship.
- **Versions derive from the root `package.json`** — do not hard-code one anywhere;
  see "Releases".

## Building the targets

### Web client
`npm --prefix client run build` → `client/dist/` (served by the server; content-hashed
assets, `index.html` never cached, so a rebuild goes live on the next page load).

### Desktop (Electron, macOS + Windows)
```bash
npm run icons        # generates build/icon.* from desktop/make-icon.js (gitignored)
npm run dist:mac     # DMGs for Apple Silicon + Intel (on a Mac)
npm run dist:win     # Windows NSIS installer (cross-builds from macOS)
npm run dist         # all of the above → release/
```
Installers are ad-hoc signed (`scripts/afterpack-sign.cjs`); Developer ID /
notarization and Authenticode are follow-ups (see CHANGELOG "Known follow-ups").
`.github/workflows/release.yml` runs exactly these commands on a macOS runner —
prefer it over building on a developer laptop. Native-module notes are in the
README's "Building the installers" and [docs/DESKTOP-TESTING.md](docs/DESKTOP-TESTING.md).

### Android
```bash
npx cap sync android           # copies mobile/www + wires plugins (commit the two tracked *.gradle outputs if they change)
cd mobile/android && ./gradlew assembleDebug --no-daemon      # debug APK
CALLTRACK_KEYSTORE=… CALLTRACK_KEYSTORE_PASS=… ./gradlew assembleRelease --no-daemon   # release-signed
```
The app's `versionCode` is `major*10000 + minor*100 + patch` of the root
`package.json` version (1.2.3 → 10203) and `versionName` is the version string;
`scripts/bump-version.mjs` prints both. Full guide: [docs/ANDROID-APK.md](docs/ANDROID-APK.md).

## Dependencies

- Add runtime packages to `dependencies` only if the **server or desktop shell**
  needs them at runtime — everything in `dependencies` is packed into the
  installers. Build/mobile tooling (`@capacitor/*`, `electron*`) belongs in
  `devDependencies`.
- Commit the lockfile in the same change as the manifest. Run
  `node scripts/third-party-notices.mjs` and commit the regenerated notices.
- Deferred majors (Express 5, react-router 7, Vite 7+, Capacitor 8, baileys 7)
  are listed in CHANGELOG "Known follow-ups"; Dependabot is configured to skip
  the ones that need a coordinated migration.

## Releases

One command owns every version string:

```bash
git switch main && git pull && git status      # clean tree required
node scripts/bump-version.mjs 1.2.3            # --dry-run first if unsure
```

It writes `package.json`, `package-lock.json`, `client/package.json`, the README
download block (links of the form `releases/download/v1.2.3/<asset>`) and turns
the CHANGELOG's **Unreleased** section into `[1.2.3] - <date>` — so write the
release notes under *Unreleased* as you go. Then:

```bash
git diff                                       # review
git commit -am "release: v1.2.3"
git tag -a v1.2.3 -m "CallTrack CRM v1.2.3"
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`: it checks the tag equals
`package.json`, builds the DMGs + EXE on macOS and (when the keystore secrets are
configured) the release-signed APK on Linux, writes `SHA256SUMS.txt`, attaches
build-provenance attestations, and opens a **draft** GitHub release with the
CHANGELOG section as its notes. Review the draft, then publish it — the README
links start working at that moment.

Finally, publish the APK to the office LAN update channel and restart the host:

```bash
node scripts/publish-apk.js CallTrack-CRM-1.2.3-android.apk   # refuses debug builds and downgrades
# on the office computer:
git pull && npm ci && npm --prefix client ci && npm --prefix client run build
launchctl kickstart -k gui/$(id -u)/com.calltrack.crm          # server changes need a restart
```

## Pull requests

- Branch from `main`; keep PRs focused; CI must be green (`main` is branch-protected
  to require it — see CHANGELOG follow-ups for the exact settings).
- Describe the user-visible change in `CHANGELOG.md` under **Unreleased**.
- Security-sensitive changes: reference the finding id (`SEC-`, `H-`, `M-`…) from
  [docs/SECURITY-REMEDIATION.md](docs/SECURITY-REMEDIATION.md) and add a test.
- Vulnerabilities: do not open a PR that discloses one — follow [SECURITY.md](SECURITY.md).

By contributing you agree your work is released under the repository's
[MIT License](LICENSE). Note the bundled WhatsApp engine's GPL-3.0 `libsignal`
dependency ([THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).
