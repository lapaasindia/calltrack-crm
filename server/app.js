// Embeddable server core: used by the CLI (server/index.js) and by the
// desktop app (desktop/main.js). IMPORTANT: import this module only AFTER
// setting CRM_DATA_DIR / CRM_BACKUP_DIR env vars — db.js reads them at load.
//
// asyncRoutes MUST be the first import: it patches express's Router layers so
// a rejected async handler becomes a 500 JSON response instead of a hung
// request + unhandledRejection (audit SEC-8 / SCALE-8). Route modules build
// their Routers at import time, after this line.
import './lib/asyncRoutes.js';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import https from 'node:https';

import dbDefault, { DATA_DIR, getSetting, shutdownDb, APP_VERSION } from './db.js';
import { SqliteSessionStore, closeSessionStore } from './lib/sessionStore.js';
import {
  requireAuth, requirePasswordChanged, requireOwner, requireWriter,
} from './middleware/auth.js';
import { startBackupScheduler } from './lib/backup.js';
import { startCloudBackupScheduler } from './lib/cloudBackup.js';
import { ensureBootstrapped } from './bootstrap.js';
import { log, requestLogger } from './lib/logger.js';
import { opsHealth, installProcessGuards } from './lib/ops.js';
import { drainJobs } from './lib/jobs.js';
import { startMaintenanceJob } from './lib/maintenance.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import productRoutes from './routes/products.js';
import templateRoutes from './routes/templates.js';
import leadRoutes from './routes/leads.js';
import callRoutes from './routes/calls.js';
import followupRoutes from './routes/followups.js';
import todayRoutes from './routes/today.js';
import dealRoutes from './routes/deals.js';
import importRoutes from './routes/imports.js';
import reportRoutes from './routes/reports.js';
import settingsRoutes from './routes/settings.js';
import syncRoutes from './routes/sync.js';
import reviewRoutes from './routes/review.js';
import taskRoutes from './routes/tasks.js';
import projectRoutes from './routes/projects.js';
import timeBlockRoutes from './routes/timeblocks.js';
import currentWorkRoutes from './routes/current-work.js';
import meetingRoutes from './routes/meetings.js';
import deviceRoutes from './routes/devices.js';
import aiRoutes, { recordingsRouter } from './routes/ai.js';
import routingRoutes from './routes/routing.js';
import coachingRoutes from './routes/coaching.js';
import auditRoutes from './routes/audit.js';
import catalogRoutes from './routes/catalog.js';
import invoiceRoutes from './routes/invoices.js';
import notificationRoutes from './routes/notifications.js';
import backupRoutes from './routes/backup.js';
import dashboardRoutes from './routes/dashboard.js';
import whatsappRoutes from './routes/whatsapp.js';
import { startAiWorker } from './lib/ai.js';
import { startTranscodeWorker } from './lib/transcode.js';
import { invalidateOnWrite } from './lib/cache.js';
import { startRetentionJob } from './lib/recordingsRetention.js';
import { startWhatsApp, stopWhatsApp } from './lib/whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Single source of truth: the root package.json version (read once by db.js so
// /api/health, the in-app label and schema_migrations.app_version never drift).
export { APP_VERSION };

export function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

// TLS is opt-in: set CRM_TLS_CERT + CRM_TLS_KEY to PEM file paths to serve
// HTTPS. When on, session cookies are marked Secure automatically. Default
// stays plain HTTP for the existing LAN deployment (audit H-3).
export function tlsConfig() {
  const cert = process.env.CRM_TLS_CERT;
  const key = process.env.CRM_TLS_KEY;
  if (cert && key && fs.existsSync(cert) && fs.existsSync(key)) {
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  }
  return null;
}

