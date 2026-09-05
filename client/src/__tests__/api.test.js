import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rupees, rupeesFromRupees, fmtDate, fmtDateTime, fmtEpoch, todayIstDate, dtLocalToUtcIso, utcIsoToDtLocal,
  isOverdue, istDateOf, renderTemplate, telLink, waLink, isSafeHttpUrl, api, ApiError, NETWORK_ERROR_MESSAGE,
  isOffline, checkHealth, goBack,
} from '../api.js';

describe('rupees()', () => {
  it('prints whole rupees without decimals', () => {
    expect(rupees(500000)).toBe('₹5,000');
    expect(rupees(0)).toBe('₹0');
    expect(rupees(null)).toBe('₹0');
  });
  it('prints two decimals whenever there are paise (QA-3 / CLIENT-17)', () => {
    expect(rupees(899982)).toBe('₹8,999.82');
    expect(rupees(5899882)).toBe('₹58,998.82');
    expect(rupees(105)).toBe('₹1.05');
  });
  it('keeps negatives (discount lines) and honours exact', () => {
    expect(rupees(-100050)).toBe('-₹1,000.50');
    expect(rupees(100000, { exact: true })).toBe('₹1,000.00');
  });
  it('uses Indian digit grouping', () => {
    expect(rupees(1234567800)).toBe('₹1,23,45,678');
  });
  it('rupeesFromRupees converts a rupee number once', () => {
    expect(rupeesFromRupees(49999)).toBe('₹49,999');
    expect(rupeesFromRupees(1180.59)).toBe('₹1,180.59');
  });
});

