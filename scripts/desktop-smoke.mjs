// Opt-in desktop smoke test — `npm run test:desktop`.
//
// Proves the report-CSV download path works in the REAL Electron shell on THIS
// OS (run it on macOS and on Windows). It:
//   1. starts a tiny local web server (NO database — ABI-safe, never touches
//      better-sqlite3), serving a page and an attachment CSV;
//   2. launches the actual app (electron .) pointed at it, with the download
//      folder redirected to a temp dir;
//   3. the app (desktop/main.js runSmoke) triggers both a main-process
//      downloadURL and the real client fetch->Blob->a[download].click();
//   4. asserts both files landed in the temp dir.
//
// It is deliberately NOT part of `npm test` (that stays pure-Node and headless).
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron'; // in a Node context this is the binary path

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = '<!doctype html><meta charset="utf-8"><title>smoke</title><body>ready</body>';
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

function done(pass, detail) {
  const files = (() => { try { return fs.readdirSync(downloadDir); } catch { return []; } })();
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
  const child = spawn(electronPath, ['.', '--disable-gpu'], { cwd: root, env, stdio: 'inherit' });

  const killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    done(false, 'TIMEOUT after 60s.');
  }, 60000);

  child.on('exit', (code) => {
    clearTimeout(killTimer);
    const files = (() => { try { return fs.readdirSync(downloadDir); } catch { return []; } })();
    const gotDownloadUrl = files.some((f) => f.startsWith('export'));
    const gotBlobClick = files.some((f) => f.startsWith('smoke-renderer'));
    done(
      code === 0 && gotDownloadUrl && gotBlobClick,
      `electron exit=${code} downloadURL=${gotDownloadUrl} blobClick=${gotBlobClick}.`,
    );
  });

  child.on('error', (err) => {
    clearTimeout(killTimer);
    done(false, `failed to launch electron: ${err.message}.`);
  });
});
