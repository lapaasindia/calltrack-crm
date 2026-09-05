import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Field } from '../components.jsx';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryIn, setRetryIn] = useState(0); // seconds left on a 429 lock

  // Live countdown for "try again in N s" (server Retry-After / retry_after_seconds).
  useEffect(() => {
    if (retryIn <= 0) return undefined;
    const t = setInterval(() => setRetryIn((s) => (s > 1 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [retryIn > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    if (busy || retryIn > 0) return;
    setBusy(true);
    setError('');
    try {
      const user = await api.post('/api/auth/login', { username: username.trim(), password });
      onLogin(user);
    } catch (err) {
      if (err.status === 429 && err.retryAfter) {
        setRetryIn(err.retryAfter);
        setError(`Too many attempts — try again in ${err.retryAfter} s`);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const locked = retryIn > 0;
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">Call<span>Track</span></div>
        <div className="tag">Calling team CRM</div>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none" autoCorrect="off" autoComplete="username" autoFocus />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" />
        </Field>
        {(error || locked) && (
          <div className="field"><div className="err" role="alert">
            {locked ? `Too many attempts — try again in ${retryIn} s` : error}
          </div></div>
        )}
        <button className="btn block" disabled={busy || locked || !username || !password}>
          {busy ? 'Logging in…' : locked ? `Wait ${retryIn} s` : 'Log in'}
        </button>
        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--ink-soft)', marginTop: 14 }}>
          v{__APP_VERSION__}
        </div>
      </form>
    </div>
  );
}
