// Idempotent first-run setup for a fresh database: the admin login and the
// default WhatsApp templates, WITHOUT demo data. (Demo data lives in seed.js
// and is only for trying the app out.)
import bcrypt from 'bcryptjs';
import db, { getSetting, setSetting } from './db.js';
import { nowUtc } from './lib/istTime.js';

export function ensureBootstrapped() {
  const now = nowUtc();

  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    db.prepare(
      'INSERT INTO users (username, password_hash, full_name, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('admin', bcrypt.hashSync('admin123', 10), 'Admin', 'admin', now);
    console.log('First run: created admin user (admin / admin123 — change it in Settings).');
  }

  if (!db.prepare('SELECT id FROM message_templates LIMIT 1').get()) {
    const mk = db.prepare(
      'INSERT INTO message_templates (name, category, body, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    mk.run('Intro', 'intro',
      'Hi {name}! 👋 This is {caller_name} from {company}. I tried calling you about your enquiry. When is a good time to talk?', 1, now);
    mk.run('Follow-up', 'follow_up',
      'Hi {name}, {caller_name} here from {company}. Just following up on our last conversation about {product}. Shall we connect today?', 2, now);
    mk.run('Payment reminder', 'payment_reminder',
      'Hi {name}, gentle reminder from {company}: your payment of {amount_due} is due on {due_date}. Please let us know once done. Thank you! 🙏', 3, now);
    mk.run('Support check-in', 'support',
      'Hi {name}, {caller_name} from {company} here. Checking in — is everything going well with {product}? Happy to help with anything.', 4, now);
  }

  if (getSetting('company_name') === null) setSetting('company_name', 'Our Company');
}
