// "Attached" mode helpers (DESK-5 / DESK-7): where does the CallTrack background
// service live on this machine, and where does it keep its data? Pure
// functions — the caller (main.js) injects paths/xml/platform so this is
// unit-testable and never touches launchctl.

import path from 'node:path';

export const SERVICE_LABEL = 'com.calltrack.crm';

// A marker written by scripts/install-autostart.js (and removed by
// uninstall-autostart) at a FIXED per-user location, independent of the
// desktop app's userData (which differs between `electron .` and the packaged
// app — DESK-23). The desktop app reads it to know "a service owns this
// machine's data; never self-host".
export function serviceMarkerPath({ platform = process.platform, homedir, appData } = {}) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'CallTrack', 'service.json');
  }
  if (platform === 'win32') {
    return path.join(appData || path.join(homedir, 'AppData', 'Roaming'), 'CallTrack', 'service.json');
  }
  return path.join(homedir, '.config', 'calltrack', 'service.json');
}

export function launchAgentPlistPath({ homedir } = {}) {
  return path.join(homedir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

// Minimal plist reader for the handful of keys install-autostart writes. Not a
// general XML parser: it walks <key>NAME</key> followed by the next value
// element, which is exactly how launchd plists are laid out. Nested
// <dict> (EnvironmentVariables) is flattened one level.
export function parsePlist(xml) {
  const out = {};
  if (typeof xml !== 'string') return out;
  const unescape = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const re = /<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<integer>([^<]*)<\/integer>|<(true|false)\s*\/>|<dict>([\s\S]*?)<\/dict>|<array>([\s\S]*?)<\/array>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const key = unescape(m[1]);
    if (m[2] !== undefined) out[key] = unescape(m[2]);
    else if (m[3] !== undefined) out[key] = Number(m[3]);
    else if (m[4] !== undefined) out[key] = m[4] === 'true';
    else if (m[5] !== undefined) out[key] = parsePlist(`${m[5]}`);
    else if (m[6] !== undefined) {
      out[key] = [...m[6].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => unescape(x[1]));
    }
  }
  return out;
}

// Resolve the service's data/backup folders. Priority: the install marker
// (written with the exact values), then the plist's EnvironmentVariables /
// WorkingDirectory (server/db.js defaults to <cwd>/data and <cwd>/backups).
export function servicePathsFrom({ marker, plist } = {}) {
  if (marker && typeof marker === 'object' && marker.dataDir) {
    return {
      dataDir: marker.dataDir,
      backupDir: marker.backupDir || path.join(path.dirname(marker.dataDir), 'backups'),
      root: marker.root || null,
      source: 'marker',
    };
  }
  const p = plist && typeof plist === 'object' ? plist : (typeof plist === 'string' ? parsePlist(plist) : null);
  if (p && (p.WorkingDirectory || p.EnvironmentVariables?.CRM_DATA_DIR)) {
    const env = p.EnvironmentVariables || {};
    const root = p.WorkingDirectory || null;
    const dataDir = env.CRM_DATA_DIR || (root ? path.join(root, 'data') : null);
    const backupDir = env.CRM_BACKUP_DIR || (dataDir ? path.join(path.dirname(dataDir), 'backups') : null);
    if (dataDir) return { dataDir, backupDir, root, source: 'plist' };
  }
  return null;
}

// LAN addresses for Connection Info — mirrors server/app.js lanAddresses()
// without importing the server (which would load the database). `ifaces` is
// the os.networkInterfaces() map.
export function lanAddressesFrom(ifaces) {
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const iface of list || []) {
      if (iface && iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}
