// Single source of truth for Indian phone normalization.
// Used by: manual lead entry, CSV/XLSX import, search, tel:/wa.me link builders.
// Canonical form: 10 digits, first digit 6-9.

const SCI_NOTATION = /^\s*\d+(?:\.\d+)?[eE]\+?\d+\s*$/;

export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
  let s = String(raw).trim();
  if (s === '') return { ok: false, reason: 'empty' };

  // Meta Lead Ads exports phones as "p:+919876543210"
  if (s.toLowerCase().startsWith('p:')) s = s.slice(2);

  // Excel-mangled scientific notation, e.g. "9.87655E+09". The expansion is
  // exact arithmetic, but a short mantissa means Excel truncated the display
  // and the trailing digits are gone. Two or more trailing zeros on a mobile
  // number almost always means lost digits — flag the row, never guess.
  if (SCI_NOTATION.test(s)) {
    const num = Number(s);
    if (!Number.isFinite(num)) return { ok: false, reason: 'invalid' };
    const expanded = num.toFixed(0);
    if (/00$/.test(expanded)) return { ok: false, reason: 'excel_mangled' };
    s = expanded;
  }

  const digits = s.replace(/\D/g, '');
  if (digits === '') return { ok: false, reason: 'empty' };

  let phone = digits;
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  else if (phone.length === 13 && phone.startsWith('091')) phone = phone.slice(3);
  else if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);

  if (phone.length !== 10) return { ok: false, reason: 'wrong_length' };
  if (!/^[6-9]/.test(phone)) return { ok: false, reason: 'bad_prefix' };
  return { ok: true, phone };
}

// tel: link — direct anchor, works over plain http on every mobile browser.
export function telLink(phone) {
  return `tel:+91${phone}`;
}

// wa.me requires country code WITHOUT '+'; text must be URI-encoded
// (handles Hindi/emoji; newlines become %0A).
export function waLink(phone, text) {
  const base = `https://wa.me/91${phone}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}
