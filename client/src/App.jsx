import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Today from './pages/Today.jsx';
import Leads from './pages/Leads.jsx';
import LeadDetail from './pages/LeadDetail.jsx';
import ImportPage from './pages/ImportPage.jsx';
import Collections from './pages/Collections.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

function Toast({ toast }) {
  if (!toast) return null;
  return <div className={`toast ${toast.kind || ''}`}>{toast.msg}</div>;
}

function Nav({ user, dueCount, onLogout }) {
  const isAdmin = user.role === 'admin';
  const items = [
    { to: '/', label: 'Today', icon: '☀️', badge: dueCount },
    { to: '/leads', label: 'Leads', icon: '👥' },
    { to: '/collections', label: 'Payments', icon: '₹' },
    ...(isAdmin ? [
      { to: '/import', label: 'Import', icon: '⬆️' },
      { to: '/reports', label: 'Reports', icon: '📊' },
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
          <b>{user.full_name}</b>
          {user.role === 'admin' ? 'Admin' : 'Caller'}
          <div><button onClick={onLogout}>Log out</button></div>
        </div>
      </aside>
      <div className="mobile-topbar">
        <span className="brand">Call<b>Track</b></span>
        <span className="who">{user.full_name.split(' ')[0]} <button onClick={onLogout}>Log out</button></span>
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

  // Due-count badge: poll every 60s + refresh when the tab comes back
  // (iOS Safari suspends background tabs; no service workers over LAN http).
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const refresh = () =>
      api.get('/api/today')
        .then((d) => alive && setDueCount(d.followups.length + d.payments_due.length))
        .catch(() => {});
    refresh();
    const iv = setInterval(refresh, 60000);
    const onVis = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [user, location.pathname]);

  if (user === undefined) return null;
  if (!user) return <Login onLogin={setUser} />;

  const logout = async () => { await api.post('/api/auth/logout'); setUser(null); };

  return (
    <AppCtx.Provider value={{ user, showToast }}>
      <div className="app">
        <Nav user={user} dueCount={dueCount} onLogout={logout} />
        <main className="main">
          <Routes>
            <Route path="/" element={<Today />} />
            <Route path="/leads" element={<Leads />} />
            <Route path="/leads/:id" element={<LeadDetail />} />
            <Route path="/collections" element={<Collections />} />
            {user.role === 'admin' && (
              <>
                <Route path="/import" element={<ImportPage />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/settings" element={<Settings />} />
              </>
            )}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <Toast toast={toast} />
      </div>
    </AppCtx.Provider>
  );
}
