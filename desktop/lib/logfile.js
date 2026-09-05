// File logging for the Electron main process (DESK-22). console.* output is
// discarded when the app is launched from Finder/Explorer, so the shell keeps
// its own line-oriented log under userData/logs/main.log with a simple
// size-based rotation (main.log → main.log.1 → main.log.2). No dependencies;
// every write is wrapped so logging can never take the app down.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX = 2 * 1024 * 1024; // 2 MB per file
const DEFAULT_KEEP = 3;               // main.log + .1 + .2

export function rotateIfNeeded(file, { maxBytes = DEFAULT_MAX, keep = DEFAULT_KEEP } = {}) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size < maxBytes) return false;
  for (let i = keep - 1; i >= 1; i -= 1) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    try { fs.rmSync(to, { force: true }); } catch { /* ignore */ }
    try { fs.renameSync(from, to); } catch { /* ignore */ }
  }
  return true;
}

function fmt(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function createFileLogger({ dir, name = 'main.log', maxBytes = DEFAULT_MAX, keep = DEFAULT_KEEP, echo = true } = {}) {
  const file = path.join(dir, name);
  let ready = false;
  const ensure = () => {
    if (ready) return true;
    try { fs.mkdirSync(dir, { recursive: true }); ready = true; } catch { /* keep trying */ }
    return ready;
  };
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${args.map(fmt).join(' ')}\n`;
    if (echo) {
      try { (level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout).write(line); } catch { /* ignore */ }
    }
    if (!ensure()) return;
    try {
      rotateIfNeeded(file, { maxBytes, keep });
      fs.appendFileSync(file, line);
    } catch { /* disk full / permissions: never throw from a logger */ }
  };
  return {
    file,
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
  };
}
