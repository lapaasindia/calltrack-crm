import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { api, fmtDateTime } from './api.js';
import { isAdmin, isOwner } from './permissions.js';
import Login from './pages/Login.jsx';
import ForcePasswordChange from './pages/ForcePasswordChange.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Today from './pages/Today.jsx';
import Leads from './pages/Leads.jsx';
import LeadDetail from './pages/LeadDetail.jsx';
import ImportPage from './pages/ImportPage.jsx';
import Collections from './pages/Collections.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';
import Review from './pages/Review.jsx';
import Coaching from './pages/Coaching.jsx';
import PriceBuilder from './pages/PriceBuilder.jsx';
import Invoices from './pages/Invoices.jsx';
import InvoiceDetail from './pages/InvoiceDetail.jsx';
import WhatsApp from './pages/WhatsApp.jsx';
import Tasks from './pages/Tasks.jsx';
import TaskDetail from './pages/TaskDetail.jsx';
import Projects from './pages/Projects.jsx';
import Calendar from './pages/Calendar.jsx';
import Meetings from './pages/Meetings.jsx';
import MeetingDetail from './pages/MeetingDetail.jsx';
import CurrentWorkWidget from './CurrentWorkWidget.jsx';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

function Toast({ toast }) {
  if (!toast) return null;
  return <div className={`toast ${toast.kind || ''}`}>{toast.msg}</div>;
}

const NOTIF_ICON = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '⛔' };

