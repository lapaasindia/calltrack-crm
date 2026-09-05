// Small shared hooks so every page stops re-implementing load/error/retry,
// in-flight guards and visibility-aware polling.
import { useCallback, useEffect, useRef, useState } from 'react';

// useRequest(fetcher, deps, { enabled }) → { data, error, loading, reload, setData }
//   * fetcher({ signal }) returns a promise; it is re-run when deps change or
//     reload() is called, and aborted on unmount / re-run;
//   * previous data is kept while reloading so lists don't flash;
//   * errors never escape — they land in `error` for <ErrorState>.
export function useRequest(fetcher, deps = [], { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: !!enabled });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; });

  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return undefined;
    }
    const ctrl = new AbortController();
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(() => fetcherRef.current({ signal: ctrl.signal }))
      .then((data) => { if (alive) setState({ data, error: null, loading: false }); })
      .catch((err) => {
        if (!alive || (err && err.name === 'AbortError')) return;
        setState((s) => ({ ...s, error: err, loading: false }));
      });
    return () => { alive = false; ctrl.abort(); };
    // deps are the caller's dependency list, spread on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tick, ...deps]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const setData = useCallback((updater) => setState((s) => ({
    ...s, data: typeof updater === 'function' ? updater(s.data) : updater,
  })), []);
  return { ...state, reload, setData };
}

// useSubmit(fn) → [run, saving]. `run` ignores calls while a previous one is
// still in flight (double-tap guard) and flips `saving` for the button label.
// fn's own errors propagate to the caller unless it catches them.
export function useSubmit(fn) {
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = useCallback(async (...args) => {
    if (busy.current) return undefined;
    busy.current = true;
    setSaving(true);
    try {
      return await fnRef.current(...args);
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  }, []);
  return [run, saving];
}

// Debounced copy of a value (search boxes, date ranges).
export function useDebouncedValue(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// Run fn now and every `intervalMs` — but ONLY while the tab is visible.
// Hidden tab → interval cleared; visible again → immediate refresh + restart.
export function usePolling(fn, intervalMs, deps = [], { enabled = true } = {}) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    const start = () => { if (timer == null) timer = setInterval(() => fnRef.current(), intervalMs); };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
    const onVis = () => {
      if (document.visibilityState === 'hidden') stop();
      else { fnRef.current(); start(); }
    };
    fnRef.current();
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...deps]);
}

// A re-render tick every `ms` while `active` (for live elapsed-time labels).
// No interval at all while inactive or while the tab is hidden.
export function useTicker(active, ms = 1000) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let timer = null;
    const start = () => { if (timer == null) timer = setInterval(() => setTick((n) => n + 1), ms); };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
    const onVis = () => { if (document.visibilityState === 'hidden') stop(); else { setTick((n) => n + 1); start(); } };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [active, ms]);
  return tick;
}

// Subscribe to a window event with the latest handler (no re-subscribe churn).
export function useWindowEvent(name, handler, { enabled = true } = {}) {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => {
    if (!enabled) return undefined;
    const fn = (e) => ref.current(e);
    window.addEventListener(name, fn);
    return () => window.removeEventListener(name, fn);
  }, [name, enabled]);
}
