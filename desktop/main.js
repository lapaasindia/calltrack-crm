// CallTrack desktop app. Three ways it can run, chosen on first launch:
//  - host: runs the embedded server + database on THIS computer (data in the
//    OS app-data folder), serves the office LAN, shows the UI. If a CallTrack
//    background service (LaunchAgent) is installed on this machine the app
//    ATTACHES to it instead of starting a second server (DESK-5).
//  - join: connects to the host computer's address over the office network.
// Everything stays on the local machines — no cloud anywhere (the only
// outbound request is a once-a-day version check that can be switched off).
import {
  app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, powerSaveBlocker, clipboard, session,
  utilityProcess, Notification,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  decideNavigation, decideRedirect, decideFrameNavigation, decideWindowOpen, decidePermission,
  isSafeExternalScheme,
} from './lib/navigation.js';
import { dedupeFilename, sanitizeFilename, downloadPolicy, completedDownloads } from './lib/downloads.js';
import { checkRestoreCandidate, interpretCheck, sidecarNames, SQLITE_HEADER_LEN } from './lib/restore.js';
import { serviceMarkerPath, launchAgentPlistPath, servicePathsFrom, lanAddressesFrom } from './lib/service.js';
import { createFileLogger } from './lib/logfile.js';
import { parseGithubLatest, decideUpdate, isCheckDue } from './lib/updates.js';
import { nativeBindingPath } from './lib/native.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- dev / test hooks (DESK-18: never active in a packaged build) ----------
const DEV = !app.isPackaged;
const SMOKE_URL = DEV ? process.env.CALLTRACK_SMOKE_URL : undefined;
const AUTOSETUP = DEV ? process.env.CALLTRACK_AUTOSETUP : undefined;
const ALLOW_SELF_HOST = DEV && process.env.CALLTRACK_ALLOW_SELF_HOST === '1';
if (DEV && process.env.CALLTRACK_USERDATA) app.setPath('userData', process.env.CALLTRACK_USERDATA);

const USER_DATA = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const PREVIOUS_CONFIG_PATH = path.join(USER_DATA, 'config.previous.json');
const STATE_PATH = path.join(USER_DATA, 'state.json');
const DATA_DIR = path.join(USER_DATA, 'data');
const BACKUP_DIR = path.join(USER_DATA, 'backups');
const LOG_DIR = path.join(USER_DATA, 'logs');
const DB_FILE = path.join(DATA_DIR, 'crm.sqlite');
const RELEASES_URL = 'https://github.com/lapaasindia/calltrack-crm/releases';
const RELEASES_API = 'https://api.github.com/repos/lapaasindia/calltrack-crm/releases/latest';
const SERVICE_WAIT_MS = 60000;
const OFFLINE_POLL_MS = 5000;

const log = createFileLogger({ dir: LOG_DIR, echo: true });
log.info(`CallTrack CRM v${app.getVersion()} electron ${process.versions.electron} ${process.platform}/${process.arch} packaged=${app.isPackaged} userData=${USER_DATA}`);

// Hardened renderer settings shared by every window that shows remote content.
const SAFE_WEBPREFS = { contextIsolation: true, nodeIntegration: false, sandbox: true };

let mainWindow = null;
let setupWindow = null;
let tray = null;
let serverInfo = null;   // { port, urls, attached, stop? }
let serverVersion = null;
let appUrl = null;       // the in-app origin the main window shows
let quitting = false;
let serverStopped = false;
let booting = null;      // promise guard (DESK-5c): one boot at a time
let offlinePoll = null;
let updateInfo = null;
const setupContents = new WeakSet();

// Counters the desktop smoke test (npm run test:desktop) asserts on. Only
// ever read when CALLTRACK_SMOKE_URL is set; harmless otherwise.
const smokeStats = {
  deniedPermissions: [], cancelledFrameNavs: [], cancelledRedirects: [], allowedPopups: [], openedExternal: [],
};
const downloadListeners = new Set();

// ---------- config / state ----------
function validConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  if (cfg.mode === 'host') {
    const port = Number(cfg.port) || 3000;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { ...cfg, mode: 'host', port };
  }
  if (cfg.mode === 'join') {
    const u = normalizeServerUrl(cfg.serverUrl);
    if (!u) return null;
    return { ...cfg, mode: 'join', serverUrl: u };
  }
  return null;
}
function readConfig() {
  try { return validConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch { return null; }
}
function writeConfig(cfg) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
function readPreviousConfig() {
  try { return validConfig(JSON.parse(fs.readFileSync(PREVIOUS_CONFIG_PATH, 'utf8'))); } catch { return null; }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || {}; } catch { return {}; }
}
function writeState(patch) {
  const next = { ...readState(), ...patch };
  try { fs.mkdirSync(USER_DATA, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2)); } catch (err) { log.warn('state write failed', err.message); }
  return next;
}

// "http://192.168.1.50:3000" — scheme, host and port only. Anything else
// (userinfo, path, query, non-http scheme, >200 chars) is rejected.
function normalizeServerUrl(input) {
  let s = String(input == null ? '' : input).trim().replace(/\/+$/, '');
  if (!s || s.length > 200) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname && u.pathname !== '/') return null;
  if (!u.port) u.port = '3000';
  return u.origin;
}

// ---------- helpers ----------
async function fetchHealth(base, timeoutMs = 4000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${String(base).replace(/\/$/, '')}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    return data && data.app === 'calltrack-crm' ? data : null;
  } catch { return null; }
}
async function isCallTrack(base) {
  const h = await fetchHealth(base);
  if (h) serverVersion = h.version || serverVersion;
  return !!h;
}

