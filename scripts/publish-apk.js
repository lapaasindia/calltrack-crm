// Publishes a built release APK to the office server's download folder so
// phones can install it and the in-app updater can find it. Writes the APK
// and a version.json (read by GET /api/app-version).
// Usage: node scripts/publish-apk.js <path-to-release.apk> [versionCode] [versionName]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '..', 'data');
const APK_DIR = path.join(DATA_DIR, 'apk');

const src = process.argv[2];
const versionCode = parseInt(process.argv[3], 10) || 1;
const versionName = process.argv[4] || '1.0.0';

if (!src || !fs.existsSync(src)) {
  console.error('Usage: node scripts/publish-apk.js <release.apk> [versionCode] [versionName]');
  process.exit(1);
}

fs.mkdirSync(APK_DIR, { recursive: true });
const bytes = fs.readFileSync(src);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(APK_DIR, 'calltrack.apk'), bytes);
fs.writeFileSync(path.join(APK_DIR, 'version.json'), JSON.stringify({
  versionCode, versionName, sha256,
  size: bytes.length,
}, null, 2));

console.log(`Published CallTrack APK v${versionName} (code ${versionCode}, ${(bytes.length / 1048576).toFixed(1)} MB)`);
console.log(`  → ${path.join(APK_DIR, 'calltrack.apk')}`);
console.log('  Phones download it from:  http://<office-server>/download/calltrack.apk');
