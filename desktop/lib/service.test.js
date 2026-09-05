import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parsePlist, servicePathsFrom, serviceMarkerPath, launchAgentPlistPath, lanAddressesFrom, SERVICE_LABEL,
} from './service.js';

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.calltrack.crm</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>/Users/o/.nvm/versions/node/v22.15.1/bin/node</string>
    <string>/Users/o/Desktop/CRM &amp; Co/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/o/Desktop/CRM &amp; Co</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>`;

test('parsePlist reads strings, ints, bools, arrays and one level of dict (XML-unescaped)', () => {
  const p = parsePlist(PLIST);
  assert.equal(p.Label, SERVICE_LABEL);
  assert.equal(p.WorkingDirectory, '/Users/o/Desktop/CRM & Co');
  assert.deepEqual(p.ProgramArguments.slice(0, 2), ['/usr/bin/caffeinate', '-s']);
  assert.equal(p.ProgramArguments[3], '/Users/o/Desktop/CRM & Co/server/index.js');
  assert.equal(p.EnvironmentVariables.NODE_ENV, 'production');
  assert.equal(p.RunAtLoad, true);
  assert.equal(p.ThrottleInterval, 30);
  assert.deepEqual(parsePlist(null), {});
});

test('servicePathsFrom prefers the install marker, then the plist', () => {
  assert.deepEqual(
    servicePathsFrom({ marker: { dataDir: '/srv/ct/data', backupDir: '/srv/ct/backups', root: '/srv/ct' }, plist: PLIST }),
    { dataDir: '/srv/ct/data', backupDir: '/srv/ct/backups', root: '/srv/ct', source: 'marker' },
  );
  const fromPlist = servicePathsFrom({ plist: PLIST });
  assert.equal(fromPlist.source, 'plist');
  assert.equal(fromPlist.dataDir, path.join('/Users/o/Desktop/CRM & Co', 'data'));
  assert.equal(fromPlist.backupDir, path.join('/Users/o/Desktop/CRM & Co', 'backups'));
  // CRM_DATA_DIR in the plist environment wins over WorkingDirectory/data.
  const envPlist = PLIST.replace('<key>NODE_ENV</key>', '<key>CRM_DATA_DIR</key><string>/Volumes/X/ctdata</string><key>NODE_ENV</key>');
  assert.equal(servicePathsFrom({ plist: envPlist }).dataDir, '/Volumes/X/ctdata');
  assert.equal(servicePathsFrom({}), null);
  assert.equal(servicePathsFrom({ plist: '<plist><dict></dict></plist>' }), null);
});

test('marker / plist locations are per-user and platform specific', () => {
  assert.equal(serviceMarkerPath({ platform: 'darwin', homedir: '/Users/o' }),
    '/Users/o/Library/Application Support/CallTrack/service.json');
  assert.equal(serviceMarkerPath({ platform: 'win32', homedir: 'C:\\Users\\o', appData: 'C:\\Users\\o\\AppData\\Roaming' }),
    path.join('C:\\Users\\o\\AppData\\Roaming', 'CallTrack', 'service.json'));
  assert.equal(launchAgentPlistPath({ homedir: '/Users/o' }), '/Users/o/Library/LaunchAgents/com.calltrack.crm.plist');
});

test('lanAddressesFrom picks external IPv4 addresses only', () => {
  const ifaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.50', internal: false }],
    utun0: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
    broken: undefined,
  };
  assert.deepEqual(lanAddressesFrom(ifaces), ['192.168.1.50', '10.8.0.2']);
  assert.deepEqual(lanAddressesFrom(null), []);
});
