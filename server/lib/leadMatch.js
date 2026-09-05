// Finding the lead a captured (unknown-at-sync-time) call probably belongs to,
// so a reviewer can attach it to the EXISTING lead instead of creating a
// duplicate. Captured calls store the canonical 10-digit phone (see phone.js).
import db from '../db.js';
import { canSeeAllLeads } from './permissions.js';

// alt_phone is stored unnormalised ("+91 97000-00002", "097000 00002"); its
// last 10 digits (after dropping the usual separators) are the number.
const ALT_DIGITS = "replace(replace(replace(replace(replace(alt_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')";
const CHUNK = 200; // stay well under SQLite's bound-parameter limit

// Candidate leads for MANY phones in ONE query (SCALE-15: the review page used
// to run a LIKE scan per row). Returns Map<phone, candidates[]>, best match
// first per phone:
//   - exact primary-phone match  -> match: 'phone'     (high confidence)
//   - alt_phone last-10-digits   -> match: 'alt_phone' (possible — confirm only)
// Scoped to leads the user may access (admin tier: all; others: their own
// assigned leads), mirroring canAccessLead so we never offer a button that
// would 403. Every requested phone gets an entry (possibly empty).
export function findLeadCandidatesBatch(phones, user) {
  const out = new Map();
  const list = [...new Set((phones || []).filter((p) => typeof p === 'string' && p))];
  for (const p of list) out.set(p, []);
  if (!list.length) return out;
  const seesAll = canSeeAllLeads(user.role);

  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const ph = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, name, phone, stage, assigned_to, updated_at,
              CASE WHEN alt_phone IS NOT NULL AND alt_phone <> ''
                   THEN substr(${ALT_DIGITS}, -10, 10) END AS alt_last10
         FROM leads
        WHERE deleted_at IS NULL
          AND (phone IN (${ph}) OR substr(${ALT_DIGITS}, -10, 10) IN (${ph}))`
    ).all(...chunk, ...chunk);
    for (const l of rows) {
      if (!seesAll && l.assigned_to !== user.id) continue;
      const cand = { id: l.id, name: l.name, phone: l.phone, stage: l.stage, assigned_to: l.assigned_to };
      if (out.has(l.phone)) out.get(l.phone).push({ ...cand, match: 'phone', _u: l.updated_at });
      if (l.alt_last10 && l.alt_last10 !== l.phone && out.has(l.alt_last10)) {
        out.get(l.alt_last10).push({ ...cand, match: 'alt_phone', _u: l.updated_at });
      }
    }
  }
  for (const [p, cands] of out) {
    // Exact phone matches first, then most recently updated.
    cands.sort((a, b) => {
      if (a.match !== b.match) return a.match === 'phone' ? -1 : 1;
      return String(b._u).localeCompare(String(a._u));
    });
    out.set(p, cands.slice(0, 10).map(({ _u, ...c }) => c));
  }
  return out;
}

// Single-phone convenience wrapper over the batch lookup.
export function findLeadCandidates(phone, user) {
  if (!phone) return [];
  return findLeadCandidatesBatch([phone], user).get(phone) || [];
}
