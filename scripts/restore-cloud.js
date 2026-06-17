#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// restore-cloud.js — Disaster-recovery for the Phase 1B off-site Google Drive
// backup. Lists the encrypted backups in Drive, downloads them, decrypts each
// with the backup passphrase, and restores the DB snapshot + recordings into a
// target directory.
//
// USAGE
//   node scripts/restore-cloud.js list
//       List the encrypted backup files currently in the "CallTrack Backups"
//       Drive folder (newest DB snapshot first).
//
//   node scripts/restore-cloud.js restore --out <dir> [--date YYYY-MM-DD]
//       Download + decrypt everything into <dir>. The newest DB snapshot is
//       restored to <dir>/crm.sqlite (or the snapshot for --date if given);
//       recordings/invoices/exports are restored under <dir>/ preserving their
//       relative paths. To go live, stop the app and copy <dir>/crm.sqlite over
//       your data/crm.sqlite (and recordings/ over data/recordings/).
//
// REQUIREMENTS (env or prompts)
//   This script reads the SAME running install's settings DB to recover the
//   OAuth client id/secret + refresh token (encrypted under data/secret.key).
//   So run it on the original machine (or a copy of data/secret.key + the live
//   settings). You must supply the BACKUP PASSPHRASE — it is never stored.
//     CRM_DATA_DIR           path to the data/ dir (default: ../data next to server)
//     CRM_BACKUP_PASSPHRASE  the encryption passphrase (or you'll be prompted)
//
// EXAMPLES
//   CRM_BACKUP_PASSPHRASE='correct horse battery staple' \
//     node scripts/restore-cloud.js list
//   CRM_BACKUP_PASSPHRASE='...' \
//     node scripts/restore-cloud.js restore --out ./restored
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CRM_DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '..', 'data');

// Import AFTER CRM_DATA_DIR is set — db.js reads it at module load.
const { getSetting } = await import('../server/db.js');
const { openSecret } = await import('../server/lib/secretBox.js');
const { decryptFile } = await import('../server/lib/cryptoBackup.js');
const drive = await import('../server/lib/googleDrive.js');
const { DRIVE_FOLDER_NAME } = await import('../server/lib/cloudBackup.js');

function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

async function prompt(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!silent) return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
  // Hidden input for the passphrase.
  process.stdout.write(question);
  rl.input.on('keypress', () => { readline.clearLine(rl.output, 0); readline.cursorTo(rl.output, 0); rl.output.write(question); });
  return new Promise((res) => rl.question('', (a) => { rl.close(); process.stdout.write('\n'); res(a); }));
}

async function getAccessToken() {
  const cfg = getSetting('cloud_backup', null);
  if (!cfg || !cfg.client_id || !cfg.client_secret_enc || !cfg.refresh_token_enc) {
    fail('Drive is not connected in this install (no OAuth client/refresh token in settings). '
      + 'Run this on the original machine with its data/secret.key.');
  }
  const tok = await drive.refreshAccessToken({
    clientId: cfg.client_id,
    clientSecret: openSecret(cfg.client_secret_enc),
    refreshToken: openSecret(cfg.refresh_token_enc),
  });
  if (!tok.access_token) fail('Could not get an access token from Google.');
  return tok.access_token;
}

async function listBackupFiles(accessToken) {
  const folderId = await drive.ensureFolder(accessToken, DRIVE_FOLDER_NAME);
  const files = await drive.listFiles(accessToken, { folderId });
  return files;
}

// Map a flattened Drive name back to its original relative source path:
// 'recordings__2026__06__abc.m4a.enc' → 'recordings/2026/06/abc.m4a'
function sourcePathFromDriveName(name) {
  return name.replace(/\.enc$/, '').replace(/__/g, '/');
}

// Resolve `rel` under `base` and refuse anything that escapes it. A Drive
// object is named by whoever can write the backup folder, so a hostile name
// like '..__..__etc__cron.d__x' must NOT be able to write outside the restore
// dir (audit M-3).
function safeJoin(base, rel) {
  const baseAbs = path.resolve(base);
  const dest = path.resolve(baseAbs, rel);
  if (dest !== baseAbs && !dest.startsWith(baseAbs + path.sep)) {
    throw new Error(`unsafe path outside restore dir: ${rel}`);
  }
  return dest;
}

