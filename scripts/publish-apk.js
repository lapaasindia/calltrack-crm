#!/usr/bin/env node
// Publishes a RELEASE-SIGNED Android APK to the office server's download
// channel (data/apk/) so phones can install it from
// http://<office-server>:3000/download/calltrack.apk and the in-app updater
// (GET /api/app-version, compared by versionCode) offers it as an update.
//
//   node scripts/publish-apk.js <app-release.apk> [--out <dir>] [--dry-run] [--force]
//                               [--allow-debug] [--allow-unverified]
//                               [--version-code N --version-name X]
//
// Safety rails (audit DEP-3 — the old script took the version as optional CLI
// arguments defaulting to 1 / "1.0.0", so a forgotten argument silently
// DOWNGRADED the whole office):
//   * versionCode / versionName are read FROM THE APK (`aapt2 dump badging`
//     from the Android SDK build-tools). Without aapt2 they fall back to
//     mobile/android/app/build.gradle, then to package.json (major*10000 +
//     minor*100 + patch); --version-code/--version-name override the fallback.
//   * Debug-signed APKs are refused (`apksigner verify --print-certs` →
//     "CN=Android Debug"; without apksigner, the `application-debuggable`
//     badging flag). A debug build cannot install over a release-signed one,
//     so publishing it would break every phone's update. --allow-debug
//     overrides (test channels only).
//   * A versionCode lower than or equal to the currently published
//     <out>/version.json is refused (phones would never see it, or would be
//     offered a downgrade they cannot install). --force overrides.
//   * version.json records sha256 + size (what the phone verifies) plus the
//     signer certificate digest and publish time.
//   * --dry-run runs every check and writes nothing; --out lets you publish
//     to any directory (tests use a scratch dir, never data/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EXPECTED_PACKAGE = 'com.calltrack.mobile';
const WIN = process.platform === 'win32';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const kv = argv.find((a) => a.startsWith(`${name}=`));
  return kv ? kv.slice(name.length + 1) : undefined;
};
const VALUE_OPTS = new Set(['--out', '--version-code', '--version-name']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_OPTS.has(argv[i - 1])));
const src = positional[0];
const dryRun = has('--dry-run');
const force = has('--force');
const allowDebug = has('--allow-debug');
const allowUnverified = has('--allow-unverified');
const DATA_DIR = process.env.CRM_DATA_DIR || path.join(ROOT, 'data');
const outDir = path.resolve(opt('--out') || path.join(DATA_DIR, 'apk'));

function usage(code) {
  console.log(`Usage: node scripts/publish-apk.js <app-release.apk> [--out <dir>] [--dry-run] [--force]
                                   [--allow-debug] [--allow-unverified] [--version-code N --version-name X]

  --out <dir>          publish here instead of ${path.join('data', 'apk')} (CRM_DATA_DIR respected)
  --dry-run            run every check, write nothing
  --force              publish even if versionCode <= the currently published one
  --allow-debug        publish a debug-signed APK (test channel only — breaks updates for release installs)
  --allow-unverified   publish even if the APK could not be inspected (no aapt2/apksigner found)
  --version-code N     versionCode to record when the APK cannot be inspected (with --version-name)
  --version-name X     versionName to record when the APK cannot be inspected`);
  process.exit(code);
}
if (has('--help') || has('-h')) usage(0);
if (!src) usage(1);
if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
  console.error(`\n  ✗ APK not found: ${src}\n`);
  process.exit(1);
}

const problems = [];
const warnings = [];
const refuse = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);