// Only hand SAFE schemes to the OS shell. Renderer content (which over plain
// http join mode could be MITM'd, or could carry a user-set meeting_url) must
// never be able to launch file:, smb:/UNC, or custom protocols like ms-msdt:
// that turn a link into native execution (audit H-5). The scheme allowlist
// lives in ./lib/navigation.js so it is unit-tested.
function safeOpenExternal(target) {
  if (!isSafeExternalScheme(target)) {
    log.warn('blocked unsafe external URL:', String(target).slice(0, 200));
    return;
  }
  if (SMOKE_URL) { smokeStats.openedExternal.push(target); return; }
  shell.openExternal(target).catch((err) => log.warn('openExternal failed', err.message));
}

function policyCtx() {
  return { windowUrl: appUrl, config: readConfig() };
}

// A CallTrack background service on this machine (scripts/install-autostart.js)
// owns the data; the desktop app must attach to it, never start a rival host.
function serviceInstalled() {
  const home = os.homedir();
  const marker = serviceMarkerPath({ homedir: home, appData: process.env.APPDATA });
  let markerData = null;
  try { markerData = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* none */ }
  let plist = null;
  if (process.platform === 'darwin') {
    try { plist = fs.readFileSync(launchAgentPlistPath({ homedir: home }), 'utf8'); } catch { /* none */ }
  }
  if (!markerData && !plist) return null;
  return { marker: markerData, plist, paths: servicePathsFrom({ marker: markerData, plist }) };
}

function lanUrls(port, scheme = 'http') {
  return lanAddressesFrom(os.networkInterfaces()).map((ip) => `${scheme}://${ip}:${port}`);
}

// Where downloads (the report CSV exports) are saved. The desktop smoke test
// overrides this; otherwise the OS Downloads folder, falling back to temp if it
// can't be resolved (locked-down / OneDrive-redirected Windows profiles can
// make getPath throw).
function downloadsDir() {
  if (DEV && process.env.CALLTRACK_SMOKE_DOWNLOAD_DIR) return process.env.CALLTRACK_SMOKE_DOWNLOAD_DIR;
  for (const key of ['downloads', 'temp']) {
    try { return app.getPath(key); } catch { /* try next */ }
  }
  return USER_DATA;
}

// ---------- downloads (DESK-9 / DEP-5) ----------
// Allow-listed document/data/media types are saved straight to the Downloads
// folder with a non-colliding, cross-platform-safe name and revealed. Every
// other type (executables, scripts, installers …) goes through the OS Save
// dialog and is never auto-revealed.
//
// CRITICAL: this callback must be SYNCHRONOUS up to item.setSavePath() — if any
// await runs first, Electron falls back to the Save As dialog or ignores the
// path. So the dedupe uses fs.existsSync, never fs.promises. Registered exactly
// ONCE on the shared default session.
function installDownloadHandler(ses) {
  ses.on('will-download', (event, item) => {
    const original = item.getFilename() || 'download';
    const dir = downloadsDir();
    const policy = downloadPolicy(original);
    const finish = (name, state, savePath) => {
      for (const cb of downloadListeners) { try { cb({ name, state, savePath, policy }); } catch { /* ignore */ } }
      log.info(`download ${state}: ${name} (${policy})`);
    };
    if (policy === 'silent') {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
      const name = dedupeFilename(original, (n) => fs.existsSync(path.join(dir, n)));
      const savePath = path.join(dir, name);
      item.setSavePath(savePath);
      item.once('done', (e, state) => {
        finish(name, state, savePath);
        if (SMOKE_URL) return; // no Finder/Explorer windows or dialogs on CI
        if (state === 'completed') {
          try { shell.showItemInFolder(savePath); } catch { /* best effort */ }
        } else if (state === 'interrupted') {
          const opts = { type: 'error', message: 'Download failed', detail: `Could not save ${name}.` };
          (mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, opts) : dialog.showMessageBox(opts)).catch(() => {});
        }
      });
      return;
    }
    // Not allow-listed: show the OS Save dialog with the real name/extension.
    item.setSaveDialogOptions({
      title: `Save ${original}`,
      defaultPath: path.join(dir, sanitizeFilename(original)),
    });
    item.once('done', (e, state) => finish(original, state, item.getSavePath()));
  });
}

// ---------- navigation guards (DESK-2 / DESK-6 / DESK-17) ----------
// Attached to EVERY webContents (main window, same-origin popups, the setup
// window) via app.on('web-contents-created'), so a child window opened by
// window.open inherits exactly the same policy as the window that opened it.
function offlinePageUrl() {
  return pathToFileURL(path.join(__dirname, 'offline.html')).href;
}
function isOfflinePage(contents) {
  try { return contents.getURL().startsWith(offlinePageUrl()); } catch { return false; }
}
// The offline page is a static file with no preload; its two buttons are links
// to calltrack:// pseudo-URLs that will-navigate turns into actions. Honoured
// ONLY when the navigating page is our own offline.html (a remote page cannot
// reach a file: URL, so it cannot forge this).
function handleLocalAction(contents, target) {
  if (!isOfflinePage(contents)) return false;
  if (target === 'calltrack://retry') { pollNow(); return true; }
  if (target === 'calltrack://change-setup') { changeSetup(); return true; }
  return false;
}

