// Fetch the better-sqlite3 prebuild for the INSTALLED Electron version into
// build/native/<platform>-<arch>/better_sqlite3.node (DESK-4 / DESK-20).
//
// The repo's node_modules/better-sqlite3 binary is built for the Node ABI and
// is what the always-on LaunchAgent server loads — it is NEVER touched here.
// prebuild-install runs with cwd = a scratch copy of the package's
// package.json, so its output lands in the scratch dir; the .node is then
// moved under build/native/, its magic bytes are checked in JS (Mach-O / MZ)
// and its SHA-256 is recorded in build/native/native.lock.json. The desktop
// app points server/db.js at that file via CRM_SQLITE_NATIVE_BINDING
// (desktop/lib/native.js); electron-builder ships build/native as
// Resources/native (extraResources).
//
//   node scripts/fetch-electron-sqlite.js                  # all targets
//   node scripts/fetch-electron-sqlite.js --platform darwin --arch arm64
//   node scripts/fetch-electron-sqlite.js --verify          # only check the lock
//   node scripts/fetch-electron-sqlite.js --update-lock     # accept a changed binary for the same versions
//
// better-sqlite3 >= 13 ships N-API prebuilds for every platform INSIDE the npm
// package (node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node); N-API
// binaries are ABI-stable across Node and Electron, so those are copied as-is
// (nothing to download) and the host platform's copy is load-tested inside the
// installed Electron. Older better-sqlite3 (NAN builds, one binary per Electron
// ABI) fall back to prebuild-install, then to a direct GitHub release download
// with the ABI read from the Electron binary when node-abi predates it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const VERIFY_ONLY = args.includes('--verify');

const ALL_TARGETS = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
];
const targets = ALL_TARGETS.filter((t) => (!opt('platform') || t.platform === opt('platform')) && (!opt('arch') || t.arch === opt('arch')));

const electronVersion = require('electron/package.json').version;
const sqlitePkg = require('better-sqlite3/package.json');
const sqliteVersion = sqlitePkg.version;
const NATIVE_DIR = path.join(root, 'build', 'native');
const LOCK = path.join(NATIVE_DIR, 'native.lock.json');
const prebuildInstall = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Native module magic bytes, checked in JS so no `file(1)` dependency.
export function classifyBinary(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x4d && buf[1] === 0x5a) return 'pe';                       // "MZ"
  const be = buf.readUInt32BE(0);
  if (be === 0xfeedfacf || be === 0xcffaedfe) return 'macho64';               // Mach-O 64 (either endian marker)
  if (be === 0xfeedface || be === 0xcefaedfe) return 'macho32';
  if (be === 0xcafebabe || be === 0xbebafeca) return 'macho-fat';
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'elf';
  return null;
}

export function expectedKind(platform) {
  return platform === 'win32' ? ['pe'] : platform === 'darwin' ? ['macho64', 'macho-fat'] : ['elf'];
}

function electronAbi() {
  // node-abi first (what prebuild-install uses); fall back to asking the
  // installed Electron binary directly (works for versions node-abi predates).
  try { return String(require('node-abi').getAbi(electronVersion, 'electron')); } catch { /* unknown to node-abi */ }
  const bin = require('electron');
  const out = spawnSync(bin, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000,
  });
  const abi = String(out.stdout || '').trim();
  if (!/^\d+$/.test(abi)) throw new Error(`could not determine Electron ${electronVersion} ABI: ${out.stderr || out.error}`);
  return abi;
}

