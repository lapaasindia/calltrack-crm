// Thin fetch wrapper. 401 → bounce to login (session expired / logged out).
async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'same-origin',
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    window.dispatchEvent(new Event('crm:logout'));
    throw new ApiError('Session expired — please log in again', 401, null);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),
};

// ---------- formatting helpers ----------
const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});
export const rupees = (paise) => inr.format(Math.round((paise || 0) / 100));

export function fmtDateTime(utcIso) {
  if (!utcIso) return '';
  return new Date(utcIso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// Business dates are IST calendar dates ('YYYY-MM-DD'). Parse as UTC and
// format as UTC so the literal calendar date renders in EVERY browser
// timezone — parsing without 'Z' would shift it by the local offset.
export function fmtDate(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
  });
}

export function todayIstDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export const IST_OFFSET_MS = 330 * 60 * 1000;

// Interpret a datetime-local input value ('YYYY-MM-DDTHH:mm') as IST wall
// time and return the UTC instant. new Date(value) would interpret it in the
// browser's timezone instead — wrong whenever that isn't IST.
export function dtLocalToUtcIso(dtLocal) {
  const [d, t] = dtLocal.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, min] = t.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, day, h, min) - IST_OFFSET_MS).toISOString();
}

// Inverse of dtLocalToUtcIso: a UTC instant → the 'YYYY-MM-DDTHH:mm' value a
// datetime-local input expects, expressed as IST wall time (so editing a saved
// instant shows the same clock time the user picked, in every browser tz).
export function utcIsoToDtLocal(utcIso) {
  if (!utcIso) return '';
  return new Date(Date.parse(utcIso) + IST_OFFSET_MS).toISOString().slice(0, 16);
}

// Is this UTC instant before the start of today (IST)? → overdue badge
export function isOverdue(utcIso) {
  const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date(utcIso));
  return istDate < todayIstDate();
}

// Render a WhatsApp template body with lead/deal context.
export function renderTemplate(body, ctx) {
  return body
    .replaceAll('{name}', ctx.name || '')
    .replaceAll('{product}', ctx.product || 'our program')
    .replaceAll('{amount_due}', ctx.amount_due || '')
    .replaceAll('{due_date}', ctx.due_date || '')
    .replaceAll('{caller_name}', ctx.caller_name || '')
    .replaceAll('{company}', ctx.company || '');
}

export const telLink = (phone) => `tel:+91${phone}`;
export const waLink = (phone, text) =>
  `https://wa.me/91${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
