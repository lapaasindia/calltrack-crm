import React, { useState } from 'react';
import { api } from '../api.js';

// Shown when the logged-in account is flagged must_change_password (a fresh
// bootstrap admin or an admin-reset account). The server blocks every other
// endpoint until the password is rotated (audit H-1), so this is the only
// screen such an account can use.
export default function ForcePasswordChange({ onDone, onLogout }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (next !== confirm) { setError('New passwords do not match'); return; }
    setBusy(true);
    try {
      await api.post('/api/auth/change-password', { current_password: current, new_password: next });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">Call<span>Track</span></div>
        <div className="tag">Set a new password to continue</div>
        <div className="field">
          <label>Current password</label>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password" autoFocus />
        </div>
        <div className="field">
          <label>New password</label>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password" placeholder="at least 8 characters" />
        </div>
        <div className="field">
          <label>Confirm new password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password" />
        </div>
        {error && <div className="field"><div className="err">{error}</div></div>}
        <button className="btn block" disabled={busy || !current || next.length < 8 || !confirm}>
          {busy ? 'Saving…' : 'Set new password'}
        </button>
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button type="button" className="linklike" onClick={onLogout}>Log out</button>
        </div>
      </form>
    </div>
  );
}