// Minimal tar reader: find the first entry ending in '.node' in a tar buffer.
function extractNodeFromTar(tar) {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const dataStart = off + 512;
    if ((type === '0' || type === '\0') && name.endsWith('.node')) {
      return tar.subarray(dataStart, dataStart + size);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error('no .node entry in tarball');
}

async function directDownload({ platform, arch, abi }, dest) {
  const asset = `better-sqlite3-v${sqliteVersion}-electron-v${abi}-${platform}-${arch}.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/${asset}`;
  console.log(`  direct download: ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const tar = zlib.gunzipSync(gz);
  fs.writeFileSync(dest, extractNodeFromTar(tar));
}

// better-sqlite3 >= 13: the package itself carries N-API prebuilds.
function bundledPrebuild({ platform, arch }) {
  const file = path.join(root, 'node_modules', 'better-sqlite3', 'prebuilds', `${platform}-${arch}.node`);
  return fs.existsSync(file) ? file : null;
}

// Prove the host platform's binary actually loads inside the installed
// Electron (its Node ABI), using better-sqlite3's own loader with
// nativeBinding — exactly what desktop/main.js makes server/db.js do.
function loadCheckInElectron(dest) {
  const bin = require('electron');
  const code = `const D = require('better-sqlite3'); const db = new D(':memory:', { nativeBinding: ${JSON.stringify(dest)} });`
    + ` process.stdout.write(String(db.prepare('select sqlite_version() v').get().v)); db.close();`;
  const r = spawnSync(bin, ['-e', code], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000,
  });
  if (r.status !== 0 || !/^\d+\.\d+/.test(String(r.stdout).trim())) {
    throw new Error(`does not load inside Electron ${electronVersion}: ${(r.stderr || r.stdout || String(r.error)).trim().split('\n').slice(-2).join(' | ')}`);
  }
  return String(r.stdout).trim();
}

function viaPrebuildInstall({ platform, arch }, scratch) {
  if (!fs.existsSync(prebuildInstall)) throw new Error('prebuild-install is not installed (better-sqlite3 >= 13 no longer needs it)');
  // A scratch package dir holding only package.json: prebuild-install reads
  // name/version from it and writes build/Release/<name>.node under cwd.
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({
    name: sqlitePkg.name, version: sqlitePkg.version, repository: sqlitePkg.repository,
  }));
  const r = spawnSync(prebuildInstall, [
    '--runtime=electron', `--target=${electronVersion}`, `--platform=${platform}`, `--arch=${arch}`, '--verbose',
  ], { cwd: scratch, encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) throw new Error(`prebuild-install exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  const built = path.join(scratch, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(built)) throw new Error('prebuild-install reported success but no .node was written');
  return built;
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; }
}

function verify(lock) {
  let ok = true;
  for (const t of targets) {
    const rel = `${t.platform}-${t.arch}/better_sqlite3.node`;
    const file = path.join(NATIVE_DIR, rel);
    const entry = lock?.files?.[rel];
    if (!entry) { console.log(`  ${rel}: not in lock`); ok = false; continue; }
    if (!fs.existsSync(file)) { console.log(`  ${rel}: MISSING`); ok = false; continue; }
    const bytes = fs.readFileSync(file);
    const kind = classifyBinary(bytes.subarray(0, 8));
    const sum = crypto.createHash('sha256').update(bytes).digest('hex');
    const good = sum === entry.sha256 && expectedKind(t.platform).includes(kind);
    console.log(`  ${rel}: ${good ? 'ok' : 'MISMATCH'} (${kind}, sha256 ${sum.slice(0, 12)}…)`);
    if (!good) ok = false;
  }
  if (lock && (lock.electron !== electronVersion || lock.betterSqlite3 !== sqliteVersion)) {
    console.log(`  lock was written for electron ${lock.electron} / better-sqlite3 ${lock.betterSqlite3}, installed: ${electronVersion} / ${sqliteVersion}`);
    ok = false;
  }
  return ok;
}

async function main() {
  // Every binary the LaunchAgent's Node could load must be byte-identical
  // before and after this script (both the >=13 prebuilds/ layout and the
  // legacy build/Release one).
  const repoBinaries = [
    path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    ...(() => { try { const d = path.join(root, 'node_modules', 'better-sqlite3', 'prebuilds'); return fs.readdirSync(d).map((f) => path.join(d, f)); } catch { return []; } })(),
  ].filter((f) => fs.existsSync(f));
  const fingerprint = () => repoBinaries.map((f) => `${path.basename(f)}=${sha256(f)}`).join(';');
  const before = fingerprint();
  console.log(`electron ${electronVersion}, better-sqlite3 ${sqliteVersion} → ${NATIVE_DIR}`);

  if (VERIFY_ONLY) {
    const ok = verify(readLock());
    process.exit(ok ? 0 : 1);
  }

  const abi = electronAbi();
  console.log(`electron ABI ${abi}`);
  fs.mkdirSync(NATIVE_DIR, { recursive: true });
  const lock = readLock() || {};
  const sameVersions = lock.electron === electronVersion && lock.betterSqlite3 === sqliteVersion;
  if (lock.electron && !sameVersions) {
    console.log(`lock was for electron ${lock.electron} / better-sqlite3 ${lock.betterSqlite3} — versions changed, rewriting it`);
  }
  const files = { ...(sameVersions ? lock.files : {}) };
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-native-'));

  try {
    for (const t of targets) {
      const rel = `${t.platform}-${t.arch}/better_sqlite3.node`;
      const dest = path.join(NATIVE_DIR, rel);
      if (files[rel] && fs.existsSync(dest) && sha256(dest) === files[rel].sha256) {
        console.log(`${rel}: already present and matches lock — skipped`);
        continue;
      }
      console.log(`${rel}: fetching…`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const scratch = path.join(scratchRoot, `${t.platform}-${t.arch}`);
      const bundled = bundledPrebuild(t);
      if (bundled) {
        console.log(`  bundled N-API prebuild: ${path.relative(root, bundled)}`);
        fs.copyFileSync(bundled, dest);
      } else {
        try {
          fs.copyFileSync(viaPrebuildInstall(t, scratch), dest);
        } catch (err) {
          console.log(`  prebuild-install: ${err.message}`);
          await directDownload({ ...t, abi }, dest);
        }
      }
      const head = Buffer.alloc(8);
      const fd = fs.openSync(dest, 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
      const kind = classifyBinary(head);
      if (!expectedKind(t.platform).includes(kind)) {
        fs.rmSync(dest, { force: true });
        throw new Error(`${rel}: downloaded file is ${kind || 'unrecognised'}, expected ${expectedKind(t.platform).join('/')}`);
      }
      const entry = { sha256: sha256(dest), size: fs.statSync(dest).size, abi, kind, napi: !!bundled };
      // Supply-chain pin: same electron + better-sqlite3 versions as the
      // committed lock but a different binary is a red flag, not an update.
      if (files[rel] && files[rel].sha256 !== entry.sha256 && !args.includes('--update-lock')) {
        fs.rmSync(dest, { force: true });
        throw new Error(`${rel}: sha256 ${entry.sha256.slice(0, 12)}… differs from native.lock.json (${files[rel].sha256.slice(0, 12)}…) for the same versions. If this is intended, re-run with --update-lock.`);
      }
      files[rel] = entry;
      console.log(`  ok (${kind}${entry.napi ? ', N-API' : ''}, ${entry.size} bytes, sha256 ${entry.sha256.slice(0, 12)}…)`);
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  fs.writeFileSync(LOCK, `${JSON.stringify({
    electron: electronVersion, abi, betterSqlite3: sqliteVersion, fetchedAt: new Date().toISOString(), files,
  }, null, 2)}\n`);
  console.log(`lock written: ${LOCK}`);

  const hostRel = `${process.platform}-${process.arch}/better_sqlite3.node`;
  if (files[hostRel] && !args.includes('--no-load-check')) {
    const v = loadCheckInElectron(path.join(NATIVE_DIR, hostRel));
    console.log(`${hostRel}: loads inside Electron ${electronVersion} (SQLite ${v})`);
  }

  const after = fingerprint();
  if (before !== after) {
    console.error('ERROR: node_modules/better-sqlite3 binary changed during the fetch — this must never happen.');
    process.exit(2);
  }
  console.log('node_modules/better-sqlite3 untouched (sha256 unchanged).');
  if (!verify(readLock())) process.exit(1);
}

const isMain = process.argv[1] && /fetch-electron-sqlite\.js$/.test(process.argv[1]);
if (isMain) {
  main().catch((err) => { console.error(`fetch-electron-sqlite: ${err.message}`); process.exit(1); });
}
