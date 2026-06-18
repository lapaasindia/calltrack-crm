import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilename, dedupeFilename } from './downloads.js';

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
