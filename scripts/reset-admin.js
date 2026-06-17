// Recovery tool: reset a user's password directly in the database when you're
// locked out (e.g. the admin password was changed and forgotten).
//
//   node scripts/reset-admin.js [username] [newPassword]
//     defaults: username=admin, newPassword=admin123
//
// Run it on the office Mac from the project root. It's safe while the server is
// running (SQLite WAL + busy_timeout); the new password works on the next login.
// After logging in, change the password in Settings to something only you know.
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'crm.sqlite');

const username = process.argv[2] || 'admin';
const newPassword = process.argv[3] || 'admin123';

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');
const hash = bcrypt.hashSync(newPassword, 10);
const info = db
  .prepare('UPDATE users SET password_hash = ? WHERE username = ? COLLATE NOCASE')
  .run(hash, username);
db.close();

if (info.changes === 0) {
  console.error(`No user named "${username}" found in ${DB_PATH}.`);
  process.exit(1);
}
console.log(`OK — password for "${username}" reset to "${newPassword}".`);
console.log('Log in at http://localhost:3000, then change it in Settings.');