function NotificationBell({ data, onReadAll }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const unread = data?.unread || 0;
  const list = data?.notifications || [];

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="notif-bell" ref={ref}>
      <button className="notif-trigger" onClick={() => setOpen((o) => !o)} title="Notifications">
        🔔{unread > 0 && <span className="notif-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-dropdown">
          <div className="notif-head">
            <b>Notifications</b>
            {unread > 0 && (
              <button className="notif-readall" onClick={() => { onReadAll(); }}>Mark all read</button>
            )}
          </div>
          <div className="notif-list">
            {list.length === 0 && <div className="notif-empty">You're all caught up.</div>}
            {list.map((n) => (
              <div key={n.id} className={`notif-item ${n.read ? '' : 'unread'}`}>
                <span className="notif-ic">{NOTIF_ICON[n.type] || NOTIF_ICON.info}</span>
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

function Nav({ user, dueCount, reviewCount, waUnread, waEnabled, notifs, onReadAll, onLogout }) {
  const admin = isAdmin(user.role);
  const owner = isOwner(user.role);
  const items = [
    // Admin/manager land on the Dashboard (path '/'); callers land on Today
    // (also at '/') and can open the Dashboard from its own nav entry.
    ...(admin
      ? [{ to: '/', label: 'Dashboard', icon: '📊' }, { to: '/today', label: 'Today', icon: '☀️', badge: dueCount }]
      : [{ to: '/', label: 'Today', icon: '☀️', badge: dueCount }, { to: '/dashboard', label: 'Dashboard', icon: '📊' }]),
    { to: '/leads', label: 'Leads', icon: '👥' },
    { to: '/work', label: 'Work', icon: '🗂️' },
    { to: '/projects', label: 'Projects', icon: '📁' },
    { to: '/calendar', label: 'Calendar', icon: '📅' },
    { to: '/meetings', label: 'Meetings', icon: '🤝' },
    { to: '/collections', label: 'Payments', icon: '₹' },
    { to: '/pricing', label: 'Price builder', icon: '🧮' },
    { to: '/invoices', label: 'Invoices', icon: '🧾' },
    // WhatsApp inbox is hidden until the owner enables it (admin tier only).
    ...(waEnabled && admin ? [{ to: '/whatsapp', label: 'WhatsApp', icon: '💬', badge: waUnread }] : []),
    { to: '/coaching', label: 'Coaching', icon: '🎯' },
    { to: '/review', label: 'Review', icon: '🔍', badge: reviewCount },
    // Reports + Import are admin-tier (incl. managers) — matches their server
    // gate (requireAdmin on /api/reports + /api/import). Settings is owner-only.
    ...(admin ? [
      { to: '/import', label: 'Import', icon: '⬆️' },
      { to: '/reports', label: 'Reports', icon: '📊' },
    ] : []),
    ...(owner ? [
      { to: '/settings', label: 'Settings', icon: '⚙️' },
    ] : []),
  ];
  return (
    <>
      <aside className="sidebar">
        <div className="logo">Call<span>Track</span></div>
        <nav>
          {items.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.to === '/'}>
              <span>{it.icon}</span> {it.label}
              {it.badge > 0 && <span className="pill-count">{it.badge}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <div className="user-box">
          <div className="user-box-head">
            <b>{user.full_name}</b>
            <NotificationBell data={notifs} onReadAll={onReadAll} />
          </div>
          {user.role === 'admin' ? 'Admin' : 'Caller'}
          <div><button onClick={onLogout}>Log out</button></div>
        </div>
      </aside>
      <div className="mobile-topbar">
        <span className="brand">Call<b>Track</b></span>
        <span className="who">
          <NotificationBell data={notifs} onReadAll={onReadAll} />
          {user.full_name.split(' ')[0]} <button onClick={onLogout}>Log out</button>
        </span>
      </div>
      <div className="bottom-nav">
        {items.slice(0, 5).map((it) => (
          <NavLink key={it.to} to={it.to} end={it.to === '/'}>
            <span className="icon">{it.icon}</span> {it.label}
          </NavLink>
        ))}
      </div>
    </>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking
  const [toast, setToast] = useState(null);
  const [dueCount, setDueCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);
  const [notifs, setNotifs] = useState({ notifications: [], unread: 0 });
  const [waEnabled, setWaEnabled] = useState(false);
  const [waUnread, setWaUnread] = useState(0);
  const location = useLocation();

  const showToast = useCallback((msg, kind) => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    api.get('/api/auth/me').then(setUser).catch(() => setUser(null));
    const onLogout = () => setUser(null);
    window.addEventListener('crm:logout', onLogout);
    return () => window.removeEventListener('crm:logout', onLogout);
  }, []);

  // Is the WhatsApp inbox feature on? Read once when the user resolves; it gates
  // the nav entry + route. Cheap, and re-read on each user change.
  useEffect(() => {
    if (!user) return;
    api.get('/api/settings').then((s) => setWaEnabled(!!s.whatsapp_enabled)).catch(() => {});
  }, [user]);

  // Due-count badge: poll every 60s + refresh when the tab comes back
  // (iOS Safari suspends background tabs; no service workers over LAN http).
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const refresh = () => {
      api.get('/api/today')
        .then((d) => alive && setDueCount(d.followups.length + d.payments_due.length + (d.tasks?.length || 0)))
        .catch(() => {});
      api.get('/api/review/summary')
        .then((s) => alive && setReviewCount(s.total))
        .catch(() => {});
      api.get('/api/notifications')
        .then((n) => alive && setNotifs(n))
        .catch(() => {});
      if (waEnabled) {
        api.get('/api/whatsapp/unread')
          .then((w) => alive && setWaUnread(w.enabled ? (w.count || 0) : 0))
          .catch(() => {});
      }
    };
    refresh();
    const iv = setInterval(refresh, 60000);
    const onVis = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [user, location.pathname, waEnabled]);

  if (user === undefined) return null;
  if (!user) return <Login onLogin={setUser} />;

  const logout = async () => { await api.post('/api/auth/logout'); setUser(null); };

  // Forced password change (audit H-1): a fresh/reset admin must rotate its
  // password before anything else — every other endpoint 403s until it does.
  if (user.must_change_password) {
    return (
      <ForcePasswordChange
        onDone={() => setUser({ ...user, must_change_password: 0 })}
        onLogout={logout}
      />
    );
  }

  const markAllRead = async () => {
    try {
      await api.post('/api/notifications/read-all');
      setNotifs((n) => ({ ...n, notifications: n.notifications.map((x) => ({ ...x, read: 1 })), unread: 0 }));
    } catch { /* best effort; next poll re-syncs */ }
  };

  const admin = isAdmin(user.role);
  const owner = isOwner(user.role);

  return (
    <AppCtx.Provider value={{ user, showToast }}>
      <div className="app">
        <Nav user={user} dueCount={dueCount} reviewCount={reviewCount}
          waUnread={waUnread} waEnabled={waEnabled}
          notifs={notifs} onReadAll={markAllRead} onLogout={logout} />
        <main className="main">
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
            {waEnabled && admin && <Route path="/whatsapp" element={<WhatsApp />} />}
            <Route path="/coaching" element={<Coaching />} />
            <Route path="/review" element={<Review />} />
            {admin && (
              <>
                <Route path="/import" element={<ImportPage />} />
                <Route path="/reports" element={<Reports />} />
              </>
            )}
            {owner && <Route path="/settings" element={<Settings />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <Toast toast={toast} />
        <CurrentWorkWidget />
      </div>
    </AppCtx.Provider>
  );
}
