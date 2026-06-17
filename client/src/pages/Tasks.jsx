import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { useApp } from '../App.jsx';
import { isAdmin } from '../permissions.js';

const COLUMNS = ['To Do', 'Doing', 'Review', 'Done', 'Drop'];
const PRIORITIES = ['Daily', 'High', 'Medium', 'Low'];
const PRIORITY_COLOR = {
  Daily: '#7c3aed', High: '#dc2626', Medium: '#d97706', Low: '#2563eb',
};

function PriorityDot({ priority }) {
  return <span title={priority} style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: 999,
    background: PRIORITY_COLOR[priority] || '#9ca3af', marginRight: 6,
  }} />;
}

function CardMenu({ task, onMove, onDelete, onOpen }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button className="btn small secondary" onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', zIndex: 20, minWidth: 150,
          background: 'var(--card, #fff)', border: '1px solid var(--line)', borderRadius: 8,
          boxShadow: '0 6px 20px rgba(0,0,0,.12)', padding: 4,
        }}>
          <button className="menu-item" onClick={() => { onOpen(); setOpen(false); }}>Edit / open</button>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)', padding: '4px 8px' }}>Move to</div>
          {COLUMNS.filter((c) => c !== task.board_status).map((c) => (
            <button key={c} className="menu-item" onClick={() => { onMove(c); setOpen(false); }}>{c}</button>
          ))}
          <button className="menu-item" style={{ color: 'var(--red)' }}
            onClick={() => { onDelete(); setOpen(false); }}>Delete</button>
        </div>
      )}
    </div>
  );
}

export default function Tasks() {
  const { user, showToast } = useApp();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState(null);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [filters, setFilters] = useState({ project_id: '', assignee: '', priority: '' });
  const [dragId, setDragId] = useState(null);

  const admin = isAdmin(user.role);

  const load = () => {
    const q = new URLSearchParams({ status: 'all' });
    if (filters.project_id) q.set('project_id', filters.project_id);
    if (filters.assignee) q.set('assignee', filters.assignee);
    if (filters.priority) q.set('priority', filters.priority);
    api.get(`/api/tasks?${q.toString()}`).then(setTasks).catch((e) => showToast(e.message, 'error'));
  };
  useEffect(load, [filters]);

  useEffect(() => {
    api.get('/api/projects').then(setProjects).catch(() => {});
    if (admin) api.get('/api/users').then(setUsers).catch(() => {});
  }, []);

  const byColumn = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map((c) => [c, []]));
    (tasks || []).forEach((t) => { (map[t.board_status] || map['To Do']).push(t); });
    return map;
  }, [tasks]);

  // Optimistic move; refetch on error to undo.
  const move = async (taskId, board_status) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, board_status } : t)));
    try { await api.patch(`/api/tasks/${taskId}`, { board_status }); }
    catch (err) { showToast(err.message, 'error'); load(); }
  };

  const remove = async (taskId) => {
    if (!confirm('Delete this task?')) return;
    try { await api.del(`/api/tasks/${taskId}`); load(); showToast('Task deleted'); }
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
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <select value={filters.project_id} onChange={(e) => setFilters((f) => ({ ...f, project_id: e.target.value }))}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {admin && (
            <select value={filters.assignee} onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}>
              <option value="">All assignees</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          )}
          <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        {!tasks && <div className="empty">Loading…</div>}

        {tasks && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(170px, 1fr))`, gap: 10, overflowX: 'auto' }}>
            {COLUMNS.map((col) => (
              <div key={col}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop(col)}
                style={{ background: 'var(--bg-soft, #f8fafc)', borderRadius: 10, padding: 8, minHeight: 120 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                  <span>{col}</span>
                  <span className="pill-count">{byColumn[col].length}</span>
                </div>
                {byColumn[col].map((t) => (
                  <div key={t.id}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => navigate(`/work/${t.id}`)}
                    className="card" style={{ margin: '0 0 8px', padding: 10, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        <PriorityDot priority={t.priority} />{t.title}
                      </div>
                      <CardMenu task={t}
                        onMove={(c) => move(t.id, c)}
                        onDelete={() => remove(t.id)}
                        onOpen={() => navigate(`/work/${t.id}`)} />
                    </div>
                    <div className="tl-meta" style={{ marginTop: 4 }}>
                      {t.project_name && <span>{t.project_name} · </span>}
                      {t.assigned_to_name}
                    </div>
                    <div className="tl-meta">Due {fmtDate(t.due_date)}</div>
                    {col !== 'Done' && col !== 'Drop' && (
                      <button className="btn small secondary" style={{ marginTop: 6 }}
                        onClick={(e) => { e.stopPropagation(); move(t.id, 'Done'); }}>✓ Complete</button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
