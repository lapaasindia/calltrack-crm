// Short-lived, resource-scoped signed tickets for streaming a recording's audio
// (audit M-2/L-1). Replaces putting the long-lived device bearer token in the
// <audio> URL, where it would persist in WebView history. A ticket is an HMAC
// over {userId, recordingId, exp}; it grants read-only access to ONE recording
// and dies after TTL_MS. node:crypto only — same secret root as secretBox.js.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';

const TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to start playback.

// Derive a stable 32-byte HMAC key from data/secret.key (the app's persistent
// session secret), namespaced so it never collides with secretBox's AEAD key or
// the session signer. Mirrors secretBox.boxKey() so a restored key with loose
// perms is re-locked to 0o600 and a missing key is created the same way app.js
// would (lets tests/tools mint tickets before createApp() ran).
function ticketKey() {
  const secretFile = path.join(DATA_DIR, 'secret.key');
  let secret;
  if (fs.existsSync(secretFile)) {
    try { fs.chmodSync(secretFile, 0o600); } catch { /* best effort */ }
    secret = fs.readFileSync(secretFile, 'utf8');
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
  return crypto.createHash('sha256').update(`media-ticket:${secret}`).digest();
}

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) =>
  Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const sign = (body) => b64url(crypto.createHmac('sha256', ticketKey()).update(body).digest());

// Mint a ticket "<payload>.<sig>" scoped to one recording for one user.
// `ttlMs`/`now` are injectable so tests can mint already-expired tickets.
export function signMediaTicket({ userId, recordingId, ttlMs = TTL_MS, now = Date.now() }) {
  const payload = { u: Number(userId), r: Number(recordingId), e: now + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body)}`;
}

// Returns { userId, recordingId, exp } for a valid, unexpired ticket, else null.
// The caller MUST still check recordingId matches the requested resource — this
// verifies authenticity + expiry, not authorization to a particular file.
export function verifyMediaTicket(ticket, { now = Date.now() } = {}) {
  if (typeof ticket !== 'string') return null;
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot === ticket.length - 1) return null;
  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);

  // Constant-time signature compare (timingSafeEqual needs equal lengths).
  const got = Buffer.from(sig);
  const want = Buffer.from(sign(body));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;

  let payload;
  try { payload = JSON.parse(fromB64url(body).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.e !== 'number' || typeof payload.u !== 'number'
      || typeof payload.r !== 'number') return null;
  if (payload.e < now) return null; // expired

  return { userId: payload.u, recordingId: payload.r, exp: payload.e };
}

export { TTL_MS };
