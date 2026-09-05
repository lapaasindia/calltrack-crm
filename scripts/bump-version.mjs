#!/usr/bin/env node
// The ONE way a CallTrack release number changes.
//
//   node scripts/bump-version.mjs <x.y.z> [--dry-run] [--allow-dirty] [--force] [--date YYYY-MM-DD]
//
// Writes every place a version lives that is not already derived from the
// root package.json at runtime/build time:
//
//   package.json + package-lock.json   (root; = `npm version --no-git-tag-version`)
//   client/package.json                (version field only; its lockfile records
//                                       the version on the next `npm --prefix client install`)
//   README.md                          (the "Latest version" download block between the
//                                       <!-- release-links:start/end --> markers, using
//                                       releases/download/v<x.y.z>/<asset> — never
//                                       `releases/latest/download/<versioned name>`, which
//                                       404s the moment a newer release exists)
//   CHANGELOG.md                       ("Unreleased" becomes "[x.y.z] - <date>", a fresh
//                                       empty Unreleased is left on top, compare links updated)
//
// Everything else derives from package.json: /api/health + the web bundle
// (server/db.js, client/vite.config.js) and the Android versionCode/versionName
// (major*10000 + minor*100 + patch — printed below so the operator can check
// the APK with `aapt2 dump badging`).
//
// It does NOT commit, tag, build or publish — it prints the checklist for that.
// It refuses to run on a dirty tree (so the release commit contains only the
// bump) unless --allow-dirty is given.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'lapaasindia/calltrack-crm';
const GH = `https://github.com/${REPO}`;

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const kv = argv.find((a) => a.startsWith(`${name}=`));
  return kv ? kv.slice(name.length + 1) : undefined;
};
const dryRun = flags.has('--dry-run');
const allowDirty = flags.has('--allow-dirty');
const force = flags.has('--force');
const root = path.resolve(opt('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--date', '--root'].includes(argv[i - 1])));
const next = positional[0];

function die(msg, code = 1) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(code);
}
if (!next || flags.has('--help') || flags.has('-h')) {
  console.log(`Usage: node scripts/bump-version.mjs <x.y.z> [--dry-run] [--allow-dirty] [--force] [--date YYYY-MM-DD]

  --dry-run      show what would change, write nothing
  --allow-dirty  proceed with uncommitted changes in the tree (the release commit
                 should normally contain ONLY this bump)
  --force        allow a version that is not greater than the current one, or an
                 empty "Unreleased" changelog section
  --date         date to stamp on the CHANGELOG entry (default: today, IST)`);
  process.exit(next ? 0 : 1);
}
if (!/^\d+\.\d+\.\d+$/.test(next)) die(`"${next}" is not a plain x.y.z version (pre-release tags are not supported: the Android versionCode is derived from the three numbers).`);

// ── helpers ──────────────────────────────────────────────────────────────────
const p = (...seg) => path.join(root, ...seg);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const parts = (v) => v.split('.').map(Number);
const cmp = (a, b) => {
  const [a1, a2, a3] = parts(a); const [b1, b2, b3] = parts(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
};
const androidVersionCode = (v) => { const [M, m, pch] = parts(v); return M * 10000 + m * 100 + pch; };
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
// Today's date on the IST calendar (all CallTrack business dates are IST).
const todayIst = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
const date = opt('--date') || todayIst();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die(`--date must be YYYY-MM-DD, got "${date}"`);

const writes = []; // { file, content }
function plan(file, content) { writes.push({ file, content }); }

// ── preconditions ────────────────────────────────────────────────────────────
for (const f of ['package.json', 'package-lock.json', 'client/package.json', 'README.md', 'CHANGELOG.md']) {
  if (!fs.existsSync(p(f))) die(`missing ${f} (run from the repo root, or pass --root)`);
}
const dirty = git('status', '--porcelain');
if (dirty && !allowDirty) {
  die(`the working tree has uncommitted changes — commit or stash them first so the release commit contains only the bump (or pass --allow-dirty):\n\n${dirty.split('\n').map((l) => '      ' + l).join('\n')}`);
}

const pkg = readJson(p('package.json'));
const current = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(current)) die(`package.json version "${current}" is not x.y.z`);
if (cmp(next, current) <= 0 && !force) die(`${next} is not greater than the current version ${current} (pass --force to override)`);