export function createApp() {
  // Session secret: generated once, persisted — regenerating on each boot
  // would log everyone out on every restart.
  const secretFile = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  // Re-assert 0o600 on every boot: a key restored from an archive or copied
  // under a loose umask could be group/world-readable, and this one file roots
  // both session signing and the secret box (audit L-3).
  try { fs.chmodSync(secretFile, 0o600); } catch { /* best effort (e.g. Windows) */ }
  const SECRET = fs.readFileSync(secretFile, 'utf8');
  const secureCookies = process.env.CRM_SECURE_COOKIES === 'true' || !!tlsConfig();

  const app = express();
  app.disable('x-powered-by');

  // Baseline security headers. CSP here is just the clickjacking/abuse floor
  // that never breaks self-contained HTML pages or the SPA; a stricter
  // script-src policy should be layered in once verified against the built
  // client. (audit: web-security systemic theme)
  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    next();
  });

  // Request log (method, path, status, ms, user id, request id) — before the
  // body parser so a 413/400 from it is recorded too (audit SCALE-17).
  app.use(requestLogger(log));

  // CORS for the mobile app: its WebView origin (http(s)://localhost) is
  // cross-origin to the LAN server. Bearer-token requests carry no cookies,
  // so reflecting the origin WITHOUT allow-credentials is safe — it can't be
  // abused to ride a browser session (those stay same-origin).
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });

  // 1 MB is plenty for every normal API call; a 10 MB body was parsed
  // synchronously for ANY endpoint (audit SCALE-24). Routes that legitimately
  // take more (lead imports, mobile sync batches) mount their own express.json
  // with a larger limit.
  app.use(express.json({ limit: '1mb' }));

  app.use(session({
    store: new SqliteSessionStore(),
    secret: SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    name: 'crm.sid',
    cookie: {
      // Secure when TLS is configured (CRM_TLS_* or CRM_SECURE_COOKIES=true).
      // Over plain http a Secure cookie would be silently dropped and nobody
      // could log in, so it stays off for the default LAN deployment — but the
      // moment TLS is terminated, cookies become Secure automatically (H-3).
      secure: secureCookies,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));

  // Public: lets the desktop app (and curl) identify a CallTrack server. Kept
  // to a liveness fingerprint only — disk-free space is no longer leaked to
  // unauthenticated peers (audit L-8).
  app.get('/api/health', (req, res) => {
    res.json({ app: 'calltrack-crm', version: APP_VERSION });
  });

  // Public: the mobile app checks this (possibly unpaired/revoked) to find
  // updates. The APK itself is served from data/apk/.
  const apkDir = path.join(DATA_DIR, 'apk');
  app.get('/api/app-version', (req, res) => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(apkDir, 'version.json'), 'utf8'));
      res.json(meta);
    } catch {
      res.json({ versionCode: 0 });
    }
  });
  app.get('/download/calltrack.apk', (req, res) => {
    const apk = path.join(apkDir, 'calltrack.apk');
    if (!fs.existsSync(apk)) return res.status(404).send('No APK published yet');
    res.download(apk, 'calltrack.apk');
  });

  // Public auth endpoints; everything else requires a session.
  app.use('/api/auth', authRoutes);
  app.use('/api', requireAuth);
  // A still-default admin (must_change_password) is locked to the
  // change-password endpoint until it picks a real password (audit H-1).
  app.use('/api', requirePasswordChanged);
  // read_only accounts can never write: 403 on any non-GET/HEAD/OPTIONS under
  // /api (change-password/logout live under /api/auth, mounted above, so a
  // read_only user can still rotate their own password).
  app.use('/api', requireWriter);
  // Catch-all cache invalidation (SCALE-12): any successful mutating request
  // — sync, review, imports, WhatsApp, tasks… — drops the 30 s dashboard /
  // leaderboard cache, on top of the explicit bump() in the calls / deals /
  // payments / leads routes.
  app.use('/api', invalidateOnWrite);

  // Owner-only operability snapshot (audit SCALE-17): DB integrity + WAL size,
  // backup ages, AI queue, event-loop lag, free disk. Authenticated, unlike
  // /api/health, because it names file sizes and paths.
  app.get('/api/ops/health', requireOwner, (req, res) => {
    res.json(opsHealth({ version: APP_VERSION }));
  });

  app.use('/api/users', userRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/templates', templateRoutes);
  app.use('/api/leads/:id/calls', callRoutes);
  app.use('/api/leads/:id/follow-up', followupRoutes);
  app.use('/api/leads', leadRoutes);
  app.use('/api/today', todayRoutes);
  app.use('/api', dealRoutes); // /api/leads/:id/deals, /api/deals/:id/*, /api/collections, /api/payments/:id
  app.use('/api/imports', importRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/review', reviewRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/time-blocks', timeBlockRoutes);
  app.use('/api/current-work', currentWorkRoutes);
  app.use('/api/meetings', meetingRoutes);
  app.use('/api/devices', deviceRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/recordings', recordingsRouter());
  app.use('/api/routing-rules', routingRoutes);
  app.use('/api/coaching', coachingRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/catalog', catalogRoutes);
  app.use('/api/invoices', invoiceRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/whatsapp', whatsappRoutes);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, req, res, next) => {
    // Body-parser problems are the client's fault, not a server error: say so
    // with the right status instead of an opaque 500.
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON body' });
    }
    // A foreign-key violation means the row is still referenced elsewhere —
    // surface that as a clear 409 instead of an opaque 500 so a missed detach
    // (e.g. a new table referencing projects) degrades gracefully.
    if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return res.status(409).json({ error: 'Still referenced by other records — remove or detach those first.' });
    }
    log.error({
      err, req_id: req.id, method: req.method, path: (req.originalUrl || '').split('?')[0], user_id: req.user?.id ?? null,
    }, 'request failed');
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Server error', request_id: req.id });
  });

  // Serve the built client (audit CLIENT-12):
  //   * /assets/* are content-hashed by Vite → immutable, cached for a year,
  //     and an UNKNOWN asset is a 404 (never index.html, which used to turn a
  //     stale tab after an upgrade into "Unexpected token '<'" + a white page).
  //   * index.html is never cached (no-store) so every load picks up the new
  //     asset hashes right after a rebuild.
  //   * favicon / source maps 404 instead of returning the SPA shell.
  //   * SPA catch-all only for non-asset, non-API paths.
  // CRM_CLIENT_DIST lets a test instance serve a scratch build without
  // touching client/dist (which the live office server serves straight from disk).
  const distDir = process.env.CRM_CLIENT_DIST || path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(distDir)) {
    const indexHtml = path.join(distDir, 'index.html');
    app.use('/assets', express.static(path.join(distDir, 'assets'), {
      immutable: true, maxAge: '1y', fallthrough: false, index: false,
    }));
    // fallthrough:false hands a 404 error to the error pipeline; keep it terse.
    // eslint-disable-next-line no-unused-vars
    app.use('/assets', (err, req, res, next) => {
      res.status(err.status || 404).type('text/plain').send('Not found');
    });
    app.get(['/favicon.ico', '*.map'], (req, res) => res.status(404).type('text/plain').send('Not found'));
    // Other root-level build files (manifest, icons) — plain static, revalidated.
    app.use(express.static(distDir, { index: false, maxAge: 0 }));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/assets/') || req.path.startsWith('/api/')) {
        return res.status(404).type('text/plain').send('Not found');
      }
      res.set('Cache-Control', 'no-store');
      res.sendFile(indexHtml);
    });
  } else {
    app.get('/', (req, res) => res
      .status(503)
      .send('Client not built yet. Run: npm run build'));
  }

  return app;
}

