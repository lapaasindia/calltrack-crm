// Local-side encryption for off-site backups: every file is AES-256-GCM
// encrypted with a key derived from the user's passphrase (scrypt KDF) BEFORE
// it leaves the office, so Google only ever stores ciphertext. Pure +
// dependency-free (node:crypto only) so it is fully unit-testable.
//
// On-disk format of an encrypted file:
//   [ MAGIC(8) | version(1) | salt(16) | iv(12) | tag(16) | ciphertext... ]
// The salt is per-file (random) so two files with the same passphrase still get
// independent keys; the GCM tag authenticates the ciphertext (and detects both
// tampering AND a wrong passphrase — decryption throws).
import crypto from 'node:crypto';
import fs from 'node:fs';

const MAGIC = Buffer.from('CTBKP\x00\x01\x00'); // 8 bytes, "CallTrack BacKuP"
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN; // 53

// scrypt is intentionally slow; these are the Node defaults except N is raised
// for a passphrase (not a high-entropy key). 32 bytes = AES-256 key.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Passphrase required');
  }
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, 32, SCRYPT_PARAMS);
}

// Encrypt srcAbs → destAbs. Reads the whole file into memory: backup files here
// are DB snapshots (tens of MB) and individual recordings (a few MB), so this is
// fine and keeps the GCM tag handling trivial.
export function encryptFile(srcAbs, destAbs, passphrase) {
  const plaintext = fs.readFileSync(srcAbs);
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, tag]);
  fs.writeFileSync(destAbs, Buffer.concat([header, ciphertext]));
  return { bytes: header.length + ciphertext.length };
}

// Decrypt srcAbs → destAbs. Throws on a wrong passphrase / corrupt file (the
// GCM auth check fails) — callers should surface that as "wrong passphrase".
export function decryptFile(srcAbs, destAbs, passphrase) {
  const blob = fs.readFileSync(srcAbs);
  if (blob.length < HEADER_LEN) throw new Error('Not a CallTrack backup file (too small)');
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a CallTrack backup file (bad magic)');
  }
  let off = MAGIC.length;
  const version = blob[off]; off += 1;
  if (version !== VERSION) throw new Error(`Unsupported backup version ${version}`);
  const salt = blob.subarray(off, off + SALT_LEN); off += SALT_LEN;
  const iv = blob.subarray(off, off + IV_LEN); off += IV_LEN;
  const tag = blob.subarray(off, off + TAG_LEN); off += TAG_LEN;
  const ciphertext = blob.subarray(off);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // .final() throws "Unsupported state or unable to authenticate data" on a
  // wrong passphrase — that IS our wrong-passphrase signal.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  fs.writeFileSync(destAbs, plaintext);
  return { bytes: plaintext.length };
}

// Lets us verify a passphrase WITHOUT ever storing it: we persist only the salt
// + this verifier. On a later "set/verify passphrase" we re-derive with the
// stored salt and compare in constant time. (HMAC-SHA256 of a fixed label under
// the scrypt key — distinct from any encryption key material.)
export function deriveVerifier(passphrase, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const key = deriveKey(passphrase, salt);
  return crypto.createHmac('sha256', key).update('calltrack-backup-verifier').digest('hex');
}

export function newSaltHex() {
  return crypto.randomBytes(SALT_LEN).toString('hex');
}

export function verifierMatches(passphrase, saltHex, expectedVerifierHex) {
  const got = Buffer.from(deriveVerifier(passphrase, saltHex), 'hex');
  const want = Buffer.from(String(expectedVerifierHex || ''), 'hex');
  if (got.length !== want.length || got.length === 0) return false;
  return crypto.timingSafeEqual(got, want);
}
