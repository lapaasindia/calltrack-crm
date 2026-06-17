// Phase 1B — off-site encrypted Google Drive backup. Unit + integration tests
// that NEVER touch the real Google API: the Drive client is injected as a fake.
//   - cryptoBackup: encrypt/decrypt round-trip + wrong-passphrase throws + verifier
//   - cloudBackup file selection respects the include/exclude rules
//   - runCloudBackup records ledger rows and is incremental (unchanged files
//     upload exactly once)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-cloudbackup-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
fs.mkdirSync(process.env.CRM_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.CRM_BACKUP_DIR, { recursive: true });

let crypto; // cryptoBackup module
let cloud; // cloudBackup module
let db; // db module (settings + ledger)

before(async () => {
  crypto = await import('../lib/cryptoBackup.js');
  cloud = await import('../lib/cloudBackup.js');
  db = (await import('../db.js')).default;
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── cryptoBackup ─────────────────────────────────────────────────────────────
test('encryptFile/decryptFile round-trips the exact bytes', () => {
  const src = path.join(TMP, 'plain.bin');
  const enc = path.join(TMP, 'plain.enc');
  const out = path.join(TMP, 'plain.out');
  const data = Buffer.from('secret payload — हिन्दी + 🔐 + binary \x00\x01\x02', 'utf8');
  fs.writeFileSync(src, data);

  crypto.encryptFile(src, enc, 'correct horse battery staple');
  // Ciphertext must NOT equal plaintext and must carry our header.
  const blob = fs.readFileSync(enc);
  assert.ok(!blob.equals(data), 'ciphertext differs from plaintext');
  assert.ok(blob.length > data.length, 'header + tag add bytes');

  crypto.decryptFile(enc, out, 'correct horse battery staple');
  assert.deepEqual(fs.readFileSync(out), data, 'decrypted bytes match original');
});

test('decryptFile throws on the wrong passphrase', () => {
  const src = path.join(TMP, 'wp.bin');
  const enc = path.join(TMP, 'wp.enc');
  const out = path.join(TMP, 'wp.out');
  fs.writeFileSync(src, Buffer.from('top secret'));
  crypto.encryptFile(src, enc, 'right-passphrase');
  assert.throws(() => crypto.decryptFile(enc, out, 'wrong-passphrase'),
    /authenticate|Unsupported state/i);
});

test('deriveVerifier detects a wrong passphrase without storing it', () => {
  const salt = crypto.newSaltHex();
  const verifier = crypto.deriveVerifier('pass-one', salt);
  assert.ok(crypto.verifierMatches('pass-one', salt, verifier));
  assert.ok(!crypto.verifierMatches('pass-two', salt, verifier));
});

// ── file selection (include / exclude) ───────────────────────────────────────
// Uses ISOLATED dirs (NOT the live CRM_DATA_DIR) so we can drop a junk file
// literally named crm.sqlite without clobbering the real database connection.
test('buildUploadSet includes data + latest snapshot, excludes junk', () => {
  const dataDir = path.join(TMP, 'sel-data');
  const backupDir = path.join(TMP, 'sel-backups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  // Recordings (should be included).
  fs.mkdirSync(path.join(dataDir, 'recordings', '2026', '06'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'recordings', '2026', '06', 'a.m4a'), 'audio-a');
  fs.writeFileSync(path.join(dataDir, 'recordings', '2026', '06', 'b.m4a'), 'audio-b');
  // Invoices (future dir — should be included).
  fs.mkdirSync(path.join(dataDir, 'invoices'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'invoices', 'inv-1.pdf'), 'pdf');

  // Excluded junk.
  fs.writeFileSync(path.join(dataDir, 'crm.sqlite'), 'live-db');
  fs.writeFileSync(path.join(dataDir, 'crm.sqlite-wal'), 'wal');
  fs.writeFileSync(path.join(dataDir, 'crm.sqlite-shm'), 'shm');
  fs.writeFileSync(path.join(dataDir, 'sessions.sqlite'), 'sessions');
  fs.writeFileSync(path.join(dataDir, 'secret.key'), 'KEY');
  fs.writeFileSync(path.join(dataDir, 'server.log'), 'log');
  fs.mkdirSync(path.join(dataDir, 'apk'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'apk', 'calltrack.apk'), 'apk');
  // tmp scratch under recordings — excluded.
  fs.mkdirSync(path.join(dataDir, 'recordings', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'recordings', 'tmp', 'partial'), 'tmp');

  // Two dated DB snapshots — only the newest must be selected.
  fs.writeFileSync(path.join(backupDir, 'crm-2026-06-15.sqlite'), 'old-snap');
  fs.writeFileSync(path.join(backupDir, 'crm-2026-06-16.sqlite'), 'new-snap');

  const set = cloud.buildUploadSet({ dataDir, backupDir });
  const paths = set.map((s) => s.source_path).sort();

  assert.ok(paths.includes('recordings/2026/06/a.m4a'));
  assert.ok(paths.includes('recordings/2026/06/b.m4a'));
  assert.ok(paths.includes('invoices/inv-1.pdf'));
  assert.ok(paths.includes('backups/crm-2026-06-16.sqlite'), 'newest snapshot included');
  assert.ok(!paths.includes('backups/crm-2026-06-15.sqlite'), 'older snapshot NOT uploaded');

  for (const junk of [
    'crm.sqlite', 'crm.sqlite-wal', 'crm.sqlite-shm', 'sessions.sqlite',
    'secret.key', 'server.log', 'apk/calltrack.apk', 'recordings/tmp/partial',
  ]) {
    assert.ok(!paths.includes(junk), `excluded: ${junk}`);
  }
});

// ── runCloudBackup with an injected fake uploader ────────────────────────────
function makeFakeDrive() {
  const store = new Map(); // id -> {name, bytes}
  let n = 0;
  return {
    uploads: [],
    deletes: [],
    refreshAccessToken: async () => ({ access_token: 'fake-token', expires_in: 3600 }),
    ensureFolder: async () => 'fake-folder-id',
    uploadFile: async (_token, { name, srcAbs }) => {
      const id = `file-${++n}`;
      const bytes = fs.statSync(srcAbs).size;
      store.set(id, { name, bytes });
      const rec = { id, name, bytes };
      // Verify the uploaded blob is ENCRYPTED (carries our magic header).
      const head = fs.readFileSync(srcAbs).subarray(0, 5).toString('latin1');
      rec.encrypted = head === 'CTBKP';
      return rec;
    },
    listFiles: async () => [...store.entries()].map(([id, v]) => ({ id, name: v.name, size: v.bytes })),
    deleteFile: async (_token, id) => { store.delete(id); return true; },
    _store: store,
  };
}

test('runCloudBackup encrypts, uploads, records ledger rows, and is incremental', async () => {
  // Connect Drive in settings (fake creds; the fake client ignores them).
  const { setSetting, getSetting } = await import('../db.js');
  const { sealSecret } = await import('../lib/secretBox.js');
  setSetting('cloud_backup', {
    client_id: 'fake-client',
    client_secret_enc: sealSecret('fake-secret'),
    refresh_token_enc: sealSecret('fake-refresh'),
    sync_enabled: true,
  });

  // Seed two recordings in the LIVE data dir so they're part of the upload set.
  const recDir = path.join(process.env.CRM_DATA_DIR, 'recordings', '2026', '06');
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, 'a.m4a'), 'audio-a');
  fs.writeFileSync(path.join(recDir, 'b.m4a'), 'audio-b');

  const fake = makeFakeDrive();
  fake.uploadFile = (orig => async (token, args) => {
    const rec = await orig(token, args);
    fake.uploads.push({ name: args.name, encrypted: rec.encrypted });
    return rec;
  })(fake.uploadFile);

  const res1 = await cloud.runCloudBackup({
    drive: fake,
    passphrase: 'a-very-strong-passphrase',
    notify: false,
  });
  assert.equal(res1.ok, true, `first run ok (${res1.error || ''})`);
  assert.ok(res1.files >= 1, 'uploaded at least the snapshot + recordings');
  // Every uploaded blob must have been encrypted (CTBKP magic).
  assert.ok(fake.uploads.every((u) => u.encrypted), 'all uploads are ciphertext');

  // Ledger rows recorded for each uploaded file.
  const ledgerCount = db.prepare('SELECT COUNT(*) AS n FROM cloud_backup_files').get().n;
  assert.equal(ledgerCount, res1.files, 'one ledger row per uploaded file');
  // The recordings were uploaded on run 1.
  assert.ok(fake.uploads.some((u) => u.name.includes('a.m4a')), 'recording a uploaded');
  assert.ok(fake.uploads.some((u) => u.name.includes('b.m4a')), 'recording b uploaded');

  // Second run: content-addressed files (recordings) must NOT re-upload. The DB
  // snapshot legitimately changes daily (we just wrote ledger rows), so it may
  // re-upload — that's correct. The incremental guarantee is about UNCHANGED
  // files (the recordings).
  fake.uploads.length = 0;
  const res2 = await cloud.runCloudBackup({
    drive: fake,
    passphrase: 'a-very-strong-passphrase',
    notify: false,
  });
  assert.equal(res2.ok, true);
  assert.ok(!fake.uploads.some((u) => u.name.includes('.m4a')), 'unchanged recordings NOT re-uploaded');
  assert.ok(res2.skipped >= 2, 'both recordings skipped via the ledger');

  // Adding a NEW recording uploads exactly that one new recording next run
  // (plus possibly the changed DB snapshot — assert on the recording only).
  fs.writeFileSync(path.join(process.env.CRM_DATA_DIR, 'recordings', '2026', '06', 'c.m4a'), 'audio-c');
  fake.uploads.length = 0;
  const res3 = await cloud.runCloudBackup({
    drive: fake,
    passphrase: 'a-very-strong-passphrase',
    notify: false,
  });
  const recordingUploads = fake.uploads.filter((u) => u.name.includes('.m4a'));
  assert.equal(recordingUploads.length, 1, 'only the new recording uploaded');
  assert.ok(recordingUploads[0].name.includes('c.m4a'));
  assert.ok(!fake.uploads.some((u) => u.name.includes('a.m4a') || u.name.includes('b.m4a')),
    'old recordings still not re-uploaded');
});

test('runCloudBackup skips quietly when Drive is not connected', async () => {
  const { setSetting } = await import('../db.js');
  setSetting('cloud_backup', { sync_enabled: false });
  const res = await cloud.runCloudBackup({ drive: makeFakeDrive(), passphrase: 'x', notify: false });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'not_connected');
});