// ── locate Android SDK build-tools (aapt2, apksigner) ────────────────────────
function sdkRoots() {
  const home = os.homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, 'Library', 'Android', 'sdk'),
    path.join(home, 'Android', 'Sdk'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
  ].filter(Boolean);
}
function newestBuildTools() {
  const dirs = [];
  for (const sdk of sdkRoots()) {
    const bt = path.join(sdk, 'build-tools');
    if (!fs.existsSync(bt)) continue;
    for (const v of fs.readdirSync(bt)) {
      if (/^\d+\.\d+\.\d+/.test(v)) dirs.push({ v, dir: path.join(bt, v) });
    }
  }
  dirs.sort((a, b) => b.v.localeCompare(a.v, undefined, { numeric: true }));
  return dirs.map((d) => d.dir);
}
function findTool(name) {
  const exe = WIN ? `${name}.exe` : name;
  const bat = WIN ? `${name}.bat` : name;
  for (const dir of newestBuildTools()) {
    for (const cand of [path.join(dir, exe), path.join(dir, bat)]) {
      if (fs.existsSync(cand)) return cand;
    }
  }
  // PATH lookup: run it once; if the OS finds it, use the bare name.
  const probe = spawnSync(name, ['--help'], { encoding: 'utf8', shell: WIN, windowsHide: true });
  if (!probe.error) return name;
  return null;
}
function run(tool, args) {
  const r = spawnSync(tool, args, { encoding: 'utf8', shell: WIN, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

// ── inspect the APK ──────────────────────────────────────────────────────────
const apk = { inspected: false, packageName: null, versionCode: null, versionName: null, debuggable: null, signer: null, debugSigned: null };

const aapt2 = findTool('aapt2');
if (aapt2) {
  const r = run(aapt2, ['dump', 'badging', src]);
  if (r.ok) {
    const m = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/.exec(r.out);
    if (m) {
      apk.inspected = true;
      apk.packageName = m[1];
      apk.versionCode = Number(m[2]);
      apk.versionName = m[3];
      apk.debuggable = /^application-debuggable\s*$/m.test(r.out);
    } else {
      warn(`aapt2 ran but no "package:" line was found in its badging output`);
    }
  } else {
    warn(`aapt2 failed on ${path.basename(src)}: ${r.out.trim().split('\n')[0]}`);
  }
} else {
  warn('aapt2 not found (set ANDROID_HOME, or install Android SDK build-tools) — cannot read versionCode/versionName from the APK');
}

const apksigner = findTool('apksigner');
if (apksigner) {
  const r = run(apksigner, ['verify', '--print-certs', src]);
  if (r.ok) {
    const dn = /Signer #1 certificate DN: (.*)$/m.exec(r.out);
    const sha = /Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/m.exec(r.out);
    apk.signer = { dn: dn ? dn[1].trim() : null, sha256: sha ? sha[1] : null };
    apk.debugSigned = !!(dn && /CN=Android Debug/i.test(dn[1]));
  } else if (/DOES NOT VERIFY|not signed|no signature/i.test(r.out)) {
    refuse(`the APK is not signed or does not verify (apksigner): ${r.out.trim().split('\n').filter(Boolean).slice(-1)[0]}`);
  } else {
    warn(`apksigner failed: ${r.out.trim().split('\n').filter((l) => !/^WARNING/.test(l)).slice(-1)[0] || 'unknown error'}`);
  }
} else {
  warn('apksigner not found — cannot verify the signing certificate');
}

// ── fallbacks when the APK could not be inspected ────────────────────────────
function gradleVersion() {
  try {
    const g = fs.readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'build.gradle'), 'utf8');
    const vc = /^\s*versionCode\s+(\d+)\s*$/m.exec(g);
    const vn = /^\s*versionName\s+"([^"]+)"\s*$/m.exec(g);
    if (vc && vn) return { versionCode: Number(vc[1]), versionName: vn[1], source: 'mobile/android/app/build.gradle' };
  } catch { /* ignore */ }
  return null;
}
function packageJsonVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const [M, m, pch] = v.split('.').map(Number);
    if ([M, m, pch].every(Number.isInteger)) return { versionCode: M * 10000 + m * 100 + pch, versionName: v, source: 'package.json (major*10000+minor*100+patch)' };
  } catch { /* ignore */ }
  return null;
}
let versionSource = 'APK (aapt2 dump badging)';
if (!apk.inspected) {
  const cliCode = opt('--version-code');
  const cliName = opt('--version-name');
  let fb = null;
  if (cliCode || cliName) {
    if (!(cliCode && cliName)) refuse('--version-code and --version-name must be given together');
    fb = { versionCode: Number(cliCode), versionName: cliName, source: 'command line' };
  } else {
    fb = gradleVersion() || packageJsonVersion();
  }
  if (!fb || !Number.isInteger(fb.versionCode) || fb.versionCode < 1) {
    refuse('could not determine versionCode/versionName (no aapt2, no build.gradle literal, no package.json) — pass --version-code N --version-name X');
  } else {
    apk.versionCode = fb.versionCode;
    apk.versionName = fb.versionName;
    versionSource = fb.source;
    warn(`versionCode ${fb.versionCode} / versionName "${fb.versionName}" taken from ${fb.source}, NOT from the APK — make sure they match the build`);
  }
}

