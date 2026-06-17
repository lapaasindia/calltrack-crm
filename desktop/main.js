// CallTrack desktop app. Two modes, chosen on first launch:
//  - host: runs the embedded server + database on THIS computer (data in the
//    OS app-data folder), serves the office LAN, shows the UI.
//  - join: connects to the host computer's address over the office network.
// Everything stays on the local machines — no cloud anywhere.
import {
  app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, powerSaveBlocker, clipboard,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test hooks (used by automated checks; harmless in production).
if (process.env.CALLTRACK_USERDATA) app.setPath('userData', process.env.CALLTRACK_USERDATA);

const USER_DATA = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const DATA_DIR = path.join(USER_DATA, 'data');
const BACKUP_DIR = path.join(USER_DATA, 'backups');

let mainWindow = null;
let setupWindow = null;
let tray = null;
let serverInfo = null; // { port, urls } when hosting
let quitting = false;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
}
function writeConfig(cfg) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

async function isCallTrack(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    return data.app === 'calltrack-crm';
  } catch { return false; }
}

// Only hand SAFE schemes to the OS shell. Renderer content (which over plain
// http join mode could be MITM'd, or could carry a user-set meeting_url) must
// never be able to launch file:, smb:/UNC, or custom protocols like ms-msdt:
// that turn a link into native execution (audit H-5).
const SAFE_EXTERNAL_SCHEME = /^(https?|mailto|tel):/i;
function safeOpenExternal(target) {
  if (SAFE_EXTERNAL_SCHEME.test(String(target || ''))) {
    shell.openExternal(target).catch(() => {});
  } else {
    console.warn('[calltrack] blocked unsafe external URL:', target);
  }
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 380,
    minHeight: 600,
    title: 'CallTrack CRM',
    backgroundColor: '#1a1f36',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.loadURL(url);

  // External links (wa.me, tel:) must open outside the app window — but only
  // safe schemes (audit H-5).
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    safeOpenExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url) && !target.startsWith('http://localhost') && !target.startsWith('http://127.0.0.1')) {
      const cfg = readConfig();
      if (cfg?.mode !== 'join' || !target.startsWith(cfg.serverUrl)) {
        e.preventDefault();
        safeOpenExternal(target);
      }
    }
  });

  // In host mode the server must keep running for the team even when the
  // window is closed — hide instead of quit.
  mainWindow.on('close', (e) => {
    const cfg = readConfig();
    if (!quitting && cfg?.mode === 'host') {
      e.preventDefault();
      mainWindow.hide();
      ensureTray();
    }
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc, failedUrl) => {
    if (failedUrl?.startsWith('http')) openSetup(`Could not reach ${failedUrl} — is the main computer on?`);
  });
}

function openSetup(error = '') {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 560,
    height: 700,
    resizable: false,
    title: 'CallTrack Setup',
    backgroundColor: '#1a1f36',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  setupWindow.removeMenu?.();
  setupWindow.loadFile(path.join(__dirname, 'setup.html'), { query: error ? { error } : {} });
}

