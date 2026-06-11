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

export function fmtDate(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export function todayIstDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// Is this UTC instant before the start of today (IST)? → overdue badge
export function isOverdue(utcIso, dateOnly) {
  const today = todayIstDate();
  if (dateOnly) return utcIso < today;
  const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date(utcIso));
  return istDate < today;
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
