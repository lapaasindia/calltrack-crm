// MOB-22 — recordings the WebView / Safari cannot play (.amr/.3gp/.ogg/.opus)
// get a transcoded .m4a sibling. Pure helpers, the queue with an INJECTED
// transcode step (no ffmpeg), the audio route (serves the sibling with the
// right Content-Type + Range, original otherwise, 404 when purged), the
// playable flags on review/untagged/lead endpoints, retention purging the
// sibling, and — only when Homebrew ffmpeg is installed — one real round trip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-wave2-transcode-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_ADMIN_PASSWORD = 'admin123';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const HAVE_FFMPEG = fs.existsSync(FFMPEG);

let baseUrl;
let server;
let db;
let tc;
let adminCookie;
let token;
let ownerId;
let leadId;
let recordingsBase;

const api = async (pathname, { method = 'GET', body, cookie, token: tok, raw, headers: extra = {} } = {}) => {
  const headers = { ...extra };
  if (body && !raw) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
};
const login = async (username, password) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
};
const upload = (bytes, fname, fields = {}) => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), fname);
  form.append('filename', fname);
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  return api('/api/sync/recordings', { method: 'POST', token, body: form, raw: true });
};

// A tiny valid PCM WAV (16 kHz mono, 0.2 s sine) — what a fake transcoder
// "produces" and what ffmpeg can turn into a real .3gp/.ogg for the round trip.
function makeWav(seconds = 0.2, rate = 16000) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const uniqueBytes = (label) => Buffer.concat([Buffer.from(`#!fake-${label}-`), crypto.randomBytes(64)]);

