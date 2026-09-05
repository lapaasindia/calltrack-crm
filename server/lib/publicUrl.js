// CRM_PUBLIC_URL — the address the CRM is reachable at from OUTSIDE a reverse
// proxy (Coolify/Traefik, nginx, Caddy), e.g. https://crm.example.com. It is
// what a phone must be told to connect to: the container's own interface IPs
// mean nothing beyond the Docker network. Used by
//   * routes/devices.js — put first in the pairing-code URL list, so the QR the
//     admin shows points at the proxy (the web client encodes urls[0] when it
//     is itself on localhost / a .local name, else its own origin);
//   * routes/backup.js — accepted as an "own host" for the Google Drive OAuth
//     redirect, next to localhost / LAN IPs / .local / CRM_OAUTH_REDIRECT_HOST;
//   * server/index.js — printed (and QR-coded) in the start-up banner.
// It is never reported by /api/health.
//
// Accepted: an absolute http(s) URL that is an origin only — no path (a lone
// trailing slash is tolerated), no query/fragment, no credentials. Anything
// else is ignored as a whole (createApp() logs one warning at boot) rather than
// half-applied. Read on every call: it is a handful of string ops, and tests
// flip the variable between requests.

export function parsePublicUrl(raw = process.env.CRM_PUBLIC_URL) {
  const none = { origin: null, host: null, hostname: null, scheme: null, error: null };
  const value = String(raw ?? '').trim();
  if (!value) return none;
  let u;
  try { u = new URL(value); } catch {
    return { ...none, error: `CRM_PUBLIC_URL "${value}" is not an absolute URL (expected https://crm.example.com)` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ...none, error: `CRM_PUBLIC_URL must start with http:// or https:// (got "${u.protocol}//")` };
  }
  if (u.username || u.password) {
    return { ...none, error: 'CRM_PUBLIC_URL must not contain a username or password' };
  }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    return { ...none, error: `CRM_PUBLIC_URL must be an origin only (scheme://host[:port]) — drop the path/query from "${value}"` };
  }
  return {
    origin: u.origin, // default port already dropped, host lower-cased by the URL parser
    host: u.host.toLowerCase(),
    hostname: u.hostname.toLowerCase(),
    scheme: u.protocol.replace(/:$/, ''),
    error: null,
  };
}

// Convenience for callers that only need the origin (or null).
export function publicOrigin() {
  return parsePublicUrl().origin;
}
