import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseGithubLatest, decideUpdate, isCheckDue, parseVersion } from './updates.js';

test('compareVersions handles v-prefix, numeric ordering and junk', () => {
  assert.equal(compareVersions('1.2.2', '1.2.3'), -1);
  assert.equal(compareVersions('v1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('1.2.2', 'v1.2.2'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.2', 'latest'), null);
  assert.deepEqual(parseVersion('2.0.0-beta.1'), [2, 0, 0]);
  assert.equal(parseVersion('x'), null);
});

test('parseGithubLatest only trusts github.com html_url and a semver tag', () => {
  assert.deepEqual(parseGithubLatest({ tag_name: 'v1.2.3', html_url: 'https://github.com/lapaasindia/calltrack-crm/releases/tag/v1.2.3' }),
    { version: '1.2.3', url: 'https://github.com/lapaasindia/calltrack-crm/releases/tag/v1.2.3' });
  assert.deepEqual(parseGithubLatest({ tag_name: 'v1.2.3', html_url: 'https://evil.example/x' }), { version: '1.2.3', url: null });
  assert.equal(parseGithubLatest({ tag_name: 'nightly' }), null);
  assert.equal(parseGithubLatest(null), null);
  assert.equal(parseGithubLatest('string'), null);
});

test('decideUpdate picks the newest of host / github, and stays quiet when current', () => {
  const rel = 'https://github.com/lapaasindia/calltrack-crm/releases';
  assert.deepEqual(decideUpdate({ current: '1.2.2', hostVersion: '1.2.2', latest: { version: '1.2.2', url: rel } }), { available: false });
  assert.deepEqual(decideUpdate({ current: '1.2.2', hostVersion: '1.2.3', latest: null, releasesUrl: rel }),
    { available: true, version: '1.2.3', source: 'host', url: rel });
  const both = decideUpdate({ current: '1.2.2', hostVersion: '1.2.3', latest: { version: '1.3.0', url: `${rel}/tag/v1.3.0` }, releasesUrl: rel });
  assert.equal(both.version, '1.3.0');
  assert.equal(both.source, 'github');
  // A host OLDER than the app is not an "update".
  assert.deepEqual(decideUpdate({ current: '1.2.2', hostVersion: '1.1.0', latest: null }), { available: false });
  // Offline / garbage never throws.
  assert.deepEqual(decideUpdate({ current: '1.2.2', hostVersion: undefined, latest: { version: 'x' } }), { available: false });
});

test('isCheckDue: once a day', () => {
  const now = Date.parse('2026-09-05T10:00:00Z');
  assert.equal(isCheckDue(undefined, now), true);
  assert.equal(isCheckDue('garbage', now), true);
  assert.equal(isCheckDue('2026-09-04T09:59:00Z', now), true);
  assert.equal(isCheckDue('2026-09-05T02:00:00Z', now), false);
});