// ── root package.json / package-lock.json ────────────────────────────────────
pkg.version = next;
plan('package.json', JSON.stringify(pkg, null, 2) + '\n');

const lock = readJson(p('package-lock.json'));
lock.version = next;
if (lock.packages && lock.packages['']) lock.packages[''].version = next;
plan('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

// ── client/package.json (version only — the client lockfile is regenerated by
// the client install, which CI verifies with `npm --prefix client ci`) ────────
const cpkg = readJson(p('client/package.json'));
cpkg.version = next;
plan('client/package.json', JSON.stringify(cpkg, null, 2) + '\n');

// ── README download block ────────────────────────────────────────────────────
const README_START = '<!-- release-links:start -->';
const README_END = '<!-- release-links:end -->';
function readmeBlock(v) {
  const dl = (asset) => `${GH}/releases/download/v${v}/${asset}`;
  const anchor = `${v.replace(/\./g, '')}---${date}`; // GitHub's anchor for "## [x.y.z] - date"
  return `${README_START}
<!-- Generated by scripts/bump-version.mjs — do not edit by hand. -->
**Latest version: v${v}** ([what changed](CHANGELOG.md#${anchor}) · [all releases](${GH}/releases))

| Platform | Download |
|---|---|
| **Mac** (Apple Silicon — M1/M2/M3/M4) | [CallTrack-CRM ${v} — mac-arm64.dmg](${dl(`CallTrack-CRM-${v}-mac-arm64.dmg`)}) |
| **Mac** (Intel) | [CallTrack-CRM ${v} — mac-x64.dmg](${dl(`CallTrack-CRM-${v}-mac-x64.dmg`)}) |
| **Windows** 10/11 (64-bit) | [CallTrack-CRM ${v} Setup — win-x64.exe](${dl(`CallTrack-CRM-Setup-${v}-win-x64.exe`)}) |
| **Android** call-capture app | [CallTrack-CRM ${v} — android.apk](${dl(`CallTrack-CRM-${v}-android.apk`)}) |

Verify a download against [\`SHA256SUMS.txt\`](${dl('SHA256SUMS.txt')}) (\`shasum -a 256 <file>\` on Mac, \`certutil -hashfile <file> SHA256\` on Windows).
${README_END}`;
}
const readme = fs.readFileSync(p('README.md'), 'utf8');
const rs = readme.indexOf(README_START);
const re = readme.indexOf(README_END);
if (rs === -1 || re === -1 || re < rs) die(`README.md has no ${README_START} … ${README_END} block to rewrite`);
plan('README.md', readme.slice(0, rs) + readmeBlock(next) + readme.slice(re + README_END.length));

// ── CHANGELOG.md ─────────────────────────────────────────────────────────────
const changelog = fs.readFileSync(p('CHANGELOG.md'), 'utf8');
const unrelRe = /^## \[Unreleased\][^\n]*\n/m;
const um = unrelRe.exec(changelog);
if (!um) die('CHANGELOG.md has no "## [Unreleased]" section');
const bodyStart = um.index + um[0].length;
const nextHeading = changelog.slice(bodyStart).search(/^## \[/m);
const bodyEnd = nextHeading === -1 ? changelog.length : bodyStart + nextHeading;
let unreleasedBody = changelog.slice(bodyStart, bodyEnd).replace(/^\s*_Nothing yet\._\s*$/m, '').trim();
if (!unreleasedBody && !force) die('the "Unreleased" section of CHANGELOG.md is empty — write the release notes first (or pass --force)');
if (changelog.includes(`## [${next}]`)) die(`CHANGELOG.md already has a [${next}] section`);
const lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
const releaseSection = `## [${next}] - ${date}\n\n${unreleasedBody || '_No changes recorded._'}\n\n`;
let newChangelog = changelog.slice(0, um.index)
  + `## [Unreleased]\n\n_Nothing yet._\n\n`
  + releaseSection
  + changelog.slice(bodyEnd).replace(/^\n+/, '');
// Link references at the bottom (Keep a Changelog style).
const unrelLink = `[Unreleased]: ${GH}/compare/v${next}...HEAD`;
const relLink = `[${next}]: ${lastTag ? `${GH}/compare/${lastTag}...v${next}` : `${GH}/releases/tag/v${next}`}`;
if (/^\[Unreleased\]: .*$/m.test(newChangelog)) {
  newChangelog = newChangelog.replace(/^\[Unreleased\]: .*$/m, `${unrelLink}\n${relLink}`);
} else {
  newChangelog = newChangelog.trimEnd() + `\n\n${unrelLink}\n${relLink}\n`;
}
plan('CHANGELOG.md', newChangelog);

// ── mobile: read-only consistency checks (the mobile build derives its
// versionCode/versionName from package.json; warn if a literal still lags) ───
const warnings = [];
const code = androidVersionCode(next);
try {
  const gradle = fs.readFileSync(p('mobile/android/app/build.gradle'), 'utf8');
  const vc = /^\s*versionCode\s+(\d+)\s*$/m.exec(gradle);
  const vn = /^\s*versionName\s+"([^"]+)"\s*$/m.exec(gradle);
  if (vc && Number(vc[1]) !== code) warnings.push(`mobile/android/app/build.gradle still hard-codes versionCode ${vc[1]} (expected ${code} = ${next} → major*10000+minor*100+patch). Derive it from package.json or update it before building the APK.`);
  if (vn && vn[1] !== next) warnings.push(`mobile/android/app/build.gradle still hard-codes versionName "${vn[1]}" (expected "${next}").`);
} catch { /* no android project checked out */ }
try {
  const app = fs.readFileSync(p('mobile/www/app.js'), 'utf8');
  const m = /const APP_VERSION\s*=\s*'([^']+)'/.exec(app);
  if (m && m[1] !== next) warnings.push(`mobile/www/app.js still has a literal APP_VERSION = '${m[1]}' (expected '${next}', or read it from /api/health at runtime).`);
} catch { /* ignore */ }