function attachGuards(contents) {
  contents.setWindowOpenHandler(({ url: target }) => {
    if (setupContents.has(contents)) return { action: 'deny' };
    const d = decideWindowOpen({ target, ...policyCtx() });
    if (d.action === 'allow') {
      smokeStats.allowedPopups.push(target);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1000, height: 800, autoHideMenuBar: true, backgroundColor: '#ffffff',
          webPreferences: SAFE_WEBPREFS,
        },
      };
    }
    if (d.openExternal) safeOpenExternal(target); else log.warn('blocked popup:', String(target).slice(0, 200));
    return { action: 'deny' };
  });

  contents.on('will-navigate', (e, target) => {
    if (setupContents.has(contents)) { e.preventDefault(); return; }
    if (handleLocalAction(contents, target)) { e.preventDefault(); return; }
    const d = decideNavigation({ target, ...policyCtx() });
    if (d.cancel) {
      e.preventDefault();
      if (d.openExternal) safeOpenExternal(target); else log.warn('blocked navigation:', String(target).slice(0, 200));
    }
  });

  // Server-side redirects never emit will-navigate — same policy (DESK-17).
  contents.on('will-redirect', (e, target) => {
    const d = decideRedirect({ target, ...policyCtx() });
    if (d.cancel) {
      e.preventDefault();
      smokeStats.cancelledRedirects.push(target);
      log.warn('blocked redirect:', String(target).slice(0, 200));
    }
  });

  // Subframes (DESK-2): an <iframe src="smb://…"> only ever reached
  // will-frame-navigate, which nobody handled, and then Chromium's default-
  // granted openExternal permission. Non-main frames may only load in-app URLs.
  contents.on('will-frame-navigate', (details) => {
    const d = decideFrameNavigation({ target: details.url, isMainFrame: details.isMainFrame, ...policyCtx() });
    if (d.cancel) {
      details.preventDefault();
      smokeStats.cancelledFrameNavs.push(details.url);
      log.warn('blocked subframe navigation:', String(details.url).slice(0, 200));
    }
  });

  contents.on('render-process-gone', (e, details) => {
    log.error('renderer gone', details);
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    setTimeout(() => { try { if (!contents.isDestroyed()) contents.reload(); } catch { /* ignore */ } }, 500);
  });
  contents.on('unresponsive', () => log.warn('renderer unresponsive'));
  contents.on('responsive', () => log.info('renderer responsive again'));
}

// ---------- windows ----------
function createMainWindow(url) {
  appUrl = url;
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 380,
    minHeight: 600,
    title: 'CallTrack CRM',
    backgroundColor: '#1a1f36',
    webPreferences: SAFE_WEBPREFS,
  });
  mainWindow.loadURL(url);

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
  mainWindow.on('closed', () => { mainWindow = null; stopPolling(); });

  // DESK-8: only a MAIN-frame failure of a real http(s) load means the host is
  // unreachable. Subframes fail on their own; -3 ERR_ABORTED is a superseded
  // navigation (a click while loading, reload mid-load) over a working app.
  mainWindow.webContents.on('did-fail-load', (e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (!/^https?:/i.test(failedUrl || '')) return;
    log.warn(`main frame failed to load ${failedUrl}: ${desc} (${code})`);
    showOffline({ mode: 'offline', url: failedUrl, reason: `${desc} (${code})` });
  });
  return mainWindow;
}

// Offline / "service starting" screen (DESK-5a / DESK-8): a static local page
// while the main process polls /api/health and reloads the app on success.
function showOffline({ mode, url, reason = '' }) {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(appUrl || url);
  const query = { mode, url: appUrl || url, reason, version: app.getVersion(), log: log.file };
  mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query });
  startPolling(appUrl || url);
}
// Note: did-finish-load is useless for "is the app back": Chromium emits it
// for its chrome-error:// page too, and getURL() then still reports the
// original http URL. The poll therefore ends itself: on success, or when the
// offline page is no longer what the window shows.
function startPolling(base) {
  stopPolling();
  const tick = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) { stopPolling(); return; }
    if (!isOfflinePage(mainWindow.webContents)) { stopPolling(); return; }
    const h = await fetchHealth(base, 3000);
    if (h && offlinePoll) {
      serverVersion = h.version || serverVersion;
      stopPolling();
      log.info(`${base} is reachable again — loading the app`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(base);
    }
  };
  offlinePoll = setInterval(tick, OFFLINE_POLL_MS);
  offlinePoll.tick = tick;
}
function pollNow() { if (offlinePoll?.tick) offlinePoll.tick(); }
function stopPolling() { if (offlinePoll) { clearInterval(offlinePoll); offlinePoll = null; } }

function openSetup(error = '') {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 560,
    height: 720,
    resizable: false,
    title: 'CallTrack Setup',
    backgroundColor: '#1a1f36',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  setupContents.add(setupWindow.webContents);
  setupWindow.removeMenu?.();
  // DESK-16: the setup page never navigates anywhere and never opens windows
  // (a dropped file/URL would otherwise replace it with window.calltrack live).
  setupWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.on('closed', () => { setupWindow = null; });
  const prev = readPreviousConfig();
  const state = readState();
  const query = {};
  if (error) query.error = error;
  if (state.pendingMessage) { query.error = state.pendingMessage; writeState({ pendingMessage: null }); }
  if (serviceInstalled()) query.attached = '1';
  if (prev?.mode === 'join') query.previous = prev.serverUrl;
  setupWindow.loadFile(path.join(__dirname, 'setup.html'), { query });
}

// ---------- boot ----------
async function attachTo(port) {
  const base = `http://127.0.0.1:${port}`;
  serverInfo = { port, urls: { local: base, lan: lanUrls(port) }, attached: true };
  log.info(`attached to the CallTrack service on port ${port} (v${serverVersion || '?'})`);
  createMainWindow(base);
  buildMenu();
  return true;
}

