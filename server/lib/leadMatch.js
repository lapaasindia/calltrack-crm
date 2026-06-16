// Finding the lead a captured (unknown-at-sync-time) call probably belongs to,
// so a reviewer can attach it to the EXISTING lead instead of creating a
// duplicate. Captured calls store the canonical 10-digit phone (see phone.js).
import db from '../db.js';

// Returns candidate leads for a 10-digit phone, best match first:
//   - exact primary-phone match  -> match: 'phone'   (high confidence)
//   - alt_phone digit-substring  -> match: 'alt_phone' (possible; alt_phone is
//     stored unnormalised, so this is a best-effort suffix match — confirm only)
// Scoped to leads the user may access (admins: all; callers: their own assigned
// leads), mirroring canAccessLead so we never offer a button that would 403.
export function findLeadCandidates(phone, user) {
  if (!phone) return [];
  const like = `%${phone}%`;
  const rows = db.prepare(
    `SELECT id, name, phone, alt_phone, stage, assigned_to
       FROM leads
      WHERE deleted_at IS NULL
        AND ( phone = ?
              OR ( alt_phone IS NOT NULL AND alt_phone <> ''
                   AND replace(replace(replace(replace(alt_phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ? ) )
      ORDER BY (phone = ?) DESC, updated_at DESC
      LIMIT 10`
  ).all(phone, like, phone);

  return rows
    .filter((l) => user.role === 'admin' || l.assigned_to === user.id)
    .map((l) => ({
      id: l.id,
      name: l.name,
      phone: l.phone,
      stage: l.stage,
      assigned_to: l.assigned_to,
      match: l.phone === phone ? 'phone' : 'alt_phone',
    }));
}
