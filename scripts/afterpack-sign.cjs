// electron-builder afterPack hook (macOS only): give the packaged .app a VALID
// deep ad-hoc code signature.
//
// We don't ship a paid Apple Developer ID, so electron-builder skips signing
// and leaves the stale Electron ad-hoc seal in place. Once our own files are
// added to the bundle that seal no longer matches the contents, so the
// signature is INVALID. On Apple Silicon macOS reports an invalid signature on
// a quarantined app as "CallTrack CRM is damaged and can't be opened" — and
// right-click -> Open will NOT bypass that.
//
// Re-signing with a fresh deep ad-hoc signature ("-") makes the signature valid
// again (under our own identifier, com.calltrack.crm). That downgrades the
// scary "damaged" error to the normal "unidentified developer" prompt, which
// right-click -> Open (or `xattr -cr <app>`) clears. It does NOT remove the
// prompt entirely — only Apple notarization (paid) does that.
//
// Runs once per macOS arch (arm64, x64); skipped for the Windows build.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename; // "CallTrack CRM"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`[afterPack] deep ad-hoc signed ${appPath}`);
};
