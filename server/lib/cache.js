// Tiny in-memory response cache for the polled, expensive-to-compute
// read endpoints (audit SCALE-12): /api/dashboard, /api/reports/summary,
// /api/reports/leaderboard, /api/coaching/leaderboard. Those are requested
// far more often than the data changes (every open dashboard tab polls), and
// they only ever aggregate — so a 30 s TTL plus invalidation on every write
// is invisible to users and turns 20 concurrent dashboard loads into one
// query.
//
//   key   = route + user scope (admin tier → team:<role>, else u:<id>) + the
//           sorted query string, so no user can ever see another scope's copy
//   TTL   = 30 s (CACHE_TTL_MS)
//   bump()= drop everything. Called from the calls/deals/payments/leads write
//           routes and, as a catch-all, by app.js for every successful
//           mutating /api request (sync, review, imports, WhatsApp…).
//
// Responses carry `X-Cache: HIT|MISS`. Only 200 JSON responses are stored.
export const CACHE_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 500;

const store = new Map(); // key -> { expires, body, type }
let generation = 0;
let hits = 0;
let misses = 0;

export function bump() {
  generation += 1;
  store.clear();
}

export function cacheStats() {
  return { entries: store.size, generation, hits, misses, ttl_ms: CACHE_TTL_MS };
}

function get(key) {
  const e = store.get(key);
  if (!e) return null;
  if (e.expires <= Date.now()) { store.delete(key); return null; }
  return e;
}

function set(key, body, type) {
  if (store.size >= MAX_ENTRIES) {
    // Evict the oldest entry (Map preserves insertion order).
    const first = store.keys().next().value;
    if (first !== undefined) store.delete(first);
  }
  store.set(key, { expires: Date.now() + CACHE_TTL_MS, body, type });
}

// Canonical query string: sorted keys, first value of each.
export function canonicalQuery(q) {
  return Object.keys(q || {}).sort()
    .map((k) => `${k}=${Array.isArray(q[k]) ? q[k][0] : q[k]}`)
    .join('&');
}

// Express middleware factory. `scopeOf(req)` returns the scope string.
export function cached(route, scopeOf) {
  return (req, res, next) => {
    if (req.method !== 'GET' || req.query.nocache === '1') return next();
    const key = `${route}|${scopeOf(req)}|${canonicalQuery(req.query)}`;
    const hit = get(key);
    if (hit) {
      hits += 1;
      res.set('X-Cache', 'HIT');
      res.set('Content-Type', hit.type);
      return res.status(200).send(hit.body);
    }
    misses += 1;
    res.set('X-Cache', 'MISS');
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        try {
          set(key, JSON.stringify(body), 'application/json; charset=utf-8');
        } catch { /* unserialisable — just don't cache */ }
      }
      return originalJson(body);
    };
    next();
  };
}

// Catch-all invalidation: any successful mutating /api request drops the
// cache. Mounted in app.js after auth so unauthenticated probes can't churn it.
export function invalidateOnWrite(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => { if (res.statusCode < 400) bump(); });
  next();
}

// Test hook.
export function _resetCacheForTests() {
  store.clear();
  generation = 0;
  hits = 0;
  misses = 0;
}