// The service is installed but not (yet) answering: show "starting…" and poll
// for up to 60 s; never start a rival host on the same machine (DESK-5a).
async function waitForService(port, svc) {
  const base = `http://127.0.0.1:${port}`;
  appUrl = base;
  log.info(`CallTrack service installed (${svc.paths?.source || 'plist'}) — waiting for ${base}`);
  createMainWindow(base);
  buildMenu();
  serverInfo = { port, urls: { local: base, lan: lanUrls(port) }, attached: true };
  for (;;) {
    // showOffline() polls /api/health and loads the app the moment it answers;
    // this loop only decides when to give up and ask.
    showOffline({ mode: 'service', url: base });
    const deadline = Date.now() + SERVICE_WAIT_MS;
    let up = false;
    while (Date.now() < deadline && !up) {
      await new Promise((r) => { setTimeout(r, 1000); });
      if (!mainWindow || mainWindow.isDestroyed() || quitting) return false;
      up = !isOfflinePage(mainWindow.webContents) || !!(await fetchHealth(base, 3000));
    }
    if (up) {
      log.info(`CallTrack service answered on port ${port}`);
      buildMenu();
      return true;
    }
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: 'The CallTrack background service is not responding',
      detail: `This computer has the CallTrack service installed, so the app does not start its own server.\n\n`
        + `The service did not answer on port ${port} within ${SERVICE_WAIT_MS / 1000} s. In Terminal run:\n`
        + `    npm run doctor\n\n`
        + `inside the CallTrack folder to see why (logs: ~/Library/Logs/CallTrack/). `
        + 'If the service was removed, run "npm run uninstall-autostart" and this app will host the server itself.',
      buttons: ['Keep waiting', 'Change setup…', 'Quit'],
      defaultId: 0, cancelId: 0,
    });
    if (response === 1) { changeSetup(); return false; }
    if (response === 2) { quitting = true; app.quit(); return false; }
  }
}

function describePortHolder(port) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? ['netstat', ['-ano', '-p', 'tcp']]
      : ['lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']];
    execFile(cmd[0], cmd[1], { timeout: 4000 }, (err, stdout) => {
      const lines = String(stdout || '').split('\n').filter((l) => l.includes(`:${port}`)).slice(0, 4);
      resolve(lines.join('\n').trim());
    });
  });
}

// DESK-5b: the configured port is what every joiner and every paired phone
// has stored. Never hop to another port silently — say what is in the way.
async function portConflict(cfg, port) {
  const holder = await describePortHolder(port);
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: `Port ${port} is being used by another program`,
    detail: `CallTrack cannot start its server because something else is listening on port ${port}.\n\n`
      + (holder ? `${holder}\n\n` : '')
      + 'CallTrack keeps this port fixed so phones and the other computers can find it. '
      + 'Stop that program and retry, or change setup (which changes the address on every device).',
    buttons: ['Retry', 'Change setup…', 'Quit'],
    defaultId: 0, cancelId: 2,
  });
  if (response === 0) return startHost(cfg);
  if (response === 1) { changeSetup(); return false; }
  quitting = true; app.quit();
  return false;
}

