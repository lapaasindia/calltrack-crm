// Navigation / external-link policy for the desktop shell, factored out of
// main.js so it can be unit-tested without launching Electron (no electron
// import here). It decides, for a click that would navigate the main window,
// whether to let it happen IN-WINDOW or cancel it and hand the URL to the OS
// browser instead.
//
// Security (audit H-5): only http(s)/mailto/tel may ever reach the OS shell —
// never file:, smb:/UNC, data:, javascript:, or custom protocols (ms-msdt: …)
// that turn a link into native code execution.

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