async function cmdList() {
  const accessToken = await getAccessToken();
  const files = await listBackupFiles(accessToken);
  if (!files.length) { console.log('No backup files found in Drive.'); return; }
  const snapshots = files.filter((f) => /backups__crm-\d{4}-\d{2}-\d{2}\.sqlite\.enc$/.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  const others = files.filter((f) => !/backups__crm-/.test(f.name));
  console.log(`\nDB snapshots (${snapshots.length}, newest first):`);
  for (const f of snapshots) console.log(`  ${f.name}  (${f.size || '?'} bytes)`);
  console.log(`\nOther files (recordings/invoices/exports): ${others.length}`);
  for (const f of others.slice(0, 20)) console.log(`  ${sourcePathFromDriveName(f.name)}`);
  if (others.length > 20) console.log(`  …and ${others.length - 20} more`);
  console.log('');
}

async function getPassphrase() {
  let pass = process.env.CRM_BACKUP_PASSPHRASE;
  if (!pass) pass = await prompt('Backup passphrase: ', { silent: true });
  if (!pass) fail('A passphrase is required to decrypt the backups.');
  return pass;
}

async function cmdRestore(args) {
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(process.cwd(), 'restored');
  const dateIdx = args.indexOf('--date');
  const wantDate = dateIdx >= 0 ? args[dateIdx + 1] : null;

  const passphrase = await getPassphrase();
  const accessToken = await getAccessToken();
  const files = await listBackupFiles(accessToken);
  if (!files.length) fail('No backup files found in Drive.');

  fs.mkdirSync(outDir, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrestore-'));

  // Pick the DB snapshot to restore.
  const snapshots = files.filter((f) => /backups__crm-\d{4}-\d{2}-\d{2}\.sqlite\.enc$/.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  let snapshot = snapshots[0];
  if (wantDate) snapshot = snapshots.find((f) => f.name.includes(`crm-${wantDate}.sqlite`)) || snapshot;
  if (!snapshot) fail('No DB snapshot found to restore.');

  // Decrypt the chosen DB snapshot → <out>/crm.sqlite.
  console.log(`Restoring DB snapshot ${snapshot.name} → ${path.join(outDir, 'crm.sqlite')}`);
  await downloadAndDecrypt(accessToken, snapshot, tmpRoot, path.join(outDir, 'crm.sqlite'), passphrase);

  // Decrypt all non-DB files (recordings/invoices/exports) preserving structure.
  const others = files.filter((f) => !/backups__crm-/.test(f.name));
  let n = 0;
  for (const f of others) {
    const rel = sourcePathFromDriveName(f.name);
    try {
      const dest = safeJoin(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await downloadAndDecrypt(accessToken, f, tmpRoot, dest, passphrase);
      n++;
    } catch (err) {
      console.error(`  ! failed to restore ${rel}: ${err.message}`);
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n✓ Restored DB + ${n} data files into ${outDir}`);
  console.log('  To go live: stop the app, then copy crm.sqlite over data/crm.sqlite');
  console.log('  and recordings/ over data/recordings/.\n');
}

async function downloadAndDecrypt(accessToken, file, tmpRoot, destAbs, passphrase) {
  // Basename only — the raw Drive name must not steer the temp path either.
  const tmpEnc = path.join(tmpRoot, path.basename(file.name));
  await drive.downloadFile(accessToken, file.id, tmpEnc);
  try {
    decryptFile(tmpEnc, destAbs, passphrase);
  } catch (err) {
    if (/unable to authenticate|Unsupported state/i.test(err.message)) {
      fail('Decryption failed — wrong passphrase (or a corrupt backup file).');
    }
    throw err;
  } finally {
    fs.rmSync(tmpEnc, { force: true });
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'list') await cmdList();
  else if (cmd === 'restore') await cmdRestore(rest);
  else {
    console.log('Usage:\n  node scripts/restore-cloud.js list\n'
      + '  node scripts/restore-cloud.js restore --out <dir> [--date YYYY-MM-DD]');
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  fail(err.stack || err.message);
}
