// Removes the macOS LaunchAgent installed by install-autostart.js. Data,
// backups and logs are left untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchctlArgs, LABEL } from './lib/launchagent.js';

if (process.platform !== 'darwin') {
  console.error('uninstall-autostart is macOS-only.');
  process.exit(1);
}

const home = os.homedir();
const plistPath = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const markerPath = path.join(home, 'Library', 'Application Support', 'CallTrack', 'service.json');
const lc = launchctlArgs({ uid: os.userInfo().uid, plistPath });

let stopped = false;
try { execFileSync('launchctl', lc.bootout, { stdio: 'ignore' }); stopped = true; } catch { /* not loaded */ }
const hadPlist = fs.existsSync(plistPath);
fs.rmSync(plistPath, { force: true });
fs.rmSync(markerPath, { force: true });

console.log(hadPlist ? 'CallTrack autostart removed.' : 'No CallTrack LaunchAgent was installed.');
if (stopped) console.log('  - The background service was stopped.');
console.log('  - Your data, backups and logs were NOT deleted.');
console.log('  - The desktop app will now host the server itself when opened in host mode.');
