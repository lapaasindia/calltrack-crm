// Cross-platform download filename helpers for the desktop shell, factored out
// of main.js so they unit-test under node:test without launching Electron (no
// electron / fs import — the caller injects an `exists` predicate).
//
// The names these see are app-controlled today (e.g.
// 'funnel-2026-05-20-to-2026-06-18.csv'), so sanitizing rarely fires — it is
// defense-in-depth so a future free-text filename (a lead/customer name) can
// never produce a name the OS rejects, especially on Windows.

// Characters illegal in a Windows filename. (Space and hyphen are legal
// mid-name and are intentionally NOT here.) C0 control chars are handled
// separately by char code so no fragile regex escapes are needed.
const ILLEGAL_LIST = ['<', '>', ':', '"', '/', String.fromCharCode(92), '|', '?', '*'];
// Windows reserved DEVICE names. Reserved even WITH an extension — and the OS
// resolves the device from the segment before the FIRST dot, so both 'CON.csv'
// and 'CON.tar.gz' hit the console device. Checked against that first segment.
const RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const FALLBACK = 'download';

function stripIllegal(s) {
  let out = '';
  for (const ch of String(s)) {
    out += (ch.charCodeAt(0) <= 0x1f || ILLEGAL_LIST.includes(ch)) ? '_' : ch;
  }
  return out;
}

// Split a filename into [stem, ext] on the LAST dot. A leading dot (index 0) or
// no dot means the whole name is the stem — so dotfiles ('.gitignore') and
// extensionless names ('README') keep their name, and 'a.b.c.csv' keeps '.csv'.
function splitName(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

export function sanitizeFilename(name) {
  let s = stripIllegal(name == null ? '' : name);
  // Windows silently strips trailing dots/spaces and rejects names that are
  // only dots/spaces; Node's path does not, so do it ourselves. Trim leading
  // spaces too, but keep a leading dot so dotfiles survive.
  s = s.replace(/[ .]+$/, '').replace(/^ +/, '');
  if (!s) return FALLBACK;
  if (RESERVED_STEM.test(s.split('.')[0])) return `_${s}`;
  return s;
}

// Return a non-colliding filename per the injected `exists(name)` predicate:
// 'report.csv' -> 'report (1).csv' -> 'report (2).csv' … The counter is
// inserted between stem and extension. The loop is bounded because the caller
// runs it synchronously inside Electron's will-download handler.
export function dedupeFilename(name, exists) {
  const safe = sanitizeFilename(name);
  if (!exists(safe)) return safe;
  const [stem, ext] = splitName(safe);
  for (let n = 1; n <= 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`; // pathological fallback
}
