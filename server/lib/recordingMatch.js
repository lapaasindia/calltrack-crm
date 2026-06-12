// Matches an uploaded call recording to a synced call. Timestamps are the
// primary signal (recording starts at ANSWER; the call log timestamp is at
// dial/ring — outgoing ring time in India is commonly 30-60s, hence the wide
// window). A phone number found in the filename only boosts confidence —
// OEMs substitute the saved contact NAME for the number, so it is never
// required. One confident candidate → attach; anything else → review queue.
// Never guess: a recording on the wrong lead is worse than an unattached one.
import db from '../db.js';
import { normalizePhone } from './phone.js';
import { IST_OFFSET_MS } from './istTime.js';

const WINDOW_MS = 90 * 1000;

// Phone number anywhere in a filename: "+91 98765-43210", "(9876543210)" etc.
export function numberFromFilename(filename) {
  const digits = filename.replace(/\D+/g, ' ');
  for (const chunk of digits.split(' ')) {
    if (chunk.length < 10 || chunk.length > 13) continue;
    const norm = normalizePhone(chunk);
    if (norm.ok) return norm.phone;
  }
  return null;
}

// Recording start time from OEM filename conventions, interpreted as IST
// wall time: Samsung "..._250612_143005.m4a", MIUI "...(_)20250612143005.mp3",
// generic epoch-ms "...1749717605000...".
export function timestampFromFilename(filename) {
  let m = filename.match(/(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
  if (!m) {
    const m2 = filename.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:\D|$)/);
    if (m2) m = [m2[0], `20${m2[1]}`, m2[2], m2[3], m2[4], m2[5], m2[6]];
  }
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - IST_OFFSET_MS;
    if (utcMs > Date.UTC(2015, 0, 1) && utcMs < Date.now() + 86400000) return utcMs;
  }
  const epoch = filename.match(/(?:^|\D)(1[5-9]\d{11})(?:\D|$)/);
  if (epoch) return Number(epoch[1]);
  return null;
}

// Returns { status: 'matched'|'ambiguous'|'unmatched', callId, capturedCallId }.
export function matchRecording({ userId, filename, lastModifiedMs, durationSeconds }) {
  const fnTs = timestampFromFilename(filename);
  // lastModified ≈ recording END; fall back to it minus duration.
  const recStart = fnTs ?? (durationSeconds
    ? lastModifiedMs - durationSeconds * 1000
    : lastModifiedMs);
  const fnNumber = numberFromFilename(filename);

  const findCandidates = (table, tsCol) => db.prepare(
    `SELECT * FROM ${table}
     WHERE user_id = ? AND ${tsCol} BETWEEN ? AND ?
       AND duration_seconds > 0`
  ).all(userId, recStart - WINDOW_MS, recStart + WINDOW_MS);

  const scoreOf = (row, phone) => {
    let score = 0;
    if (fnNumber && phone === fnNumber) score += 10;
    if (durationSeconds && row.duration_seconds) {
      const slack = Math.max(20, row.duration_seconds * 0.25);
      if (Math.abs(row.duration_seconds - durationSeconds) <= slack) score += 3;
    }
    return score;
  };

  // Candidates among synced mobile calls (joined to leads for the number)…
  const calls = db.prepare(
    `SELECT c.id, c.duration_seconds, c.call_log_ts, l.phone
     FROM calls c JOIN leads l ON l.id = c.lead_id
     WHERE c.user_id = ? AND c.source = 'mobile'
       AND c.call_log_ts BETWEEN ? AND ? AND c.duration_seconds > 0`
  ).all(userId, recStart - WINDOW_MS, recStart + WINDOW_MS)
    .map((r) => ({ kind: 'call', id: r.id, score: scoreOf(r, r.phone), ts: r.call_log_ts }));

  // …and among captured (unknown-number) calls, so the recording follows the
  // captured call into the lead if one is created later.
  const captured = findCandidates('captured_calls', 'call_log_ts')
    .map((r) => ({ kind: 'captured', id: r.id, score: scoreOf(r, r.phone), ts: r.call_log_ts }));

  const all = [...calls, ...captured];
  if (!all.length) return { status: 'unmatched', callId: null, capturedCallId: null };

  const best = Math.max(...all.map((c) => c.score));
  let top = all.filter((c) => c.score === best);
  if (top.length > 1) {
    // Tiebreak on timestamp proximity — but only when it clearly separates.
    top.sort((a, b) => Math.abs(a.ts - recStart) - Math.abs(b.ts - recStart));
    const gap = Math.abs(top[1].ts - recStart) - Math.abs(top[0].ts - recStart);
    if (gap < 15000) return { status: 'ambiguous', callId: null, capturedCallId: null };
    top = [top[0]];
  }
  // A bare time-window hit with no number and no duration corroboration is
  // too weak to auto-attach when the window held other activity.
  if (best === 0 && all.length > 1) {
    return { status: 'ambiguous', callId: null, capturedCallId: null };
  }

  const winner = top[0];
  return {
    status: 'matched',
    callId: winner.kind === 'call' ? winner.id : null,
    capturedCallId: winner.kind === 'captured' ? winner.id : null,
  };
}
