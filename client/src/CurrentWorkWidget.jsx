// Phase 4B — the floating "current work" widget, mounted globally in App.jsx.
//
// Polls GET /api/current-work every 15s for the user's active item (the
// scheduled task / time block whose window contains now, ending soonest). A
// separate 1s tick advances the elapsed-time display ONLY (no extra fetch).
// Inline Start/Stop drives the SINGLE GLOBAL timer (taskTimer.js); Open jumps
// to the task; the widget can be collapsed to a pill or dismissed for the day.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api.js';
import {
  getActiveTimer, startTimer, stopTimer, elapsedSeconds, fmtDuration,
} from './taskTimer.js';

const DISMISS_KEY = 'crm_cw_dismissed_at'; // dismissed for the rest of the day

function dismissedToday() {
  try {
    const v = localStorage.getItem(DISMISS_KEY);
    if (!v) return false;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    return v === today;
  } catch { return false; }
}

// Minutes remaining until end_at (negative clamped to 0).
function minsLeft(endIso) {
  return Math.max(0, Math.round((Date.parse(endIso) - Date.now()) / 60000));
}

export default function CurrentWorkWidget() {
  const navigate = useNavigate();
  const [current, setCurrent] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState(dismissedToday());
  const [active, setActive] = useState(getActiveTimer());
  const [, setTick] = useState(0);
  const aliveRef = useRef(true);

  const refresh = useCallback(() => {
    api.get('/api/current-work')
      .then((d) => { if (aliveRef.current) setCurrent(d.current); })
      .catch(() => {});
  }, []);

  // ONE 15s poll for data + ONE 1s tick for the clock. Refresh on tab focus.
  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const poll = setInterval(refresh, 15000);
    const clock = setInterval(() => setTick((n) => n + 1), 1000);
    const onVis = () => document.visibilityState === 'visible' && refresh();
    const onTimer = () => setActive(getActiveTimer());
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('crm:timer', onTimer);
    return () => {
      aliveRef.current = false;
      clearInterval(poll); clearInterval(clock);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('crm:timer', onTimer);
    };
  }, [refresh]);

  if (hidden || !current) return null;

  const isTask = current.kind === 'task';
  const isMeeting = current.kind === 'meeting';
  const taskId = isTask ? current.id : current.linked_task_id;
  const isRunning = active && taskId != null && active.taskId === taskId;
  const liveExtra = isRunning ? elapsedSeconds(active) : 0;

  const dismiss = () => {
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      localStorage.setItem(DISMISS_KEY, today);
    } catch { /* ignore */ }
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
      <button onClick={() => setCollapsed(false)} title="Current work"
        style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: 200,
          background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 999,
          padding: '10px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0,0,0,.18)',
        }}>
        ⏱ {isRunning ? fmtDuration(liveExtra, true) : 'Now'}
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 200, width: 280,
      background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12,
      boxShadow: '0 8px 28px rgba(0,0,0,.16)', padding: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--ink-soft)' }}>
          {isTask ? '📋 Working now' : isMeeting ? '🤝 In meeting' : '🟧 Now'}
        </span>
        <span style={{ display: 'flex', gap: 2 }}>
          <button className="btn small secondary" title="Collapse" onClick={() => setCollapsed(true)}>—</button>
          <button className="btn small secondary" title="Dismiss for today" onClick={dismiss}>✕</button>
        </span>
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{current.title}</div>
      <div className="tl-meta" style={{ marginBottom: 8 }}>
        {isTask
          ? <>{current.project_name ? `${current.project_name} · ` : ''}{minsLeft(current.end_at)}m left</>
          : isMeeting
            ? <>{current.location ? `${current.location} · ` : ''}{minsLeft(current.end_at)}m left</>
            : <>{current.block_type} · {minsLeft(current.end_at)}m left</>}
      </div>

      {isRunning && (
        <div style={{ fontSize: 13, color: 'var(--green)', fontWeight: 700, marginBottom: 8 }}>
          ● {fmtDuration(liveExtra, true)}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        {taskId != null && (
          <button className={`btn small ${isRunning ? 'secondary' : ''}`}
            style={isRunning ? { color: 'var(--red)' } : undefined}
            onClick={toggleTimer}>
            {isRunning ? '■ Stop' : '▶ Start'}
          </button>
        )}
        <button className="btn small secondary" onClick={open}>Open</button>
      </div>
    </div>
  );
}
