// Generates build/icon.png (1024px, for installers) and desktop/tray.png
// (32px) by rendering an SVG in an offscreen Electron window — fully local.
// Run: npx electron desktop/make-icon.js
import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b54f0"/>
      <stop offset="1" stop-color="#3730a3"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <g transform="translate(232,232) scale(23.3)">
    <path fill="#ffffff" d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
  </g>
  <circle cx="744" cy="306" r="86" fill="#34d399"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1024,
    webPreferences: { offscreen: true },
  });
  const html = `<body style="margin:0;background:transparent">${SVG}</body>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });

  fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), image.toPNG());
  const tray = nativeImage.createFromBuffer(image.toPNG()).resize({ width: 32, height: 32 });
  fs.writeFileSync(path.join(__dirname, 'tray.png'), tray.toPNG());
  console.log('Icons written: build/icon.png (1024) + desktop/tray.png (32)');
  app.quit();
});
