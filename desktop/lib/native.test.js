import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { nativeBindingPath, nativeDirName, NATIVE_FILE } from './native.js';

test('native binding path: Resources/native when packaged, build/native in dev', () => {
  assert.equal(
    nativeBindingPath({ isPackaged: true, resourcesPath: '/Applications/CallTrack CRM.app/Contents/Resources', platform: 'darwin', arch: 'arm64' }),
    path.join('/Applications/CallTrack CRM.app/Contents/Resources', 'native', 'darwin-arm64', NATIVE_FILE),
  );
  assert.equal(
    nativeBindingPath({ isPackaged: false, root: '/repo', platform: 'win32', arch: 'x64' }),
    path.join('/repo', 'build', 'native', 'win32-x64', NATIVE_FILE),
  );
  assert.equal(nativeDirName({ platform: 'darwin', arch: 'x64' }), 'darwin-x64');
});
