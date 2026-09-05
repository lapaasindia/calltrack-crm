// Phase 4B — the floating "current work" widget, mounted globally in App.jsx.
//
// Polls GET /api/current-work every 60 s (only while the tab is visible) for
// the user's active item (the scheduled task / time block whose window
// contains now, ending soonest). A 1 s tick advances the elapsed-time display
// ONLY while a timer is actually running. Inline Start/Stop drives the SINGLE
// GLOBAL timer (taskTimer.js); Open jumps to the task; the widget can be
// collapsed to a pill or dismissed for the day (per user).
import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, istDateOf } from './api.js';
import { useApp } from './ctx.js';
import { usePolling, useTicker, useWindowEvent } from './hooks.js';
import {
  getActiveTimer, startTimer, stopTimer, elapsedSeconds, fmtDuration, dismissKey,
} from './taskTimer.js';

function dismissedToday(userId) {
  try {
    const v = localStorage.getItem(dismissKey(userId));
    return !!v && v === istDateOf(new Date());
  } catch { return false; }
}

// Minutes remaining until end_at (negative clamped to 0).
function minsLeft(endIso) {
  return Math.max(0, Math.round((Date.parse(endIso) - Date.now()) / 60000));
}

export default function CurrentWorkWidget() {
  const navigate = useNavigate();
  const { user, readOnly } = useApp();
  const [current, setCurrent] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState(() => dismissedToday(user.id));
  const [active, setActive] = useState(() => getActiveTimer());

  const refresh = useCallback(() => {
    api.get('/api/current-work').then((d) => setCurrent(d.current)).catch(() => {});
  }, []);

  usePolling(refresh, 60000, [refresh], { enabled: !hidden });
  useWindowEvent('crm:timer', () => setActive(getActiveTimer()));

  const isTask = current && current.kind === 'task';
  const isMeeting = current && current.kind === 'meeting';
  const taskId = current ? (isTask ? current.id : current.linked_task_id) : null;
  const isRunning = !!(active && taskId != null && active.taskId === taskId);
  useTicker(isRunning && !hidden && !!current, 1000);

  if (hidden || !current) return null;

  const liveExtra = isRunning ? elapsedSeconds(active) : 0;

  const dismiss = () => {
    try { localStorage.setItem(dismissKey(user.id), istDateOf(new Date())); } catch { /* ignore */ }
    setHidden(true);
  };

  const toggleTimer = async () => {
    if (taskId == null) return;
    if (isRunning) await stopTimer();
    else await startTimer(taskId, current.title);
    refresh();
  };

  const open = () => {
    if (isMeeting) navigate(`/meetings/${current.id}`);
    else if (taskId != null) navigate(`/work/${taskId}`);
    else navigate('/calendar');
  };

  if (collapsed) {
    return (
      <button type="button" onClick={() => setCollapsed(false)} title="Current work" aria-label="Show current work"
        style={{
          position: 'fixed', right: 16, bottom: 'calc(var(--nav-h) + var(--safe-bottom) + 12px)', zIndex: 90,
          background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 999,
          padding: '10px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0,0,0,.18)',
        }}>
        ⏱ {isRunning ? fmtDuration(liveExtra, true) : 'Now'}
      </button>
    );
  }

  return (
    <div role="region" aria-label="Current work" style={{
      position: 'fixed', right: 16, bottom: 'calc(var(--nav-h) + var(--safe-bottom) + 12px)', zIndex: 90, width: 280, maxWidth: 'calc(100vw - 32px)',
      background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12,
      boxShadow: '0 8px 28px rgba(0,0,0,.16)', padding: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--ink-soft)' }}>
          {isTask ? '📋 Working now' : isMeeting ? '🤝 In meeting' : '🟧 Now'}
        </span>
        <span style={{ display: 'flex', gap: 2 }}>
          <button type="button" className="btn small secondary" title="Collapse" aria-label="Collapse" onClick={() => setCollapsed(true)}>—</button>
          <button type="button" className="btn small secondary" title="Dismiss for today" aria-label="Dismiss for today" onClick={dismiss}>✕</button>
        </span>
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2, overflowWrap: 'anywhere' }}>{current.title}</div>
      <div className="tl-meta" style={{ marginBottom: 8 }}>
        {isTask
          ? <>{current.project_name ? `${current.project_name} · ` : ''}{minsLeft(current.end_at)}m left</>
          : isMeeting
            ? <>{current.location ? `${current.location} · ` : ''}{minsLeft(current.end_at)}m left</>
            : <>{current.block_type} · {minsLeft(current.end_at)}m left</>}
      </div>

      {isRunning && (
        <div style={{ fontSize: 13, color: 'var(--green-text)', fontWeight: 700, marginBottom: 8 }}>
          ● {fmtDuration(liveExtra, true)}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        {taskId != null && !readOnly && (
          <button type="button" className={`btn small ${isRunning ? 'secondary danger-text' : ''}`}
            onClick={toggleTimer}>
            {isRunning ? '■ Stop' : '▶ Start'}
          </button>
        )}
        <button type="button" className="btn small secondary" onClick={open}>Open</button>
      </div>
    </div>
  );
}
