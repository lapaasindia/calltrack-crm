import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideNavigation, decideRedirect, decideFrameNavigation, decideWindowOpen, decidePermission,
  isInAppUrl, isSafeExternalScheme, ALLOWED_PERMISSIONS,
} from './navigation.js';

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

// ---- DESK-17: server-side redirects -----------------------------------------

test('redirects: same-origin allowed, off-app cancelled and never opened externally', () => {
  assert.deepEqual(decideRedirect({ target: 'http://127.0.0.1:3000/login', windowUrl: WIN }),
    { cancel: false, openExternal: false });
  const cfg = { mode: 'join', serverUrl: 'http://192.168.1.5:3000' };
  assert.equal(decideRedirect({ target: 'http://192.168.1.5:3000/login', windowUrl: 'http://192.168.1.5:3000', config: cfg }).cancel, false);
  // A 302 is not a user click: a phishing target is dropped, not opened in the OS browser.
  for (const t of ['https://phish.example/login', 'http://example.invalid/', 'file:///etc/passwd', 'x-probe://a']) {
    assert.deepEqual(decideRedirect({ target: t, windowUrl: WIN }), { cancel: true, openExternal: false }, t);
  }
});

// ---- DESK-2: subframes -------------------------------------------------------

test('subframes may only load in-app URLs and never reach the OS shell', () => {
  const sub = (target, config) => decideFrameNavigation({ target, windowUrl: WIN, config, isMainFrame: false });
  assert.deepEqual(sub('http://127.0.0.1:3000/api/invoices/1/html'), { cancel: false, openExternal: false });
  // A custom protocol in an <iframe> was the DESK-2 bypass — cancelled, not opened.
  for (const t of ['x-calltrack-probe://sub', 'smb://attacker/s', 'mailto:spam@x', 'tel:+1', 'https://ads.example/']) {
    assert.deepEqual(sub(t), { cancel: true, openExternal: false }, t);
  }
  const cfg = { mode: 'join', serverUrl: 'http://192.168.1.5:3000' };
  assert.equal(sub('http://192.168.1.5:3000/weekly.html', cfg).cancel, false);
  assert.equal(sub('http://192.168.1.5:3000.evil.com/', cfg).cancel, true);
});

test('main-frame navigations are left to will-navigate (frame policy is a no-op)', () => {
  assert.deepEqual(
    decideFrameNavigation({ target: 'https://example.com', windowUrl: WIN, isMainFrame: true }),
    { cancel: false, openExternal: false },
  );
});

// ---- DESK-6: window.open / target=_blank -------------------------------------

test('same-origin popups are allowed (child window shares the session cookie)', () => {
  for (const t of ['http://127.0.0.1:3000/api/invoices/7/html', 'http://localhost:3000/api/dashboard/weekly.html']) {
    assert.deepEqual(decideWindowOpen({ target: t, windowUrl: WIN }), { action: 'allow', openExternal: false }, t);
  }
  const cfg = { mode: 'join', serverUrl: 'http://192.168.1.5:3000' };
  assert.equal(decideWindowOpen({ target: 'http://192.168.1.5:3000/api/invoices/7/html', windowUrl: 'http://192.168.1.5:3000', config: cfg }).action, 'allow');
});

test('off-app popups are denied; safe schemes go to the OS, unsafe ones nowhere', () => {
  assert.deepEqual(decideWindowOpen({ target: 'https://accounts.google.com/o/oauth2/auth', windowUrl: WIN }),
    { action: 'deny', openExternal: true });
  assert.deepEqual(decideWindowOpen({ target: 'https://wa.me/123', windowUrl: WIN }),
    { action: 'deny', openExternal: true });
  for (const t of ['smb://h/s', 'file:///x', 'javascript:1', 'x-probe://a', 'about:blank', '']) {
    assert.deepEqual(decideWindowOpen({ target: t, windowUrl: WIN }), { action: 'deny', openExternal: false }, t);
  }
});

// ---- DESK-3: web permissions -------------------------------------------------

test('permissions: deny-by-default, allow-list only for the in-app origin', () => {
  const ask = (permission, requestingUrl, config) => decidePermission({ permission, requestingUrl, windowUrl: WIN, config });
  for (const p of ['media', 'geolocation', 'clipboard-read', 'display-capture', 'pointerLock', 'hid', 'usb', 'serial', 'midi', 'idle-detection', 'unknown']) {
    assert.equal(ask(p, 'http://127.0.0.1:3000/'), false, p);
  }
  for (const p of ALLOWED_PERMISSIONS) {
    assert.equal(ask(p, 'http://127.0.0.1:3000/today'), true, p);
    assert.equal(ask(p, 'https://evil.example/'), false, `${p} off-app`);
    assert.equal(ask(p, 'file:///Users/x/setup.html'), false, `${p} file:`);
  }
  const cfg = { mode: 'join', serverUrl: 'http://192.168.1.5:3000' };
  assert.equal(ask('notifications', 'http://192.168.1.5:3000/', cfg), true);
  assert.equal(ask('notifications', 'http://192.168.1.5:3000/', { mode: 'host' }), false);
});

test('openExternal is always denied as a permission (links go through safeOpenExternal)', () => {
  assert.equal(decidePermission({ permission: 'openExternal', requestingUrl: 'http://127.0.0.1:3000/', windowUrl: WIN }), false);
  assert.equal(decidePermission({ permission: 'openExternal', requestingUrl: WIN, windowUrl: WIN, config: { mode: 'host' } }), false);
});
