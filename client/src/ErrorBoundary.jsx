import React from 'react';

// Catches render/runtime errors in its subtree so one broken screen never
// blanks the whole app. Mounted around <Routes> (keyed by pathname) in App.jsx,
// so the sidebar still works and navigating to another page clears the error.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface it so it can be diagnosed instead of disappearing into a blank page.
    console.error('[CallTrack] UI error:', error, info && info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ maxWidth: 620, margin: '40px auto' }}>
        <h2 style={{ marginTop: 0 }}>Something went wrong on this screen</h2>
        <p style={{ color: 'var(--ink-soft)' }}>
          Your data is safe — this is only a display problem. Try another page from the
          menu, or reload the app.
        </p>
        <pre style={{
          background: 'var(--bg-soft, #f6f6f8)', border: '1px solid var(--line, #e3e3ea)',
          borderRadius: 8, padding: 12, fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap',
          color: 'var(--red, #b91c1c)',
        }}>
          {String((this.state.error && this.state.error.message) || this.state.error)}
        </pre>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={() => window.location.assign('/')}>Go to home</button>
          <button className="btn secondary" onClick={() => window.location.reload()}>Reload app</button>
        </div>
      </div>
    );
  }
}
