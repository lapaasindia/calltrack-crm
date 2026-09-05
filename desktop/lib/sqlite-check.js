// Tiny integrity probe run in a SEPARATE process (utilityProcess.fork from the
// Electron main process, or plain `node` from tests) so better-sqlite3 is never
// loaded into the main process (DESK-4 / DESK-15).
//
//   node desktop/lib/sqlite-check.js <file> [--binding <better_sqlite3.node>]
//
// Prints one JSON line: { quick_check, users, user_version } or { error } or
// { skipped, reason } (binding missing / ABI mismatch — the caller then falls
// back to header-only validation). Opened read-only; a WAL sidecar next to the
// file is read but never checkpointed.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

function emit(obj) {
  const line = JSON.stringify(obj);
  if (process.parentPort && typeof process.parentPort.postMessage === 'function') {
    try { process.parentPort.postMessage(obj); } catch { /* fall through to stdout */ }
  }
  process.stdout.write(`${line}\n`);
}

export function checkDatabase(file, { nativeBinding } = {}) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    return { skipped: true, reason: `better-sqlite3 not loadable: ${err.message}` };
  }
  let db;
  try {
    const opts = { readonly: true, fileMustExist: true };
    if (nativeBinding && fs.existsSync(nativeBinding)) opts.nativeBinding = nativeBinding;
    db = new Database(file, opts);
  } catch (err) {
    // NODE_MODULE_VERSION / "not a valid Mach-O" = wrong ABI for this runtime,
    // not a bad backup: report as skipped so the caller doesn't blame the file.
    if (/NODE_MODULE_VERSION|not a valid|Mach-O|not a Win32|bindings file|dlopen/i.test(err.message)) {
      return { skipped: true, reason: err.message.split('\n')[0] };
    }
    return { error: err.message.split('\n')[0] };
  }
  try {
    const qc = db.pragma('quick_check', { simple: true });
    const userVersion = db.pragma('user_version', { simple: true });
    let users = 0;
    try {
      users = db.prepare('SELECT count(*) AS n FROM users').get().n;
    } catch (err) {
      return { quick_check: qc, users: 0, user_version: userVersion, users_error: err.message };
    }
    return { quick_check: qc, users, user_version: userVersion };
  } catch (err) {
    return { error: err.message.split('\n')[0] };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

const isMain = !!process.argv[1] && /sqlite-check\.js$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const bIdx = args.indexOf('--binding');
  const nativeBinding = bIdx >= 0 ? args[bIdx + 1] : process.env.CRM_SQLITE_NATIVE_BINDING;
  if (!file) {
    emit({ error: 'usage: sqlite-check.js <file> [--binding <path>]' });
    process.exit(2);
  }
  emit(checkDatabase(file, { nativeBinding }));
  // Give parentPort a tick to flush before exiting.
  setTimeout(() => process.exit(0), 20);
}
