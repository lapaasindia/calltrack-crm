// Recordings pile up (~6-9 GB/month for a small team). Keep audio for a
// configurable window AFTER it's been transcribed, then delete the audio file
// — transcripts and summaries stay in the DB forever. Recordings are NOT in
// the VACUUM INTO database backup, so this never touches business data.
import fs from 'node:fs';
import path from 'node:path';
import db, { getSetting } from '../db.js';
import { nowUtc } from './istTime.js';
import { RECORDINGS_BASE } from '../routes/sync.js';

export function purgeOnce() {
  const days = getSetting('recording_retention_days', 90);
  if (!days || days <= 0) return; // 0 = keep forever
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // Only purge audio that AI has already processed (or that AI is off for and
  // is past the window) — never delete audio we haven't transcribed yet.
  // A purged row keeps file_path = '' (the column is NOT NULL in a STRICT
  // table — the old `SET file_path = NULL` threw inside the catch below, so
  // files were deleted but rows never marked and the audio route 500'd).
  const rows = db.prepare(
    `SELECT id, file_path, playable_path FROM recordings
     WHERE created_at < ? AND file_path <> ''
       AND ai_status IN ('done','failed','skipped')`
  ).all(cutoff);

  let purged = 0;
  for (const r of rows) {
    const abs = path.join(RECORDINGS_BASE, r.file_path);
    try {
      if (fs.existsSync(abs)) fs.rmSync(abs);
      // The transcoded .m4a sibling (MOB-22) goes with the original.
      if (r.playable_path) {
        const pabs = path.join(RECORDINGS_BASE, r.playable_path);
        if (fs.existsSync(pabs)) fs.rmSync(pabs);
      }
      db.prepare("UPDATE recordings SET file_path = '', playable_path = NULL WHERE id = ?").run(r.id);
      purged++;
    } catch (err) {
      console.error(`[retention] recording ${r.id}: ${err.message} (will retry next run)`);
    }
  }
  if (purged) console.log(`[retention] purged ${purged} old recording files (kept transcripts)`);
  return purged;
}

export function startRetentionJob() {
  const tick = () => { try { purgeOnce(); } catch (e) { console.error('[retention]', e.message); } };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 12 * 60 * 60 * 1000).unref(); // twice a day
}
