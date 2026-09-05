// Finding the lead a captured (unknown-at-sync-time) call probably belongs to,
// so a reviewer can attach it to the EXISTING lead instead of creating a
// duplicate. Captured calls store the canonical 10-digit phone (see phone.js).
//
// Since migration 018 every number a lead has ever had lives in lead_phones
// (kind 'primary' | 'alt' | 'previous', maintained by triggers on leads), so
// one indexed lookup replaces the old replace(replace(alt_phone…)) scan and
// also surfaces leads by a number they USED to have (SCALE-18b).
import db from '../db.js';
import { canSeeAllLeads } from './permissions.js';

const CHUNK = 200; // stay well under SQLite's bound-parameter limit
const MATCH_BY_KIND = { primary: 'phone', alt: 'alt_phone', previous: 'previous' };
const MATCH_RANK = { phone: 0, previous: 1, alt_phone: 2 };

// Candidate leads for MANY phones in ONE query (SCALE-15: the review page used
// to run a LIKE scan per row). Returns Map<phone, candidates[]>, best match
// first per phone:
//   - current primary phone      -> match: 'phone'     (high confidence)
//   - a number the lead had before -> match: 'previous'  (edited away; likely)
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
    // Open rows (current primary / current alt) plus closed 'previous' rows;
    // a closed alt row is a number that was edited away as alt — not offered.
    const rows = db.prepare(
      `SELECT lp.phone AS q, lp.kind, lp.valid_to,
              l.id, l.name, l.phone, l.stage, l.assigned_to, l.updated_at
         FROM lead_phones lp JOIN leads l ON l.id = lp.lead_id
        WHERE lp.phone IN (${ph}) AND l.deleted_at IS NULL
          AND (lp.valid_to IS NULL OR lp.kind = 'previous')`
    ).all(...chunk);
    for (const r of rows) {
      if (!seesAll && r.assigned_to !== user.id) continue;
      const bucket = out.get(r.q);
      if (!bucket) continue;
      const match = MATCH_BY_KIND[r.kind] || 'alt_phone';
      // The same lead can appear once per kind for a phone (e.g. a number that
      // is both its previous primary and current alt); keep the best kind.
      const existing = bucket.find((c) => c.id === r.id);
      if (existing) {
        if (MATCH_RANK[match] < MATCH_RANK[existing.match]) existing.match = match;
        continue;
      }
      bucket.push({
        id: r.id, name: r.name, phone: r.phone, stage: r.stage, assigned_to: r.assigned_to,
        match, _u: r.updated_at, _v: r.valid_to,
      });
    }
  }
  for (const [p, cands] of out) {
    // Exact phone first, then previous holders (most recently ended first),
    // then alt matches; ties by most recently updated.
    cands.sort((a, b) => {
      if (a.match !== b.match) return MATCH_RANK[a.match] - MATCH_RANK[b.match];
      if (a.match === 'previous' && a._v !== b._v) return String(b._v).localeCompare(String(a._v));
      return String(b._u).localeCompare(String(a._u));
    });
    out.set(p, cands.slice(0, 10).map(({ _u, _v, ...c }) => c));
  }
  return out;
}

// Single-phone convenience wrapper over the batch lookup.
export function findLeadCandidates(phone, user) {
  if (!phone) return [];
  return findLeadCandidatesBatch([phone], user).get(phone) || [];
}