describe('IST date helpers', () => {
  it('fmtDate renders the literal calendar date in any browser tz', () => {
    expect(fmtDate('2026-09-06')).toMatch(/6 Sept? 2026/);
    expect(fmtDate('')).toBe('');
    expect(fmtDate('garbage')).toBe('');
  });
  it('datetime-local ↔ UTC round-trips as IST wall time', () => {
    expect(dtLocalToUtcIso('2026-09-06T11:00')).toBe('2026-09-06T05:30:00.000Z');
    expect(utcIsoToDtLocal('2026-09-06T05:30:00.000Z')).toBe('2026-09-06T11:00');
    expect(utcIsoToDtLocal('')).toBe('');
  });
  it('todayIstDate / istDateOf are YYYY-MM-DD in Asia/Kolkata', () => {
    expect(todayIstDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 2026-09-05T20:00Z is 01:30 on the 6th in IST.
    expect(istDateOf('2026-09-05T20:00:00Z')).toBe('2026-09-06');
  });
  it('isOverdue compares IST calendar days', () => {
    expect(isOverdue('2000-01-01T00:00:00Z')).toBe(true);
    expect(isOverdue(new Date(Date.now() + 86400000 * 3).toISOString())).toBe(false);
  });
  it('fmtDateTime / fmtEpoch tolerate bad input', () => {
    expect(fmtDateTime('')).toBe('');
    expect(fmtDateTime('nope')).toBe('');
    expect(fmtEpoch('abc')).toBe('');
    expect(fmtEpoch(Date.UTC(2026, 8, 6, 5, 30))).toMatch(/6 Sept?/);
  });
});

describe('links & templates', () => {
  it('builds tel: and wa.me links', () => {
    expect(telLink('9876543210')).toBe('tel:+919876543210');
    expect(waLink('9876543210')).toBe('https://wa.me/919876543210');
    expect(waLink('9876543210', 'Hi Ravi & co')).toBe('https://wa.me/919876543210?text=Hi%20Ravi%20%26%20co');
  });
  it('renders template placeholders', () => {
    expect(renderTemplate('Hi {name} from {company}, {product}!', { name: 'Asha', company: 'Lapaas' }))
      .toBe('Hi Asha from Lapaas, our program!');
  });
  it('isSafeHttpUrl guards meeting links (CLIENT-23)', () => {
    expect(isSafeHttpUrl('https://meet.google.com/abc')).toBe(true);
    expect(isSafeHttpUrl('http://x.y')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
  });
});

describe('request()', () => {
  const events = [];
  const listeners = {};
  beforeEach(() => {
    events.length = 0;
    for (const name of ['crm:logout', 'crm:must-change-password', 'crm:connectivity', 'crm:refresh-badges']) {
      listeners[name] = (e) => events.push([name, e.detail]);
      window.addEventListener(name, listeners[name]);
    }
  });
  afterEach(() => {
    for (const [name, fn] of Object.entries(listeners)) window.removeEventListener(name, fn);
    vi.restoreAllMocks();
  });
  const jsonRes = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (k === 'Content-Type' ? (headers[k] ?? 'application/json') : (headers[k] ?? null)) },
    json: async () => body,
  });

  it('returns JSON and fires refresh-badges after a mutation only', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(200, { ok: 1 }));
    await api.get('/api/x');
    expect(events.some(([n]) => n === 'crm:refresh-badges')).toBe(false);
    await api.post('/api/x', { a: 1 });
    expect(events.some(([n]) => n === 'crm:refresh-badges')).toBe(true);
    expect(fetch.mock.calls[1][1].method).toBe('POST');
    expect(fetch.mock.calls[1][1].body).toBe('{"a":1}');
  });
  it('maps a network failure to the office-computer message and flags offline', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.get('/api/leads')).rejects.toMatchObject({ message: NETWORK_ERROR_MESSAGE, status: 0, network: true });
    expect(isOffline()).toBe(true);
    expect(events).toContainEqual(['crm:connectivity', { offline: true }]);
    // recovery clears the flag
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(200, { app: 'calltrack-crm' }));
    expect(await checkHealth()).toBe(true);
    expect(isOffline()).toBe(false);
  });
  it('treats a non-JSON 5xx from a proxy in front of a dead server as unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 502, headers: { get: (k) => (k === 'Content-Type' ? 'text/html' : null) }, json: async () => { throw new Error('not json'); } });
    await expect(api.get('/api/leads')).rejects.toMatchObject({ message: NETWORK_ERROR_MESSAGE, network: true, status: 502 });
    expect(isOffline()).toBe(true);
    // a real JSON 500 from our server is NOT "offline"
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(500, { error: 'Server error', request_id: 'x' }, { 'Content-Type': 'application/json' }));
    const err = await api.get('/api/leads').catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.network).toBeFalsy();
    expect(isOffline()).toBe(false);
  });
  it('401 outside /api/auth dispatches logout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(401, { error: 'Not logged in' }));
    await expect(api.get('/api/leads')).rejects.toBeInstanceOf(ApiError);
    expect(events.some(([n]) => n === 'crm:logout')).toBe(true);
  });
  it('401 on /api/auth surfaces the server message instead (bad password)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(401, { error: 'Invalid username or password' }));
    await expect(api.post('/api/auth/login', {})).rejects.toMatchObject({ message: 'Invalid username or password', status: 401 });
    expect(events.some(([n]) => n === 'crm:logout')).toBe(false);
  });
  it('403 with must_change_password dispatches the event (CLIENT-10)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(403, { error: 'Change your password', must_change_password: true }));
    await expect(api.get('/api/today')).rejects.toMatchObject({ status: 403 });
    expect(events.some(([n]) => n === 'crm:must-change-password')).toBe(true);
  });
  it('plain 403 reads "You don\'t have access"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(403, { error: 'Owner only' }));
    await expect(api.get('/api/audit')).rejects.toMatchObject({ message: "You don't have access — Owner only" });
  });
  it('429 carries retryAfter from Retry-After / retry_after_seconds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(429, { error: 'Too many attempts', retry_after_seconds: 45 }, { 'Retry-After': '45' }));
    await expect(api.post('/api/auth/login', {})).rejects.toMatchObject({ status: 429, retryAfter: 45 });
  });
  it('keeps request_id from a 500 body for the toast', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(500, { error: 'Server error', request_id: 'abc123' }));
    await expect(api.get('/api/x')).rejects.toMatchObject({ status: 500, data: { request_id: 'abc123' } });
  });
});

describe('goBack()', () => {
  it('pops history only when react-router has a previous entry', () => {
    const navigate = vi.fn();
    window.history.replaceState({ idx: 0 }, '');
    goBack(navigate, '/leads');
    expect(navigate).toHaveBeenCalledWith('/leads', { replace: true });
    window.history.replaceState({ idx: 2 }, '');
    goBack(navigate, '/leads');
    expect(navigate).toHaveBeenLastCalledWith(-1);
  });
});
