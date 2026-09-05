#!/usr/bin/env node
// Regenerates THIRD-PARTY-NOTICES.md from the installed production dependency
// trees (root = server + desktop shell; client = the web bundle) plus the
// non-npm runtimes the installers ship. Run after any dependency change:
//
//   node scripts/third-party-notices.mjs            # writes THIRD-PARTY-NOTICES.md
//   node scripts/third-party-notices.mjs --check    # exit 1 if the file is stale (CI)
//
// License text is read from each package's `license` field (SPDX). Packages
// with no usable field are listed as UNKNOWN so a human looks at them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
const check = process.argv.includes('--check');

function prodTree(prefix) {
  const r = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable', '--prefix', prefix], {
    encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024,
  });
  // npm ls exits non-zero on "invalid"/"extraneous" problems but still prints the tree.
  return (r.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l && l !== prefix && l.includes('node_modules'));
}
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ') || 'UNKNOWN';
  return 'UNKNOWN';
}
function collect(prefix) {
  const seen = new Map();
  for (const dir of prodTree(prefix)) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    if (!pkg.name) continue;
    // Platform-specific optional binaries (sharp's libvips builds, esbuild
    // platform packages …) differ per OS/CPU, which would make this file differ
    // between a Mac and the Linux CI runner. They are the same code under the
    // same license as their parent package, which IS listed.
    if (pkg.os || pkg.cpu) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    seen.set(key, { name: pkg.name, version: pkg.version, license: licenseOf(pkg), url: pkg.homepage || repo || '' });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
}
function table(rows) {
  const byLicense = new Map();
  for (const r of rows) {
    if (!byLicense.has(r.license)) byLicense.set(r.license, []);
    byLicense.get(r.license).push(r);
  }
  const order = [...byLicense.keys()].sort((a, b) => byLicense.get(b).length - byLicense.get(a).length || a.localeCompare(b));
  let md = `| License | Packages |\n|---|---|\n`;
  for (const lic of order) md += `| ${lic} | ${byLicense.get(lic).length} |\n`;
  md += '\n| Package | Version | License |\n|---|---|---|\n';
  for (const r of rows) md += `| ${r.url ? `[${r.name}](${cleanUrl(r.url)})` : r.name} | ${r.version} | ${r.license} |\n`;
  return md;
}
const cleanUrl = (u) => u.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const rootRows = collect(ROOT);
const clientDir = path.join(ROOT, 'client');
const clientRows = fs.existsSync(path.join(clientDir, 'node_modules')) ? collect(clientDir) : [];
const copyleft = rootRows.concat(clientRows).filter((r) => /GPL|AGPL|LGPL|MPL|EPL|CDDL/i.test(r.license) && !/LGPL-2\.1-or-later WITH/.test(r.license));
const unknown = rootRows.concat(clientRows).filter((r) => r.license === 'UNKNOWN');
const versionOf = (name) => rootRows.find((r) => r.name === name)?.version || 'n/a';

const md = `# Third-party notices

CallTrack CRM is released under the [MIT License](LICENSE). The installers and
the running server include the open-source components listed here, each under
its own license. This file is **generated** by \`scripts/third-party-notices.mjs\`
from the installed production dependency trees — regenerate it after any
dependency change (\`node scripts/third-party-notices.mjs\`; CI runs \`--check\`).
Platform-specific optional binaries (per-OS builds of \`sharp\`/libvips, etc.)
are folded into their parent package.

## Read this first — copyleft components

${copyleft.length ? copyleft.map((r) => `- **${r.name}@${r.version}** — ${r.license}${r.url ? ` (${cleanUrl(r.url)})` : ''}`).join('\n') : '- none detected'}

- **libsignal (\`libsignal\` via \`baileys\`) is GPL-3.0.** It is the Signal-protocol
  implementation the bundled WhatsApp engine (\`server/lib/whatsapp.js\`) loads
  in-process, and it ships inside every desktop installer. CallTrack itself is
  open source, so the GPL's source-availability condition is met by this public
  repository: anyone who receives an installer can obtain the complete
  corresponding source at https://github.com/lapaasindia/calltrack-crm. **If you
  fork CallTrack into a closed-source product, you must either keep your
  distribution GPL-compatible or remove the WhatsApp engine** (\`baileys\` and its
  \`libsignal\` dependency). The engine is opt-in at runtime (an admin has to click
  *Connect*), but the code is distributed regardless. See
  [ADR 0004](docs/adr/0004-whatsapp-bundled.md).
- \`libsignal\` is installed from a git commit (no npm tarball / integrity hash);
  see the ADR for the reproducibility trade-off.

${unknown.length ? `## Packages with no machine-readable license field (check by hand)\n\n${unknown.map((r) => `- ${r.name}@${r.version}${r.url ? ` — ${cleanUrl(r.url)}` : ''}`).join('\n')}\n\n` : ''}## Runtimes and platform components (not in the npm trees)

| Component | Where | License |
|---|---|---|
| Node.js | server runtime (\`npm start\`, LaunchAgent) | MIT (with third-party notices in the Node.js distribution) |
| Electron ${versionOf('electron') === 'n/a' ? rootPkg.devDependencies?.electron || '' : versionOf('electron')} | desktop shell (Mac/Windows installers) | MIT; bundles Chromium (BSD-3-Clause and others) and Node.js |
| SQLite (via \`better-sqlite3\`) | database engine | Public domain |
| Capacitor Android runtime, \`@capacitor/*\` plugins | Android app | MIT |
| Google ML Kit barcode scanning (via \`@capacitor-mlkit/barcode-scanning\`) | Android app QR pairing | Google APIs Terms of Service (proprietary binaries downloaded by Gradle) |
| AndroidX, Kotlin stdlib, WorkManager | Android app | Apache-2.0 |
| whisper.cpp / Ollama models | optional local AI worker — installed separately by the operator, never bundled | MIT (whisper.cpp); model licenses vary |

## Server + desktop shell — production dependencies (\`npm ls --omit=dev --all\`)

${rootRows.length} packages.

${table(rootRows)}
## Web client bundle — production dependencies (\`npm --prefix client ls --omit=dev --all\`)

${clientRows.length ? `${clientRows.length} packages (bundled by Vite into \`client/dist\`; devDependencies such as Vite itself are not shipped).\n\n${table(clientRows)}` : '_client/node_modules not installed when this file was generated — run `npm --prefix client ci` and regenerate._\n'}
`;

if (check) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== md) {
    console.error('THIRD-PARTY-NOTICES.md is stale — run: node scripts/third-party-notices.mjs');
    process.exit(1);
  }
  console.log('THIRD-PARTY-NOTICES.md is up to date');
} else {
  fs.writeFileSync(OUT, md);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${rootRows.length} server/desktop + ${clientRows.length} client packages; ${copyleft.length} copyleft; ${unknown.length} unknown`);
}
