import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, NavLink, Navigate, Link, useLocation } from 'react-router-dom';
import { api, checkHealth, fmtDateTime, isOffline } from './api.js';
import { AppCtx } from './ctx.js';
import { isAdmin, isOwner, isReadOnly, roleLabel } from './permissions.js';
import { usePolling, useWindowEvent } from './hooks.js';
import { ConfirmModal, Modal, PromptModal, invalidateTemplateCache } from './components.jsx';
import { setTimerUser, stopTimer, clearUserState } from './taskTimer.js';
import Login from './pages/Login.jsx';
import ForcePasswordChange from './pages/ForcePasswordChange.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Today from './pages/Today.jsx';
import Leads from './pages/Leads.jsx';
import LeadDetail from './pages/LeadDetail.jsx';
import Collections from './pages/Collections.jsx';
import Review from './pages/Review.jsx';
import Tasks from './pages/Tasks.jsx';
import TaskDetail from './pages/TaskDetail.jsx';
import Projects from './pages/Projects.jsx';
import Calendar from './pages/Calendar.jsx';
import Meetings from './pages/Meetings.jsx';
import MeetingDetail from './pages/MeetingDetail.jsx';
import CurrentWorkWidget from './CurrentWorkWidget.jsx';

export { useApp } from './ctx.js';

