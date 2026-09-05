// Opt-in desktop smoke test — `npm run test:desktop`.
//
// Proves, in the REAL Electron shell on THIS OS (run it on macOS and on
// Windows), the parts of the desktop app that a plain-Node test cannot reach:
//   1. starts a tiny local web server (NO database — never touches
//      better-sqlite3), serving a page, an attachment CSV, a same-origin popup
//      page and a redirect to an off-app host;
//   2. launches the actual app (electron .) pointed at it, with the download
//      folder redirected to a temp dir and its own userData;
//   3. the app (desktop/main.js runSmoke) triggers a main-process downloadURL
//      AND the real client fetch->Blob->a[download].click(), waits for each
//      download's 'done' event (state 'completed') — never mistaking a
//      '.crdownload' partial for a finished file (DEP-5) — then exercises the
//      navigation / permission guards: subframe custom-scheme navigation is
//      cancelled (DESK-2), an off-app server redirect is cancelled (DESK-17),
//      a same-origin window.open yields a child BrowserWindow (DESK-6), and
//      camera/microphone/geolocation are denied while notifications are
//      allowed for the in-app origin (DESK-3);
//   4. this script asserts the app's exit code AND that both files are on disk.
//
// It is deliberately NOT part of `npm test` (that stays pure-Node and headless).
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron'; // in a Node context this is the binary path
import { completedDownloads } from '../desktop/lib/downloads.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = '<!doctype html><meta charset="utf-8"><title>smoke</title><body>ready</body>';
const POPUP = '<!doctype html><meta charset="utf-8"><title>popup</title><body>popup</body>';
const CSV = 'col_a,col_b\n1,2\n';

const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-smoke-dl-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-smoke-ud-'));

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/export.csv')) {
    res.writeHead(200, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="export.csv"',
    });
    res.end(CSV);
  } else if (req.url.startsWith('/popup.html')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(POPUP);
  } else if (req.url.startsWith('/redirect')) {
    res.writeHead(302, { location: 'http://example.invalid/' });
    res.end();
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  }
});

function cleanup() {
  try { server.close(); } catch { /* ignore */ }
  for (const d of [downloadDir, userData]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function listDownloads() {
  try { return fs.readdirSync(downloadDir); } catch { return []; }
}

function done(pass, detail) {
  const files = listDownloads();
  cleanup();
  console.log(`[smoke] ${detail} files=${JSON.stringify(files)}`);
  console.log(pass ? '[smoke] PASS ✓' : '[smoke] FAIL ✗');
  process.exit(pass ? 0 : 1);
}

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const env = {
    ...process.env,
    CALLTRACK_SMOKE_URL: `http://127.0.0.1:${port}`,
    CALLTRACK_SMOKE_DOWNLOAD_DIR: downloadDir,
    CALLTRACK_USERDATA: userData,
  };
  // --disable-gpu keeps headless CI runners from hanging on GPU init.
  const child = spawn(electronPath, ['.', '--disable-gpu'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let appResult = null;
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    const m = /\[smoke\] result (\{.*\})/.exec(text);
    if (m) { try { appResult = JSON.parse(m[1]); } catch { /* ignore */ } }
  });

  const killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    done(false, 'TIMEOUT after 90s.');
  }, 90000);

  child.on('exit', (code) => {
    clearTimeout(killTimer);
    // Both files must be COMPLETE on disk (partials are ignored).
    const seen = completedDownloads(listDownloads(), ['export', 'smoke-renderer']);
    const filesOk = seen.export && seen['smoke-renderer'];
    const checks = appResult ? {
      downloads: appResult.downloadsOk, frame: appResult.frameCancelled, redirect: appResult.redirectCancelled,
      inApp: appResult.stillInApp, popup: appResult.popupChildWindow, permissions: appResult.permissionsOk,
    } : null;
    done(
      code === 0 && filesOk && !!appResult?.ok,
      `electron exit=${code} filesOnDisk=${filesOk} app=${JSON.stringify(checks)}${appResult?.error ? ` error=${appResult.error}` : ''}.`,
    );
  });

  child.on('error', (err) => {
    clearTimeout(killTimer);
    done(false, `failed to launch electron: ${err.message}.`);
  });
});
