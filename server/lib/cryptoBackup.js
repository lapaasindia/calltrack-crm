// Local-side encryption for off-site backups: every file is AES-256-GCM
// encrypted with a key derived from the user's passphrase (scrypt KDF) BEFORE
// it leaves the office, so Google only ever stores ciphertext. Pure +
// dependency-free (node:crypto only) so it is fully unit-testable.
//
// On-disk format of an encrypted file (UNCHANGED — existing backups and
// scripts/restore-cloud.js keep working):
//   [ MAGIC(8) | version(1) | salt(16) | iv(12) | tag(16) | ciphertext... ]
// The salt is per-file (random) so two files with the same passphrase still get
// independent keys; the GCM tag authenticates the ciphertext (and detects both
// tampering AND a wrong passphrase — decryption throws).
//
// Two API flavours:
//   * encryptFile / decryptFile   — synchronous, whole file in memory. Kept for
//                                   the restore script and small one-offs.
//   * encryptFileAsync /          — streaming + async scrypt (audit SCALE-4):
//     decryptFileAsync              the cloud backup runs these so a 10k-file
//                                   upload never blocks the event loop (scrypt
//                                   alone was 24 ms per file, on the loop) and
//                                   a 1 GB snapshot never sits in RAM. The tag
//                                   is patched into the header at the end, so
//                                   the format stays byte-identical.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('CTBKP\x00\x01\x00'); // 8 bytes, "CallTrack BacKuP"
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN; // 53
const TAG_OFFSET = MAGIC.length + 1 + SALT_LEN + IV_LEN; // 37

// scrypt is intentionally slow; these are the Node defaults except N is raised
// for a passphrase (not a high-entropy key). 32 bytes = AES-256 key.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Passphrase required');
  }
}

function deriveKey(passphrase, salt) {
  assertPassphrase(passphrase);
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, 32, SCRYPT_PARAMS);
}

function deriveKeyAsync(passphrase, salt) {
  assertPassphrase(passphrase);
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(passphrase, 'utf8'), salt, 32, SCRYPT_PARAMS, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

function parseHeader(head) {
  if (head.length < HEADER_LEN) throw new Error('Not a CallTrack backup file (too small)');
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a CallTrack backup file (bad magic)');
  }
  let off = MAGIC.length;
  const version = head[off]; off += 1;
  if (version !== VERSION) throw new Error(`Unsupported backup version ${version}`);
  const salt = head.subarray(off, off + SALT_LEN); off += SALT_LEN;
  const iv = head.subarray(off, off + IV_LEN); off += IV_LEN;
  const tag = head.subarray(off, off + TAG_LEN);
  return { salt, iv, tag };
}

// Encrypt srcAbs → destAbs (sync, whole file in memory).
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

// Decrypt srcAbs → destAbs (sync). Throws on a wrong passphrase / corrupt file
// (the GCM auth check fails) — callers should surface that as "wrong passphrase".
export function decryptFile(srcAbs, destAbs, passphrase) {
  const blob = fs.readFileSync(srcAbs);
  const { salt, iv, tag } = parseHeader(blob);
  const ciphertext = blob.subarray(HEADER_LEN);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // .final() throws "Unsupported state or unable to authenticate data" on a
  // wrong passphrase — that IS our wrong-passphrase signal.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  fs.writeFileSync(destAbs, plaintext);
  return { bytes: plaintext.length };
}

// Streaming encrypt: header with a zero tag placeholder → ciphertext streamed
// through the cipher → tag patched in at TAG_OFFSET. Same bytes on disk as
// encryptFile. Resolves { bytes }.
export async function encryptFileAsync(srcAbs, destAbs, passphrase) {
  assertPassphrase(passphrase);
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await deriveKeyAsync(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, Buffer.alloc(TAG_LEN)]);
  await fsp.writeFile(destAbs, header);
  try {
    await pipeline(
      fs.createReadStream(srcAbs),
      cipher,
      fs.createWriteStream(destAbs, { flags: 'r+', start: HEADER_LEN }),
    );
    const tag = cipher.getAuthTag();
    const fd = await fsp.open(destAbs, 'r+');
    try { await fd.write(tag, 0, TAG_LEN, TAG_OFFSET); } finally { await fd.close(); }
    return { bytes: (await fsp.stat(destAbs)).size };
  } catch (err) {
    await fsp.rm(destAbs, { force: true }).catch(() => {});
    throw err;
  }
}

// Streaming decrypt. Rejects on a wrong passphrase / corrupt file (GCM auth
// failure surfaces from the decipher's final step) and removes the partial
// output. Resolves { bytes }.
export async function decryptFileAsync(srcAbs, destAbs, passphrase) {
  assertPassphrase(passphrase);
  const fd = await fsp.open(srcAbs, 'r');
  let head;
  try {
    const buf = Buffer.alloc(HEADER_LEN);
    const { bytesRead } = await fd.read(buf, 0, HEADER_LEN, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
  const { salt, iv, tag } = parseHeader(head);
  const key = await deriveKeyAsync(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(srcAbs, { start: HEADER_LEN }),
      decipher,
      fs.createWriteStream(destAbs),
    );
    return { bytes: (await fsp.stat(destAbs)).size };
  } catch (err) {
    await fsp.rm(destAbs, { force: true }).catch(() => {});
    throw err;
  }
}

// Streaming SHA-256 of a file (hex). Never loads the file into memory.
export async function sha256FileAsync(abs) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(abs), hash);
  return hash.digest('hex');
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
