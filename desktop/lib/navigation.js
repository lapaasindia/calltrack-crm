// Navigation / external-link / permission policy for the desktop shell,
// factored out of main.js so it can be unit-tested without launching Electron
// (no electron import here). It decides, for anything that would navigate a
// frame, open a window, redirect, or ask for a web permission, whether to let
// it happen IN-APP or cancel it (optionally handing a safe URL to the OS).
//
// Security (audit H-5 / DESK-2 / DESK-3 / DESK-6 / DESK-17): only
// http(s)/mailto/tel may ever reach the OS shell — never file:, smb:/UNC,
// data:, javascript:, or custom protocols (ms-msdt: …) that turn a link into
// native code execution. Subframes, redirects and popups follow the SAME
// allow-list as top-level navigation, and web permissions are deny-by-default.

export const SAFE_EXTERNAL_SCHEME = /^(https?|mailto|tel):/i;

export function isSafeExternalScheme(target) {
  return SAFE_EXTERNAL_SCHEME.test(String(target == null ? '' : target).trim());
}

function originOf(u) {
  try { return new URL(u).origin; } catch { return null; }
}

// Loopback hosts can never be a remote attacker, so any port is fine. Note we
// match the host EXACTLY — 'http://127.0.0.1.evil.com' has host
// '127.0.0.1.evil.com', which is NOT loopback and must not be treated as in-app.
function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

// Should `target` navigate inside the app window? True when it is loopback (the
// embedded server), the exact origin of the window we loaded, or — in join
// mode — the exact origin of the configured host server. Comparison is by
// parsed origin/host, never string prefix, so look-alike hosts can't slip in.
export function isInAppUrl(target, windowUrl, config) {
  let url;
  try { url = new URL(String(target)); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (isLoopbackHost(url.hostname)) return true;
  const winOrigin = originOf(windowUrl);
  if (winOrigin && url.origin === winOrigin) return true;
  if (config && config.mode === 'join' && config.serverUrl) {
    const srvOrigin = originOf(config.serverUrl);
    if (srvOrigin && url.origin === srvOrigin) return true;
  }
  return false;
}

// The will-navigate decision. { cancel } — should the in-window navigation be
// prevented; { openExternal } — should the URL instead be opened in the OS
// browser (only ever true for a safe scheme).
export function decideNavigation({ target, windowUrl, config } = {}) {
  if (isInAppUrl(target, windowUrl, config)) return { cancel: false, openExternal: false };
  return { cancel: true, openExternal: isSafeExternalScheme(target) };
}

// Server-side redirects (DESK-17): a compromised / MITM'd host must not be
// able to 302 the trusted window to a phishing page. Off-app redirects are
// cancelled and — unlike a user's click — NEVER handed to the OS browser: a
// redirect is not a user action, so nothing legitimately leaves the app here.
export function decideRedirect({ target, windowUrl, config } = {}) {
  if (isInAppUrl(target, windowUrl, config)) return { cancel: false, openExternal: false };
  return { cancel: true, openExternal: false };
}

// Subframe navigation (DESK-2). `will-navigate` is main-frame only, so an
// <iframe src="smb://…"> never reached the H-5 allow-list. Non-main frames may
// ONLY load in-app URLs — and they never open anything externally (an iframe
// is not a user click). Main-frame navigations are left to will-navigate.
export function decideFrameNavigation({ target, windowUrl, config, isMainFrame } = {}) {
  if (isMainFrame) return { cancel: false, openExternal: false };
  if (isInAppUrl(target, windowUrl, config)) return { cancel: false, openExternal: false };
  return { cancel: true, openExternal: false };
}

// window.open / target=_blank (DESK-6). Same-origin popups (the print-ready
// invoice, the weekly report) must open in a child window that shares the
// session cookie; everything else is denied and — if safe — handed to the OS.
export function decideWindowOpen({ target, windowUrl, config } = {}) {
  if (isInAppUrl(target, windowUrl, config)) return { action: 'allow', openExternal: false };
  return { action: 'deny', openExternal: isSafeExternalScheme(target) };
}

// Web permissions (DESK-3): deny by default. Only what the CRM actually uses,
// and only when the requesting page is the configured in-app origin. Camera,
// microphone ('media'), geolocation, clipboard-read, display-capture,
// pointer lock, HID/USB/serial etc. are never granted to the (possibly
// MITM'd, plaintext-http) remote page. 'openExternal' is ALWAYS denied here —
// links that may leave the app go through safeOpenExternal after the
// navigation policy above, never through Chromium's own protocol launcher.
export const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);

export function decidePermission({ permission, requestingUrl, windowUrl, config } = {}) {
  if (permission === 'openExternal') return false;
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  return isInAppUrl(requestingUrl, windowUrl, config);
}