// ── Route layer (owner-only control surface) ─────────────────────────────────
test('backup routes: status, passphrase set+verify, connect gating', async () => {
  const { startServer } = await import('../app.js');
  const { server } = await startServer({ port: 0 });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const apiCall = async (p, { method = 'GET', body, cookie } = {}) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(`${baseUrl}${p}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
  };

  try {
    const login = await apiCall('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    // Status reflects whatever the prior tests left in settings (connected w/ fake creds).
    const status = await apiCall('/api/backup/status', { cookie });
    assert.equal(status.status, 200);
    assert.equal(typeof status.data.hasPassphrase, 'boolean');
    assert.equal(typeof status.data.connected, 'boolean');

    // Connect requires saved client credentials → first ensure creds exist.
    const creds = await apiCall('/api/backup/google/credentials', {
      method: 'POST', cookie, body: { client_id: 'cid', client_secret: 'csecret' },
    });
    assert.equal(creds.status, 200);
    const connect = await apiCall('/api/backup/google/connect', { method: 'POST', cookie });
    assert.equal(connect.status, 200);
    assert.ok(connect.data.url.startsWith('https://accounts.google.com/'), 'returns a Google consent URL');
    assert.ok(connect.data.url.includes('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file'));

    // Passphrase: too short rejected.
    const short = await apiCall('/api/backup/passphrase', { method: 'POST', cookie, body: { passphrase: 'short' } });
    assert.equal(short.status, 400);

    // Set a fresh passphrase (this test process's db may already have one from
    // the run-now tests; handle both: a match verifies, a mismatch 400s).
    const set = await apiCall('/api/backup/passphrase', {
      method: 'POST', cookie, body: { passphrase: 'a-very-strong-passphrase' },
    });
    assert.equal(set.status, 200, JSON.stringify(set.data));
    assert.ok(set.data.created || set.data.verified);

    // A different passphrase must NOT be accepted once one is set.
    const wrong = await apiCall('/api/backup/passphrase', {
      method: 'POST', cookie, body: { passphrase: 'a-totally-different-one' },
    });
    assert.equal(wrong.status, 400);
    assert.match(wrong.data.error, /does not match/i);

    // Owner-only: a non-owner session is forbidden. Create a caller + log in.
    await apiCall('/api/users', {
      method: 'POST', cookie,
      body: { username: 'caller1', full_name: 'Caller One', password: 'pass123', role: 'caller' },
    });
    const callerLogin = await apiCall('/api/auth/login', { method: 'POST', body: { username: 'caller1', password: 'pass123' } });
    const callerCookie = callerLogin.headers.get('set-cookie').split(';')[0];
    const forbidden = await apiCall('/api/backup/status', { cookie: callerCookie });
    assert.equal(forbidden.status, 403, 'cloud backup is owner-only');
  } finally {
    server.close();
  }
});
