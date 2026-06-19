// Embeddable server core: used by the CLI (server/index.js) and by the
// desktop app (desktop/main.js). IMPORTANT: import this module only AFTER
// setting CRM_DATA_DIR / CRM_BACKUP_DIR env vars — db.js reads them at load.
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import https from 'node:https';

import { DATA_DIR } from './db.js';
import { SqliteSessionStore } from './lib/sessionStore.js';
import { requireAuth, requirePasswordChanged } from './middleware/auth.js';
import { startBackupScheduler } from './lib/backup.js';
import { startCloudBackupScheduler } from './lib/cloudBackup.js';
import { ensureBootstrapped } from './bootstrap.js';

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
import { startRetentionJob } from './lib/recordingsRetention.js';
import { startWhatsApp } from './lib/whatsapp.js';
import dbDefault, { getSetting } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Single source of truth: the root package.json version (so /api/health and the
// in-app version label never drift from the real release). Read once at load.
export const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch { return '0.0.0'; }
})();

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

  app.use(express.json({ limit: '10mb' })); // big lead imports arrive as JSON

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
    console.error(err);
    // A foreign-key violation means the row is still referenced elsewhere —
    // surface that as a clear 409 instead of an opaque 500 so a missed detach
    // (e.g. a new table referencing projects) degrades gracefully.
    if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return res.status(409).json({ error: 'Still referenced by other records — remove or detach those first.' });
    }
    res.status(500).json({ error: 'Server error' });
  });

  // Serve the built client; SPA catch-all for client-side routing.
  const distDir = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  } else {
    app.get('/', (req, res) => res
      .status(503)
      .send('Client not built yet. Run: npm run build'));
  }

  return app;
}

// Starts everything: bootstrap (first-run admin/templates), HTTP server,
// daily backup scheduler. Resolves with the bound port and reachable URLs.
export function startServer({ port = 3000 } = {}) {
  ensureBootstrapped();
  const app = createApp();
  const tls = tlsConfig();
  const scheme = tls ? 'https' : 'http';
  return new Promise((resolve, reject) => {
    const httpServer = tls ? https.createServer(tls, app) : app;
    const server = httpServer.listen(port, '0.0.0.0', () => {
      startBackupScheduler();
      startCloudBackupScheduler();
      startAiWorker();
      startRetentionJob();
      // WhatsApp: default-OFF and lazy. startWhatsApp() returns immediately when
      // whatsapp_enabled is false, and degrades (never throws) if baileys is not
      // installed — so default boot stays clean and offline-safe.
      if (getSetting('whatsapp_enabled', false) === true) {
        startWhatsApp(dbDefault, { getSetting, dataDir: DATA_DIR })
          .catch((e) => console.error('[whatsapp] boot start failed:', e && e.message));
      }
      const hostname = os.hostname().replace(/\.local$/, '');
      resolve({
        server,
        port,
        urls: {
          local: `${scheme}://localhost:${port}`,
          lan: lanAddresses().map((ip) => `${scheme}://${ip}:${port}`),
          mdns: `${scheme}://${hostname}.local:${port}`,
        },
      });
    });
    server.on('error', reject);
  });
}
