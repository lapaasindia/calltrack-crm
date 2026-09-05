// Generates the PWA / favicon PNGs from the desktop icon (build/icon.png).
// Uses `sharp` from the ROOT node_modules (it is an Electron build dep there)
// — nothing is added to the client's dependency tree. Run: npm run icons
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../build/icon.png');
const out = path.resolve(here, '../public/icons');

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('sharp is not installed in the root node_modules — icons not regenerated (existing files kept).');
  process.exit(0);
}
if (!fs.existsSync(src)) { console.error(`missing ${src}`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

const plain = [
  ['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180],
  ['favicon-32.png', 32], ['favicon-16.png', 16],
];
for (const [name, size] of plain) {
  await sharp(src).resize(size, size).png().toFile(path.join(out, name));
}
// Maskable: the icon sits in the inner 80% "safe zone" over the brand colour.
const inner = Math.round(512 * 0.8);
const icon = await sharp(src).resize(inner, inner).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#1a1f36' } })
  .composite([{ input: icon, gravity: 'centre' }])
  .png()
  .toFile(path.join(out, 'icon-maskable-512.png'));
console.log('icons written to', out);
