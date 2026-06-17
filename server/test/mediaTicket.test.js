// Media-ticket tests (audit M-2/L-1): short-lived, single-recording signed
// grants that replace the long-lived device token in <audio> URLs.
//   · lib: mint + verify — valid, expired, wrong-recording binding, tampered
//   · HTTP: POST .../ticket mints; GET .../audio?ticket= is scoped + expiring
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mediaticket-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_RECORDINGS_DIR = path.join(TMP, 'recordings');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

let baseUrl;
let server;
let db;
let signMediaTicket;
let verifyMediaTicket;
let adminCookie;
let adminId;
let recA; // a recording id the admin can access
let recB; // a second recording id (for wrong-recording scoping)

const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];

const post = async (pathname, cookie) => {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST', headers: cookie ? { Cookie: cookie } : {},
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const getAudio = (pathname) => fetch(`${baseUrl}${pathname}`);

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  ({ signMediaTicket, verifyMediaTicket } = await import('../lib/mediaTicket.js'));

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  assert.equal(login.status, 200);
  adminCookie = cookieOf(login);
  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;

  // Two real recordings on disk so we can exercise resource-scoping end to end.
  fs.mkdirSync(process.env.CRM_RECORDINGS_DIR, { recursive: true });
  const dev = db.prepare(
    `INSERT INTO device_tokens (user_id, device_name, token_hash, paired_at)
     VALUES (?, 'test-phone', 'hash-mediaticket-test', ?)`
  ).run(adminId, new Date().toISOString());
  const mkRec = (name, bytes) => {
    fs.writeFileSync(path.join(process.env.CRM_RECORDINGS_DIR, name), bytes);
    return db.prepare(
      `INSERT INTO recordings (user_id, device_id, file_path, sha256, original_filename, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(adminId, dev.lastInsertRowid, name, `sha-${name}`, name, bytes.length, new Date().toISOString())
      .lastInsertRowid;
  };
  recA = mkRec('rec-a.m4a', Buffer.from('audio-a'));
  recB = mkRec('rec-b.m4a', Buffer.from('audio-b'));
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- lib: mint + verify ----------
test('valid: a freshly minted ticket verifies and carries its claims', () => {
  const ticket = signMediaTicket({ userId: 7, recordingId: 42 });
  const claims = verifyMediaTicket(ticket);
  assert.ok(claims, 'ticket verifies');
  assert.equal(claims.userId, 7);
  assert.equal(claims.recordingId, 42);
  assert.ok(claims.exp > Date.now(), 'expiry is in the future');
});

test('expired: a ticket past its exp is rejected', () => {
  const expired = signMediaTicket({ userId: 7, recordingId: 42, ttlMs: -1000 });
  assert.equal(verifyMediaTicket(expired), null, 'already-expired ticket fails');
  // A still-future ticket also fails once "now" advances past its expiry.
  const shortLived = signMediaTicket({ userId: 7, recordingId: 42, ttlMs: 1000 });
  assert.ok(verifyMediaTicket(shortLived), 'valid right now');
  assert.equal(verifyMediaTicket(shortLived, { now: Date.now() + 5000 }), null, 'fails after TTL');
});

test('wrong-recording: the ticket is bound to the recording it was minted for', () => {
  const claims = verifyMediaTicket(signMediaTicket({ userId: 7, recordingId: 42 }));
  // verify() proves authenticity; the route compares this id to the requested
  // one. A ticket for 42 must never read as 43.
  assert.equal(claims.recordingId, 42);
  assert.notEqual(claims.recordingId, 43);
});

test('tampered: any mutation to payload or signature is rejected', () => {
  const ticket = signMediaTicket({ userId: 7, recordingId: 42 });
  const [body, sig] = ticket.split('.');

  // Flip a signature byte.
  const badSig = `${body}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
  assert.equal(verifyMediaTicket(badSig), null, 'tampered signature fails');

  // Flip a payload byte (signature no longer matches).
  const badBody = `${body.slice(0, -1)}${body.slice(-1) === 'A' ? 'B' : 'A'}.${sig}`;
  assert.equal(verifyMediaTicket(badBody), null, 'tampered payload fails');

  // Forge an extended-expiry payload but keep the original signature.
  const forgedBody = Buffer.from(JSON.stringify({ u: 7, r: 42, e: Date.now() + 9e9 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(verifyMediaTicket(`${forgedBody}.${sig}`), null, 'forged expiry fails');

  // Structurally broken inputs.
  assert.equal(verifyMediaTicket(''), null);
  assert.equal(verifyMediaTicket('no-dot'), null);
  assert.equal(verifyMediaTicket(null), null);
});

// ---------- HTTP: mint endpoint + scoped streaming ----------
test('mint endpoint issues a ticket for an accessible recording', async () => {
  const mint = await post(`/api/review/audio/${recA}/ticket`, adminCookie);
  assert.equal(mint.status, 200);
  assert.ok(mint.data.ticket, 'returns a ticket');
  assert.equal(verifyMediaTicket(mint.data.ticket).recordingId, recA);

  // Unauthenticated mint is refused (the mint endpoint is behind requireAuth).
  const anon = await post(`/api/review/audio/${recA}/ticket`);
  assert.equal(anon.status, 401);
});

test('a ticket streams its recording, but only that one', async () => {
  const { data } = await post(`/api/review/audio/${recA}/ticket`, adminCookie);
  const ticket = encodeURIComponent(data.ticket);

  const ok = await getAudio(`/api/review/audio/${recA}?ticket=${ticket}`);
  assert.equal(ok.status, 200, 'streams the scoped recording with no header/cookie');

  // Same valid ticket, different recording → resource-scoping refuses it.
  const wrong = await getAudio(`/api/review/audio/${recB}?ticket=${ticket}`);
  assert.equal(wrong.status, 403, 'ticket does not unlock a different recording');

  // No ticket, no auth → 401 (ticket never weakened the global gate).
  const none = await getAudio(`/api/review/audio/${recA}`);
  assert.equal(none.status, 401);
});

test('tampered and expired tickets are refused at the audio route', async () => {
  const { data } = await post(`/api/review/audio/${recA}/ticket`, adminCookie);
  const tampered = `${data.ticket.slice(0, -1)}${data.ticket.slice(-1) === 'A' ? 'B' : 'A'}`;
  const bad = await getAudio(`/api/review/audio/${recA}?ticket=${encodeURIComponent(tampered)}`);
  assert.equal(bad.status, 401, 'tampered ticket rejected');

  const expired = signMediaTicket({ userId: adminId, recordingId: recA, ttlMs: -1000 });
  const stale = await getAudio(`/api/review/audio/${recA}?ticket=${encodeURIComponent(expired)}`);
  assert.equal(stale.status, 401, 'expired ticket rejected');
});

test('a media ticket cannot authenticate a non-audio endpoint', async () => {
  // The branch in requireAuth is path-scoped: a ticket must not be usable as a
  // general credential on, say, the leads list.
  const { data } = await post(`/api/review/audio/${recA}/ticket`, adminCookie);
  const res = await getAudio(`/api/leads?ticket=${encodeURIComponent(data.ticket)}`);
  assert.equal(res.status, 401, 'ticket grants nothing outside the audio route');
});
