import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeFilename, dedupeFilename, downloadPolicy, extensionOf, isPartialDownload,
  completedDownloads, SILENT_SAVE_EXTENSIONS,
} from './downloads.js';

const BS = String.fromCharCode(92); // backslash
const ctl = (n) => String.fromCharCode(n);

test('the real app filename passes through unchanged (happy path, both OSes)', () => {
  assert.equal(
    sanitizeFilename('funnel-2026-05-20-to-2026-06-18.csv'),
    'funnel-2026-05-20-to-2026-06-18.csv',
  );
});

test('strips Windows-illegal characters', () => {
  assert.equal(
    sanitizeFilename('a<b>c:d"e/f' + BS + 'g|h?i*j.csv'),
    'a_b_c_d_e_f_g_h_i_j.csv',
  );
});

test('strips C0 control characters', () => {
  assert.equal(sanitizeFilename('a' + ctl(0) + 'b' + ctl(31) + '.csv'), 'a_b_.csv');
});

test('trims trailing dots/spaces (Windows strips them); keeps mid-name spaces', () => {
  assert.equal(sanitizeFilename('report.'), 'report');
  assert.equal(sanitizeFilename('name '), 'name');
  assert.equal(sanitizeFilename('report .csv'), 'report .csv'); // mid-name space is legal
});

test('Windows reserved device names are escaped, extension and case ignored', () => {
  assert.equal(sanitizeFilename('CON.csv'), '_CON.csv');
  assert.equal(sanitizeFilename('nul'), '_nul');
  assert.equal(sanitizeFilename('Com1.txt'), '_Com1.txt');
  assert.equal(sanitizeFilename('LPT9'), '_LPT9');
  assert.equal(sanitizeFilename('console.csv'), 'console.csv'); // not reserved (only exact CON)
  // Windows resolves the device from the FIRST dot, so multi-dot names hit it too.
  assert.equal(sanitizeFilename('CON.tar.gz'), '_CON.tar.gz');
  assert.equal(sanitizeFilename('console.tar.gz'), 'console.tar.gz');
});

test('dotfiles and extensionless names keep their name', () => {
  assert.equal(sanitizeFilename('.gitignore'), '.gitignore');
  assert.equal(sanitizeFilename('README'), 'README');
});

test('empty / all-stripped names fall back to a constant', () => {
  assert.equal(sanitizeFilename(''), 'download');
  assert.equal(sanitizeFilename('   '), 'download');
  assert.equal(sanitizeFilename('...'), 'download');
  assert.equal(sanitizeFilename(null), 'download');
});

test('dedupe returns the name when free', () => {
  assert.equal(dedupeFilename('funnel.csv', () => false), 'funnel.csv');
});

test('dedupe increments past existing collisions', () => {
  const taken = new Set(['funnel.csv', 'funnel (1).csv']);
  assert.equal(dedupeFilename('funnel.csv', (n) => taken.has(n)), 'funnel (2).csv');
});

test('dedupe preserves a multi-dot extension', () => {
  const taken = new Set(['a.b.c.csv']);
  assert.equal(dedupeFilename('a.b.c.csv', (n) => taken.has(n)), 'a.b.c (1).csv');
});

test('dedupe sanitizes first (reserved name) before numbering', () => {
  assert.equal(dedupeFilename('CON.csv', () => false), '_CON.csv');
});

test('dedupe on an extensionless dotfile appends after the name', () => {
  const taken = new Set(['.gitignore']);
  assert.equal(dedupeFilename('.gitignore', (n) => taken.has(n)), '.gitignore (1)');
});

// ---- DESK-9: download type allow-list ---------------------------------------

test('the CRM\'s own export types save silently', () => {
  for (const n of [
    'funnel-2026-05-20-to-2026-06-18.csv', 'leads.xlsx', 'old-report.xls', 'Invoice-INV-0007.pdf',
    'crm-2026-09-05.sqlite', 'export.json', 'recordings.zip', 'notes.txt',
    'shot.png', 'a.jpg', 'a.JPEG', 'a.webp', 'call-1.m4a', 'x.mp3', 'x.wav', 'x.amr', 'x.3gp', 'x.opus', 'x.ogg',
  ]) {
    assert.equal(downloadPolicy(n), 'silent', n);
  }
});

test('executables, scripts, installers and unknown types go through the Save dialog', () => {
  for (const n of [
    'Invoice.exe', 'setup.msi', 'CallTrack.dmg', 'run.bat', 'run.cmd', 'x.ps1', 'x.sh', 'x.js', 'x.html',
    'shortcut.lnk', 'x.scr', 'x.jar', 'x.app', 'x.pkg', 'x.vbs', 'README', 'x.', 'x.exe ', 'Invoice.pdf.exe',
  ]) {
    assert.equal(downloadPolicy(n), 'ask', n);
  }
});

test('extension is case-insensitive and read from the sanitized name', () => {
  assert.equal(extensionOf('X.CSV'), 'csv');
  assert.equal(extensionOf('report.csv.'), 'csv'); // trailing dot stripped first
  assert.equal(extensionOf('CON.pdf'), 'pdf');
  assert.equal(extensionOf('noext'), '');
  assert.equal(SILENT_SAVE_EXTENSIONS.has('exe'), false);
});

// ---- DEP-5: partial downloads -----------------------------------------------

test('Chromium in-flight partials are recognised', () => {
  for (const n of ['export.csv.crdownload', 'smoke-renderer.csv.CRDOWNLOAD', 'x.part', 'x.tmp', 'Unconfirmed 1234.download']) {
    assert.equal(isPartialDownload(n), true, n);
  }
  for (const n of ['export.csv', 'export (1).csv', 'crdownload.csv', 'x.parts', '']) {
    assert.equal(isPartialDownload(n), false, n);
  }
});

test('completedDownloads ignores partials when matching expected prefixes', () => {
  assert.deepEqual(
    completedDownloads(['export.csv.crdownload', 'smoke-renderer.csv.crdownload'], ['export', 'smoke-renderer']),
    { export: false, 'smoke-renderer': false },
  );
  assert.deepEqual(
    completedDownloads(['export.csv', 'smoke-renderer.csv.crdownload'], ['export', 'smoke-renderer']),
    { export: true, 'smoke-renderer': false },
  );
  assert.deepEqual(
    completedDownloads(['export (1).csv', 'smoke-renderer.csv'], ['export', 'smoke-renderer']),
    { export: true, 'smoke-renderer': true },
  );
  assert.deepEqual(completedDownloads(undefined, ['a']), { a: false });
});
