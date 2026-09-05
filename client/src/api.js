// Thin fetch wrapper.
//   * network failure → ApiError("Can't reach the office computer") + a global
//     'crm:connectivity' event so the app can show the offline banner;
//   * 401 → 'crm:logout' (session expired / revoked elsewhere);
//   * 403 {must_change_password} → 'crm:must-change-password';
//   * 403 → "You don't have access";
//   * 429 → err.retryAfter (seconds) from Retry-After / retry_after_seconds;
//   * any successful mutation → 'crm:refresh-badges' so nav counts re-poll.
export const NETWORK_ERROR_MESSAGE = "Can't reach the office computer";

let offline = false;
export const isOffline = () => offline;
function setOffline(next) {
  if (offline === next) return;
  offline = next;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crm:connectivity', { detail: { offline: next } }));
  }
}

export class ApiError extends Error {
  constructor(message, status, data, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    Object.assign(this, extra);
  }
}

function errorMessage(status, data) {
  if (status === 403) {
    return data && data.error ? `You don't have access — ${data.error}` : "You don't have access";
  }
  return (data && data.error) || `Request failed (${status})`;
}

async function request(path, options = {}) {
  const { signal, ...rest } = options;
  const method = String(rest.method || 'GET').toUpperCase();
  let res;
  try {
    res = await fetch(path, {
      headers: rest.body ? { 'Content-Type': 'application/json' } : {},
      credentials: 'same-origin',
      ...rest,
      signal,
      body: rest.body ? JSON.stringify(rest.body) : undefined,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    setOffline(true);
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0, null, { network: true });
  }
  // A gateway/proxy in front of a dead server answers 502/503/504 (or a plain-
  // text 500) instead of refusing the connection — treat that as unreachable too.
  const isJson = /json/i.test(res.headers.get('Content-Type') || '');
  if (res.status >= 500 && !isJson) {
    setOffline(true);
    throw new ApiError(NETWORK_ERROR_MESSAGE, res.status, null, { network: true });
  }
  setOffline(false);
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    window.dispatchEvent(new Event('crm:logout'));
    throw new ApiError('Session expired — please log in again', 401, null);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && data && data.must_change_password) {
      window.dispatchEvent(new Event('crm:must-change-password'));
      throw new ApiError(data.error || 'You must change your password before continuing', 403, data);
    }
    const err = new ApiError(errorMessage(res.status, data), res.status, data);
    const retryAfter = Number(res.headers.get('Retry-After')) || Number(data && data.retry_after_seconds) || 0;
    if (retryAfter > 0) err.retryAfter = Math.ceil(retryAfter);
    throw err;
  }
  // Any successful mutation may change the nav counts — except auth calls
  // (logout/login/change-password), which the app handles itself.
  if (method !== 'GET' && method !== 'HEAD' && !path.startsWith('/api/auth')) {
    window.dispatchEvent(new Event('crm:refresh-badges'));
  }
  return data;
}

export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};

// Cheap reachability probe used by the offline banner (never dispatches logout).
export async function checkHealth() {
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok && /json/i.test(res.headers.get('Content-Type') || '')) { setOffline(false); return true; }
  } catch { /* still down */ }
  return false;
}

// ---------- formatting helpers ----------
const inr0 = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});
const inr2 = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
// Integer paise → "₹1,234" or, whenever there ARE paise (or exact is set),
// "₹1,234.56" — so GST lines/totals match the printed invoice to the paisa.
export function rupees(paise, { exact = false } = {}) {
  const p = Math.round(Number(paise) || 0);
  if (exact || p % 100 !== 0) return inr2.format(p / 100);
  return inr0.format(p / 100);
}
// For endpoints that (still) return rupees as a number.
export const rupeesFromRupees = (r) => rupees(Math.round((Number(r) || 0) * 100));

export function fmtDateTime(utcIso) {
  if (!utcIso) return '';
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// Epoch milliseconds (e.g. Android call-log timestamps) → same display.
export function fmtEpoch(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return fmtDateTime(new Date(n).toISOString());
}

// Business dates are IST calendar dates ('YYYY-MM-DD'). Parse as UTC and
// format as UTC so the literal calendar date renders in EVERY browser
// timezone — parsing without 'Z' would shift it by the local offset.
export function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', {
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

// IST 'YYYY-MM-DD' of a UTC instant.
export function istDateOf(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));
}

// IST date n days ago ('YYYY-MM-DD').
export function daysAgo(n) {
  return istDateOf(new Date(Date.now() - n * 86400000));
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

// Only http(s) links are ever rendered as clickable hrefs (defence in depth
// for legacy rows written before the server enforced the scheme).
export const isSafeHttpUrl = (url) => /^https?:\/\/\S+$/i.test(String(url || '').trim());

// In-app back: only pop history when the previous entry is ours (react-router
// keeps an index in history.state). Otherwise — e.g. a standalone/PWA launch
// straight onto a detail page — go to the given fallback route.
export function goBack(navigate, fallback = '/') {
  const idx = typeof window !== 'undefined' && window.history.state && window.history.state.idx;
  if (typeof idx === 'number' && idx > 0) navigate(-1);
  else navigate(fallback, { replace: true });
}

// Print a server-rendered HTML page (invoice, weekly report) from THIS tab:
// fetch it with the session cookie and print it through a hidden same-origin
// iframe. Works in browsers, in the desktop shell (where window.open goes to
// the external browser without the session) and in Android WebViews.
export async function printUrl(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not load the printable page (${res.status})`);
  const html = await res.text();
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('title', 'print');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;';
  document.body.appendChild(iframe);
  await new Promise((resolve) => {
    iframe.onload = () => resolve();
    iframe.srcdoc = html;
  });
  const win = iframe.contentWindow;
  win.focus();
  win.print();
  setTimeout(() => iframe.remove(), 60000);
}