async function startHost(cfg) {
  const wantPort = cfg.port || 3000;

  // If a CallTrack server is already running on the wanted port (e.g. the
  // LaunchAgent service on this Mac), attach to it instead of starting our own.
  // Doing this BEFORE importing the server module means we never load the
  // native better-sqlite3 binary inside Electron — which avoids an ABI mismatch
  // with the Node build and prevents a second database from opening.
  if (await isCallTrack(`http://127.0.0.1:${wantPort}`)) {
    serverInfo = { port: wantPort, urls: null, attached: true };
    createMainWindow(`http://127.0.0.1:${serverInfo.port}`);
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  process.env.CRM_DATA_DIR = DATA_DIR;
  process.env.CRM_BACKUP_DIR = BACKUP_DIR;

  const { startServer } = await import('../server/app.js');
  const candidates = [wantPort, 3001, 3002, 3003, 8080, 8081];
  let lastErr = null;
  for (const port of candidates) {
    try {
      serverInfo = await startServer({ port });
      if (port !== wantPort) writeConfig({ ...cfg, port });
      break;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE') throw err;
      // Port busy: if it's another CallTrack server (e.g. the LaunchAgent
      // setup), just attach to it instead of fighting over the port.
      if (await isCallTrack(`http://127.0.0.1:${port}`)) {
        serverInfo = { port, urls: null, attached: true };
        break;
      }
    }
  }
  if (!serverInfo) throw lastErr || new Error('No free port found');

  // Keep the machine from sleeping while it serves the team.
  powerSaveBlocker.start('prevent-app-suspension');
  createMainWindow(`http://127.0.0.1:${serverInfo.port}`);
}

function startJoin(cfg) {
  createMainWindow(cfg.serverUrl);
}

async function boot() {
  const cfg = readConfig();
  if (!cfg) return openSetup();
  try {
    if (cfg.mode === 'host') await startHost(cfg);
    else startJoin(cfg);
  } catch (err) {
    console.error('[calltrack] start failed:', err);
    openSetup(`Could not start: ${err.message}`);
  }
}

function connectionInfo() {
  const cfg = readConfig();
  if (cfg?.mode === 'join') return `Connected to: ${cfg.serverUrl}`;
  if (!serverInfo) return 'Server not running.';
  if (serverInfo.attached) {
    return `Using the CallTrack server already running on this computer (port ${serverInfo.port}).`;
  }
  const lines = [
    'Team members connect using any of these addresses',
    '(phone browsers work too — same office WiFi):',
    '',
    ...(serverInfo.urls?.lan || []),
    serverInfo.urls?.mdns || '',
  ].filter(Boolean);
  return lines.join('\n');
}

function ensureTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, 'tray.png');
    tray = new Tray(iconPath);
    tray.setToolTip('CallTrack CRM — server running');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open CallTrack', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: 'Connection info', click: () => dialog.showMessageBox({ message: 'CallTrack CRM', detail: connectionInfo() }) },
      { type: 'separator' },
      { label: 'Quit (stops the server)', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch { /* tray is best-effort */ }
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'CallTrack',
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: 'Quit CallTrack', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } },
      ],
    }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Server',
      submenu: [
        {
          label: 'Connection Info (for the team)…',
          click: async () => {
            const info = connectionInfo();
            const { response } = await dialog.showMessageBox({
              message: 'CallTrack CRM', detail: info, buttons: ['Copy', 'OK'], defaultId: 1,
            });
            if (response === 0) clipboard.writeText(info);
          },
        },
        { label: 'Open Backups Folder', click: () => shell.openPath(BACKUP_DIR) },
        { label: 'Open Data Folder', click: () => shell.openPath(USER_DATA) },
        { type: 'separator' },
        {
          label: 'Change Setup (host / join)…',
          click: async () => {
            const { response } = await dialog.showMessageBox({
              message: 'Change how this app connects?',
              detail: 'Your data is NOT deleted — this only re-opens the host/join chooser. The app will restart.',
              buttons: ['Cancel', 'Change Setup'], defaultId: 0, cancelId: 0,
            });
            if (response === 1) {
              fs.rmSync(CONFIG_PATH, { force: true });
              quitting = true;
              app.relaunch();
              app.exit(0);
            }
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC from the setup window ----------
ipcMain.handle('setup:choose', async (e, choice) => {
  if (choice.mode === 'join') {
    let url = String(choice.serverUrl || '').trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(url)) url = `http://${url}`;
    if (!/:\d+$/.test(url.replace(/^https?:\/\//, ''))) url = `${url}:3000`;
    if (!(await isCallTrack(url))) {
      return { ok: false, error: 'No CallTrack server found at that address. Check the address and that the main computer is on.' };
    }
    writeConfig({ mode: 'join', serverUrl: url });
  } else {
    writeConfig({ mode: 'host', port: 3000 });
    if (choice.openAtLogin) app.setLoginItemSettings({ openAtLogin: true });
  }
  setupWindow?.close();
  setupWindow = null;
  await boot();
  return { ok: true };
});

ipcMain.handle('setup:restore', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Pick a CallTrack backup or database file',
    filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  const dest = path.join(DATA_DIR, 'crm.sqlite');
  if (fs.existsSync(dest)) {
    return { ok: false, error: 'This computer already has CallTrack data. Delete it first (Server → Open Data Folder) if you really want to replace it.' };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.copyFileSync(filePaths[0], dest);
  return { ok: true, file: path.basename(filePaths[0]) };
});

// ---------- app lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow || setupWindow;
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    buildMenu();
    boot();
    // Auto-setup hook for automated testing.
    if (process.env.CALLTRACK_AUTOSETUP === 'host' && !readConfig()) {
      writeConfig({ mode: 'host', port: Number(process.env.CALLTRACK_PORT) || 3000 });
      setupWindow?.close();
      boot();
    }
  });

  app.on('activate', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else if (!setupWindow) boot();
  });

  app.on('window-all-closed', () => {
    // Host mode never reaches here on close (window hides instead); join
    // mode and setup follow normal platform behavior.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { quitting = true; });
}
