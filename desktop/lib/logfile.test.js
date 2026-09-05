import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileLogger, rotateIfNeeded } from './logfile.js';

test('writes timestamped lines and rotates by size, keeping N files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-log-'));
  const log = createFileLogger({ dir, maxBytes: 200, keep: 3, echo: false });
  log.info('boot', { mode: 'host', port: 3195 });
  log.warn('careful');
  log.error(new Error('kaboom'));
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /INFO  boot \{"mode":"host","port":3195\}/);
  assert.match(text, /WARN  careful/);
  assert.match(text, /ERROR Error: kaboom/);
  assert.match(text, /^\d{4}-\d{2}-\d{2}T/m);
  // Push past the limit several times: main.log is renamed to .1 then .2, .3 never appears.
  for (let i = 0; i < 40; i += 1) log.info('x'.repeat(50));
  const files = fs.readdirSync(dir).sort();
  assert.ok(files.includes('main.log'));
  assert.ok(files.includes('main.log.1'));
  assert.ok(!files.includes('main.log.3'));
  assert.ok(fs.statSync(log.file).size < 400);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rotateIfNeeded is a no-op below the limit or when the file is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-log-'));
  const f = path.join(dir, 'main.log');
  assert.equal(rotateIfNeeded(f), false);
  fs.writeFileSync(f, 'small');
  assert.equal(rotateIfNeeded(f, { maxBytes: 100 }), false);
  fs.writeFileSync(f, 'x'.repeat(200));
  assert.equal(rotateIfNeeded(f, { maxBytes: 100, keep: 2 }), true);
  assert.ok(fs.existsSync(`${f}.1`));
  assert.ok(!fs.existsSync(f));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a logger with an unwritable dir never throws', () => {
  const log = createFileLogger({ dir: '/dev/null/not-a-dir', echo: false });
  assert.doesNotThrow(() => log.info('still fine'));
});
