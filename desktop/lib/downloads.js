// Cross-platform download filename / policy helpers for the desktop shell,
// factored out of main.js so they unit-test under node:test without launching
// Electron (no electron / fs import — the caller injects an `exists` predicate).
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

// ---- Download type policy (DESK-9) -----------------------------------------
// Only these extensions are saved SILENTLY to the Downloads folder (and
// revealed). They are the document/data/media types the CRM itself produces
// (CSV/XLSX reports, PDF invoices, SQLite backups, JSON exports, call
// recordings). Anything else — .exe, .lnk, .scr, .dmg, .js, .html, .bat … —
// goes through the OS Save dialog so the user sees the name and extension,
// and is never auto-revealed with a "double-click me" highlight.
export const SILENT_SAVE_EXTENSIONS = new Set([
  'csv', 'xlsx', 'xls', 'pdf', 'sqlite', 'json', 'zip', 'txt',
  'png', 'jpg', 'jpeg', 'webp',
  'm4a', 'mp3', 'wav', 'amr', '3gp', 'opus', 'ogg',
]);

export function extensionOf(name) {
  const safe = sanitizeFilename(name);
  const [, ext] = splitName(safe);
  return ext ? ext.slice(1).toLowerCase() : '';
}

// 'silent' → save straight to Downloads with a deduped name and reveal it;
// 'ask'    → let Chromium show the Save dialog (no reveal afterwards).
// Double extensions are judged by the LAST one only ('Invoice.pdf.exe' → exe → ask).
export function downloadPolicy(name) {
  return SILENT_SAVE_EXTENSIONS.has(extensionOf(name)) ? 'silent' : 'ask';
}

// ---- Partial-download detection (DEP-5) -------------------------------------
// Chromium writes in-flight downloads as '<name>.crdownload' (Windows/macOS);
// other builds/OSes use '.part' / '.tmp' / '.download'. A directory scan that
// prefix-matches on the final name sees these and must NOT treat them as done.
const PARTIAL_SUFFIX = /\.(crdownload|part|tmp|download)$/i;

export function isPartialDownload(name) {
  return PARTIAL_SUFFIX.test(String(name == null ? '' : name));
}

// Given a directory listing, which of the expected name prefixes have a
// COMPLETE file? Pure so the smoke's wait loop is unit-testable.
export function completedDownloads(files, prefixes) {
  const finished = (files || []).filter((f) => !isPartialDownload(f));
  const seen = {};
  for (const p of prefixes) seen[p] = finished.some((f) => f.startsWith(p));
  return seen;
}
