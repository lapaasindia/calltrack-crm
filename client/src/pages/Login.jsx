import React, { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await api.post('/api/auth/login', { username, password });
      onLogin(user);
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
        <div className="tag">Calling team CRM</div>
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none" autoCorrect="off" autoComplete="username" autoFocus />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" />
        </div>
        {error && <div className="field"><div className="err">{error}</div></div>}
        <button className="btn block" disabled={busy || !username || !password}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--ink-soft)', marginTop: 14 }}>
          v{__APP_VERSION__}
        </div>
      </form>
    </div>
  );
}
