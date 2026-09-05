// Browser-playable recordings (audit MOB-22). Many Indian OEM dialers record
// calls as .amr / .3gp (and some as Ogg/Opus); Chromium (Android WebView,
// Chrome) has no AMR decoder and Safari plays neither AMR nor Ogg, so those
// uploads matched fine, showed a player, and never played. After a recording
// is stored, routes/sync.js enqueues it here; a serial background worker runs
//   ffmpeg -y -i <in> -vn -c:a aac -b:a 64k <sha>.m4a
// next to the original, records the sibling in recordings.playable_path
// (migration 018) and leaves the original untouched for the AI pipeline.
// GET /api/review/audio/:id serves the sibling when present.
//
// Degrades gracefully: with no ffmpeg on the box nothing is queued and the
// absence is logged once. Under `node --test` the worker is off unless a test
// enables it, and the transcode step is injectable so unit tests never spawn
// a process. Tracked as a job so graceful shutdown waits for the file in
// progress (jobs.js).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import db from '../db.js';
import { runJob, isShuttingDown } from './jobs.js';
import { log } from './logger.js';
// Cycle-safe: routes/sync.js imports enqueueTranscode from here and this
// module only reads RECORDINGS_BASE inside functions, never at load time.
import { RECORDINGS_BASE } from '../routes/sync.js';

const execFileP = promisify(execFile);
const tlog = log.child({ mod: 'transcode' });

// Extensions the WebView / Safari cannot decode → transcode to .m4a.
export const TRANSCODE_EXT = new Set(['amr', '3gp', 'ogg', 'opus']);
// What every supported browser plays natively (Chrome, Android WebView,
// Safari/iOS). Raw AAC (ADTS) is decodable by all three, so it is not
// transcoded.
export const BROWSER_PLAYABLE_EXT = new Set(['m4a', 'mp3', 'wav', 'aac', 'mp4']);

export const CONTENT_TYPES = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  amr: 'audio/amr',
  '3gp': 'audio/3gpp',
};

export const extOf = (p) => (p ? String(p).split('.').pop().toLowerCase() : '');
export const contentTypeFor = (p) => CONTENT_TYPES[extOf(p)] || 'application/octet-stream';
export const needsTranscode = (ext) => TRANSCODE_EXT.has(String(ext || '').toLowerCase());

// What the audio endpoint will serve for this recording, and whether a
// browser can play it. Used by the review/untagged/lead endpoints so the
// client can show "Download to listen" instead of a dead player.
export function playableInfo(filePath, playablePath) {
  const served = playablePath || filePath;
  const ext = extOf(served);
  return {
    playable: !!served && BROWSER_PLAYABLE_EXT.has(ext),
    playable_ext: served ? ext : null,
  };
}

// ── ffmpeg resolution ───────────────────────────────────────────────────────
// Under launchd PATH is /usr/bin:/bin:/usr/sbin:/sbin, so the Homebrew binary
// is invisible unless we look for it explicitly.
const FIXED_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
let resolved; // undefined = not yet, null = absent, string = path

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function resolveFfmpeg({ fresh = false } = {}) {
  if (resolved !== undefined && !fresh) return resolved;
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
  const candidates = [];
  if (process.env.FFMPEG_BIN) candidates.push(process.env.FFMPEG_BIN);
  candidates.push(...FIXED_CANDIDATES);
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) for (const n of names) candidates.push(path.join(dir, n));
  }
  resolved = candidates.find(isExecutable) || null;
  return resolved;
}

// ── worker state ────────────────────────────────────────────────────────────
const underTest = !!process.env.NODE_TEST_CONTEXT;
let enabledOverride = null; // tests: true/false; null = auto
let transcodeFn = null;     // tests: injectable (inAbs, outAbs) => Promise
let warnedAbsent = false;
const queue = [];
const queued = new Set();
const attempts = new Map(); // recording id -> failures this process
const MAX_ATTEMPTS = 3;
let running = false;
let scheduled = null;
let stats = { done: 0, failed: 0, skipped: 0 };

export function transcodeEnabled() {
  if (enabledOverride !== null) return enabledOverride;
  if (underTest) return false;
  if (process.env.CRM_TRANSCODE === 'off') return false;
  const bin = resolveFfmpeg();
  if (!bin && !warnedAbsent) {
    warnedAbsent = true;
    tlog.warn('ffmpeg not found (FFMPEG_BIN, /opt/homebrew/bin, /usr/local/bin, PATH) — .amr/.3gp/.ogg/.opus recordings will not be transcoded for playback');
  }
  return !!bin;
}

async function defaultTranscode(inAbs, outAbs) {
  const bin = resolveFfmpeg();
  if (!bin) throw new Error('ffmpeg not available');
  await execFileP(bin, ['-y', '-loglevel', 'error', '-i', inAbs, '-vn', '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart', outAbs], { timeout: 120000, maxBuffer: 1024 * 1024 });
}

