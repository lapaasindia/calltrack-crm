// Cross-building the Windows installer from macOS: electron-builder cannot
// compile native modules for Windows, and silently packages whatever binary
// sits in node_modules (a Mach-O — crashes on Windows). This fetches the real
// win32-x64 Electron prebuild of better-sqlite3 first. Pair with
// `electron-builder --win -c.npmRebuild=false`.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const dep = path.resolve('node_modules', 'better-sqlite3');

execSync(
  `npx prebuild-install --runtime=electron --target=${electronVersion} --platform=win32 --arch=x64`,
  { cwd: dep, stdio: 'inherit' }
);

const out = execSync(`file "${path.join(dep, 'build', 'Release', 'better_sqlite3.node')}"`).toString();
if (!out.includes('PE32+')) {
  console.error('ERROR: better_sqlite3.node is not a Windows DLL after fetch:\n' + out);
  process.exit(1);
}
console.log('better-sqlite3: Windows Electron prebuild in place.');
