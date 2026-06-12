// Captures the documentation screenshots in docs/screenshots/ from a RUNNING
// CallTrack server (point it at a freshly seeded demo DB — never live data).
// Usage: CRM_URL=http://localhost:3460 npx electron scripts/screenshots.js
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const BASE = process.env.CRM_URL || 'http://localhost:3460';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginAs(win, username, password) {
  await win.loadURL(BASE);
  await win.webContents.executeJavaScript(`
    fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '${username}', password: '${password}' }),
    }).then(() => location.reload())
  `);
  await wait(1800);
}

async function shoot(win, route, file, settle = 1800) {
  await win.webContents.executeJavaScript(`window.location.href = '${route}'`);
  await wait(settle);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  console.log('captured', file);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Caller's phone view
  const mobile = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { offscreen: true } });
  await loginAs(mobile, 'priya', 'caller123');
  await shoot(mobile, '/', 'today-mobile.png');

  // Admin desktop views
  const desktop = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true } });
  await loginAs(desktop, 'admin', 'admin123');
  await shoot(desktop, '/reports', 'reports.png', 2500);
  await shoot(desktop, '/leads', 'leads.png');

  // A lead with an EMI schedule (first lead that has a deal)
  const leadId = await desktop.webContents.executeJavaScript(`
    fetch('/api/collections').then(r => r.json())
      .then(d => (d.deals.find(x => x.pending_paise > 0) || d.deals[0]).lead_id)
  `);
  await shoot(desktop, `/leads/${leadId}`, 'lead-detail.png');

  app.quit();
});
