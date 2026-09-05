// Where the Electron-ABI better-sqlite3 binary lives (DESK-4). The repo's
// node_modules copy is built for the Node ABI (it is what the LaunchAgent
// server loads) and must NEVER be rewritten for Electron; instead
// scripts/fetch-electron-sqlite.js downloads the Electron prebuild into
// build/native/<platform>-<arch>/ and electron-builder ships that folder as
// Resources/native/. server/db.js honours CRM_SQLITE_NATIVE_BINDING.
import path from 'node:path';

export const NATIVE_FILE = 'better_sqlite3.node';

export function nativeDirName({ platform = process.platform, arch = process.arch } = {}) {
  return `${platform}-${arch}`;
}

export function nativeBindingPath({ isPackaged, resourcesPath, root, platform, arch } = {}) {
  const dir = nativeDirName({ platform, arch });
  if (isPackaged) return path.join(resourcesPath, 'native', dir, NATIVE_FILE);
  return path.join(root, 'build', 'native', dir, NATIVE_FILE);
}
