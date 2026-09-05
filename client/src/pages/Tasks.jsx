import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest } from '../hooks.js';
import { isAdmin, isAssignable } from '../permissions.js';
import { ErrorState, LoadingState, TaskModal } from '../components.jsx';

const COLUMNS = ['To Do', 'Doing', 'Review', 'Done', 'Drop'];
const PRIORITIES = ['Daily', 'High', 'Medium', 'Low'];
const PRIORITY_COLOR = {
  Daily: '#6b21a8', High: '#b91c1c', Medium: '#8f4d00', Low: '#1a56db',
};

function PriorityDot({ priority }) {
  return <span title={priority} aria-label={`${priority} priority`} style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: 999,
    background: PRIORITY_COLOR[priority] || '#9ca3af', marginRight: 6,
  }} />;
}

function CardMenu({ task, onMove, onDelete, onOpen }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="btn small secondary" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Actions for ${task.title}`} onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" className="menu-item" onClick={() => { onOpen(); setOpen(false); }}>Edit / open</button>
          <div className="menu-label">Move to</div>
          {COLUMNS.filter((c) => c !== task.board_status).map((c) => (
            <button key={c} type="button" role="menuitem" className="menu-item" onClick={() => { onMove(c); setOpen(false); }}>{c}</button>
          ))}
          <button type="button" role="menuitem" className="menu-item danger"
            onClick={() => { onDelete(); setOpen(false); }}>Delete</button>
        </div>
      )}
    </div>
  );
}

export default function Tasks() {
  const { user, showToast, askConfirm, canWrite } = useApp();
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [filters, setFilters] = useState({ project_id: '', assignee: '', priority: '' });
  const [dragId, setDragId] = useState(null);
  const [adding, setAdding] = useState(false);

  const admin = isAdmin(user.role);

  const { data: tasks, error, loading, reload, setData } = useRequest(({ signal }) => {
    const q = new URLSearchParams({ status: 'all' });
    if (filters.project_id) q.set('project_id', filters.project_id);
    if (filters.assignee) q.set('assignee', filters.assignee);
    if (filters.priority) q.set('priority', filters.priority);
    return api.get(`/api/tasks?${q.toString()}`, { signal });
  }, [filters.project_id, filters.assignee, filters.priority]);

  useEffect(() => {
    api.get('/api/projects').then(setProjects).catch(() => {});
    if (admin) api.get('/api/users').then((u) => setUsers(u.filter(isAssignable))).catch(() => {});
  }, [admin]);

  const byColumn = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map((c) => [c, []]));
    (tasks || []).forEach((t) => { (map[t.board_status] || map['To Do']).push(t); });
    return map;
  }, [tasks]);

  // Optimistic move; refetch on error to undo.
  const move = async (taskId, board_status) => {
    setData((prev) => (prev || []).map((t) => (t.id === taskId ? { ...t, board_status } : t)));
    try { await api.patch(`/api/tasks/${taskId}`, { board_status }); }
    catch (err) { showToast(err.message, 'error'); reload(); }
  };

  const remove = async (task) => {
    const ok = await askConfirm({ title: 'Delete this task?', message: task.title, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try { await api.del(`/api/tasks/${task.id}`); reload(); showToast('Task deleted'); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const onDrop = (column) => (e) => {
    e.preventDefault();
    if (dragId != null) move(dragId, column);
    setDragId(null);
  };

  return (
    <>
      <div className="page-title">
        <h1>Work board</h1>
        {canWrite && <button type="button" className="btn" onClick={() => setAdding(true)}>+ New task</button>}
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <select value={filters.project_id} aria-label="Project" onChange={(e) => setFilters((f) => ({ ...f, project_id: e.target.value }))}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {admin && (
            <select value={filters.assignee} aria-label="Assignee" onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}>
              <option value="">All assignees</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          )}
          <select value={filters.priority} aria-label="Priority" onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        {error && !tasks && <ErrorState error={error} onRetry={reload} />}
        {error && tasks && <ErrorState error={error} onRetry={reload} compact />}
        {loading && !tasks && <LoadingState compact />}

        {tasks && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(170px, 1fr))`, gap: 10, overflowX: 'auto' }}>
            {COLUMNS.map((col) => (
              <div key={col}
                onDragOver={(e) => canWrite && e.preventDefault()}
                onDrop={canWrite ? onDrop(col) : undefined}
                style={{ background: 'var(--bg-soft)', borderRadius: 10, padding: 8, minHeight: 120 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                  <span>{col}</span>
                  <span className="pill-count">{byColumn[col].length}</span>
                </div>
                {byColumn[col].map((t) => (
                  <div key={t.id}
                    draggable={canWrite}
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => navigate(`/work/${t.id}`)}
                    className="card" style={{ margin: '0 0 8px', padding: 10, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>
                        <PriorityDot priority={t.priority} />
                        <Link to={`/work/${t.id}`} className="name-link" onClick={(e) => e.stopPropagation()}>{t.title}</Link>
                      </div>
                      {canWrite && (
                        <CardMenu task={t}
                          onMove={(c) => move(t.id, c)}
                          onDelete={() => remove(t)}
                          onOpen={() => navigate(`/work/${t.id}`)} />
                      )}
                    </div>
                    <div className="tl-meta" style={{ marginTop: 4 }}>
                      {t.project_name && <span>{t.project_name} · </span>}
                      {t.assigned_to_name}
                    </div>
                    <div className="tl-meta">Due {fmtDate(t.due_date)}</div>
                    {canWrite && col !== 'Done' && col !== 'Drop' && (
                      <button type="button" className="btn small secondary" style={{ marginTop: 6 }}
                        onClick={(e) => { e.stopPropagation(); move(t.id, 'Done'); }}>✓ Complete</button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {adding && <TaskModal onClose={() => setAdding(false)} onSaved={reload} />}
    </>
  );
}
