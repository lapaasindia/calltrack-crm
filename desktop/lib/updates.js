// In-app update check (DESK-10, safe part). Pure helpers: compare semver-ish
// strings, read GitHub's releases/latest JSON, and decide whether a newer
// build exists. No electron-updater (installers are unsigned, so Squirrel.Mac
// would refuse them anyway) — the app only shows a link.

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// -1 / 0 / 1 like a comparator; null when either side is not a version.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// GitHub /repos/:owner/:repo/releases/latest → { version, url } or null.
export function parseGithubLatest(json) {
  if (!json || typeof json !== 'object') return null;
  const version = parseVersion(json.tag_name || json.name) ? String(json.tag_name || json.name).replace(/^v/, '') : null;
  if (!version) return null;
  const url = typeof json.html_url === 'string' && /^https:\/\/github\.com\//.test(json.html_url)
    ? json.html_url : null;
  return { version, url };
}

// Decide what (if anything) to tell the user.
//  current      — app.getVersion()
//  hostVersion  — /api/health.version of the server we are attached/joined to
//  latest       — parseGithubLatest() result (may be null when offline)
export function decideUpdate({ current, hostVersion, latest, releasesUrl } = {}) {
  const candidates = [];
  if (hostVersion && compareVersions(current, hostVersion) === -1) {
    candidates.push({ version: hostVersion, source: 'host', url: releasesUrl || null });
  }
  if (latest && latest.version && compareVersions(current, latest.version) === -1) {
    candidates.push({ version: latest.version, source: 'github', url: latest.url || releasesUrl || null });
  }
  if (!candidates.length) return { available: false };
  candidates.sort((a, b) => -(compareVersions(a.version, b.version) || 0));
  return { available: true, ...candidates[0] };
}

// Once a day, persisted as an ISO timestamp.
export function isCheckDue(lastIso, now = Date.now(), everyMs = 24 * 60 * 60 * 1000) {
  const last = Date.parse(lastIso || '');
  if (!Number.isFinite(last)) return true;
  return now - last >= everyMs;
}
