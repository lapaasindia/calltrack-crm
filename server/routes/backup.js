// Phase 1B — off-site encrypted Google Drive backup control surface. Owner-only.
//
// Connect flow:
//   1. Owner saves their Google Cloud "Desktop" OAuth client id + secret, then
//      POST /google/connect → returns the consent URL (opened in a new tab).
//   2. Google redirects the browser back to GET /google/callback?code=... on
//      THIS server (loopback-friendly). We exchange the code, store the refresh
//      token encrypted at rest, and serve a tiny "connected, you can close this"
//      page.
//   3. Owner sets a backup passphrase (POST /passphrase). We store ONLY a scrypt
//      salt + a GCM verifier — never the passphrase. Losing it = unrecoverable
//      backups (the UI warns loudly).
//   4. POST /run-now triggers an immediate encrypted upload.
import { Router } from 'express';
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.js';
import { requireOwner } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import {
  buildAuthUrl, exchangeCode,
} from '../lib/googleDrive.js';
import { sealSecret } from '../lib/secretBox.js';
import {
  newSaltHex, deriveVerifier, verifierMatches,
} from '../lib/cryptoBackup.js';
import {
  runCloudBackup, driveConnected, hasPassphrase,
  setInMemoryPassphrase, getInMemoryPassphrase,
} from '../lib/cloudBackup.js';

const router = Router();
router.use(requireOwner);

// The loopback redirect URI. Google's "Desktop" client accepts http on the
// machine's own host, so we reflect the request host (LAN IP / localhost) +
// the callback path. Must be added as an Authorized redirect URI in the Google
// Cloud console for the OAuth client.
function redirectUri(req) {
  const proto = req.protocol;
  const host = req.get('host');
  return `${proto}://${host}/api/backup/google/callback`;
}

// GET /api/backup/status — never echoes secrets, only booleans + last-sync.
router.get('/status', (req, res) => {
  const cfg = getSetting('cloud_backup', null) || {};
  res.json({
    connected: driveConnected(),
    hasClientCredentials: !!(cfg.client_id && cfg.client_secret_enc),
    hasPassphrase: hasPassphrase(),
    passphraseLoaded: !!getInMemoryPassphrase(), // can unattended sync run this process?
    syncEnabled: !!cfg.sync_enabled,
    lastCloudBackup: getSetting('last_cloud_backup', null),
  });
});

// POST /api/backup/google/credentials — owner pastes the Desktop OAuth client
// id + secret from Google Cloud. Secret is encrypted at rest immediately.
router.post('/google/credentials', (req, res) => {
  const clientId = String(req.body.client_id || '').trim();
  const clientSecret = String(req.body.client_secret || '').trim();
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Both client_id and client_secret are required' });
  }
  const cfg = getSetting('cloud_backup', null) || {};
  cfg.client_id = clientId;
  cfg.client_secret_enc = sealSecret(clientSecret);
  setSetting('cloud_backup', cfg);
  logAudit({ action: 'CLOUD_BACKUP_CREDENTIALS_SET', user: req.user, entity_type: 'backup' });
  res.json({ ok: true });
});

// POST /api/backup/google/connect — returns the consent URL to open.
router.post('/google/connect', (req, res) => {
  const cfg = getSetting('cloud_backup', null) || {};
  if (!cfg.client_id) {
    return res.status(400).json({ error: 'Save your Google OAuth client id/secret first' });
  }
  // Random per-flow state, parked in the session, checked on callback. Closes
  // the OAuth-CSRF gap where a forged GET could bind us to an attacker's Drive.
  const state = crypto.randomBytes(16).toString('hex');
  req.session.driveOauthState = state;
  const url = buildAuthUrl({
    clientId: cfg.client_id,
    redirectUri: redirectUri(req),
    state,
  });
  res.json({ url });
});

// GET /api/backup/google/callback — Google redirects the browser here. Exchange
// the code, store the encrypted refresh token, mark connected, serve a closer.
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.status(400).send(closePage(`Google authorization failed: ${error}`, false));
  if (!code) return res.status(400).send(closePage('No authorization code returned by Google.', false));
  // CSRF check: state must match the random value minted on /connect (then clear
  // it so it's single-use). A forged callback has no matching session state.
  const expectedState = req.session.driveOauthState;
  delete req.session.driveOauthState;
  if (!expectedState || state !== expectedState) {
    return res.status(400).send(closePage('Invalid OAuth state — please start the Connect flow again.', false));
  }

  try {
    const cfg = getSetting('cloud_backup', null) || {};
    if (!cfg.client_id || !cfg.client_secret_enc) {
      return res.status(400).send(closePage('OAuth client not configured.', false));
    }
    const { openSecret } = await import('../lib/secretBox.js');
    const tokens = await exchangeCode({
      clientId: cfg.client_id,
      clientSecret: openSecret(cfg.client_secret_enc),
      code: String(code),
      redirectUri: redirectUri(req),
    });
    if (!tokens.refresh_token) {
      return res.status(400).send(closePage(
        'Google did not return a refresh token. Remove the app from your Google account permissions and try Connect again.',
        false,
      ));
    }
    cfg.refresh_token_enc = sealSecret(tokens.refresh_token);
    cfg.sync_enabled = true;
    cfg.connected_at = new Date().toISOString();
    setSetting('cloud_backup', cfg);
    logAudit({ action: 'CLOUD_BACKUP_CONNECTED', user: req.user, entity_type: 'backup' });
    res.send(closePage('Google Drive connected ✓ — you can close this tab and return to CallTrack.', true));
  } catch (err) {
    res.status(500).send(closePage(`Connection failed: ${err.message}`, false));
  }
});