// ── policy checks ────────────────────────────────────────────────────────────
if (apk.inspected && apk.packageName !== EXPECTED_PACKAGE) {
  refuse(`package name is "${apk.packageName}", expected "${EXPECTED_PACKAGE}" — this is not the CallTrack app`);
}
const isDebug = apk.debugSigned === true || (apk.debugSigned === null && apk.debuggable === true);
if (isDebug) {
  const why = apk.debugSigned ? 'signed with the Android debug certificate' : 'flagged debuggable (debug build)';
  if (allowDebug) warn(`publishing a DEBUG build (${why}) because --allow-debug was given — release-signed installs cannot update to it`);
  else refuse(`the APK is ${why}. Build with the release keystore (docs/ANDROID-APK.md) — a debug-signed APK cannot install over a release-signed one, so phones would be stuck. (--allow-debug to override for a test channel.)`);
}
const verified = apk.inspected && apk.debugSigned !== null;
if (!verified && !isDebug) {
  if (allowUnverified) warn('signing certificate / debuggable flag could not be verified; continuing because --allow-unverified was given');
  else refuse('could not verify that the APK is release-signed (need Android SDK build-tools: aapt2 + apksigner). Install them, set ANDROID_HOME, or pass --allow-unverified.');
}

const versionFile = path.join(outDir, 'version.json');
let published = null;
if (fs.existsSync(versionFile)) {
  try { published = JSON.parse(fs.readFileSync(versionFile, 'utf8')); } catch { warn(`${versionFile} is not valid JSON — treating the channel as empty`); }
}
if (published && Number.isInteger(published.versionCode) && Number.isInteger(apk.versionCode)) {
  if (apk.versionCode < published.versionCode) {
    (force ? warn : refuse)(`versionCode ${apk.versionCode} is LOWER than the currently published ${published.versionCode} (v${published.versionName}) — phones would be offered a downgrade they cannot install${force ? ' (continuing: --force)' : '. Pass --force only if you really mean to roll back.'}`);
  } else if (apk.versionCode === published.versionCode) {
    if (published.sha256 && published.sha256 === sha256Of(src)) {
      (force ? warn : refuse)(`this exact APK (versionCode ${apk.versionCode}, same sha256) is already published${force ? ' (continuing: --force)' : ' — nothing to do (--force to rewrite)'}`);
    } else {
      (force ? warn : refuse)(`versionCode ${apk.versionCode} equals the currently published one — phones only update when the code INCREASES, so bump the version first${force ? ' (continuing: --force)' : ' (--force to overwrite anyway)'}`);
    }
  }
}
const pj = packageJsonVersion();
if (pj && apk.versionName && apk.versionName !== pj.versionName) {
  warn(`APK versionName "${apk.versionName}" differs from package.json ${pj.versionName} — fine for a hotfix APK, but the desktop/server and phone versions will not match`);
}

function sha256Of(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

// ── report ───────────────────────────────────────────────────────────────────
const size = fs.statSync(src).size;
const sha256 = sha256Of(src);
console.log(`
  APK        ${src}
  package    ${apk.packageName || '(not inspected)'}
  version    ${apk.versionName} (versionCode ${apk.versionCode})  ← ${versionSource}
  signer     ${apk.signer ? `${apk.signer.dn || '?'}  sha256 ${apk.signer.sha256 || '?'}` : '(not verified)'}
  size       ${(size / 1048576).toFixed(1)} MB   sha256 ${sha256}
  channel    ${outDir}${published ? `  (currently v${published.versionName}, versionCode ${published.versionCode})` : '  (empty)'}`);
for (const w of warnings) console.log(`\n  ⚠ ${w}`);
if (problems.length) {
  for (const m of problems) console.error(`\n  ✗ ${m}`);
  console.error('\n  Not published.\n');
  process.exit(2);
}
if (dryRun) {
  console.log('\n  DRY RUN — all checks passed; nothing written.\n');
  process.exit(0);
}

// ── publish (atomic: write .tmp, rename) ─────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true });
const apkDest = path.join(outDir, 'calltrack.apk');
const tmp = `${apkDest}.tmp`;
fs.copyFileSync(src, tmp);
fs.renameSync(tmp, apkDest);
const meta = {
  versionCode: apk.versionCode,
  versionName: apk.versionName,
  sha256,
  size,
  packageName: apk.packageName || EXPECTED_PACKAGE,
  signerSha256: apk.signer?.sha256 || null,
  debug: !!isDebug,
  publishedAt: new Date().toISOString(),
};
fs.writeFileSync(`${versionFile}.tmp`, JSON.stringify(meta, null, 2) + '\n');
fs.renameSync(`${versionFile}.tmp`, versionFile);

console.log(`
  ✓ Published CallTrack APK v${meta.versionName} (versionCode ${meta.versionCode}, ${(size / 1048576).toFixed(1)} MB)
    → ${apkDest}
    → ${versionFile}
  Phones download it from:  http://<office-server>:3000/download/calltrack.apk
  (the running server serves data/apk/ live — no restart needed)
`);
