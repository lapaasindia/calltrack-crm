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

import { DATA_DIR } from './db.js';
import { SqliteSessionStore } from './lib/sessionStore.js';
import { requireAuth } from './middleware/auth.js';
import { startBackupScheduler } from './lib/backup.js';
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
import deviceRoutes from './routes/devices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_VERSION = '1.0.1';

export function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

export function createApp() {
  // Session secret: generated once, persisted — regenerating on each boot
  // would log everyone out on every restart.
  const secretFile = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const SECRET = fs.readFileSync(secretFile, 'utf8');

  const app = express();
  app.disable('x-powered-by');

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
      // LAN over plain http: a Secure cookie would be silently dropped and
      // nobody could log in. This is intentional for this deployment.
      secure: false,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));

  // Public: lets the desktop app (and curl) identify a CallTrack server.
  app.get('/api/health', (req, res) => {
    let diskFreeGb = null;
    try {
      const s = fs.statfsSync(DATA_DIR);
      diskFreeGb = Math.round((s.bavail * s.bsize) / 1073741824);
    } catch { /* best effort */ }
    res.json({ app: 'calltrack-crm', version: APP_VERSION, disk_free_gb: diskFreeGb });
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
  app.use('/api/devices', deviceRoutes);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, req, res, next) => {
    console.error(err);
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
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      startBackupScheduler();
      const hostname = os.hostname().replace(/\.local$/, '');
      resolve({
        server,
        port,
        urls: {
          local: `http://localhost:${port}`,
          lan: lanAddresses().map((ip) => `http://${ip}:${port}`),
          mdns: `http://${hostname}.local:${port}`,
        },
      });
    });
    server.on('error', reject);
  });
}