// POST /api/backup/passphrase — set (first time) or verify (subsequent) the
// backup passphrase. We store ONLY salt + verifier; the passphrase itself is
// held in process memory so the scheduler can run unattended until restart.
router.post('/passphrase', (req, res) => {
  const passphrase = String(req.body.passphrase || '');
  if (!passphrase) return res.status(400).json({ error: 'Passphrase required' });
  const existing = getSetting('cloud_backup_passphrase', null);
  if (existing && existing.salt && existing.verifier) {
    // Already set: verify it matches (so we don't silently change the key under
    // a pile of already-encrypted Drive backups that the old passphrase opens).
    // No length policy here — it must accept whatever was set previously.
    if (!verifierMatches(passphrase, existing.salt, existing.verifier)) {
      return res.status(400).json({ error: 'Passphrase does not match the one already set' });
    }
    setInMemoryPassphrase(passphrase);
    return res.json({ ok: true, verified: true });
  }
  // Setting a NEW passphrase: this single secret protects ALL off-site backups
  // against an offline attack, so require real strength (audit M-5).
  if (passphrase.length < 12) {
    return res.status(400).json({ error: 'Backup passphrase must be at least 12 characters (it is the only thing protecting your off-site backups)' });
  }
  if (/^(.)\1*$/.test(passphrase) || /^(?:password|passphrase|backup|calltrack)/i.test(passphrase)) {
    return res.status(400).json({ error: 'That passphrase is too weak — use a longer, unpredictable phrase' });
  }
  const salt = newSaltHex();
  const verifier = deriveVerifier(passphrase, salt);
  setSetting('cloud_backup_passphrase', { salt, verifier, set_at: new Date().toISOString() });
  setInMemoryPassphrase(passphrase);
  logAudit({ action: 'CLOUD_BACKUP_PASSPHRASE_SET', user: req.user, entity_type: 'backup' });
  res.json({ ok: true, created: true });
});

// POST /api/backup/run-now — trigger an immediate backup. The passphrase must
// have been loaded this session (via /passphrase) or be in CRM_BACKUP_PASSPHRASE.
router.post('/run-now', async (req, res) => {
  if (!driveConnected()) return res.status(400).json({ error: 'Google Drive is not connected' });
  const pass = String(req.body.passphrase || '') || getInMemoryPassphrase();
  if (!pass) {
    return res.status(400).json({ error: 'Enter the backup passphrase first' });
  }
  // If a passphrase was supplied here, verify it against the stored verifier.
  const stored = getSetting('cloud_backup_passphrase', null);
  if (stored && stored.salt && stored.verifier && !verifierMatches(pass, stored.salt, stored.verifier)) {
    return res.status(400).json({ error: 'Wrong passphrase' });
  }
  setInMemoryPassphrase(pass);
  try {
    const result = await runCloudBackup({ passphrase: pass });
    if (result.ok) {
      logAudit({ action: 'CLOUD_BACKUP_RUN', user: req.user, entity_type: 'backup', details: { files: result.files, bytes: result.bytes } });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `Backup failed: ${err.message}` });
  }
});

// POST /api/backup/disconnect — stop syncing but KEEP the tokens/passphrase so
// reconnecting is one click. Just flips sync_enabled off.
router.post('/disconnect', (req, res) => {
  const cfg = getSetting('cloud_backup', null) || {};
  cfg.sync_enabled = false;
  setSetting('cloud_backup', cfg);
  setInMemoryPassphrase(null);
  logAudit({ action: 'CLOUD_BACKUP_DISCONNECTED', user: req.user, entity_type: 'backup' });
  res.json({ ok: true });
});

// Tiny self-contained HTML for the OAuth popup tab.
function closePage(message, ok) {
  const color = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html><html><head><meta charset="utf-8"><title>CallTrack Backup</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f1a;color:#e6edf6;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:420px;text-align:center;padding:28px;background:#121a2b;border-radius:16px;
border:1px solid #243049}.msg{color:${color};font-weight:700;font-size:17px;margin-bottom:8px}
small{color:#8b97ab}</style></head>
<body><div class="box"><div class="msg">${escapeHtml(message)}</div>
<small>This tab can be closed.</small></div>
<script>setTimeout(function(){try{window.close()}catch(e){}},2500)</script></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export default router;
