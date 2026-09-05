// Phase 4B — Task detail at /work/:id (opened from the Tasks board). One
// consistent detail surface: inline edits (title / priority / board_status /
// due / project / scheduled window), description, subtasks with a progress bar,
// and a time-tracking card driven by the SINGLE GLOBAL timer (taskTimer.js).
//
// Edits go through the existing tasks PATCH; subtasks use its subtask_action.
// Scheduling a window that overlaps surfaces the server's 409 inline. Fields
// the user is still typing in (`dirty`) are never overwritten by a reload.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, dtLocalToUtcIso, utcIsoToDtLocal, goBack } from '../api.js';
import { useApp } from '../ctx.js';
import { useTicker, useWindowEvent } from '../hooks.js';
import { ErrorState, Field, LoadingState } from '../components.jsx';
import {
  getActiveTimer, startTimer, stopTimer, elapsedSeconds, fmtDuration,
} from '../taskTimer.js';

const BOARD = ['To Do', 'Doing', 'Review', 'Done', 'Drop'];
const PRIORITIES = ['Daily', 'High', 'Medium', 'Low'];

function safeSubtasks(raw) {
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function draftOf(t) {
  return {
    title: t.title || '',
    details: t.details || '',
    priority: t.priority,
    board_status: t.board_status,
    due_date: t.due_date || '',
    project_id: t.project_id ? String(t.project_id) : '',
    start: utcIsoToDtLocal(t.scheduled_start_at),
    end: utcIsoToDtLocal(t.scheduled_end_at),
  };
}

export default function TaskDetail() {
  const { id } = useParams();
  const { showToast, canWrite } = useApp();
  const navigate = useNavigate();
  const [task, setTask] = useState(null);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [saving, setSaving] = useState(false);

  const [draft, setDraft] = useState({});
  const dirty = useRef(new Set());
  const [newSub, setNewSub] = useState('');
  const [manualMin, setManualMin] = useState('');

  const [active, setActive] = useState(() => getActiveTimer());
  useWindowEvent('crm:timer', () => setActive(getActiveTimer()));

  const load = useCallback(() => {
    api.get(`/api/tasks/${id}`)
      .then((t) => {
        setTask(t);
        setError(null);
        const fresh = draftOf(t);
        // Merge field-by-field: keep whatever the user is mid-edit on.
        setDraft((d) => {
          const next = { ...fresh };
          for (const k of dirty.current) if (d[k] !== undefined) next[k] = d[k];
          return next;
        });
      })
      .catch((e) => setError(e));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/api/projects').then(setProjects).catch(() => {}); }, []);

  const isRunning = !!(active && task && active.taskId === task.id);
  useTicker(isRunning, 1000);

  const back = () => goBack(navigate, '/work');

  if (error && !task) {
    return (
      <>
        <div className="page-title"><h1><button type="button" className="back-btn" aria-label="Back" onClick={back}>←</button> Task</h1></div>
        <ErrorState error={error} onRetry={load} />
        <div style={{ marginTop: 10 }}><Link to="/work" className="btn small secondary">Back to board</Link></div>
      </>
    );
  }
  if (!task) return <LoadingState />;

  const subtasks = safeSubtasks(task.subtasks);
  const doneCount = subtasks.filter((s) => s.completed).length;
  const pct = subtasks.length ? Math.round((doneCount / subtasks.length) * 100) : 0;
  const liveExtra = isRunning ? elapsedSeconds(active) : 0;

  const editField = (k, v) => { dirty.current.add(k); setDraft((d) => ({ ...d, [k]: v })); };

  const patch = async (body, { onConflict, clear = [] } = {}) => {
    setConflict(null);
    setSaving(true);
    try {
      await api.patch(`/api/tasks/${task.id}`, body);
      for (const k of clear) dirty.current.delete(k);
      load();
      return true;
    } catch (err) {
      if (err.status === 409 && onConflict) onConflict(err.message);
      else showToast(err.message, 'error');
      return false;
    } finally { setSaving(false); }
  };

  const saveField = (field, value) => patch({ [field]: value }, { clear: [field] });

  const saveSchedule = async () => {
    if (!draft.start || !draft.end) {
      // Clearing both ends unschedules the task.
      return patch({ scheduled_start_at: null, scheduled_end_at: null }, { clear: ['start', 'end'] });
    }
    const start_at = dtLocalToUtcIso(draft.start);
    const end_at = dtLocalToUtcIso(draft.end);
    if (!(new Date(start_at) < new Date(end_at))) return showToast('Start must be before end', 'error');
    return patch({ scheduled_start_at: start_at, scheduled_end_at: end_at }, { onConflict: setConflict, clear: ['start', 'end'] });
  };

  const addSub = async () => {
    if (!newSub.trim() || saving) return;
    const ok = await patch({ subtask_action: 'add', subtask_title: newSub.trim() });
    if (ok) setNewSub('');
  };
  const toggleSub = (sid) => patch({ subtask_action: 'toggle', subtask_id: sid });
  const delSub = (sid) => patch({ subtask_action: 'delete', subtask_id: sid });

  const addManual = async () => {
    const m = Number(manualMin);
    if (!Number.isFinite(m) || m <= 0) return showToast('Enter minutes > 0', 'error');
    if (saving) return undefined;
    setSaving(true);
    try { await api.post(`/api/tasks/${task.id}/time`, { minutes: m }); setManualMin(''); load(); showToast('Time added ✓'); }
    catch (err) { showToast(err.message, 'error'); }
    finally { setSaving(false); }
    return undefined;
  };

  const toggleTimer = async () => {
    if (isRunning) { await stopTimer(); load(); }
    else { await startTimer(task.id, task.title); load(); }
  };

  const ro = !canWrite;

  return (
    <>
      <div className="page-title">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="back-btn" aria-label="Back to board" onClick={back}>←</button>
          Task
        </h1>
      </div>

      {error && <ErrorState error={error} onRetry={load} compact />}

      <div className="card">
        <Field label="Title">
          <input value={draft.title || ''} disabled={ro} onChange={(e) => editField('title', e.target.value)}
            onBlur={() => draft.title.trim() && draft.title !== task.title && saveField('title', draft.title.trim())} />
        </Field>

        <div className="form-grid">
          <Field label="Board status">
            <select value={draft.board_status || ''} disabled={ro}
              onChange={(e) => { editField('board_status', e.target.value); saveField('board_status', e.target.value); }}>
              {BOARD.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select value={draft.priority || ''} disabled={ro}
              onChange={(e) => { editField('priority', e.target.value); saveField('priority', e.target.value); }}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
        </div>

        <div className="form-grid">
          <Field label="Due date">
            <input type="date" value={draft.due_date || ''} disabled={ro}
              onChange={(e) => { editField('due_date', e.target.value); saveField('due_date', e.target.value); }} />
          </Field>
          <Field label="Project">
            <select value={draft.project_id || ''} disabled={ro}
              onChange={(e) => { editField('project_id', e.target.value); saveField('project_id', e.target.value || null); }}>
              <option value="">— none —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Description">
          <textarea rows={3} value={draft.details || ''} disabled={ro}
            onChange={(e) => editField('details', e.target.value)}
            onBlur={() => draft.details !== (task.details || '') && saveField('details', draft.details)} />
        </Field>

        {task.lead_id && (
          <div className="tl-meta">Lead: <Link to={`/leads/${task.lead_id}`}>{task.lead_name}</Link></div>
        )}
      </div>

      {/* Scheduled window */}
      <div className="card">
        <h2>Schedule</h2>
        <div className="form-grid">
          <Field label="Start (IST)">
            <input type="datetime-local" value={draft.start || ''} disabled={ro}
              onChange={(e) => editField('start', e.target.value)} />
          </Field>
          <Field label="End (IST)">
            <input type="datetime-local" value={draft.end || ''} disabled={ro}
              onChange={(e) => editField('end', e.target.value)} />
          </Field>
        </div>
        {conflict && <div className="inline-warn" role="alert">⚠️ {conflict}</div>}
        {!ro && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={saving} onClick={saveSchedule}>Save schedule</button>
            {(task.scheduled_start_at || task.scheduled_end_at) && (
              <button type="button" className="btn secondary" disabled={saving}
                onClick={() => { setDraft((d) => ({ ...d, start: '', end: '' })); patch({ scheduled_start_at: null, scheduled_end_at: null }, { clear: ['start', 'end'] }); }}>
                Unschedule
              </button>
            )}
          </div>
        )}
      </div>

      {/* Subtasks + progress */}
      <div className="card">
        <h2>Subtasks {subtasks.length > 0 && `(${doneCount}/${subtasks.length})`}</h2>
        {subtasks.length > 0 && (
          <div style={{ height: 8, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', margin: '0 0 12px' }}
            role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--green)' }} />
          </div>
        )}
        <div className="row-list">
          {subtasks.map((s) => (
            <div key={s.id} className="lead-row">
              <input type="checkbox" className="row-check" aria-label={`Subtask ${s.title}`} disabled={ro}
                checked={!!s.completed} onChange={() => toggleSub(s.id)} />
              <div className="info">
                <div className="name" style={{ textDecoration: s.completed ? 'line-through' : 'none', color: s.completed ? 'var(--ink-faint)' : 'var(--ink)' }}>
                  {s.title}
                </div>
              </div>
              {!ro && <button type="button" className="btn small secondary" onClick={() => delSub(s.id)} title="Delete" aria-label={`Delete subtask ${s.title}`}>✕</button>}
            </div>
          ))}
        </div>
        {!ro && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input value={newSub} aria-label="New subtask" onChange={(e) => setNewSub(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addSub()} placeholder="Add a subtask…" />
            <button type="button" className="btn" disabled={!newSub.trim() || saving} onClick={addSub}>Add</button>
          </div>
        )}
      </div>

      {/* Time tracking */}
      <div className="card">
        <h2>Time tracking</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div className="tl-meta">Tracked</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {fmtDuration((task.time_tracked || 0) + liveExtra)}
              {isRunning && <span style={{ fontSize: 13, color: 'var(--green-text)', marginLeft: 8 }}>● running {fmtDuration(liveExtra, true)}</span>}
            </div>
          </div>
          {!ro && (
            <>
              <button type="button" className={`btn ${isRunning ? 'secondary danger-text' : ''}`} onClick={toggleTimer}>
                {isRunning ? '■ Stop timer' : '▶ Start timer'}
              </button>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="number" min="1" style={{ width: 90 }} placeholder="minutes" aria-label="Minutes to add"
                  value={manualMin} onChange={(e) => setManualMin(e.target.value)} />
                <button type="button" className="btn secondary" disabled={saving} onClick={addManual}>+ Add manual</button>
              </div>
            </>
          )}
        </div>
        {active && !isRunning && (
          <div className="tl-meta" style={{ marginTop: 8, color: 'var(--amber-text)' }}>
            ⏱ Another task is being timed — starting this one will stop it.
          </div>
        )}
      </div>
    </>
  );
}