// Starts everything: bootstrap (first-run admin/templates), HTTP server,
// schedulers. Resolves with { server, port, urls, stop } — stop() is the
// graceful shutdown (stop accepting, drain jobs, checkpoint + close the DB)
// that index.js runs on SIGTERM/SIGINT and the desktop app runs on quit.
// processGuards installs the process-level unhandledRejection /
// uncaughtException policy (default on; off under `node --test` so a test
// failure is never swallowed).
export function startServer({ port = 3000, processGuards = !process.env.NODE_TEST_CONTEXT } = {}) {
  ensureBootstrapped();
  const app = createApp();
  const tls = tlsConfig();
  const scheme = tls ? 'https' : 'http';
  return new Promise((resolve, reject) => {
    const httpServer = tls ? https.createServer(tls, app) : app;
    const server = httpServer.listen(port, '0.0.0.0', () => {
      let stopping = null;
      const stop = ({ timeoutMs = 10000 } = {}) => {
        if (stopping) return stopping;
        stopping = (async () => {
          const t0 = Date.now();
          log.info('shutdown: stop accepting connections');
          const closed = new Promise((res) => server.close(() => res()));
          try { server.closeIdleConnections?.(); } catch { /* older Node */ }
          // Let a running backup / cloud upload / AI job finish (bounded).
          const drained = await drainJobs(Math.max(1000, timeoutMs - 2000));
          if (!drained) log.warn('shutdown: background jobs still running after grace period');
          await Promise.race([closed, new Promise((res) => setTimeout(res, 1500).unref())]);
          try { server.closeAllConnections?.(); } catch { /* older Node */ }
          try { await stopWhatsApp(); } catch (err) { log.warn({ err }, 'shutdown: whatsapp stop failed'); }
          shutdownDb();
          // sessions.sqlite is a separate connection: checkpoint + close it too.
          try { closeSessionStore(); } catch (err) { log.warn({ err }, 'shutdown: session store close failed'); }
          log.info({ ms: Date.now() - t0 }, 'shutdown: complete');
        })();
        return stopping;
      };

      if (processGuards) {
        installProcessGuards({
          onFatal: (err) => {
            log.fatal({ err }, 'fatal error — exiting after graceful stop');
            setTimeout(() => process.exit(1), 5000).unref();
            stop({ timeoutMs: 4000 }).finally(() => process.exit(1));
          },
        });
      }

      startBackupScheduler();
      startCloudBackupScheduler();
      startAiWorker();
      startTranscodeWorker(); // MOB-22: .amr/.3gp → .m4a siblings (no-op without ffmpeg)
      startRetentionJob();
      startMaintenanceJob();
      // WhatsApp: default-OFF and lazy. startWhatsApp() returns immediately when
      // whatsapp_enabled is false, and degrades (never throws) if baileys is not
      // installed — so default boot stays clean and offline-safe.
      if (getSetting('whatsapp_enabled', false) === true) {
        startWhatsApp(dbDefault, { getSetting, dataDir: DATA_DIR })
          .catch((e) => log.error({ err: e }, '[whatsapp] boot start failed'));
      }
      const hostname = os.hostname().replace(/\.local$/, '');
      log.info({ port, version: APP_VERSION }, 'server listening');
      resolve({
        server,
        port,
        urls: {
          local: `${scheme}://localhost:${port}`,
          lan: lanAddresses().map((ip) => `${scheme}://${ip}:${port}`),
          mdns: `${scheme}://${hostname}.local:${port}`,
        },
        stop,
      });
    });
    server.on('error', reject);
  });
}