// A failed FIRST boot right after a restore means the picked file is not a
// usable CallTrack database: move it aside and re-open the wizard (DESK-15).
function handleServerStartFailure(err) {
  const state = readState();
  log.error('server failed to start', err);
  if (state.restorePending && fs.existsSync(DB_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bad = `${DB_FILE}.bad-${stamp}`;
    try {
      fs.renameSync(DB_FILE, bad);
      for (const side of Object.values(sidecarNames(DB_FILE))) {
        if (fs.existsSync(side)) fs.renameSync(side, `${bad}${side.slice(DB_FILE.length)}`);
      }
    } catch (e) { log.error('could not move the bad database aside', e); }
    writeState({
      restorePending: false,
      pendingMessage: `The restored backup could not be opened (${String(err.message).split('\n')[0].slice(0, 160)}). `
        + `It was moved to ${path.basename(bad)}. Pick a different backup, or start fresh.`,
    });
    try { fs.renameSync(CONFIG_PATH, PREVIOUS_CONFIG_PATH); } catch { /* ignore */ }
    quitting = true;
    app.relaunch();
    app.exit(0);
    return false;
  }
  openSetup(`Could not start: ${String(err.message).split('\n')[0].slice(0, 200)}\nDetails: ${log.file}`);
  return false;
}

async function selfHost(cfg, port) {
  const base = `http://127.0.0.1:${port}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  process.env.CRM_DATA_DIR = DATA_DIR;
  process.env.CRM_BACKUP_DIR = BACKUP_DIR;
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';

  // DESK-4: point server/db.js at the Electron-ABI (or N-API) prebuild shipped
  // under Resources/native (packaged) / build/native (dev) — the repo's
  // node_modules binary is never rebuilt for Electron.
  const binding = nativeBindingPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, root: ROOT });
  if (fs.existsSync(binding)) {
    process.env.CRM_SQLITE_NATIVE_BINDING = binding;
    log.info(`sqlite native binding: ${binding}`);
  } else {
    log.warn(`no prebuilt sqlite binding at ${binding} — using node_modules/better-sqlite3 (run: node scripts/fetch-electron-sqlite.js)`);
  }

  let startServer;
  try {
    ({ startServer } = await import('../server/app.js'));
  } catch (err) {
    return handleServerStartFailure(err);
  }
  try {
    serverInfo = await startServer({ port });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      // Lost the race with the service / another CallTrack? Attach. A foreign
      // process? Blocking dialog, never a silent port hop.
      if (await isCallTrack(base)) return attachTo(port);
      return portConflict(cfg, port);
    }
    return handleServerStartFailure(err);
  }
  serverInfo.attached = false;
  serverVersion = app.getVersion();
  if (readState().restorePending) writeState({ restorePending: false });
  log.info(`hosting on port ${port}: ${JSON.stringify(serverInfo.urls)}`);
  // Keep the machine from sleeping while it serves the team.
  try { powerSaveBlocker.start('prevent-app-suspension'); } catch { /* best effort */ }
  createMainWindow(base);
  buildMenu();
  return true;
}

async function startHost(cfg) {
  const port = cfg.port || 3000;
  const base = `http://127.0.0.1:${port}`;
  // Already served on this machine (the LaunchAgent, or an `npm start`)? Attach.
  if (await isCallTrack(base)) return attachTo(port);
  const svc = serviceInstalled();
  if (svc && !ALLOW_SELF_HOST) return waitForService(port, svc);
  if (svc && ALLOW_SELF_HOST) log.warn('CALLTRACK_ALLOW_SELF_HOST=1: ignoring the installed service (dev only)');
  return selfHost(cfg, port);
}

function startJoin(cfg) {
  createMainWindow(cfg.serverUrl);
  buildMenu();
  isCallTrack(cfg.serverUrl).then(() => buildMenu());
  return true;
}

// Re-entrant callers (activate, setup:choose, AUTOSETUP) share one in-flight
// boot so two servers can never be started (DESK-5c).
function boot() {
  if (booting) return booting;
  booting = (async () => {
    const cfg = readConfig();
    if (!cfg) { openSetup(); return false; }
    try {
      return cfg.mode === 'host' ? await startHost(cfg) : startJoin(cfg);
    } catch (err) {
      log.error('start failed', err);
      openSetup(`Could not start: ${String(err.message).split('\n')[0].slice(0, 200)}\nDetails: ${log.file}`);
      return false;
    }
  })().finally(() => { booting = null; });
  return booting;
}

// "Change Setup": keep the old config as config.previous.json until the new
// choice has booted successfully (DESK-8), clear the login item when leaving
// host mode (DESK-18), and relaunch into the wizard.
function changeSetup() {
  const cfg = readConfig();
  if (cfg?.mode === 'host') { try { app.setLoginItemSettings({ openAtLogin: false }); } catch { /* ignore */ } }
  try { fs.renameSync(CONFIG_PATH, PREVIOUS_CONFIG_PATH); } catch { fs.rmSync(CONFIG_PATH, { force: true }); }
  quitting = true;
  app.relaunch();
  app.exit(0);
}

// ---------- attached-mode helpers (DESK-7) ----------
async function serviceFolders() {
  if (!serverInfo?.attached) return { dataDir: DATA_DIR, backupDir: BACKUP_DIR, source: 'app' };
  // Preferred: ask the server (owner session cookie travels with ses.fetch).
  try {
    const res = await session.defaultSession.fetch(`${appUrl}/api/settings/paths`, { credentials: 'include' });
    if (res.ok) {
      const j = await res.json();
      if (j && j.data_dir) return { dataDir: j.data_dir, backupDir: j.backup_dir, logsDir: j.logs_dir, source: 'api' };
    }
  } catch { /* not logged in as owner, or older server */ }
  const svc = serviceInstalled();
  if (svc?.paths) return svc.paths;
  return { dataDir: DATA_DIR, backupDir: BACKUP_DIR, source: 'app' };
}

async function connectionInfo() {
  const cfg = readConfig();
  if (cfg?.mode === 'join') {
    return `Connected to: ${cfg.serverUrl}${serverVersion ? `  (CallTrack CRM v${serverVersion})` : ''}`;
  }
  if (!serverInfo) return 'Server not running.';
  const lines = [
    'Team members connect using any of these addresses',
    '(phone browsers work too — same office WiFi):',
    '',
    ...(serverInfo.urls?.lan?.length ? serverInfo.urls.lan : lanUrls(serverInfo.port)),
    serverInfo.urls?.mdns || '',
    '',
    serverInfo.attached
      ? `This window is attached to the CallTrack background service on this computer (port ${serverInfo.port}${serverVersion ? `, v${serverVersion}` : ''}).`
      : `Server: CallTrack CRM v${app.getVersion()} (port ${serverInfo.port})`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  return lines.join('\n');
}

// ---------- tray / menu ----------
function quitLabel() {
  return serverInfo?.attached
    ? 'Quit (closes this window; the background service keeps running)'
    : (serverInfo ? 'Quit (stops the server)' : 'Quit CallTrack');
}

function ensureTray() {
  if (tray) return;
  try {
    tray = new Tray(path.join(__dirname, 'tray.png'));
    tray.setToolTip(serverInfo?.attached ? 'CallTrack CRM — attached to the background service' : 'CallTrack CRM — server running');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open CallTrack', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: 'Connection info', click: async () => dialog.showMessageBox({ message: 'CallTrack CRM', detail: await connectionInfo() }) },
      { type: 'separator' },
      { label: quitLabel(), click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch { /* tray is best-effort */ }
}

function buildMenu() {
  const viewMenu = DEV ? { role: 'viewMenu' } : {
    label: 'View',
    submenu: [
      { role: 'reload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  const updateItems = updateInfo?.available ? [
    {
      label: `Update available: CallTrack CRM v${updateInfo.version} — Download…`,
      click: () => safeOpenExternal(updateInfo.url || RELEASES_URL),
    },
  ] : [];
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: 'CallTrack',
      submenu: [
        { role: 'about' }, { type: 'separator' },
        ...updateItems,
        { label: 'Check for Updates…', click: () => checkForUpdates({ manual: true }) },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: quitLabel(), accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } },
      ],
    }] : []),
    { role: 'editMenu' },
    viewMenu,
    {
      label: 'Server',
      submenu: [
        {
          label: 'Connection Info (for the team)…',
          click: async () => {
            const info = await connectionInfo();
            const { response } = await dialog.showMessageBox({
              message: 'CallTrack CRM', detail: info, buttons: ['Copy', 'OK'], defaultId: 1,
            });
            if (response === 0) clipboard.writeText(info);
          },
        },
        { label: 'Open Backups Folder', click: async () => shell.openPath((await serviceFolders()).backupDir) },
        { label: 'Open Data Folder', click: async () => shell.openPath((await serviceFolders()).dataDir) },
        { label: 'Open App Log Folder', click: () => shell.openPath(LOG_DIR) },
        { type: 'separator' },
        ...(process.platform !== 'darwin' ? [
          ...updateItems,
          { label: 'Check for Updates…', click: () => checkForUpdates({ manual: true }) },
          { type: 'separator' },
        ] : []),
        {
          label: 'Change Setup (host / join)…',
          click: async () => {
            const { response } = await dialog.showMessageBox({
              message: 'Change how this app connects?',
              detail: 'Your data is NOT deleted — this only re-opens the host/join chooser. The app will restart.',
              buttons: ['Cancel', 'Change Setup'], defaultId: 0, cancelId: 0,
            });
            if (response === 1) changeSetup();
          },
        },
        ...(process.platform !== 'darwin' ? [{ type: 'separator' }, { label: quitLabel(), click: () => { quitting = true; app.quit(); } }] : []),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- update check (DESK-10, safe part) ----------
// Once a day, fail-silent, no auto-download: compares this build with the
// host's /api/health.version and GitHub's latest release, then offers a link.
async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': `calltrack-crm/${app.getVersion()}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function checkForUpdates({ manual = false } = {}) {
  const cfg = readConfig();
  if (SMOKE_URL || (cfg && cfg.updateCheck === false && !manual)) return;
  const state = readState();
  if (!manual && !isCheckDue(state.lastUpdateCheck)) return;
  writeState({ lastUpdateCheck: new Date().toISOString() });
  try {
    if (appUrl) {
      const h = await fetchHealth(appUrl, 4000);
      if (h) serverVersion = h.version || serverVersion;
    }
    const latest = parseGithubLatest(await fetchJson(RELEASES_API));
    updateInfo = decideUpdate({ current: app.getVersion(), hostVersion: serverVersion, latest, releasesUrl: RELEASES_URL });
    log.info('update check', JSON.stringify({ current: app.getVersion(), host: serverVersion, latest: latest?.version, result: updateInfo }));
    buildMenu();
    if (updateInfo.available) {
      if (manual) {
        const { response } = await dialog.showMessageBox({
          message: `CallTrack CRM v${updateInfo.version} is available`,
          detail: `You have v${app.getVersion()}. ${updateInfo.source === 'host' ? 'The main computer already runs the newer version.' : ''}\nDownload the installer from the releases page.`,
          buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1,
        });
        if (response === 0) safeOpenExternal(updateInfo.url || RELEASES_URL);
      } else if (state.notifiedVersion !== updateInfo.version && Notification.isSupported()) {
        writeState({ notifiedVersion: updateInfo.version });
        const n = new Notification({
          title: `CallTrack CRM v${updateInfo.version} is available`,
          body: `You have v${app.getVersion()}. Click to open the download page.`,
        });
        n.on('click', () => safeOpenExternal(updateInfo.url || RELEASES_URL));
        n.show();
      }
    } else if (manual) {
      dialog.showMessageBox({ message: `CallTrack CRM v${app.getVersion()} is up to date`, detail: latest ? `Latest release: v${latest.version}` : 'Could not reach GitHub to check the latest release.' }).catch(() => {});
    }
  } catch (err) {
    log.warn('update check failed', err.message);
  }
}

// ---------- IPC from the setup window (DESK-16: sender + payload validated) ----------
function assertSetupSender(e) {
  const frameUrl = e.senderFrame?.url || '';
  let ok = false;
  try {
    const u = new URL(frameUrl);
    ok = u.protocol === 'file:' && /\/setup\.html$/.test(u.pathname) && !!setupWindow && e.sender === setupWindow.webContents;
  } catch { ok = false; }
  if (!ok) {
    log.warn('rejected IPC from', frameUrl.slice(0, 120));
    throw new Error('bad sender');
  }
}

ipcMain.handle('setup:choose', async (e, choice) => {
  assertSetupSender(e);
  if (!choice || typeof choice !== 'object' || !['host', 'join'].includes(choice.mode)) {
    return { ok: false, error: 'Invalid choice.' };
  }
  const previous = readPreviousConfig();
  if (choice.mode === 'join') {
    const url = normalizeServerUrl(choice.serverUrl);
    if (!url) return { ok: false, error: 'Enter the main computer\'s address like 192.168.1.50:3000.' };
    if (!(await isCallTrack(url))) {
      return { ok: false, error: 'No CallTrack server found at that address. Check the address and that the main computer is on.' };
    }
    writeConfig({ mode: 'join', serverUrl: url });
  } else {
    // A configured joiner becoming the host is the one choice that can split
    // the team's data in two — make it explicit (DESK-8).
    if (previous?.mode === 'join') {
      const { response } = await dialog.showMessageBox(setupWindow, {
        type: 'warning',
        message: 'Make this computer the main computer?',
        detail: `This app was connected to ${previous.serverUrl}. If you continue, THIS computer will hold the team's data from now on and the old main computer will be ignored by this app.\n\nOnly do this if the old main computer is being retired (restore its latest backup here first).`,
        buttons: ['Cancel', 'Make this the main computer'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1) return { ok: false };
    }
    writeConfig({ mode: 'host', port: 3000 });
    if (choice.openAtLogin === true) { try { app.setLoginItemSettings({ openAtLogin: true }); } catch { /* ignore */ } }
  }
  setupWindow?.close();
  setupWindow = null;
  const ok = await boot();
  if (ok) fs.rmSync(PREVIOUS_CONFIG_PATH, { force: true });
  else if (previous) { try { fs.renameSync(PREVIOUS_CONFIG_PATH, CONFIG_PATH); } catch { /* ignore */ } }
  return { ok: !!ok };
});

// Restore a backup into this computer's (not yet started) database (DESK-15):
// header + size + free-space checks in the main process, then PRAGMA
// quick_check + a users count in a separate utility process (the main process
// never loads better-sqlite3), staged copy, then rename into place.
function runSqliteCheck(file) {
  return new Promise((resolve) => {
    const binding = nativeBindingPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, root: ROOT });
    const script = path.join(__dirname, 'lib', 'sqlite-check.js');
    let result = null;
    let out = '';
    let child;
    const finish = (r) => { if (result) return; result = r; clearTimeout(timer); try { child?.kill(); } catch { /* ignore */ } resolve(r); };
    const timer = setTimeout(() => finish({ error: 'integrity check timed out after 60 s' }), 60000);
    try {
      child = utilityProcess.fork(script, [file, '--binding', binding], {
        env: { ...process.env, CRM_SQLITE_NATIVE_BINDING: binding },
        stdio: 'pipe',
        serviceName: 'calltrack-sqlite-check',
      });
    } catch (err) {
      return finish({ skipped: true, reason: `could not start the check process: ${err.message}` });
    }
    child.on('message', (msg) => finish(msg));
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => log.warn('sqlite-check:', String(d).trim()));
    child.on('exit', (code) => {
      if (result) return;
      const line = out.trim().split('\n').filter(Boolean).pop();
      try { finish(JSON.parse(line)); } catch { finish({ error: `check process exited with code ${code}` }); }
    });
  });
}

ipcMain.handle('setup:restore', async (e) => {
  assertSetupSender(e);
  if (serviceInstalled() || serverInfo?.attached) {
    return { ok: false, error: 'This computer runs the CallTrack background service, which owns the data. Restore into the service\'s data folder instead (npm run doctor shows where it is).' };
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(setupWindow, {
    title: 'Pick a CallTrack backup or database file',
    filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  const src = filePaths[0];
  if (fs.existsSync(DB_FILE)) {
    return { ok: false, error: `This computer already has CallTrack data at ${DB_FILE}. Move that file away first if you really want to replace it.` };
  }
  let headerBytes;
  let size;
  try {
    size = fs.statSync(src).size;
    const fd = fs.openSync(src, 'r');
    headerBytes = Buffer.alloc(SQLITE_HEADER_LEN);
    const n = fs.readSync(fd, headerBytes, 0, SQLITE_HEADER_LEN, 0);
    fs.closeSync(fd);
    headerBytes = headerBytes.subarray(0, n);
  } catch (err) {
    return { ok: false, error: `Could not read that file: ${err.message}` };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let freeBytes = null;
  try { const s = fs.statfsSync(DATA_DIR); freeBytes = Number(s.bsize) * Number(s.bavail); } catch { /* unknown */ }
  const sides = sidecarNames(src);
  const walSize = fs.existsSync(sides.wal) ? fs.statSync(sides.wal).size : 0;
  const pre = checkRestoreCandidate({ headerBytes, size, freeBytes, walSize });
  if (!pre.ok) return { ok: false, error: pre.error };

  // Stage: copy db (+ WAL/SHM sidecars, so a live copy keeps its last writes),
  // verify the staged copy, then rename into place.
  const staging = path.join(DATA_DIR, `restore-staging-${Date.now()}`);
  const staged = path.join(staging, 'crm.sqlite');
  const stagedSides = sidecarNames(staged);
  try {
    fs.mkdirSync(staging, { recursive: true });
    fs.copyFileSync(src, staged);
    if (walSize > 0) fs.copyFileSync(sides.wal, stagedSides.wal);
    if (fs.existsSync(sides.shm)) fs.copyFileSync(sides.shm, stagedSides.shm);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `Could not copy the backup: ${err.message}` };
  }
  const check = interpretCheck(await runSqliteCheck(staged));
  if (!check.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: check.error };
  }
  try {
    fs.renameSync(staged, DB_FILE);
    for (const k of ['wal', 'shm']) if (fs.existsSync(stagedSides[k])) fs.renameSync(stagedSides[k], sidecarNames(DB_FILE)[k]);
    fs.rmSync(staging, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: `Could not move the backup into place: ${err.message}` };
  }
  writeState({ restorePending: true });
  log.info(`restored ${src} → ${DB_FILE} (${check.skipped ? `header only: ${check.reason}` : `${check.users} users, schema ${check.userVersion}`}${pre.liveCopy ? ', WAL sidecar included' : ''})`);
  return {
    ok: true,
    file: path.basename(src),
    users: check.users ?? null,
    note: check.skipped ? 'Header checked; full integrity check will run when the server starts.' : (pre.liveCopy ? 'This was a copy of a live database — its journal was restored with it.' : ''),
  };
});

// ---------- desktop smoke (npm run test:desktop) ----------
// Loads a tiny local page served by scripts/desktop-smoke.mjs and proves, in a
// real Electron launch WITHOUT booting host mode:
//  (1) main-process webContents.downloadURL and (2) the REAL client path
//      fetch -> Blob -> a[download].click() both land through will-download,
//      waiting for each item's 'done' (state 'completed') — not a directory
//      prefix match that mistakes '.crdownload' partials for files (DEP-5);
//  (3) a subframe navigation to a custom scheme is cancelled (DESK-2);
//  (4) a server-side redirect to an off-app host is cancelled (DESK-17);
//  (5) a same-origin window.open yields a child BrowserWindow (DESK-6);
//  (6) camera/microphone/geolocation are denied, notifications allowed (DESK-3).
// Exits 0 on success, 1 on failure; prints one "[smoke] result" JSON line.
function waitDownloads(names, timeoutMs) {
  return new Promise((resolve) => {
    const got = {};
    const timer = setTimeout(() => { downloadListeners.delete(cb); resolve(got); }, timeoutMs);
    const cb = ({ name, state }) => {
      const key = names.find((n) => name.startsWith(n));
      if (!key) return;
      got[key] = state;
      if (names.every((n) => got[n])) { clearTimeout(timer); downloadListeners.delete(cb); resolve(got); }
    };
    downloadListeners.add(cb);
  });
}

async function runSmoke() {
  const url = SMOKE_URL.replace(/\/$/, '');
  const dir = downloadsDir();
  const win = new BrowserWindow({ show: false, webPreferences: SAFE_WEBPREFS });
  const result = {};
  let code = 1;
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  try {
    fs.mkdirSync(dir, { recursive: true });
    await win.loadURL(url);

    // (1) + (2) downloads
    const dlDone = waitDownloads(['export', 'smoke-renderer'], 15000);
    win.webContents.downloadURL(`${url}/export.csv`);
    await win.webContents.executeJavaScript(
      "(async () => { const r = await fetch('/export.csv'); const b = await r.blob();"
      + ' const a = document.createElement(\'a\'); a.href = URL.createObjectURL(b);'
      + " a.download = 'smoke-renderer.csv'; document.body.appendChild(a); a.click(); a.remove(); })()",
    );
    result.downloads = await dlDone;
    result.files = completedDownloads(fs.readdirSync(dir), ['export', 'smoke-renderer']);
    result.downloadsOk = result.downloads.export === 'completed' && result.downloads['smoke-renderer'] === 'completed'
      && result.files.export && result.files['smoke-renderer'];

    // (3) subframe to a custom scheme
    await win.webContents.executeJavaScript(
      "new Promise((r) => { const f = document.createElement('iframe'); f.src = 'x-calltrack-probe://sub';"
      + ' f.onload = f.onerror = () => r(1); document.body.appendChild(f); setTimeout(() => r(0), 1500); })',
    );
    result.frameCancelled = smokeStats.cancelledFrameNavs.includes('x-calltrack-probe://sub');

    // (4) server-side redirect to an off-app host
    await win.webContents.executeJavaScript("location.href = '/redirect'; 1");
    await sleep(1500);
    result.redirectCancelled = smokeStats.cancelledRedirects.includes('http://example.invalid/');
    result.stillInApp = win.webContents.getURL().startsWith(url);
    if (!win.webContents.getURL().startsWith(url)) await win.loadURL(url);

    // (5) same-origin popup → child window (shares the session)
    const created = new Promise((r) => { win.webContents.once('did-create-window', (child) => r(child)); setTimeout(() => r(null), 4000); });
    await win.webContents.executeJavaScript("window.open('/popup.html', '_blank'); 1");
    const child = await created;
    result.popupChildWindow = !!child && BrowserWindow.getAllWindows().length >= 2;
    result.popupExternal = smokeStats.openedExternal.length === 0;
    if (child && !child.isDestroyed()) child.destroy();

    // (6) permissions
    result.permissions = await win.webContents.executeJavaScript(
      '(async () => { const q = async (n) => { try { return (await navigator.permissions.query({ name: n })).state; } catch (e) { return "err:" + e.message; } };'
      + ' return { camera: await q("camera"), microphone: await q("microphone"), geolocation: await q("geolocation"),'
      + ' notifications: await q("notifications"), notificationRequest: await Notification.requestPermission() }; })()',
    );
    const p = result.permissions || {};
    result.permissionsOk = p.camera === 'denied' && p.microphone === 'denied' && p.geolocation === 'denied'
      && p.notifications === 'granted' && p.notificationRequest === 'granted';

    result.ok = !!(result.downloadsOk && result.frameCancelled && result.redirectCancelled && result.stillInApp
      && result.popupChildWindow && result.popupExternal && result.permissionsOk);
    code = result.ok ? 0 : 1;
  } catch (err) {
    result.error = err && err.message;
  } finally {
    console.log(`[smoke] result ${JSON.stringify(result)}`);
    app.exit(code);
  }
}

// ---------- process-level safety (DESK-22) ----------
let shownFatal = false;
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err);
  if (!shownFatal) {
    shownFatal = true;
    try { dialog.showErrorBox('CallTrack CRM hit an unexpected error', `${err?.message || err}\n\nDetails were written to:\n${log.file}`); } catch { /* ignore */ }
  }
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason instanceof Error ? reason : String(reason));
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

  app.on('web-contents-created', (e, contents) => attachGuards(contents));
  app.on('child-process-gone', (e, details) => log.error('child process gone', details));

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    // DESK-3 / DESK-2: web permissions are deny-by-default; 'openExternal'
    // (Chromium's own protocol launcher, the subframe bypass) is never granted.
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const requestingUrl = details?.requestingUrl || (wc && !wc.isDestroyed() ? wc.getURL() : '');
      const ok = decidePermission({ permission, requestingUrl, ...policyCtx() });
      if (!ok) { smokeStats.deniedPermissions.push(permission); log.warn(`permission denied: ${permission} for ${String(requestingUrl).slice(0, 120)}`); }
      callback(ok);
    });
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => decidePermission({
      permission, requestingUrl: details?.requestingUrl || requestingOrigin, ...policyCtx(),
    }));
    installDownloadHandler(ses);
    buildMenu();

    if (SMOKE_URL) { runSmoke(); return; }
    if (AUTOSETUP === 'host' && !readConfig()) {
      writeConfig({ mode: 'host', port: Number(process.env.CALLTRACK_PORT) || 3000 });
    }
    boot().then(() => { setTimeout(() => checkForUpdates(), 15000).unref?.(); });
  });

  app.on('activate', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else if (!setupWindow && !booting) boot();
  });

  app.on('window-all-closed', () => {
    // Host mode never reaches here on close (window hides instead); join
    // mode and setup follow normal platform behavior.
    if (process.platform !== 'darwin') app.quit();
  });

  // Graceful shutdown of the embedded server (checkpoint + close the DB).
  app.on('before-quit', (e) => {
    quitting = true;
    stopPolling();
    if (serverInfo && !serverInfo.attached && typeof serverInfo.stop === 'function' && !serverStopped) {
      e.preventDefault();
      serverStopped = true;
      log.info('quit: stopping the embedded server');
      const timer = setTimeout(() => { log.warn('quit: server stop timed out'); app.exit(0); }, 10000);
      Promise.resolve(serverInfo.stop({ timeoutMs: 8000 }))
        .catch((err) => log.error('server stop failed', err))
        .finally(() => { clearTimeout(timer); app.quit(); });
    }
  });
}
