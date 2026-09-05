import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlist, buildMarker, xmlEscape, isTccProtectedPath, servicePath, launchctlArgs, LABEL,
} from './lib/launchagent.js';

const ARGS = {
  nodeBin: '/Users/o/.nvm/versions/node/v22.15.1/bin/node',
  root: '/Users/o/CallTrack & Co <dev>',
  logDir: '/Users/o/Library/Logs/CallTrack',
};

test('xmlEscape escapes the five XML specials', () => {
  assert.equal(xmlEscape(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
  assert.equal(xmlEscape(null), '');
});

test('buildPlist: escaped paths, environment, KeepAlive{SuccessfulExit:false}, throttle/exit/process type', () => {
  const xml = buildPlist({ ...ARGS, port: 3000 });
  assert.match(xml, /<key>Label<\/key><string>com\.calltrack\.crm<\/string>/);
  // Escaped interpolations — no raw & or < inside values.
  assert.match(xml, /<string>\/Users\/o\/CallTrack &amp; Co &lt;dev&gt;<\/string>/);
  assert.match(xml, /<string>\/Users\/o\/CallTrack &amp; Co &lt;dev&gt;\/server\/index\.js<\/string>/);
  assert.doesNotMatch(xml, /Co & Co/);
  // caffeinate wrapper with node as the tracked process.
  assert.match(xml, /<string>\/usr\/bin\/caffeinate<\/string>\s*<string>-s<\/string>\s*<string>\/Users\/o\/\.nvm\/versions\/node\/v22\.15\.1\/bin\/node<\/string>/);
  // Environment.
  assert.match(xml, /<key>PATH<\/key><string>\/Users\/o\/\.nvm\/versions\/node\/v22\.15\.1\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.match(xml, /<key>NODE_ENV<\/key><string>production<\/string>/);
  assert.match(xml, /<key>PORT<\/key><string>3000<\/string>/);
  // Restart policy.
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>\s*<\/dict>/);
  assert.match(xml, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.match(xml, /<key>ExitTimeOut<\/key><integer>20<\/integer>/);
  assert.match(xml, /<key>ProcessType<\/key><string>Interactive<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  // Logs outside Desktop/Documents.
  assert.match(xml, /<key>StandardOutPath<\/key><string>\/Users\/o\/Library\/Logs\/CallTrack\/calltrack\.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key><string>\/Users\/o\/Library\/Logs\/CallTrack\/calltrack-error\.log<\/string>/);
  // Well-formed enough for a plist parser: balanced dict/array tags.
  assert.equal((xml.match(/<dict>/g) || []).length, (xml.match(/<\/dict>/g) || []).length);
  assert.equal((xml.match(/<array>/g) || []).length, (xml.match(/<\/array>/g) || []).length);
});

test('buildPlist: optional CRM_DATA_DIR / CRM_BACKUP_DIR / extra env; required args enforced', () => {
  const xml = buildPlist({ ...ARGS, dataDir: '/Volumes/X/data', backupDir: '/Volumes/X/backups', extraEnv: { CRM_LOG_LEVEL: 'debug' } });
  assert.match(xml, /<key>CRM_DATA_DIR<\/key><string>\/Volumes\/X\/data<\/string>/);
  assert.match(xml, /<key>CRM_BACKUP_DIR<\/key><string>\/Volumes\/X\/backups<\/string>/);
  assert.match(xml, /<key>CRM_LOG_LEVEL<\/key><string>debug<\/string>/);
  assert.doesNotMatch(xml, /<key>PORT<\/key>/);
  assert.throws(() => buildPlist({ root: '/x' }), /required/);
});

test('the desktop-app marker records where the service keeps its data', () => {
  const m = buildMarker({ plistPath: '/Users/o/Library/LaunchAgents/com.calltrack.crm.plist', root: '/Users/o/CallTrack', nodeBin: '/usr/local/bin/node', logDir: '/Users/o/Library/Logs/CallTrack' });
  assert.equal(m.label, LABEL);
  assert.equal(m.dataDir, '/Users/o/CallTrack/data');
  assert.equal(m.backupDir, '/Users/o/CallTrack/backups');
  assert.equal(m.port, 3000);
  assert.match(m.installedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('TCC-protected checkout detection (Desktop/Documents/Downloads under $HOME)', () => {
  const home = '/Users/o';
  assert.equal(isTccProtectedPath('/Users/o/Desktop/CRM FABLE', home), true);
  assert.equal(isTccProtectedPath('/Users/o/Documents/x', home), true);
  assert.equal(isTccProtectedPath('/Users/o/Downloads/x', home), true);
  assert.equal(isTccProtectedPath('/Users/o/CallTrack', home), false);
  assert.equal(isTccProtectedPath('/Users/o/Desktopish', home), false);
  assert.equal(isTccProtectedPath('/opt/calltrack', home), false);
  assert.equal(isTccProtectedPath('/Users/other/Desktop/x', home), false);
});

test('servicePath dedupes and keeps Homebrew ahead of system dirs; launchctl args use the gui domain', () => {
  assert.equal(servicePath({ nodeBin: '/usr/local/bin/node' }), '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  const a = launchctlArgs({ uid: 501, plistPath: '/p.plist' });
  assert.deepEqual(a.bootout, ['bootout', 'gui/501/com.calltrack.crm']);
  assert.deepEqual(a.bootstrap, ['bootstrap', 'gui/501', '/p.plist']);
  assert.deepEqual(a.print, ['print', 'gui/501/com.calltrack.crm']);
});