// Admin-only / heavy pages are split out of the caller bundle (CLIENT-11):
// recharts (Reports), SheetJS + papaparse (Import), qrcode (Settings)…
const Reports = lazy(() => import('./pages/Reports.jsx'));
const ImportPage = lazy(() => import('./pages/ImportPage.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const WhatsApp = lazy(() => import('./pages/WhatsApp.jsx'));
const Coaching = lazy(() => import('./pages/Coaching.jsx'));
const PriceBuilder = lazy(() => import('./pages/PriceBuilder.jsx'));
const Invoices = lazy(() => import('./pages/Invoices.jsx'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail.jsx'));
const AuditLog = lazy(() => import('./pages/AuditLog.jsx'));

const WA_SEEN_KEY = (uid) => `crm_wa_seen:${uid}`;
function waSince(uid) {
  try { return localStorage.getItem(WA_SEEN_KEY(uid)) || ''; } catch { return ''; }
}

function Toast({ toast }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {toast && <div className={`toast ${toast.kind || ''}`}>{toast.msg}</div>}
    </div>
  );
}

function PageLoading() {
  return <div className="page-loading" role="status" aria-live="polite">Loading…</div>;
}

function Splash({ error, onRetry }) {
  return (
    <div className="login-wrap">
      <div className="splash" role="status" aria-live="polite">
        <div className="logo">Call<span>Track</span></div>
        <div className="tag">{error ? error.message : 'Loading…'}</div>
        {error && <button type="button" className="btn" onClick={onRetry}>Try again</button>}
      </div>
    </div>
  );
}

// Known route the current role may not open (QA-13): say so instead of a
// silent bounce to the home page.
function NoAccess({ reason }) {
  return (
    <div className="card empty" role="alert">
      <div className="big" aria-hidden="true">🚫</div>
      <div style={{ fontWeight: 700, color: 'var(--ink)' }}>{reason || "You don't have access to this page"}</div>
      <div style={{ marginTop: 10 }}><Link className="btn small" to="/">Go to home</Link></div>
    </div>
  );
}

function OfflineBanner({ offline, onRetry }) {
  if (!offline) return null;
  return (
    <div className="offline-banner" role="status" aria-live="assertive">
      <span aria-hidden="true">📡</span> Can't reach the office computer — retrying…
      <button type="button" className="btn small secondary" onClick={onRetry}>Retry now</button>
    </div>
  );
}

const NOTIF_ICON = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '⛔' };

function NotificationBell({ data, onReadAll }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const unread = (data && data.unread) || 0;
  const list = (data && data.notifications) || [];

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="notif-bell" ref={ref}>
      <button type="button" className="notif-trigger" onClick={() => setOpen((o) => !o)}
        title="Notifications" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open} aria-haspopup="true">
        🔔{unread > 0 && <span className="notif-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-dropdown" role="region" aria-label="Notifications">
          <div className="notif-head">
            <b>Notifications</b>
            {unread > 0 && (
              <button type="button" className="notif-readall" onClick={() => { onReadAll(); }}>Mark all read</button>
            )}
          </div>
          <div className="notif-list">
            {list.length === 0 && <div className="notif-empty">You're all caught up.</div>}
            {list.map((n) => (
              <div key={n.id} className={`notif-item ${n.read ? '' : 'unread'}`}>
                <span className="notif-ic" aria-hidden="true">{NOTIF_ICON[n.type] || NOTIF_ICON.info}</span>
                <div className="notif-body">
                  <div className="notif-title">{n.title}</div>
                  {n.body && <div className="notif-text">{n.body}</div>}
                  <div className="notif-time">{fmtDateTime(n.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Role-aware nav: `primary` = the four bottom-nav slots on phones (callers get
// Today / Leads / Payments / Review; admin tier gets Dashboard / Today / Leads /
// Work), `rest` = everything else, reachable from the More sheet (CLIENT-6).
function buildNav(user, { waEnabled, dueCount, reviewCount, waUnread }) {
  const admin = isAdmin(user.role);
  const owner = isOwner(user.role);
  const today = { to: admin ? '/today' : '/', label: 'Today', icon: '☀️', badge: dueCount };
  const dashboard = { to: admin ? '/' : '/dashboard', label: 'Dashboard', icon: '📊' };
  const leads = { to: '/leads', label: 'Leads', icon: '👥' };
  const work = { to: '/work', label: 'Work', icon: '🗂️' };
  const projects = { to: '/projects', label: 'Projects', icon: '📁' };
  const calendar = { to: '/calendar', label: 'Calendar', icon: '📅' };
  const meetings = { to: '/meetings', label: 'Meetings', icon: '🤝' };
  const payments = { to: '/collections', label: 'Payments', icon: '₹' };
  const pricing = { to: '/pricing', label: 'Price builder', icon: '🧮' };
  const invoices = { to: '/invoices', label: 'Invoices', icon: '🧾' };
  const whatsapp = waEnabled && admin ? [{ to: '/whatsapp', label: 'WhatsApp', icon: '💬', badge: waUnread }] : [];
  const coaching = { to: '/coaching', label: 'Coaching', icon: '🎯' };
  const review = { to: '/review', label: 'Review', icon: '🔍', badge: reviewCount };
  const adminOnly = admin ? [
    { to: '/import', label: 'Import', icon: '⬆️' },
    { to: '/reports', label: 'Reports', icon: '📈' },
  ] : [];
  const ownerOnly = owner ? [
    { to: '/settings', label: 'Settings', icon: '⚙️' },
    { to: '/audit', label: 'Audit log', icon: '📜' },
  ] : [];
  const primary = admin ? [dashboard, today, leads, work] : [today, leads, payments, review];
  const rest = admin
    ? [projects, calendar, meetings, payments, pricing, invoices, ...whatsapp, coaching, review, ...adminOnly, ...ownerOnly]
    : [dashboard, work, projects, calendar, meetings, pricing, invoices, coaching];
  return { primary, rest, all: [...primary, ...rest] };
}

function NavItem({ it, onClick }) {
  return (
    <NavLink to={it.to} end={it.to === '/'} onClick={onClick}>
      <span aria-hidden="true">{it.icon}</span> {it.label}
      {it.badge > 0 && <span className="pill-count" aria-label={`${it.badge} pending`}>{it.badge}</span>}
    </NavLink>
  );
}

function MoreSheet({ items, user, onClose, onLogout }) {
  return (
    <Modal title="More" onClose={onClose} size="more-sheet">
      <nav className="more-list" aria-label="More pages">
        {items.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.to === '/'} onClick={onClose}>
            <span aria-hidden="true">{it.icon}</span> {it.label}
            {it.badge > 0 && <span className="pill-count">{it.badge}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="more-foot">
        <span><b>{user.full_name}</b> · {roleLabel(user.role)} · v{__APP_VERSION__}</span>
        <button type="button" className="btn small secondary" onClick={onLogout}>Log out</button>
      </div>
    </Modal>
  );
}

function Nav({ user, nav, notifs, onReadAll, onLogout }) {
  const location = useLocation();
  const [more, setMore] = useState(false);
  const restBadge = nav.rest.reduce((s, it) => s + (it.badge > 0 ? it.badge : 0), 0);
  const moreActive = nav.rest.some((it) => (it.to === '/' ? location.pathname === '/' : location.pathname.startsWith(it.to)));
  useEffect(() => { setMore(false); }, [location.pathname]);
  return (
    <>
      <aside className="sidebar">
        <div className="logo">Call<span>Track</span></div>
        <nav aria-label="Main">
          {nav.all.map((it) => <NavItem key={it.to} it={it} />)}
        </nav>
        <div className="spacer" />
        <div className="user-box">
          <div className="user-box-head">
            <b>{user.full_name}</b>
            <NotificationBell data={notifs} onReadAll={onReadAll} />
          </div>
          {roleLabel(user.role)}
          <div><button type="button" className="logout" onClick={onLogout}>Log out</button></div>
          <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 8 }}>v{__APP_VERSION__}</div>
        </div>
      </aside>
      <div className="mobile-topbar">
        <span className="brand">Call<b>Track</b></span>
        <span className="who">
          <NotificationBell data={notifs} onReadAll={onReadAll} />
          <span className="who-name">{user.full_name.split(' ')[0]}</span>
          <button type="button" className="logout" onClick={onLogout}>Log out</button>
        </span>
      </div>
      <nav className="bottom-nav" aria-label="Main">
        {nav.primary.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.to === '/'}>
            <span className="icon" aria-hidden="true">{it.icon}</span> {it.label}
            {it.badge > 0 && <span className="pill-count" aria-label={`${it.badge} pending`}>{it.badge}</span>}
          </NavLink>
        ))}
        <button type="button" className={moreActive ? 'active' : ''} onClick={() => setMore(true)}
          aria-haspopup="dialog" aria-expanded={more}>
          <span className="icon" aria-hidden="true">☰</span> More
          {restBadge > 0 && <span className="pill-count" aria-label={`${restBadge} pending`}>{restBadge}</span>}
        </button>
      </nav>
      {more && <MoreSheet items={nav.rest} user={user} onClose={() => setMore(false)} onLogout={onLogout} />}
    </>
  );
}

export default function App() {
  const [user, setUserState] = useState(undefined); // undefined = checking
  const [authError, setAuthError] = useState(null);
  const [toast, setToast] = useState(null);
  const [dueCount, setDueCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  const [notifs, setNotifs] = useState({ notifications: [], unread: 0 });
  const [waEnabled, setWaEnabled] = useState(false);
  const [waUnread, setWaUnread] = useState(0);
  const [offline, setOffline] = useState(isOffline());
  const [dialog, setDialog] = useState(null); // { kind: 'confirm'|'prompt', opts, resolve }
  const location = useLocation();
  const toastTimer = useRef(null);
  const countsUnsupported = useRef(false);
  const badgeTimer = useRef(null);

  // Keep the task-timer namespace in step with the signed-in user BEFORE the
  // first render that uses it (children's effects run before ours).
  const setUser = useCallback((u) => {
    setTimerUser(u && u.id != null ? u.id : null);
    setUserState(u);
  }, []);

  const showToast = useCallback((msg, kind) => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 5000 : 3500);
  }, []);

  const askConfirm = useCallback((opts) => new Promise((resolve) => {
    setDialog({ kind: 'confirm', opts: typeof opts === 'string' ? { message: opts } : (opts || {}), resolve });
  }), []);
  const askPrompt = useCallback((opts) => new Promise((resolve) => {
    setDialog({ kind: 'prompt', opts: typeof opts === 'string' ? { title: opts } : (opts || {}), resolve });
  }), []);
  const closeDialog = (result) => {
    const d = dialog;
    setDialog(null);
    if (d) d.resolve(result);
  };

  const loadMe = useCallback(() => {
    setAuthError(null);
    api.get('/api/auth/me').then(setUser).catch((err) => {
      if (err && err.network) setAuthError(err);
      else setUser(null);
    });
  }, [setUser]);

  useEffect(() => { loadMe(); }, [loadMe]);
  useWindowEvent('crm:logout', () => setUser(null));
  useWindowEvent('crm:must-change-password', () => {
    setUserState((u) => (u && !u.must_change_password ? { ...u, must_change_password: 1 } : u));
  });
  useWindowEvent('crm:connectivity', (e) => setOffline(!!(e.detail && e.detail.offline)));
  useWindowEvent('online', () => { checkHealth(); });

  // Offline banner: probe /api/health every 10 s until it answers again.
  useEffect(() => {
    if (!offline) return undefined;
    const iv = setInterval(() => { checkHealth(); }, 10000);
    return () => clearInterval(iv);
  }, [offline]);

  // Is the WhatsApp inbox feature on? Read once when the user resolves; it gates
  // the nav entry + route (public settings subset carries whatsapp_enabled).
  useEffect(() => {
    if (!user || user.must_change_password) return;
    api.get('/api/settings').then((s) => setWaEnabled(!!s.whatsapp_enabled)).catch(() => {});
  }, [user]);

  // Badge counts: /api/today/counts (tiny) with a fallback to /api/today on an
  // older server; review summary; notifications; WhatsApp unread since the
  // user's own watermark. Polled every 60 s while visible (CLIENT-18) and
  // re-run 400 ms after any mutation ('crm:refresh-badges').
  const refreshBadges = useCallback(() => {
    if (!user || user.must_change_password) return;
    const fromToday = () => api.get('/api/today')
      .then((d) => setDueCount(d.followups.length + d.payments_due.length + ((d.tasks && d.tasks.length) || 0)));
    const counts = countsUnsupported.current
      ? fromToday()
      : api.get('/api/today/counts')
        .then((c) => setDueCount(Number.isFinite(c.total) ? c.total : (c.followups + c.payments_due + c.tasks)))
        .catch((err) => {
          if (err && err.status === 404) { countsUnsupported.current = true; return fromToday(); }
          throw err;
        });
    counts.catch(() => {});
    api.get('/api/review/summary').then((s) => setReviewCount(s.total)).catch(() => {});
    api.get('/api/notifications').then((n) => setNotifs(n)).catch(() => {});
    if (waEnabled && isAdmin(user.role)) {
      const since = waSince(user.id);
      api.get(`/api/whatsapp/unread${since ? `?since=${encodeURIComponent(since)}` : ''}`)
        .then((w) => setWaUnread(w.enabled ? (w.count || 0) : 0))
        .catch(() => {});
    }
  }, [user, waEnabled]);

  const badgesEnabled = !!user && !user.must_change_password;
  usePolling(refreshBadges, 60000, [refreshBadges], { enabled: badgesEnabled });
  useWindowEvent('crm:refresh-badges', () => {
    clearTimeout(badgeTimer.current);
    badgeTimer.current = setTimeout(refreshBadges, 400);
  }, { enabled: badgesEnabled });
  // The WhatsApp page marks the inbox as seen → watermark + clear the pill.
  useWindowEvent('crm:wa-seen', () => {
    if (!user) return;
    try { localStorage.setItem(WA_SEEN_KEY(user.id), new Date().toISOString()); } catch { /* ignore */ }
    setWaUnread(0);
  }, { enabled: !!user });

  const logout = useCallback(async () => {
    clearTimeout(badgeTimer.current);
    try { await stopTimer(); } catch { /* best effort */ }
    try { await api.post('/api/auth/logout'); } catch { /* session may already be gone */ }
    if (user) clearUserState(user.id);
    invalidateTemplateCache();
    setUser(null);
  }, [user, setUser]);

  const markAllRead = async () => {
    try {
      await api.post('/api/notifications/read-all');
      setNotifs((n) => ({ ...n, notifications: n.notifications.map((x) => ({ ...x, read: 1 })), unread: 0 }));
    } catch { /* best effort; next poll re-syncs */ }
  };

  const admin = !!user && isAdmin(user.role);
  const owner = !!user && isOwner(user.role);
  const readOnly = !!user && isReadOnly(user.role);
  const ctx = useMemo(() => ({
    user, showToast, askConfirm, askPrompt, admin, owner, readOnly, canWrite: !!user && !readOnly, refreshBadges,
  }), [user, showToast, askConfirm, askPrompt, admin, owner, readOnly, refreshBadges]);

  const nav = useMemo(() => (user ? buildNav(user, { waEnabled, dueCount, reviewCount, waUnread }) : null),
    [user, waEnabled, dueCount, reviewCount, waUnread]);

  const dialogs = (
    <>
      {dialog && dialog.kind === 'confirm' && (
        <ConfirmModal {...dialog.opts} onConfirm={() => closeDialog(true)} onClose={() => closeDialog(false)} />
      )}
      {dialog && dialog.kind === 'prompt' && (
        <PromptModal {...dialog.opts} onSubmit={(v) => closeDialog(v)} onClose={() => closeDialog(null)} />
      )}
    </>
  );

  if (user === undefined) return <Splash error={authError} onRetry={loadMe} />;
  if (!user) {
    return (
      <>
        <OfflineBanner offline={offline} onRetry={checkHealth} />
        <Login onLogin={setUser} />
      </>
    );
  }

  // Forced password change (audit H-1): a fresh/reset admin must rotate its
  // password before anything else — every other endpoint 403s until it does.
  if (user.must_change_password) {
    return (
      <>
        <OfflineBanner offline={offline} onRetry={checkHealth} />
        <ForcePasswordChange
          onDone={() => setUser({ ...user, must_change_password: 0 })}
          onLogout={logout}
        />
      </>
    );
  }

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <Nav user={user} nav={nav} notifs={notifs} onReadAll={markAllRead} onLogout={logout} />
        <main className="main" id="main">
          <OfflineBanner offline={offline} onRetry={checkHealth} />
          <ErrorBoundary key={location.pathname}>
            <Suspense fallback={<PageLoading />}>
              <Routes>
                <Route path="/" element={admin ? <Dashboard /> : <Today />} />
                <Route path="/today" element={<Today />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/leads" element={<Leads />} />
                <Route path="/leads/:id" element={<LeadDetail />} />
                <Route path="/work" element={<Tasks />} />
                <Route path="/work/:id" element={<TaskDetail />} />
                <Route path="/projects" element={<Projects />} />
                <Route path="/calendar" element={<Calendar />} />
                <Route path="/meetings" element={<Meetings />} />
                <Route path="/meetings/:id" element={<MeetingDetail />} />
                <Route path="/collections" element={<Collections />} />
                <Route path="/pricing" element={<PriceBuilder />} />
                <Route path="/invoices" element={<Invoices />} />
                <Route path="/invoices/:id" element={<InvoiceDetail />} />
                <Route path="/whatsapp" element={waEnabled && admin ? <WhatsApp />
                  : <NoAccess reason={admin ? 'The WhatsApp inbox is turned off — an owner can enable it in Settings.' : undefined} />} />
                <Route path="/coaching" element={<Coaching />} />
                <Route path="/review" element={<Review />} />
                <Route path="/import" element={admin ? <ImportPage /> : <NoAccess />} />
                <Route path="/reports" element={admin ? <Reports /> : <NoAccess />} />
                <Route path="/settings" element={owner ? <Settings /> : <NoAccess />} />
                <Route path="/audit" element={owner ? <AuditLog /> : <NoAccess />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
        <Toast toast={toast} />
        <CurrentWorkWidget />
        {dialogs}
      </div>
    </AppCtx.Provider>
  );
}