// ── apply ────────────────────────────────────────────────────────────────────
console.log(`\n  CallTrack CRM  ${current}  →  ${next}   (${dryRun ? 'DRY RUN — nothing written' : 'writing'})\n`);
for (const w of writes) {
  const before = fs.readFileSync(p(w.file), 'utf8');
  const changed = before !== w.content;
  console.log(`  ${dryRun ? 'would write' : changed ? 'wrote      ' : 'unchanged  '}  ${w.file}`);
  if (!dryRun && changed) fs.writeFileSync(p(w.file), w.content);
}
if (dryRun) {
  console.log('\n  README block:\n');
  console.log(readmeBlock(next).split('\n').map((l) => '    ' + l).join('\n'));
  console.log(`\n  CHANGELOG: "## [${next}] - ${date}" gets the current Unreleased notes (${unreleasedBody ? unreleasedBody.split('\n').length + ' lines' : 'EMPTY'})`);
}
for (const w of warnings) console.log(`\n  ⚠ ${w}`);

console.log(`
  Android versionCode the mobile build derives for ${next}:  ${code}   (versionName "${next}")
  Check a built APK with:  aapt2 dump badging app-release.apk | head -1

  Next steps:
    1. git diff                                   # review the bump
    2. git commit -am "release: v${next}" && git tag -a v${next} -m "CallTrack CRM v${next}"
    3. git push --follow-tags                     # .github/workflows/release.yml builds the DMG/EXE/APK,
                                                  # SHA256SUMS.txt + provenance, and drafts the GitHub release
       — or locally on a Mac:  npm run icons && npm run dist   (→ release/), then upload the assets by hand
    4. Publish the release-signed APK to the office LAN channel (phones auto-update from it):
         node scripts/publish-apk.js <CallTrack-CRM-${next}-android.apk>
    5. On the office computer: git pull, npm ci, npm run build, then restart the server
         launchctl kickstart -k gui/$(id -u)/com.calltrack.crm
    6. Publish the draft GitHub release; README links now point at releases/download/v${next}/…
`);
