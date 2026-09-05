// Structured logging (audit SCALE-17): one pino logger for the whole server.
//
//   * JSON lines to DATA_DIR/logs/server.log, rotated daily (IST day) — the
//     current file is renamed to server-YYYY-MM-DD.log at the first write of a
//     new day and only the newest 14 rotated files are kept.
//   * Echoed to stdout when not in production (and not under `node --test`, so
//     the suite output stays readable). NODE_ENV=production keeps stdout quiet
//     because launchd already captures it into an unrotated file.
//   * requestLogger(): per-request line with method, path, status, ms, user id
//     and a short request id that is also returned as X-Request-Id, so a
//     support ticket ("it said Server error at 11:02") can be matched to a log
//     line and its stack.
//
// This module deliberately does NOT import db.js (db.js logs through it), so it
// computes DATA_DIR the same way db.js does. Logging must never throw: every
// write is wrapped, and a log dir that can't be created degrades to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
export const LOG_DIR = process.env.CRM_LOG_DIR || path.join(DATA_DIR, 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'server.log');
const KEEP_ROTATED = 14;

const IST_OFFSET_MS = 330 * 60 * 1000;
const istDay = (ms = Date.now()) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

// Minimal pino-compatible destination: synchronous appends to an open fd (a
// few µs per line at this request rate), with day-boundary rotation.
class DailyRotatingFile {
  constructor(file, keep = KEEP_ROTATED) {
    this.file = file;
    this.dir = path.dirname(file);
    this.stem = path.basename(file).replace(/\.log$/, '');
    this.keep = keep;
    this.fd = null;
    this.day = null;
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true });
    // A file left over from an earlier day (previous run) gets archived first
    // so server.log always holds only today's lines.
    try {
      const st = fs.statSync(this.file);
      const fileDay = istDay(st.mtimeMs);
      if (st.size > 0 && fileDay !== istDay()) this.archive(fileDay);
    } catch { /* no existing file */ }
    this.fd = fs.openSync(this.file, 'a');
    this.day = istDay();
    return this;
  }

  archive(day) {
    const dest = path.join(this.dir, `${this.stem}-${day}.log`);
    try {
      if (fs.existsSync(dest)) {
        // Same day archived twice (restart straddling a rotation): append.
        fs.appendFileSync(dest, fs.readFileSync(this.file));
        fs.unlinkSync(this.file);
      } else {
        fs.renameSync(this.file, dest);
      }
    } catch { /* leave the file in place; we'll keep appending */ }
    this.prune();
  }

  prune() {
    try {
      const re = new RegExp(`^${this.stem}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
      const rotated = fs.readdirSync(this.dir).filter((f) => re.test(f)).sort();
      for (const old of rotated.slice(0, Math.max(0, rotated.length - this.keep))) {
        fs.rmSync(path.join(this.dir, old), { force: true });
      }
    } catch { /* best effort */ }
  }

  rotateIfNeeded() {
    const day = istDay();
    if (day === this.day) return;
    try { fs.closeSync(this.fd); } catch { /* ignore */ }
    this.archive(this.day);
    this.fd = fs.openSync(this.file, 'a');
    this.day = day;
  }

  write(str) {
    try {
      if (this.fd === null) return;
      this.rotateIfNeeded();
      fs.writeSync(this.fd, str);
    } catch { /* disk full / fd gone: logging never breaks the app */ }
  }

  // Test hook: force the "day changed" path without waiting for midnight.
  _forceRotate(asDay) {
    this.day = asDay;
    this.rotateIfNeeded();
  }
}

const level = process.env.CRM_LOG_LEVEL || 'info';
const underTest = !!process.env.NODE_TEST_CONTEXT;
const echoStdout = process.env.CRM_LOG_STDOUT === '1'
  || (process.env.NODE_ENV !== 'production' && !underTest && process.env.CRM_LOG_STDOUT !== '0');

export const fileStream = (() => {
  try { return new DailyRotatingFile(LOG_FILE).open(); } catch { return null; }
})();

const streams = [];
if (fileStream) streams.push({ level, stream: fileStream });
if (echoStdout || !fileStream) streams.push({ level, stream: process.stdout });

export const log = pino({
  level,
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
}, pino.multistream(streams, { dedupe: false }));

// Paths whose access lines would only be noise (the SPA's hashed assets).
const SKIP_RE = /^\/assets\//;

// Express middleware: one line per finished response. Installed before body
// parsing so even a 413/400 from express.json is recorded. req.user is filled
// in later by requireAuth and read at finish time.
export function requestLogger(logger = log) {
  return (req, res, next) => {
    const id = randomUUID().slice(0, 8);
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
      if (SKIP_RE.test(pathOnly)) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const status = res.statusCode;
      const rec = {
        req_id: id,
        method: req.method,
        path: pathOnly,
        status,
        ms: Math.round(ms * 10) / 10,
        user_id: req.user?.id ?? null,
        ip: req.ip,
      };
      const len = Number(res.getHeader('content-length'));
      if (Number.isFinite(len)) rec.bytes = len;
      if (status >= 500) logger.error(rec, 'request');
      else if (status >= 400) logger.warn(rec, 'request');
      else logger.info(rec, 'request');
    });
    next();
  };
}
