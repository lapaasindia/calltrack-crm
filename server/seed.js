// Seeds the database: admin + demo callers, products, WhatsApp templates,
// targets, and ~30 demo leads with realistic activity so dashboards have data.
// Safe to re-run: skips anything that already exists.
import bcrypt from 'bcryptjs';
import db, { setSetting, getSetting } from './db.js';
import { nowUtc, todayIst, addDays } from './lib/istTime.js';
import { changeStage } from './lib/leadStage.js';

const now = nowUtc();
const today = todayIst();

function utcAt(istDate, istHour, istMin = 0) {
  // Convert an IST wall-clock time to a UTC ISO instant.
  return new Date(Date.parse(`${istDate}T00:00:00.000Z`) - 330 * 60000 + (istHour * 60 + istMin) * 60000).toISOString();
}

// ---------- Users ----------
const haveAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
if (!haveAdmin) {
  const mk = (username, name, role, pw) => db.prepare(
    'INSERT INTO users (username, password_hash, full_name, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(username, bcrypt.hashSync(pw, 10), name, role, now).lastInsertRowid;
  mk('admin', 'Sahil Khanna', 'admin', 'admin123');
  mk('priya', 'Priya Sharma', 'caller', 'caller123');
  mk('rahul', 'Rahul Verma', 'caller', 'caller123');
  console.log('Users created:');
  console.log('  admin / admin123   (admin — CHANGE THIS PASSWORD after first login)');
  console.log('  priya / caller123  (caller)');
  console.log('  rahul / caller123  (caller)');
} else {
  console.log('Users already exist — skipping.');
}

const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
const callers = db.prepare("SELECT id, full_name FROM users WHERE role = 'caller' AND is_active = 1").all();

// ---------- Products ----------
if (!db.prepare('SELECT id FROM products LIMIT 1').get()) {
  const mk = db.prepare('INSERT INTO products (name, price_paise, description, created_at) VALUES (?, ?, ?, ?)');
  mk.run('Mentorship Program', 4999900, '1:1 mentorship — 6 months', now);
  mk.run('Marketing Course', 1499900, 'Self-paced digital marketing course', now);
  mk.run('Community Membership', 499900, 'Annual community access', now);
  console.log('Products created.');
}

// ---------- WhatsApp templates ----------
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
  console.log('WhatsApp templates created.');
}

