// `npm run seed` / `npm run setup` path (audit SEC-1): the seeded admin must be
// forced to rotate the well-known 'admin123' unless CRM_ADMIN_PASSWORD was
// supplied — mirroring bootstrap.js. Runs seed.js as a child process against
// throwaway data dirs and inspects the resulting database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED = path.join(ROOT, 'server', 'seed.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-seed-test-'));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function runSeed(dataDir, { adminPassword } = {}) {
  const env = { ...process.env, CRM_DATA_DIR: dataDir, CRM_BACKUP_DIR: path.join(dataDir, 'backups') };
  delete env.CRM_ADMIN_PASSWORD;
  if (adminPassword) env.CRM_ADMIN_PASSWORD = adminPassword;
  return execFileSync(process.execPath, [SEED], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const openDb = (dataDir) => new Database(path.join(dataDir, 'crm.sqlite'), { readonly: true });

test('SEC-1: without CRM_ADMIN_PASSWORD the seeded admin is admin123 but must change it before doing anything', () => {
  const dir = path.join(TMP, 'default');
  const out = runSeed(dir);
  assert.match(out, /MUST set a new password/);
  const db = openDb(dir);
  const admin = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  assert.ok(admin, 'admin created');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.must_change_password, 1, 'forced rotation flag set');
  assert.ok(bcrypt.compareSync('admin123', admin.password_hash), 'documented default still logs in (then gated)');
  // Demo callers exist and are flagged as demo accounts in the output.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username IN ('priya','rahul')").get().n, 2);
  assert.match(out, /DEMO account/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leads WHERE source = 'demo'").get().n, 30);
  db.close();

  // Idempotent: a second run adds nothing and does not reset the flag.
  const again = runSeed(dir);
  assert.match(again, /Users already exist/);
  const db2 = openDb(dir);
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM users").get().n, 3);
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM leads WHERE source = 'demo'").get().n, 30);
  assert.equal(db2.prepare("SELECT must_change_password m FROM users WHERE username = 'admin'").get().m, 1);
  db2.close();
});

test('SEC-1: with CRM_ADMIN_PASSWORD the seeded admin uses it and is not gated', () => {
  const dir = path.join(TMP, 'env');
  const out = runSeed(dir, { adminPassword: 'Seed-Pass-2026!' });
  assert.match(out, /CRM_ADMIN_PASSWORD/);
  assert.doesNotMatch(out, /admin123/);
  const db = openDb(dir);
  const admin = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  assert.equal(admin.must_change_password, 0);
  assert.ok(bcrypt.compareSync('Seed-Pass-2026!', admin.password_hash));
  assert.ok(!bcrypt.compareSync('admin123', admin.password_hash));
  db.close();
});

test('SEC-1 end to end: the seeded default admin is locked to change-password until rotated', async () => {
  const dir = path.join(TMP, 'gate');
  runSeed(dir);
  // Boot a server on the seeded database and prove the gate is active.
  process.env.CRM_DATA_DIR = dir;
  process.env.CRM_BACKUP_DIR = path.join(dir, 'backups');
  delete process.env.CRM_ADMIN_PASSWORD;
  const { startServer } = await import('../app.js');
  const { server } = await startServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).must_change_password, true);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const leads = await fetch(`${base}/api/leads`, { headers: { Cookie: cookie } });
    assert.equal(leads.status, 403, 'seeded default admin cannot use the API until the password is changed');
    const change = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ current_password: 'admin123', new_password: 'Rotated-Pass-1' }),
    });
    assert.equal(change.status, 200);
    assert.equal((await fetch(`${base}/api/leads`, { headers: { Cookie: cookie } })).status, 200);
  } finally {
    server.close();
  }
});
