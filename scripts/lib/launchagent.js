// Pure helpers for the macOS LaunchAgent installer (DESK-12 / DESK-14 /
// DESK-22). No side effects here — install-autostart.js / uninstall-autostart.js
// / doctor.js call these and do the launchctl work — so the plist generation
// is unit-tested without touching the live service.
import path from 'node:path';

export const LABEL = 'com.calltrack.crm';

// Every interpolated value goes through this: a checkout path containing
// '&', '<' or a quote would otherwise produce an invalid plist that launchd
// silently refuses to load.
export function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// launchd's default PATH is /usr/bin:/bin:/usr/sbin:/sbin — Homebrew tools
// (ffmpeg for recordings, etc.) are invisible without this.
export function servicePath({ nodeBin } = {}) {
  const parts = [];
  if (nodeBin) parts.push(path.dirname(nodeBin));
  parts.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  return [...new Set(parts)].join(':');
}

// Anything under ~/Desktop, ~/Documents or ~/Downloads is TCC-protected: a
// launchd-spawned process gets EPERM on data/ there until the user grants
// Files-and-Folders access — a silent, confusing failure (DESK-12).
export function isTccProtectedPath(p, homedir) {
  const rel = path.relative(homedir, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const first = rel.split(path.sep)[0];
  return ['Desktop', 'Documents', 'Downloads'].includes(first);
}

export function buildPlist({
  label = LABEL, nodeBin, root, logDir, port, dataDir, backupDir, extraEnv = {},
} = {}) {
  if (!nodeBin || !root || !logDir) throw new Error('buildPlist: nodeBin, root and logDir are required');
  const env = {
    PATH: servicePath({ nodeBin }),
    NODE_ENV: 'production',
    ...(port ? { PORT: String(port) } : {}),
    ...(dataDir ? { CRM_DATA_DIR: dataDir } : {}),
    ...(backupDir ? { CRM_BACKUP_DIR: backupDir } : {}),
    ...extraEnv,
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(path.join(root, 'server', 'index.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(logDir, 'calltrack.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(logDir, 'calltrack-error.log'))}</string>
</dict>
</plist>
`;
}

// The marker the desktop app reads (desktop/lib/service.js) to know a service
// owns this machine's data and it must never self-host (DESK-5).
export function buildMarker({ label = LABEL, plistPath, root, nodeBin, dataDir, backupDir, logDir, port } = {}) {
  return {
    label,
    plist: plistPath,
    root,
    node: nodeBin,
    dataDir: dataDir || path.join(root, 'data'),
    backupDir: backupDir || path.join(root, 'backups'),
    logDir,
    port: port || 3000,
    installedAt: new Date().toISOString(),
  };
}

// launchctl invocations (modern bootstrap/bootout API, per-user GUI domain).
export function launchctlArgs({ uid, plistPath, label = LABEL } = {}) {
  const domain = `gui/${uid}`;
  return {
    bootout: ['bootout', `${domain}/${label}`],
    bootstrap: ['bootstrap', domain, plistPath],
    kickstart: ['kickstart', '-k', `${domain}/${label}`],
    print: ['print', `${domain}/${label}`],
  };
}