before(async () => {
  const { startServer } = await import('../app.js');
  ({ server } = await startServer({ port: 0 }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db = (await import('../db.js')).default;
  tc = await import('../lib/transcode.js');
  ({ RECORDINGS_BASE: recordingsBase } = await import('../routes/sync.js'));
  adminCookie = await login('admin', 'admin123');
  const u = await api('/api/users', { method: 'POST', cookie: adminCookie, body: { username: 'tcowner', full_name: 'TC Owner', password: 'somepass123', role: 'caller' } });
  ownerId = u.data.id;
  const code = await api('/api/devices/pairing-code', { method: 'POST', cookie: adminCookie, body: { user_id: ownerId } });
  const pair = await api('/api/auth/pair', { method: 'POST', body: { code: code.data.code, device_name: 'TC phone', android_id: 'TC_PHONE' } });
  token = pair.data.token;
  const lead = await api('/api/leads', { method: 'POST', cookie: adminCookie, body: { name: 'TC Lead', phone: '9733300001', assigned_to: ownerId } });
  leadId = lead.data.id;
});

after(() => {
  tc._resetTranscodeForTests();
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('helpers: which extensions need transcoding, what the browser can play, content types', () => {
  for (const e of ['amr', '3gp', 'ogg', 'opus', 'AMR']) assert.ok(tc.needsTranscode(e), e);
  for (const e of ['m4a', 'mp3', 'wav', 'aac', '']) assert.ok(!tc.needsTranscode(e), e);
  assert.deepEqual(tc.playableInfo('2026-09/abc.amr', null), { playable: false, playable_ext: 'amr' });
  assert.deepEqual(tc.playableInfo('2026-09/abc.amr', '2026-09/abc.m4a'), { playable: true, playable_ext: 'm4a' });
  assert.deepEqual(tc.playableInfo('2026-09/abc.mp3', null), { playable: true, playable_ext: 'mp3' });
  assert.deepEqual(tc.playableInfo(null, null), { playable: false, playable_ext: null });
  assert.equal(tc.contentTypeFor('x/y.m4a'), 'audio/mp4');
  assert.equal(tc.contentTypeFor('x/y.3gp'), 'audio/3gpp');
  assert.equal(tc.contentTypeFor('x/y.amr'), 'audio/amr');
  assert.equal(tc.contentTypeFor('x/y.bin'), 'application/octet-stream');
});

test('resolveFfmpeg: FFMPEG_BIN wins, then Homebrew/local, then PATH; absent → null and transcoding off', () => {
  const fake = path.join(TMP, 'ffmpeg-fake');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fake, 0o755);
  const savedBin = process.env.FFMPEG_BIN;
  const savedPath = process.env.PATH;
  process.env.FFMPEG_BIN = fake;
  assert.equal(tc.resolveFfmpeg({ fresh: true }), fake);
  delete process.env.FFMPEG_BIN;
  process.env.PATH = TMP; // no ffmpeg there under that name
  const r = tc.resolveFfmpeg({ fresh: true });
  if (HAVE_FFMPEG) assert.equal(r, FFMPEG, 'falls back to the Homebrew path');
  else assert.equal(r, null);
  // PATH lookup: a dir holding an executable named ffmpeg.
  const dir = path.join(TMP, 'pathbin');
  fs.mkdirSync(dir);
  fs.copyFileSync(fake, path.join(dir, 'ffmpeg'));
  fs.chmodSync(path.join(dir, 'ffmpeg'), 0o755);
  process.env.PATH = dir;
  const viaPath = tc.resolveFfmpeg({ fresh: true });
  assert.equal(viaPath, HAVE_FFMPEG ? FFMPEG : path.join(dir, 'ffmpeg'), 'fixed candidates rank above PATH');
  process.env.PATH = savedPath;
  if (savedBin !== undefined) process.env.FFMPEG_BIN = savedBin;
  tc.resolveFfmpeg({ fresh: true });
  // Under node --test the worker is off unless a test enables it.
  tc._setEnabledForTests(null);
  assert.equal(tc.transcodeEnabled(), false);
  assert.equal(tc.enqueueTranscode(1, 'amr'), false, 'nothing queued while disabled');
});

test('upload of an .amr is stored, marked not playable, and queued; the injected transcoder produces the sibling', async () => {
  tc._resetTranscodeForTests();
  tc._setEnabledForTests(true);
  const calls = [];
  tc._setTranscodeFnForTests(async (inAbs, outAbs) => {
    calls.push([inAbs, outAbs]);
    fs.writeFileSync(outAbs, makeWav());
  });
  const bytes = uniqueBytes('amr1');
  const r = await upload(bytes, 'call_9733300001.amr', { last_modified_ms: Date.now() - 60000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'stored');
  assert.equal(r.data.playable, false);
  assert.equal(r.data.transcode_queued, true);
  const id = r.data.recording_id;
  await tc.runTranscodeQueue();
  // The timer-scheduled run may already have drained it; either way:
  const rec = db.prepare('SELECT file_path, playable_path FROM recordings WHERE id = ?').get(id);
  assert.match(rec.file_path, /\.amr$/);
  assert.equal(rec.playable_path, rec.file_path.replace(/\.amr$/, '.m4a'), 'sibling next to the original');
  assert.ok(fs.existsSync(path.join(recordingsBase, rec.playable_path)));
  assert.ok(fs.existsSync(path.join(recordingsBase, rec.file_path)), 'original kept for the AI pipeline');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], path.join(recordingsBase, rec.file_path));
  assert.equal(calls[0][1], path.join(recordingsBase, rec.playable_path));
  // Idempotent: a second pass is a no-op.
  assert.equal(await tc.transcodeRecording(id), 'skipped');
  assert.equal(calls.length, 1);
  assert.equal(tc.transcodeStatus().done, 1);
});

test('a playable upload (.m4a) is never queued; a failed transcode leaves playable_path NULL and no stray file', async () => {
  tc._resetTranscodeForTests();
  tc._setEnabledForTests(true);
  tc._setTranscodeFnForTests(async () => { throw new Error('boom'); });
  const ok = await upload(uniqueBytes('m4a1'), 'fine.m4a');
  assert.equal(ok.data.playable, true);
  assert.equal(ok.data.transcode_queued, false);
  const bad = await upload(uniqueBytes('3gp1'), 'bad.3gp');
  assert.equal(bad.data.transcode_queued, true);
  await tc.runTranscodeQueue();
  const rec = db.prepare('SELECT file_path, playable_path FROM recordings WHERE id = ?').get(bad.data.recording_id);
  assert.equal(rec.playable_path, null);
  assert.ok(!fs.existsSync(path.join(recordingsBase, rec.file_path.replace(/\.3gp$/, '.m4a'))));
  assert.equal(tc.transcodeStatus().failed, 1);
  // After MAX_ATTEMPTS failures the sweep stops re-queueing it.
  await tc.transcodeRecording(bad.data.recording_id);
  await tc.transcodeRecording(bad.data.recording_id);
  assert.equal(tc.enqueueTranscode(bad.data.recording_id), false, 'given up after 3 failures');
  tc._setTranscodeFnForTests(null);
});

test('GET /api/review/audio/:id serves the .m4a sibling as audio/mp4 with Range support, else the original', async () => {
  tc._resetTranscodeForTests();
  tc._setEnabledForTests(true);
  const wav = makeWav();
  tc._setTranscodeFnForTests(async (inAbs, outAbs) => fs.writeFileSync(outAbs, wav));
  const original = uniqueBytes('opus1');
  const up = await upload(original, 'voice.opus');
  const id = up.data.recording_id;
  // Before the transcode: the original bytes, audio/ogg, not playable.
  const before = await api(`/api/review/audio/${id}`, { cookie: adminCookie });
  assert.equal(before.status, 200);
  assert.equal(before.headers.get('content-type'), 'audio/ogg');
  assert.ok(Buffer.from(before.data).equals(original));
  await tc.runTranscodeQueue();
  const full = await api(`/api/review/audio/${id}`, { cookie: adminCookie });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.ok(Buffer.from(full.data).equals(wav), 'the transcoded bytes');
  const part = await api(`/api/review/audio/${id}`, { cookie: adminCookie, headers: { Range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-9/${wav.length}`);
  assert.ok(Buffer.from(part.data).equals(wav.subarray(0, 10)));
  // Media ticket path (the mobile app) hits the same file.
  const ticket = await api(`/api/review/audio/${id}/ticket`, { method: 'POST', token });
  const viaTicket = await fetch(`${baseUrl}/api/review/audio/${id}?ticket=${encodeURIComponent(ticket.data.ticket)}`);
  assert.equal(viaTicket.status, 200);
  assert.equal(viaTicket.headers.get('content-type'), 'audio/mp4');
  // Purged audio → clean 404, not a 500.
  db.prepare("UPDATE recordings SET file_path = '', playable_path = NULL WHERE id = ?").run(id);
  const gone = await api(`/api/review/audio/${id}`, { cookie: adminCookie });
  assert.equal(gone.status, 404);
  assert.match(gone.data.error, /no longer stored/);
  tc._setTranscodeFnForTests(null);
});

test('review/recordings, review/untagged and the lead page expose playable + playable_ext', async () => {
  tc._resetTranscodeForTests();
  tc._setEnabledForTests(true);
  tc._setTranscodeFnForTests(async (inAbs, outAbs) => fs.writeFileSync(outAbs, makeWav()));
  // An unmatched .amr (review queue) — stays unplayable until transcoded.
  const un = await upload(uniqueBytes('amr-unmatched'), 'stray.amr');
  const queue1 = await api('/api/review/recordings', { cookie: adminCookie });
  const row1 = queue1.data.find((r) => r.id === un.data.recording_id);
  assert.ok(row1, 'in the review queue');
  assert.equal(row1.playable, false);
  assert.equal(row1.playable_ext, 'amr');
  assert.ok(!('file_path' in row1) && !('playable_path' in row1), 'paths stay server-side');
  await tc.runTranscodeQueue();
  const queue2 = await api('/api/review/recordings', { cookie: adminCookie });
  const row2 = queue2.data.find((r) => r.id === un.data.recording_id);
  assert.deepEqual([row2.playable, row2.playable_ext], [true, 'm4a']);

  // A matched .3gp on an auto-logged connected call (untagged queue + lead page).
  const ts = Date.now() - 300000;
  const synced = await api('/api/sync/calls', { method: 'POST', token, body: { calls: [{ call_log_ts: ts, phone: '9733300001', direction: 'outgoing', duration_seconds: 42 }] } });
  assert.equal(synced.data.results[0].status, 'attached');
  const callId = db.prepare('SELECT id FROM calls WHERE lead_id = ? AND call_log_ts = ?').get(leadId, ts).id;
  const rec = await upload(uniqueBytes('3gp-matched'), 'matched.3gp', { last_modified_ms: ts });
  db.prepare("UPDATE recordings SET call_id = ?, captured_call_id = NULL, match_status = 'matched' WHERE id = ?").run(callId, rec.data.recording_id);
  const untagged = await api('/api/review/untagged', { cookie: adminCookie });
  const u1 = untagged.data.find((c) => c.id === callId);
  assert.equal(u1.recording_id, rec.data.recording_id);
  assert.deepEqual([u1.recording_playable, u1.recording_playable_ext], [false, '3gp']);
  const lead1 = await api(`/api/leads/${leadId}`, { cookie: adminCookie });
  const c1 = lead1.data.calls.find((c) => c.id === callId);
  assert.deepEqual([c1.recording_playable, c1.recording_playable_ext], [false, '3gp']);
  assert.ok(!('recording_file_path' in c1));
  await tc.runTranscodeQueue();
  const lead2 = await api(`/api/leads/${leadId}`, { cookie: adminCookie });
  const c2 = lead2.data.calls.find((c) => c.id === callId);
  assert.deepEqual([c2.recording_playable, c2.recording_playable_ext], [true, 'm4a']);
  const untagged2 = await api('/api/review/untagged', { cookie: adminCookie });
  assert.deepEqual([untagged2.data.find((c) => c.id === callId).recording_playable], [true]);
  // Calls without a recording carry null flags.
  const noRec = untagged2.data.find((c) => !c.recording_id);
  if (noRec) assert.equal(noRec.recording_playable, null);
  tc._setTranscodeFnForTests(null);
});

test('sweepUntranscoded queues stored-but-untranscoded .amr/.3gp/.ogg/.opus only; retention purges the sibling too', async () => {
  tc._resetTranscodeForTests();
  tc._setEnabledForTests(true);
  tc._setTranscodeFnForTests(async (inAbs, outAbs) => fs.writeFileSync(outAbs, makeWav()));
  const pending = db.prepare("SELECT COUNT(*) AS n FROM recordings WHERE playable_path IS NULL AND file_path IS NOT NULL AND (file_path LIKE '%.amr' OR file_path LIKE '%.3gp' OR file_path LIKE '%.ogg' OR file_path LIKE '%.opus')").get().n;
  const n = tc.sweepUntranscoded();
  assert.equal(n, pending);
  await tc.runTranscodeQueue();
  assert.equal(tc.sweepUntranscoded(), 0, 'nothing left after the pass');
  // Retention: an old, AI-done recording loses both files and both columns.
  const rec = db.prepare('SELECT id, file_path, playable_path FROM recordings WHERE playable_path IS NOT NULL LIMIT 1').get();
  db.prepare("UPDATE recordings SET created_at = '2020-01-01T00:00:00.000Z', ai_status = 'done' WHERE id = ?").run(rec.id);
  const { purgeOnce } = await import('../lib/recordingsRetention.js');
  assert.ok(fs.existsSync(path.join(recordingsBase, rec.playable_path)));
  purgeOnce();
  assert.ok(!fs.existsSync(path.join(recordingsBase, rec.file_path)), 'original purged');
  assert.ok(!fs.existsSync(path.join(recordingsBase, rec.playable_path)), 'sibling purged');
  // file_path is NOT NULL (STRICT): a purged row is marked with '' — the old
  // `SET file_path = NULL` threw silently inside retention's catch, so rows
  // were never marked and the audio route 500'd on the missing file.
  assert.deepEqual(db.prepare('SELECT file_path, playable_path FROM recordings WHERE id = ?').get(rec.id), { file_path: '', playable_path: null });
  assert.equal((await api(`/api/review/audio/${rec.id}`, { cookie: adminCookie })).status, 404);
  assert.equal(tc.sweepUntranscoded(), 0, 'a purged row is never re-queued');
  tc._setTranscodeFnForTests(null);
});

test('real ffmpeg round trip (only when /opt/homebrew/bin/ffmpeg exists): .3gp/.ogg → .m4a', { skip: !HAVE_FFMPEG && 'ffmpeg not installed' }, async () => {
  tc._resetTranscodeForTests();
  tc._setEnabledForTests(true);
  tc._setTranscodeFnForTests(null); // the real ffmpeg step
  const wavPath = path.join(TMP, 'tone.wav');
  fs.writeFileSync(wavPath, makeWav(0.5));
  // Prefer a .3gp (AAC in 3GPP), fall back to Ogg/Opus — both unplayable in Safari.
  let srcPath = path.join(TMP, 'tone.3gp');
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', wavPath, '-c:a', 'aac', '-b:a', '24k', srcPath], { timeout: 30000 });
  } catch {
    srcPath = path.join(TMP, 'tone.ogg');
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', wavPath, '-c:a', 'libopus', srcPath], { timeout: 30000 });
  }
  const bytes = fs.readFileSync(srcPath);
  const up = await upload(bytes, path.basename(srcPath), { last_modified_ms: Date.now() - 1000 });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.transcode_queued, true);
  await tc.runTranscodeQueue();
  const rec = db.prepare('SELECT file_path, playable_path FROM recordings WHERE id = ?').get(up.data.recording_id);
  assert.ok(rec.playable_path && rec.playable_path.endsWith('.m4a'), `transcoded: ${JSON.stringify(rec)}`);
  const out = fs.readFileSync(path.join(recordingsBase, rec.playable_path));
  assert.ok(out.length > 200);
  assert.equal(out.subarray(4, 8).toString('latin1'), 'ftyp', 'an ISO-BMFF (MP4/M4A) file');
  const served = await api(`/api/review/audio/${up.data.recording_id}`, { cookie: adminCookie });
  assert.equal(served.headers.get('content-type'), 'audio/mp4');
  assert.equal(Buffer.from(served.data).length, out.length);
});