// Transcode ONE recording now. Returns 'done' | 'skipped' | 'not_needed' |
// 'missing' | 'failed'. Safe to call directly (tests, ops).
export async function transcodeRecording(recordingId) {
  const rec = db.prepare('SELECT id, file_path, playable_path FROM recordings WHERE id = ?').get(recordingId);
  if (!rec || !rec.file_path) return 'skipped';
  if (rec.playable_path) return 'skipped';
  if (!needsTranscode(extOf(rec.file_path))) return 'not_needed';
  const inAbs = path.join(RECORDINGS_BASE, rec.file_path);
  if (!fs.existsSync(inAbs)) return 'missing';
  const outRel = rec.file_path.replace(/\.[^./\\]+$/, '') + '.m4a';
  const outAbs = path.join(RECORDINGS_BASE, outRel);
  const t0 = Date.now();
  try {
    await (transcodeFn || defaultTranscode)(inAbs, outAbs);
    const size = fs.existsSync(outAbs) ? fs.statSync(outAbs).size : 0;
    if (!size) throw new Error('ffmpeg produced an empty file');
    db.prepare('UPDATE recordings SET playable_path = ? WHERE id = ?').run(outRel, rec.id);
    stats.done += 1;
    tlog.info({ recording: rec.id, ms: Date.now() - t0, bytes: size }, 'transcoded');
    return 'done';
  } catch (err) {
    fs.rmSync(outAbs, { force: true });
    stats.failed += 1;
    attempts.set(rec.id, (attempts.get(rec.id) || 0) + 1);
    tlog.warn({ recording: rec.id, err: err.message }, 'transcode failed');
    return 'failed';
  }
}

function schedule(delayMs = 25) {
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    runTranscodeQueue().catch((e) => tlog.error({ err: e }, 'transcode worker'));
  }, delayMs);
  scheduled.unref();
}

// Queue a recording for transcoding. Returns true when it was queued (or is
// already queued), false when transcoding is off / not needed.
export function enqueueTranscode(recordingId, ext) {
  if (ext !== undefined && !needsTranscode(ext)) return false;
  if (!transcodeEnabled()) return false;
  const id = Number(recordingId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if ((attempts.get(id) || 0) >= MAX_ATTEMPTS) return false;
  if (queued.has(id)) return true;
  queue.push(id);
  queued.add(id);
  schedule();
  return true;
}

// Drain the queue serially (one ffmpeg at a time — the office Mac also runs
// the HTTP server and the AI worker). Resolves when the queue is empty.
export async function runTranscodeQueue() {
  if (running || isShuttingDown() || !queue.length) return;
  running = true;
  try {
    await runJob('transcode', async () => {
      while (queue.length && !isShuttingDown()) {
        const id = queue.shift();
        queued.delete(id);
        await transcodeRecording(id);
      }
    });
  } catch (err) {
    if (err.code !== 'SHUTTING_DOWN') throw err;
  } finally {
    running = false;
    if (queue.length && !isShuttingDown()) schedule();
  }
}

// Sweep: queue every stored recording that still lacks a playable sibling
// (uploads from before this feature, or a failed run). Bounded per pass.
export function sweepUntranscoded(limit = 200) {
  if (!transcodeEnabled()) return 0;
  const rows = db.prepare(
    `SELECT id, file_path FROM recordings
      WHERE playable_path IS NULL AND file_path <> ''
      ORDER BY id DESC LIMIT ?`
  ).all(limit * 4);
  let n = 0;
  for (const r of rows) {
    if (!needsTranscode(extOf(r.file_path))) continue;
    if (enqueueTranscode(r.id)) n += 1;
    if (n >= limit) break;
  }
  return n;
}

// Boot: a first sweep shortly after start, then every 10 minutes. unref'd.
export function startTranscodeWorker() {
  if (!transcodeEnabled()) return;
  tlog.info({ ffmpeg: resolveFfmpeg() }, 'transcode worker armed');
  const tick = () => { try { sweepUntranscoded(); } catch (e) { tlog.error({ err: e }, 'sweep'); } };
  setTimeout(tick, 15000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}

export function transcodeStatus() {
  return {
    enabled: transcodeEnabled(),
    ffmpeg: resolved === undefined ? null : resolved,
    queued: queue.length,
    running,
    ...stats,
  };
}

// ── test hooks ──────────────────────────────────────────────────────────────
export function _setTranscodeFnForTests(fn) { transcodeFn = fn || null; }
export function _setEnabledForTests(v) { enabledOverride = v === null || v === undefined ? null : !!v; }
export function _resetTranscodeForTests() {
  queue.length = 0;
  queued.clear();
  attempts.clear();
  stats = { done: 0, failed: 0, skipped: 0 };
  transcodeFn = null;
  enabledOverride = null;
  if (scheduled) { clearTimeout(scheduled); scheduled = null; }
}
