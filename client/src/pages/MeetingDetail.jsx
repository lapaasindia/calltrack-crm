// Phase 5A — Meeting OS detail/run screen. Start/End state machine, an agenda
// list with per-item duration + a live countdown MeetingTimer (pause/resume/
// stop/extend), running-total agenda duration, RoleAssignment, DecisionLogger
// (with "create task from decision"), and Action items ("convert to task").
// Inline SVG/CSS only — no chart/calendar libraries. Instants are UTC.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtDateTime, dtLocalToUtcIso } from '../api.js';
import { useApp } from '../App.jsx';

const fmtMMSS = (totalSec) => {
  const s = Math.max(0, Math.round(totalSec));
  const sign = totalSec < 0 ? '-' : '';
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${sign}${m}:${ss}`;
};
const fmtMin = (sec) => `${Math.round((sec || 0) / 60)}m`;

export default function MeetingDetail() {
  const { id } = useParams();
  const { user, showToast } = useApp();
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    api.get(`/api/meetings/${id}`)
      .then((m) => { setMeeting(m); setErr(null); })
      .catch((e) => setErr(e.message));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (err) return <div className="card" style={{ color: 'var(--red, #dc2626)' }}>{err}</div>;
  if (!meeting) return <div className="card">Loading…</div>;

  const setStatus = async (action) => {
    try {
      await api.post(`/api/meetings/${meeting.id}/${action}`);
      showToast(action === 'start' ? 'Meeting started' : 'Meeting ended ✓');
      load();
    } catch (e) { showToast(e.message, 'error'); }
  };

  const totalPlanned = (meeting.agenda || []).reduce((s, a) => s + (a.duration || 0), 0);
  const totalSpent = (meeting.agenda || []).reduce((s, a) => s + (a.time_spent || 0), 0);

  return (
    <>
      <div className="page-title">
        <h1 style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {meeting.title}
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink-soft)' }}>{meeting.status}</span>
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {meeting.status === 'Scheduled' && (
            <button className="btn green" onClick={() => setStatus('start')}>▶ Start</button>
          )}
          {meeting.status === 'In Progress' && (
            <button className="btn" onClick={() => setStatus('end')}>⏹ End</button>
          )}
          <button className="btn secondary" onClick={() => navigate('/meetings')}>Back</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 6 }}>
          {fmtDateTime(meeting.start_at)} – {fmtDateTime(meeting.end_at)}
          {meeting.owner_name ? ` · Owner: ${meeting.owner_name}` : ''}
        </div>
        {meeting.description && <div style={{ marginBottom: 6 }}>{meeting.description}</div>}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--ink-soft)' }}>
          {meeting.location && <span>📍 {meeting.location}</span>}
          {meeting.meeting_url && <a href={meeting.meeting_url} target="_blank" rel="noreferrer">🔗 Join link</a>}
          {meeting.lead_name && <span>👤 {meeting.lead_name}</span>}
          {meeting.project_name && <span>📁 {meeting.project_name}</span>}
          {meeting.attendees?.length > 0 && <span>👥 {meeting.attendees.map((a) => a.full_name).join(', ')}</span>}
        </div>
      </div>

      <RoleAssignment meeting={meeting} onChange={load} />

      <Agenda meeting={meeting} totalPlanned={totalPlanned} totalSpent={totalSpent} onChange={load} />

      <DecisionLogger meeting={meeting} onChange={load} showToast={showToast} />

      <ActionItems meeting={meeting} onChange={load} showToast={showToast} />
    </>
  );
}

// ---------------- Roles ----------------
function RoleAssignment({ meeting, onChange }) {
  const { showToast } = useApp();
  const [users, setUsers] = useState([]);
  useEffect(() => { api.get('/api/users').then(setUsers).catch(() => {}); }, []);
  const roles = meeting.roles || {};
  const candidates = users.length ? users : meeting.attendees || [];

  const setRole = async (key, value) => {
    try {
      await api.put(`/api/meetings/${meeting.id}/roles`, { [key]: value ? Number(value) : null });
      onChange();
    } catch (e) { showToast(e.message, 'error'); }
  };

  const Picker = ({ label, roleKey }) => (
    <div className="field" style={{ margin: 0 }}>
      <label>{label}</label>
      <select value={roles[roleKey] || ''} onChange={(e) => setRole(roleKey, e.target.value)}>
        <option value="">— none —</option>
        {candidates.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
      </select>
    </div>
  );

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3 style={{ marginTop: 0 }}>Roles</h3>
      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Picker label="Facilitator" roleKey="facilitator_id" />
        <Picker label="Scribe" roleKey="scribe_id" />
        <Picker label="Decision maker" roleKey="decision_maker_id" />
      </div>
    </div>
  );
}

// ---------------- Agenda + Timer ----------------
function Agenda({ meeting, totalPlanned, totalSpent, onChange }) {
  const { showToast } = useApp();
  const [newTitle, setNewTitle] = useState('');
  const [newDuration, setNewDuration] = useState(15);
  const agenda = meeting.agenda || [];

  const add = async () => {
    if (!newTitle.trim()) return;
    try {
      await api.post(`/api/meetings/${meeting.id}/agenda`, {
        title: newTitle.trim(), duration: Number(newDuration) || 15,
      });
      setNewTitle(''); setNewDuration(15); onChange();
    } catch (e) { showToast(e.message, 'error'); }
  };
  const del = async (itemId) => {
    try { await api.del(`/api/meetings/${meeting.id}/agenda/${itemId}`); onChange(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  const move = async (idx, dir) => {
    const order = agenda.map((a) => a.id);
    const j = idx + dir;
    if (j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    try { await api.post(`/api/meetings/${meeting.id}/agenda/reorder`, { order }); onChange(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ marginTop: 0 }}>Agenda</h3>
        <div style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
          Planned <b>{totalPlanned}m</b> · Spent <b>{fmtMin(totalSpent)}</b>
        </div>
      </div>

      {agenda.length === 0 && (
        <div style={{ color: 'var(--ink-faint)', fontSize: 13, marginBottom: 10 }}>No agenda items yet.</div>
      )}
      <div className="row-list">
        {agenda.map((item, idx) => (
          <AgendaRow key={item.id} meeting={meeting} item={item}
            onChange={onChange}
            onDelete={() => del(item.id)}
            onUp={() => move(idx, -1)} onDown={() => move(idx, 1)}
            isFirst={idx === 0} isLast={idx === agenda.length - 1} />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="New agenda item" style={{ flex: 1, minWidth: 160, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)' }} />
        <input type="number" min="1" value={newDuration} onChange={(e) => setNewDuration(e.target.value)}
          title="Duration (minutes)" style={{ width: 70, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)' }} />
        <button className="btn" onClick={add}>+ Add</button>
      </div>
    </div>
  );
}

function AgendaRow({ meeting, item, onChange, onDelete, onUp, onDown, isFirst, isLast }) {
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0',
      borderBottom: '1px solid var(--line)',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{item.title}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
          Planned {item.duration}m · Spent {fmtMin(item.time_spent)} · {item.status}
        </div>
        <MeetingTimer meeting={meeting} item={item} onChange={onChange} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button className="btn small secondary" disabled={isFirst} onClick={onUp} title="Move up">↑</button>
        <button className="btn small secondary" disabled={isLast} onClick={onDown} title="Move down">↓</button>
        <button className="btn small secondary" onClick={onDelete} title="Remove">✕</button>
      </div>
    </div>
  );
}

// A per-agenda-item countdown timer. totalSeconds = (duration + extended)*60.
// Tracks elapsed locally (pause-aware); on stop POSTs elapsed to the server,
// which adds it to the item's time_spent and records a timer session.
function MeetingTimer({ meeting, item, onChange }) {
  const { showToast } = useApp();
  const [extendedMin, setExtendedMin] = useState(0);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds accumulated while running
  const [sessionId, setSessionId] = useState(null);
  const tickRef = useRef(null);
  const startRef = useRef(null); // wall-clock ms when the current run segment began

  const totalSeconds = (item.duration + extendedMin) * 60;
  const remaining = totalSeconds - elapsed;
  const pct = totalSeconds > 0 ? Math.min(100, (elapsed / totalSeconds) * 100) : 0;
  const barColor = pct >= 100 ? 'var(--red, #dc2626)' : pct >= 80 ? 'var(--amber)' : 'var(--green)';

  useEffect(() => () => { if (tickRef.current) clearInterval(tickRef.current); }, []);

  const tick = () => {
    setElapsed((prev) => {
      const segment = startRef.current ? Math.floor((Date.now() - startRef.current) / 1000) : 0;
      return baseRef.current + segment;
    });
  };
  // baseRef holds elapsed at the moment of the last (re)start, so resuming
  // continues from where it paused.
  const baseRef = useRef(0);

  const start = async () => {
    try {
      const r = await api.post(`/api/meetings/${meeting.id}/timer/start`, { agenda_item_id: item.id });
      setSessionId(r.id);
      baseRef.current = elapsed;
      startRef.current = Date.now();
      setRunning(true);
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = setInterval(tick, 1000);
    } catch (e) { showToast(e.message, 'error'); }
  };

  const pause = async () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    const segment = startRef.current ? Math.floor((Date.now() - startRef.current) / 1000) : 0;
    baseRef.current += segment;
    startRef.current = null;
    setElapsed(baseRef.current);
    setRunning(false);
    if (sessionId) {
      try { await api.post(`/api/meetings/${meeting.id}/timer/${sessionId}/pause`); } catch { /* best effort */ }
    }
  };

  const stop = async () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    const segment = (running && startRef.current) ? Math.floor((Date.now() - startRef.current) / 1000) : 0;
    const finalElapsed = baseRef.current + segment;
    setRunning(false);
    startRef.current = null;
    try {
      if (sessionId) {
        await api.post(`/api/meetings/${meeting.id}/timer/${sessionId}/stop`, { elapsed_seconds: finalElapsed });
      }
      // Mark the item Done.
      await api.patch(`/api/meetings/${meeting.id}/agenda/${item.id}`, { status: 'Done' });
      setSessionId(null);
      baseRef.current = 0;
      setElapsed(0);
      setExtendedMin(0);
      showToast('Time logged ✓');
      onChange();
    } catch (e) { showToast(e.message, 'error'); }
  };

  const extend = (min) => setExtendedMin((m) => m + min);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{
          fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 15,
          color: remaining < 0 ? 'var(--red, #dc2626)' : 'var(--ink)',
        }}>{fmtMMSS(remaining)}</span>
        {pct >= 80 && pct < 100 && <span style={{ fontSize: 11, color: 'var(--amber)' }}>⚠ wrapping up</span>}
        {pct >= 100 && <span style={{ fontSize: 11, color: 'var(--red, #dc2626)' }}>⏱ over time</span>}
        {extendedMin > 0 && <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>(+{extendedMin}m extended)</span>}
      </div>
      <div style={{ height: 7, background: 'var(--line)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, transition: 'width 0.4s, background 0.4s' }} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        {!running
          ? <button className="btn small green" onClick={start}>{elapsed > 0 ? 'Resume' : 'Start'}</button>
          : <button className="btn small secondary" onClick={pause}>Pause</button>}
        <button className="btn small" onClick={stop} disabled={!sessionId && elapsed === 0}>Stop</button>
        <span style={{ width: 8 }} />
        <button className="btn small secondary" onClick={() => extend(15)}>+15</button>
        <button className="btn small secondary" onClick={() => extend(30)}>+30</button>
        <button className="btn small secondary" onClick={() => extend(60)}>+60</button>
      </div>
    </div>
  );
}

// ---------------- Decisions ----------------
function DecisionLogger({ meeting, onChange, showToast }) {
  const users = meeting.attendees || [];
  const [form, setForm] = useState({ title: '', rationale: '', owner_id: '', review: '', status: 'Pending' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = async () => {
    if (!form.title.trim()) return showToast('Decision title required', 'error');
    try {
      await api.post(`/api/meetings/${meeting.id}/decisions`, {
        title: form.title.trim(),
        rationale: form.rationale || undefined,
        owner_id: form.owner_id ? Number(form.owner_id) : undefined,
        review_at: form.review ? dtLocalToUtcIso(form.review) : undefined,
        status: form.status,
      });
      setForm({ title: '', rationale: '', owner_id: '', review: '', status: 'Pending' });
      onChange();
    } catch (e) { showToast(e.message, 'error'); }
  };
  const toTask = async (decId) => {
    try { await api.post(`/api/meetings/${meeting.id}/decisions/${decId}/to-task`); showToast('Task created ✓'); onChange(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  const setDecStatus = async (decId, status) => {
    try { await api.patch(`/api/meetings/${meeting.id}/decisions/${decId}`, { status }); onChange(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3 style={{ marginTop: 0 }}>Decisions</h3>
      <div className="row-list">
        {(meeting.decisions || []).map((d) => (
          <div key={d.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>{d.title}</div>
              <select value={d.status} onChange={(e) => setDecStatus(d.id, e.target.value)}
                style={{ fontSize: 12, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--line)' }}>
                {['Pending', 'Accepted', 'Revisit'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {d.rationale && <div style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{d.rationale}</div>}
            <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 2 }}>
              {d.review_at ? `Review ${fmtDateTime(d.review_at)} · ` : ''}
              <button className="linklike" onClick={() => toTask(d.id)}
                style={{ background: 'none', border: 'none', color: 'var(--brand)', cursor: 'pointer', fontWeight: 700, fontSize: 11.5, padding: 0 }}>
                Create task from decision →
              </button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="form-grid">
          <input value={form.title} onChange={set('title')} placeholder="Decision title"
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)' }} />
          <select value={form.owner_id} onChange={set('owner_id')}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>
            <option value="">Owner (optional)</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
        <textarea rows={2} value={form.rationale} onChange={set('rationale')} placeholder="Rationale (optional)"
          style={{ width: '100%', marginTop: 8, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Review:
            <input type="datetime-local" value={form.review} onChange={set('review')}
              style={{ marginLeft: 6, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--line)' }} />
          </label>
          <button className="btn small" onClick={add}>+ Log decision</button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Action items ----------------
function ActionItems({ meeting, onChange, showToast }) {
  const users = meeting.attendees || [];
  const [form, setForm] = useState({ title: '', owner_id: '', due: '', status: 'Pending' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = async () => {
    if (!form.title.trim()) return showToast('Action title required', 'error');
    try {
      await api.post(`/api/meetings/${meeting.id}/actions`, {
        title: form.title.trim(),
        owner_id: form.owner_id ? Number(form.owner_id) : undefined,
        due_at: form.due ? dtLocalToUtcIso(form.due) : undefined,
        status: form.status,
      });
      setForm({ title: '', owner_id: '', due: '', status: 'Pending' });
      onChange();
    } catch (e) { showToast(e.message, 'error'); }
  };
  const toTask = async (actId) => {
    try { await api.post(`/api/meetings/${meeting.id}/actions/${actId}/to-task`); showToast('Task created ✓'); onChange(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  const setActStatus = async (actId, status) => {
    try { await api.patch(`/api/meetings/${meeting.id}/actions/${actId}`, { status }); onChange(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3 style={{ marginTop: 0 }}>Action items</h3>
      <div className="row-list">
        {(meeting.actions || []).map((a) => (
          <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{a.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>
                {a.due_at ? `Due ${fmtDateTime(a.due_at)}` : 'No due date'}
                {a.task_id ? ' · ✓ task created' : ''}
              </div>
            </div>
            <select value={a.status} onChange={(e) => setActStatus(a.id, e.target.value)}
              style={{ fontSize: 12, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--line)' }}>
              {['Pending', 'In Progress', 'Done'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {!a.task_id && (
              <button className="btn small secondary" onClick={() => toTask(a.id)}>Convert to task</button>
            )}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="form-grid">
          <input value={form.title} onChange={set('title')} placeholder="Action item"
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)' }} />
          <select value={form.owner_id} onChange={set('owner_id')}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>
            <option value="">Owner (optional)</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Due:
            <input type="datetime-local" value={form.due} onChange={set('due')}
              style={{ marginLeft: 6, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--line)' }} />
          </label>
          <button className="btn small" onClick={add}>+ Add action</button>
        </div>
      </div>
    </div>
  );
}
