import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';

import { DATA_DIR } from './db.js';
import { SqliteSessionStore } from './lib/sessionStore.js';
import { requireAuth } from './middleware/auth.js';
import { startBackupScheduler } from './lib/backup.js';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Session secret: generated once, persisted — regenerating on each boot would
// log everyone out on every restart.
const secretFile = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
}
const SECRET = fs.readFileSync(secretFile, 'utf8');

const app = express();
app.disable('x-powered-by');
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

function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

app.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  const primary = ips[0] ? `http://${ips[0]}:${PORT}` : `http://localhost:${PORT}`;
  const hostname = os.hostname().replace(/\.local$/, '');
  console.log('\n  CallTrack CRM is running!\n');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  On office WiFi:    http://${ip}:${PORT}`);
  console.log(`  Easy to remember:  http://${hostname}.local:${PORT}  (works on iPhones/most Androids)\n`);
  console.log('  Scan to open on a phone:\n');
  qrcode.generate(primary, { small: true });
  console.log('');
  startBackupScheduler();
});
