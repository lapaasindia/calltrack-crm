// Encrypts small secrets (the Google OAuth refresh token + client secret) AT
// REST in the settings table, keyed by the app's persistent session secret
// (data/secret.key — already generated in app.js). This is NOT the off-site
// backup passphrase: it just stops the refresh token sitting in plaintext in
// crm.sqlite. node:crypto only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';

// Derive a stable 32-byte key from data/secret.key. The file holds 64 hex chars
// (32 bytes) written by createApp(); we hash it so we never depend on its exact
// length/encoding.
function boxKey() {
  const secretFile = path.join(DATA_DIR, 'secret.key');
  let secret;
  if (fs.existsSync(secretFile)) {
    secret = fs.readFileSync(secretFile, 'utf8');
  } else {
    // Tests / tools may touch settings before createApp() ran. Create it the
    // same way app.js does so the key is stable across the process lifetime.
    secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
  return crypto.createHash('sha256').update(`cloud-backup-secretbox:${secret}`).digest();
}

// Returns a compact "iv:tag:ciphertext" hex string.
export function sealSecret(plaintext) {
  if (plaintext == null || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', boxKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function openSecret(sealed) {
  if (!sealed) return '';
  const [ivHex, tagHex, ctHex] = String(sealed).split(':');
  if (!ivHex || !tagHex || !ctHex) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', boxKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}
