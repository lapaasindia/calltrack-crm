import test from 'node:test';
import assert from 'node:assert/strict';
import { decideNavigation, isInAppUrl, isSafeExternalScheme } from './navigation.js';

const WIN = 'http://127.0.0.1:3000';
const dec = (target, config) => decideNavigation({ target, windowUrl: WIN, config });
const BS = String.fromCharCode(92); // backslash, kept out of string literals

test('loopback URLs (any port) navigate in-window', () => {
  for (const t of [
    'http://127.0.0.1:3000/reports', 'http://127.0.0.1:3000/',
    'http://localhost:3000/leads', 'http://127.0.0.1:9999/x', 'http://[::1]:3000/y',
  ]) {
    assert.deepEqual(dec(t), { cancel: false, openExternal: false }, t);
  }
});

test('ErrorBoundary "Go to home" (origin root) is in-app, never blocked', () => {
  // window.location.assign('/') resolves to the window origin root.
  assert.deepEqual(dec('http://127.0.0.1:3000/'), { cancel: false, openExternal: false });
});

test('join-mode host server origin navigates in-window', () => {
  const cfg = { mode: 'join', serverUrl: 'http://192.168.1.5:3000' };
  assert.equal(dec('http://192.168.1.5:3000/today', cfg).cancel, false);
});

test('the join server is off-app when NOT in join mode', () => {
  assert.equal(dec('http://192.168.1.5:3000/today', { mode: 'host' }).cancel, true);
});

test('external http(s)/mailto/tel cancel and open in the OS browser', () => {
  for (const t of [
    'https://wa.me/123', 'http://example.com', 'mailto:a@b.com',
    'tel:+15551234', 'HTTPS://EXAMPLE.COM',
  ]) {
    assert.deepEqual(dec(t), { cancel: true, openExternal: true }, t);
  }
});

test('dangerous schemes cancel and are NEVER opened externally (audit H-5)', () => {
  for (const t of [
    'file:///etc/passwd', 'smb://host/share', BS + BS + 'host' + BS + 'share',
    'javascript:alert(1)', 'data:text/html,x', 'ms-msdt:/id', 'vbscript:x',
  ]) {
    assert.deepEqual(dec(t), { cancel: true, openExternal: false }, t);
  }
});

test('look-alike loopback/server hosts are off-app, not in-window', () => {
  const cfg = { mode: 'join', serverUrl: 'http://192.168.1.5:3000' };
  for (const t of [
    'http://127.0.0.1.evil.com/', 'http://localhost.evil.com/', 'http://192.168.1.5:3000.evil.com/',
  ]) {
    assert.equal(dec(t, cfg).cancel, true, t);
  }
});

test('malformed/empty targets are blocked and not opened', () => {
  for (const t of ['', null, undefined, 'not a url', '://x']) {
    assert.deepEqual(
      decideNavigation({ target: t, windowUrl: WIN }),
      { cancel: true, openExternal: false },
      String(t),
    );
  }
});

test('isInAppUrl / isSafeExternalScheme primitives', () => {
  assert.equal(isInAppUrl('http://127.0.0.1:3000/x', WIN), true);
  assert.equal(isInAppUrl('http://127.0.0.1.evil.com/', WIN), false);
  assert.equal(isSafeExternalScheme('https://x'), true);
  assert.equal(isSafeExternalScheme('mailto:a@b'), true);
  assert.equal(isSafeExternalScheme('file:///x'), false);
  assert.equal(isSafeExternalScheme(''), false);
});
