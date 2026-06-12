// Installs a macOS LaunchAgent so CallTrack starts automatically when this
// computer logs in, restarts if it crashes, and keeps the Mac awake while
// running (caffeinate -s).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeBin = process.execPath;
const label = 'com.calltrack.crm';
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(agentsDir, `${label}.plist`);
// Logs must live OUTSIDE Desktop/Documents: macOS privacy protection stops
// launchd from opening files there (service fails to spawn with EX_CONFIG).
const logDir = path.join(os.homedir(), 'Library', 'Logs', 'CallTrack');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>${nodeBin}</string>
    <string>${path.join(root, 'server', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, 'calltrack.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'calltrack-error.log')}</string>
</dict>
</plist>
`;

fs.mkdirSync(agentsDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
try { execSync(`launchctl unload ${JSON.stringify(plistPath)} 2>/dev/null`); } catch { /* not loaded */ }
fs.writeFileSync(plistPath, plist);
execSync(`launchctl load ${JSON.stringify(plistPath)}`);

console.log('CallTrack autostart installed!');
console.log(`  - Starts automatically when you log in to this Mac`);
console.log(`  - Restarts automatically if it crashes`);
console.log(`  - Keeps the Mac awake while running`);
console.log(`  - Logs: ${path.join(logDir, 'calltrack.log')}`);
console.log('');
console.log('To remove:  launchctl unload ' + plistPath + ' && rm ' + plistPath);
console.log('');
console.log('IMPORTANT for reliability (one-time setup):');
console.log('  1. System Settings → Users & Groups → turn ON automatic login for this user');
console.log('  2. Give this Mac a fixed IP on your WiFi router (DHCP reservation) — see README');
