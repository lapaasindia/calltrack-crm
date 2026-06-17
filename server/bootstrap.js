// Idempotent first-run setup for a fresh database: the admin login and the
// default WhatsApp templates, WITHOUT demo data. (Demo data lives in seed.js
// and is only for trying the app out.)
import bcrypt from 'bcryptjs';
import db, { getSetting, setSetting } from './db.js';
import { nowUtc } from './lib/istTime.js';

export function ensureBootstrapped() {
  const now = nowUtc();

  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    // First-run admin. If CRM_ADMIN_PASSWORD is set (advanced/automated setups)
    // use it and don't force a change; otherwise fall back to the well-known
    // 'admin123' but flag must_change_password so the account is locked to the
    // change-password endpoint until the operator picks a real password. This
    // closes the "default credential stays valid forever" hole (audit H-1).
    const envPw = process.env.CRM_ADMIN_PASSWORD && String(process.env.CRM_ADMIN_PASSWORD);
    const password = envPw || 'admin123';
    const mustChange = envPw ? 0 : 1;
    db.prepare(
      'INSERT INTO users (username, password_hash, full_name, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('admin', bcrypt.hashSync(password, 10), 'Admin', 'admin', mustChange, now);
    console.log(envPw
      ? 'First run: created admin user from CRM_ADMIN_PASSWORD.'
      : 'First run: created admin user (admin / admin123). You MUST set a new password on first login.');
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

  // A fresh install needs at least one product, otherwise winning/converting a
  // lead to a deal fails ("Pick a valid product") — the Win-Deal screen has an
  // empty dropdown. Seed one neutral, clearly-editable default.
  if (!db.prepare('SELECT id FROM products LIMIT 1').get()) {
    db.prepare(
      'INSERT INTO products (name, price_paise, description, created_at) VALUES (?, ?, ?, ?)'
    ).run('Consultation', 0, 'Default product — rename it or add your own in Settings → Products.', now);
    console.log('First run: created a default product (rename it in Settings → Products).');
  }

  if (getSetting('company_name') === null) setSetting('company_name', 'Our Company');
}
