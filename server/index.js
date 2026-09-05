// CLI entry point: `npm start` / the LaunchAgent run this. The desktop app
// uses server/app.js directly instead.
import http from 'node:http';
import qrcode from 'qrcode-terminal';

const PORT = Number(process.env.PORT) || 3000;

// Is something answering as CallTrack on this port already? (2 s budget.)
function probeCallTrack(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// db.js refuses to open a database written by a newer release (SCALE-14); make
// that a one-line message instead of a stack trace.
let startServer;
try {
  ({ startServer } = await import('./app.js'));
} catch (err) {
  console.error(`\n  CallTrack CRM cannot start:\n  ${err.message}\n`);
  process.exit(1);
}
const { log } = await import('./lib/logger.js');

let instance;
try {
  instance = await startServer({ port: PORT });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    // launchd KeepAlive would otherwise relaunch us every ~10 s forever
    // (DESK-5): if the port is held by a CallTrack server there is nothing to
    // fix by restarting, so exit 0 (clean) — a foreign process is a real error.
    const other = await probeCallTrack(PORT);
    if (other && other.app === 'calltrack-crm') {
      const msg = `CallTrack CRM v${other.version || '?'} is already running on port ${PORT} — nothing to do.`;
      console.log(msg);
      log.info({ port: PORT, other_version: other.version }, 'already running; exiting cleanly');
      process.exit(0);
    }
    console.error(`Port ${PORT} is already in use by another program. Stop it or set PORT to a free port.`);
    log.error({ port: PORT }, 'port in use by a non-CallTrack process');
    process.exit(1);
  }
  console.error(`CallTrack CRM failed to start: ${err.stack || err.message}`);
  process.exit(1);
}

const { urls } = instance;
const { parsePublicUrl } = await import('./lib/publicUrl.js');
const publicUrl = parsePublicUrl().origin;
console.log('\n  CallTrack CRM is running!\n');
if (publicUrl) console.log(`  Public address:    ${publicUrl}`);
console.log(`  On this computer:  ${urls.local}`);
for (const u of urls.lan) console.log(`  On office WiFi:    ${u}`);
console.log(`  Easy to remember:  ${urls.mdns}  (works on iPhones/most Androids)\n`);
console.log('  Scan to open on a phone:\n');
qrcode.generate(publicUrl || urls.lan[0] || urls.local, { small: true });
console.log('');

// Graceful shutdown (SCALE-8): launchctl unload / reboot / Ctrl-C send a
// signal; finish in-flight work, checkpoint + close the DB, exit 0 — within
// 10 s no matter what.
let shuttingDown = false;
function onSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutdown requested');
  console.log(`\n  ${signal} received — shutting down CallTrack CRM…`);
  const deadline = setTimeout(() => {
    log.error('shutdown: 10 s deadline hit, exiting');
    process.exit(1);
  }, 10000);
  deadline.unref();
  instance.stop({ timeoutMs: 9000 }).then(
    () => process.exit(0),
    (err) => { log.error({ err }, 'shutdown failed'); process.exit(1); },
  );
}
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));
