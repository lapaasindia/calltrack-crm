// Phase 4B — Task detail at /work/:id (opened from the Tasks board). One
// consistent detail surface: inline edits (title / priority / board_status /
// due / project / scheduled window), description, subtasks with a progress bar,
// and a time-tracking card driven by the SINGLE GLOBAL timer (taskTimer.js).
//
// Edits go through the existing tasks PATCH; subtasks use its subtask_action.
// Scheduling a window that overlaps surfaces the server's 409 inline.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, dtLocalToUtcIso, utcIsoToDtLocal } from '../api.js';
import { useApp } from '../App.jsx';
import {
  getActiveTimer, startTimer, stopTimer, elapsedSeconds, fmtDuration,
} from '../taskTimer.js';

const BOARD = ['To Do', 'Doing', 'Review', 'Done', 'Drop'];
const PRIORITIES = ['Daily', 'High', 'Medium', 'Low'];

function safeSubtasks(raw) {
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export default function TaskDetail() {
  const { id } = useParams();
  const { showToast } = useApp();
  const navigate = useNavigate();
  const [task, setTask] = useState(null);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);

  const [draft, setDraft] = useState({});
  const [newSub, setNewSub] = useState('');
  const [manualMin, setManualMin] = useState('');

  // Live timer state (re-reads on the global 'crm:timer' event + a 1s tick).
  const [active, setActive] = useState(getActiveTimer());
  const [, setTick] = useState(0);

  const load = useCallback(() => {
    api.get(`/api/tasks/${id}`)
      .then((t) => {
        setTask(t);
        setDraft({
          title: t.title || '',
          details: t.details || '',
          priority: t.priority,
          board_status: t.board_status,
          due_date: t.due_date || '',
          project_id: t.project_id ? String(t.project_id) : '',
          start: utcIsoToDtLocal(t.scheduled_start_at),
          end: utcIsoToDtLocal(t.scheduled_end_at),
        });
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/api/projects').then(setProjects).catch(() => {}); }, []);

  useEffect(() => {
    const onTimer = () => setActive(getActiveTimer());
    window.addEventListener('crm:timer', onTimer);
    const iv = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { window.removeEventListener('crm:timer', onTimer); clearInterval(iv); };
  }, []);

  if (error) {
    return (
      <div className="card empty">
        <div className="big">🚫</div>
        {error}
        <div style={{ marginTop: 10 }}><Link to="/work" className="btn small">Back to board</Link></div>
      </div>
    );
  }
  if (!task) return null;

  const subtasks = safeSubtasks(task.subtasks);
  const doneCount = subtasks.filter((s) => s.completed).length;
  const pct = subtasks.length ? Math.round((doneCount / subtasks.length) * 100) : 0;
  const isRunning = active && active.taskId === task.id;
  const liveExtra = isRunning ? elapsedSeconds(active) : 0;

  const patch = async (body, { onConflict } = {}) => {
    setConflict(null);
    try { await api.patch(`/api/tasks/${task.id}`, body); load(); return true; }
    catch (err) {
      if (err.status === 409 && onConflict) onConflict(err.message);
      else showToast(err.message, 'error');
      return false;
    }
  };

  const saveField = (field, value) => patch({ [field]: value });

  const saveSchedule = async () => {
    if (!draft.start || !draft.end) {
      // Clearing both ends unschedules the task.
      return patch({ scheduled_start_at: null, scheduled_end_at: null });
    }
    const start_at = dtLocalToUtcIso(draft.start);
    const end_at = dtLocalToUtcIso(draft.end);
    if (!(new Date(start_at) < new Date(end_at))) return showToast('Start must be before end', 'error');
    return patch({ scheduled_start_at: start_at, scheduled_end_at: end_at }, { onConflict: setConflict });
  };

  const addSub = async () => {
    if (!newSub.trim()) return;
    await patch({ subtask_action: 'add', subtask_title: newSub.trim() });
    setNewSub('');
  };
  const toggleSub = (sid) => patch({ subtask_action: 'toggle', subtask_id: sid });
  const delSub = (sid) => patch({ subtask_action: 'delete', subtask_id: sid });

  const addManual = async () => {
    const m = Number(manualMin);
    if (!Number.isFinite(m) || m <= 0) return showToast('Enter minutes > 0', 'error');
    try { await api.post(`/api/tasks/${task.id}/time`, { minutes: m }); setManualMin(''); load(); showToast('Time added ✓'); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const toggleTimer = async () => {
    if (isRunning) { await stopTimer(); load(); }
    else { await startTimer(task.id, task.title); load(); }
  };

  return (
    <>
      <div className="page-title">
        <h1>
          <button className="btn small secondary" style={{ marginRight: 10 }}
            onClick={() => navigate('/work')}>‹ Board</button>
          Task
        </h1>
      </div>

      <div className="card">
        <div className="field">
          <label>Title</label>
          <input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            onBlur={() => draft.title.trim() && draft.title !== task.title && saveField('title', draft.title.trim())} />
        </div>

        <div className="form-grid">
          <div className="field">
            <label>Board status</label>
            <select value={draft.board_status}
              onChange={(e) => { setDraft((d) => ({ ...d, board_status: e.target.value })); saveField('board_status', e.target.value); }}>
              {BOARD.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Priority</label>
            <select value={draft.priority}
              onChange={(e) => { setDraft((d) => ({ ...d, priority: e.target.value })); saveField('priority', e.target.value); }}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div className="form-grid">
          <div className="field">
            <label>Due date</label>
            <input type="date" value={draft.due_date}
              onChange={(e) => { setDraft((d) => ({ ...d, due_date: e.target.value })); saveField('due_date', e.target.value); }} />
          </div>
          <div className="field">
            <label>Project</label>
            <select value={draft.project_id}
              onChange={(e) => { setDraft((d) => ({ ...d, project_id: e.target.value })); saveField('project_id', e.target.value || null); }}>
              <option value="">— none —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <div className="field">
          <label>Description</label>
          <textarea rows={3} value={draft.details}
            onChange={(e) => setDraft((d) => ({ ...d, details: e.target.value }))}
            onBlur={() => draft.details !== (task.details || '') && saveField('details', draft.details)} />
        </div>

        {task.lead_id && (
          <div className="tl-meta">Lead: <Link to={`/leads/${task.lead_id}`}>{task.lead_name}</Link></div>
        )}
      </div>

      {/* Scheduled window */}
      <div className="card">
        <h2>Schedule</h2>
        <div className="form-grid">
          <div className="field">
            <label>Start (IST)</label>
            <input type="datetime-local" value={draft.start}
              onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))} />
          </div>
          <div className="field">
            <label>End (IST)</label>
            <input type="datetime-local" value={draft.end}
              onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))} />
          </div>
        </div>
        {conflict && (
          <div style={{
            fontSize: 12.5, fontWeight: 600, color: 'var(--red)', background: 'var(--red-soft)',
            border: '1px solid var(--red)', borderRadius: 8, padding: '7px 10px', marginBottom: 10,
          }}>⚠️ {conflict}</div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={saveSchedule}>Save schedule</button>
          {(task.scheduled_start_at || task.scheduled_end_at) && (
            <button className="btn secondary"
              onClick={() => { setDraft((d) => ({ ...d, start: '', end: '' })); patch({ scheduled_start_at: null, scheduled_end_at: null }); }}>
              Unschedule
            </button>
          )}
        </div>
      </div>

      {/* Subtasks + progress */}
      <div className="card">
        <h2>Subtasks {subtasks.length > 0 && `(${doneCount}/${subtasks.length})`}</h2>
        {subtasks.length > 0 && (
          <div style={{ height: 8, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', margin: '0 0 12px' }}>
            <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--green)' }} />
          </div>
        )}
        <div className="row-list">
          {subtasks.map((s) => (
            <div key={s.id} className="lead-row">
              <input type="checkbox" style={{ width: 18, height: 18 }}
                checked={!!s.completed} onChange={() => toggleSub(s.id)} />
              <div className="info">
                <div className="name" style={{ textDecoration: s.completed ? 'line-through' : 'none', color: s.completed ? 'var(--ink-faint)' : 'var(--ink)' }}>
                  {s.title}
                </div>
              </div>
              <button className="btn small secondary" onClick={() => delSub(s.id)} title="Delete">✕</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input value={newSub} onChange={(e) => setNewSub(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSub()} placeholder="Add a subtask…" />
          <button className="btn" disabled={!newSub.trim()} onClick={addSub}>Add</button>
        </div>
      </div>

      {/* Time tracking */}
      <div className="card">
        <h2>Time tracking</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div className="tl-meta">Tracked</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {fmtDuration((task.time_tracked || 0) + liveExtra)}
              {isRunning && <span style={{ fontSize: 13, color: 'var(--green)', marginLeft: 8 }}>● running {fmtDuration(liveExtra, true)}</span>}
            </div>
          </div>
          <button className={`btn ${isRunning ? 'secondary' : ''}`} onClick={toggleTimer}
            style={isRunning ? { color: 'var(--red)' } : undefined}>
            {isRunning ? '■ Stop timer' : '▶ Start timer'}
          </button>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="number" min="1" style={{ width: 90 }} placeholder="minutes"
              value={manualMin} onChange={(e) => setManualMin(e.target.value)} />
            <button className="btn secondary" onClick={addManual}>+ Add manual</button>
          </div>
        </div>
        {active && !isRunning && (
          <div className="tl-meta" style={{ marginTop: 8, color: 'var(--amber)' }}>
            ⏱ Another task is being timed — starting this one will stop it.
          </div>
        )}
      </div>
    </>
  );
}