// ---------- Targets ----------
if (!db.prepare('SELECT id FROM targets LIMIT 1').get() && callers.length) {
  const mk = db.prepare(
    `INSERT INTO targets (user_id, calls_target, connects_target, deals_target, effective_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const c of callers) mk.run(c.id, 50, 25, 1, addDays(today, -60), now);
  console.log('Daily targets set (50 calls / 25 connects / 1 deal).');
}

// ---------- Settings ----------
if (getSetting('company_name') === null) setSetting('company_name', 'Lapaas');

// ---------- Demo leads with activity ----------
if (!db.prepare("SELECT id FROM leads WHERE source = 'demo' LIMIT 1").get() && callers.length) {
  const names = [
    ['Amit Patel', 'Ahmedabad'], ['Sneha Reddy', 'Hyderabad'], ['Vikram Singh', 'Jaipur'],
    ['Pooja Gupta', 'Delhi'], ['Rohan Mehta', 'Mumbai'], ['Anjali Nair', 'Kochi'],
    ['Karan Malhotra', 'Chandigarh'], ['Divya Iyer', 'Chennai'], ['Arjun Das', 'Kolkata'],
    ['Neha Joshi', 'Pune'], ['Suresh Kumar', 'Bengaluru'], ['Kavita Rao', 'Mysuru'],
    ['Manish Agarwal', 'Lucknow'], ['Ritu Bansal', 'Indore'], ['Deepak Yadav', 'Patna'],
    ['Shreya Kulkarni', 'Nagpur'], ['Nikhil Choudhary', 'Surat'], ['Meera Pillai', 'Thiruvananthapuram'],
    ['Aakash Jain', 'Bhopal'], ['Tanvi Desai', 'Vadodara'], ['Rajesh Khanna', 'Amritsar'],
    ['Swati Mishra', 'Varanasi'], ['Harsh Vora', 'Rajkot'], ['Lakshmi Menon', 'Coimbatore'],
    ['Gaurav Saxena', 'Kanpur'], ['Ishita Bose', 'Guwahati'], ['Varun Kapoor', 'Dehradun'],
    ['Priyanka Sinha', 'Ranchi'], ['Sandeep Reddy', 'Vijayawada'], ['Anita Sharma', 'Gurugram'],
  ];
  const sources = ['meta_ads', 'google_form', 'website', 'referral', 'demo'];
  const products = db.prepare('SELECT * FROM products').all();

  const insertLead = db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, city, source, stage, assigned_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'demo', 'new', ?, ?, ?)`
  );
  const insertCall = db.prepare(
    `INSERT INTO calls (lead_id, user_id, call_type, disposition, outcome, notes, called_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFu = db.prepare(
    `INSERT INTO follow_ups (lead_id, assigned_to, due_at, reason, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  );
  const insertDeal = db.prepare(
    `INSERT INTO deals (lead_id, product_id, created_by, deal_value_paise, won_at, won_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertInst = db.prepare(
    'INSERT INTO installments (deal_id, seq, amount_paise, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertPay = db.prepare(
    `INSERT INTO payments (deal_id, installment_id, amount_paise, method, received_date, recorded_by, recorded_at)
     VALUES (?, ?, ?, 'upi', ?, ?, ?)`
  );

  db.transaction(() => {
    names.forEach(([name, city], i) => {
      const phone = String(9000000001 + i * 7919 % 999999999).padStart(10, '9').slice(0, 10);
      const caller = callers[i % callers.length];
      const createdDate = addDays(today, -(i % 21) - 1);
      const created = utcAt(createdDate, 10 + (i % 6));
      const leadId = insertLead.run(name, phone, phone, city, caller.id, created, created).lastInsertRowid;

      const fate = i % 10;
      const callDate = addDays(createdDate, 1) <= today ? addDays(createdDate, 1) : today;
      const callAt = utcAt(callDate, 11 + (i % 7), (i * 13) % 60);

      if (fate <= 1) {
        // stays new — not yet called
      } else if (fate <= 3) {
        insertCall.run(leadId, caller.id, 'sales', 'not_picked', null, null, callAt);
        insertCall.run(leadId, caller.id, 'sales', 'connected', null, 'Asked to call later', utcAt(callDate, 16));
        changeStage(leadId, 'new', 'contacted', caller.id);
      } else if (fate <= 5) {
        insertCall.run(leadId, caller.id, 'sales', 'connected', 'interested', 'Wants details on WhatsApp', callAt);
        changeStage(leadId, 'new', 'contacted', caller.id);
        changeStage(leadId, 'contacted', 'interested', caller.id);
        const dueDate = i % 2 === 0 ? today : addDays(today, -1); // some due, some overdue
        insertFu.run(leadId, caller.id, utcAt(dueDate, 11), 'Send details and close', now);
      } else if (fate <= 6) {
        insertCall.run(leadId, caller.id, 'sales', 'connected', 'not_interested', 'Budget issue', callAt);
        changeStage(leadId, 'new', 'contacted', caller.id);
        changeStage(leadId, 'contacted', 'lost', caller.id, 'Not interested');
      } else if (fate <= 8) {
        // Won with EMI plan, partially paid
        insertCall.run(leadId, caller.id, 'sales', 'connected', 'interested', 'Ready to enroll', callAt);
        changeStage(leadId, 'new', 'contacted', caller.id);
        changeStage(leadId, 'contacted', 'interested', caller.id);
        changeStage(leadId, 'interested', 'won', caller.id);
        const product = products[i % products.length];
        const wonDate = addDays(callDate, 1) <= today ? addDays(callDate, 1) : today;
        const dealId = insertDeal.run(
          leadId, product.id, caller.id, product.price_paise,
          utcAt(wonDate, 12), wonDate, now
        ).lastInsertRowid;
        const emi = Math.round(product.price_paise / 3 / 100) * 100;
        const last = product.price_paise - emi * 2;
        const inst1 = insertInst.run(dealId, 1, emi, wonDate, 'paid', now).lastInsertRowid;
        // Alternate between an overdue EMI and one due in the future so the
        // collections view has both states to show.
        insertInst.run(dealId, 2, emi, i % 2 === 0 ? addDays(today, -3) : addDays(wonDate, 30), 'pending', now);
        insertInst.run(dealId, 3, last, addDays(wonDate, 60), 'pending', now);
        insertPay.run(dealId, inst1, emi, wonDate, caller.id, utcAt(wonDate, 13));
      } else {
        // Fully paid customer, support follow-up scheduled
        const product = products[i % products.length];
        insertCall.run(leadId, caller.id, 'sales', 'connected', 'interested', null, callAt);
        changeStage(leadId, 'new', 'contacted', caller.id);
        changeStage(leadId, 'contacted', 'won', caller.id);
        const wonDate = callDate;
        const dealId = insertDeal.run(
          leadId, product.id, caller.id, product.price_paise,
          utcAt(wonDate, 15), wonDate, now
        ).lastInsertRowid;
        insertPay.run(dealId, null, product.price_paise, wonDate, caller.id, utcAt(wonDate, 15, 30));
        db.prepare("UPDATE deals SET status = 'completed' WHERE id = ?").run(dealId);
        insertFu.run(leadId, caller.id, utcAt(today, 17), 'Onboarding check-in call', now);
      }
    });
  })();
  console.log(`Demo leads created (${names.length}). Remove anytime: Settings → Clear demo data.`);
} else {
  console.log('Demo leads already exist (or no callers) — skipping.');
}

console.log('\nSeed complete. Start the app with: npm start');
