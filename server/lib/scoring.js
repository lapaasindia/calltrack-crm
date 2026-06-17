// Rule-based lead scoring — PURE, unit-testable (no DB, no clock dependency
// except an injectable `now`). Turns the signals we actually have (source,
// call engagement, recency, stage, optional budget/industry from extra_json)
// into a 0..100 score plus a transparent factor breakdown the UI can explain.
//
// recalcLeadScore(db, leadId) is the only impure entry point: it loads the lead
// + its calls and persists score + score_factors. Hook it after a call is
// logged / synced and after a stage change.

import { nowUtc } from './istTime.js';

// Source quality — inbound/warm channels convert better than cold lists.
const SOURCE_WEIGHTS = {
  referral: 20,
  whatsapp: 18,
  website: 16,
  facebook: 12,
  instagram: 12,
  call_capture: 10,
  manual: 8,
  import: 4,
};
const SOURCE_DEFAULT = 8;

// Stage boost — a lead that has shown interest is worth more than a fresh one.
const STAGE_BOOST = {
  new: 0,
  contacted: 4,
  follow_up: 8,
  interested: 14,
  won: 20,
  lost: 0,
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function parseExtra(lead) {
  if (!lead || !lead.extra_json) return {};
  try {
    const v = JSON.parse(lead.extra_json);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// Days between the most recent call and `now`. null when there are no calls.
function daysSinceLastCall(calls, now) {
  let latest = null;
  for (const c of calls || []) {
    const t = Date.parse(c.called_at);
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  if (latest === null) return null;
  return Math.max(0, (Date.parse(now) - latest) / 86400000);
}

// Core scorer. PURE: returns {score, factors}. `now` is injectable for tests.
export function calculateLeadScore(lead, calls = [], now = nowUtc()) {
  const factors = {};

  // 1) Source weight (0..20).
  const source = String(lead?.source || 'manual').toLowerCase();
  factors.source = SOURCE_WEIGHTS[source] ?? SOURCE_DEFAULT;

  // 2) Call engagement (0..35). Connected conversations weigh most; mere
  //    attempts (not_picked/busy/etc.) earn a little. Capped so a dialer
  //    spamming a dead number can't run the score up. WhatsApp mirror rows
  //    (source='whatsapp') are excluded: they're messaging activity, not phone
  //    engagement, and outbound mirrors are hard-coded disposition='connected'
  //    so counting them would let a burst of outbound texts inflate the score.
  let connected = 0;
  let attempts = 0;
  for (const c of calls) {
    if (c.source === 'whatsapp') continue;
    if (c.disposition === 'connected') connected += 1;
    else attempts += 1;
  }
  factors.engagement = clamp(connected * 10 + attempts * 2, 0, 35);
  factors.connected_calls = connected;
  factors.total_calls = connected + attempts;

  // 3) Recency decay (-20..+15). A recent conversation is a strong buy signal;
  //    a lead untouched for weeks goes cold. No calls at all = neutral 0.
  const days = daysSinceLastCall(calls, now);
  if (days === null) {
    factors.recency = 0;
  } else if (days <= 1) factors.recency = 15;
  else if (days <= 3) factors.recency = 10;
  else if (days <= 7) factors.recency = 5;
  else if (days <= 14) factors.recency = 0;
  else if (days <= 30) factors.recency = -10;
  else factors.recency = -20;
  factors.days_since_last_call = days === null ? null : Math.round(days);

  // 4) Stage boost (0..20).
  factors.stage = STAGE_BOOST[lead?.stage] ?? 0;

  // 5) Optional budget signal from extra_json (0..15). Accepts a number of
  //    rupees or paise — we only care about relative magnitude.
  const extra = parseExtra(lead);
  const budget = Number(extra.budget ?? extra.budget_paise ?? extra.budget_rupees);
  if (Number.isFinite(budget) && budget > 0) {
    // Normalize: treat >= 1,00,000 (rupees) as the top band.
    const rupees = budget > 1000000 ? budget / 100 : budget; // paise→rupees heuristic
    if (rupees >= 100000) factors.budget = 15;
    else if (rupees >= 50000) factors.budget = 10;
    else if (rupees >= 10000) factors.budget = 6;
    else factors.budget = 3;
  } else {
    factors.budget = 0;
  }
  if (extra.industry) factors.industry = String(extra.industry);

  // Base 30 so an untouched lead from a decent source lands "Cold-Warm", not 0.
  const raw = 30
    + factors.source
    + factors.engagement
    + factors.recency
    + factors.stage
    + factors.budget;

  const score = clamp(Math.round(raw), 0, 100);
  return { score, factors };
}

// Hot / Warm / Cold label for a score. Hot>=80, Warm>=50, Cold<50.
export function scoreLabel(score) {
  const s = Number(score) || 0;
  if (s >= 80) return { label: 'Hot', emoji: '🔥', color: '#dc2626' };
  if (s >= 50) return { label: 'Warm', emoji: '🌤️', color: '#d97706' };
  return { label: 'Cold', emoji: '❄️', color: '#2563eb' };
}

// Impure: load the lead + its calls, recompute, persist. Safe to call inside an
// outer transaction (single UPDATE). Returns the {score, factors} it wrote, or
// null if the lead is gone.
export function recalcLeadScore(db, leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return null;
  const calls = db.prepare(
    'SELECT disposition, called_at, source FROM calls WHERE lead_id = ?'
  ).all(leadId);
  const { score, factors } = calculateLeadScore(lead, calls);
  db.prepare('UPDATE leads SET score = ?, score_factors = ? WHERE id = ?')
    .run(score, JSON.stringify(factors), leadId);
  return { score, factors };
}
