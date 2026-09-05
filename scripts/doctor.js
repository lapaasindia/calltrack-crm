// `npm run doctor` — one-screen health check for the always-on host (DESK-12).
// Read-only: prints launchctl state, the tail of both service logs, whether
// the port answers as CallTrack, and the pinned node binary. Never restarts
// or modifies anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { launchctlArgs, LABEL, isTccProtectedPath } from './lib/launchagent.js';

const home = os.homedir();
const plistPath = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const markerPath = path.join(home, 'Library', 'Application Support', 'CallTrack', 'service.json');
const logDir = path.join(home, 'Library', 'Logs', 'CallTrack');

const section = (t) => console.log(`\n== ${t} ==`);
const tail = (file, n = 15) => {
  try {
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    return lines.slice(-n).join('\n') || '(empty)';
  } catch { return '(missing)'; }
};

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ raw: body.slice(0, 80) }); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

let marker = null;
try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { /* none */ }
const port = Number(process.env.PORT) || marker?.port || 3000;

section('Service definition');
console.log(`platform: ${process.platform} ${os.release()}   node (this shell): ${process.version}`);
console.log(`plist:    ${plistPath} ${fs.existsSync(plistPath) ? '(present)' : '(MISSING — run npm run install-autostart)'}`);
console.log(`marker:   ${markerPath} ${marker ? '(present)' : '(missing)'}`);
if (marker) {
  console.log(`root:     ${marker.root}`);
  console.log(`data:     ${marker.dataDir}`);
  console.log(`node:     ${marker.node} ${fs.existsSync(marker.node) ? '(ok)' : '(MISSING — nvm removed it? re-run install-autostart)'}`);
  if (isTccProtectedPath(marker.root, home)) {
    console.log('warning:  checkout is under Desktop/Documents/Downloads — TCC may block the service (see docs/TROUBLESHOOTING.md)');
  }
}

if (process.platform === 'darwin') {
  section(`launchctl print gui/${os.userInfo().uid}/${LABEL}`);
  try {
    const out = execFileSync('launchctl', launchctlArgs({ uid: os.userInfo().uid, plistPath }).print, { encoding: 'utf8' });
    const keep = out.split('\n').filter((l) => /\b(state|pid|last exit|runs|path|program|error)\b/i.test(l));
    console.log(keep.join('\n') || out.slice(0, 1200));
  } catch (err) {
    console.log(`not loaded (${err.message.split('\n')[0]})`);
  }
}

section(`/api/health on 127.0.0.1:${port}`);
const health = await probe(port);
if (health && health.app === 'calltrack-crm') console.log(`OK — CallTrack CRM v${health.version} is answering`);
else if (health) console.log(`something else answers on this port: ${JSON.stringify(health)}`);
else console.log('no answer (service down, still starting, or a different port)');

section(`tail ${path.join(logDir, 'calltrack.log')}`);
console.log(tail(path.join(logDir, 'calltrack.log')));
section(`tail ${path.join(logDir, 'calltrack-error.log')}`);
console.log(tail(path.join(logDir, 'calltrack-error.log')));
if (marker?.dataDir) {
  const serverLog = path.join(marker.dataDir, 'logs', 'server.log');
  section(`tail ${serverLog}`);
  console.log(tail(serverLog, 10));
}
console.log('');
