import React, { useEffect, useMemo, useState } from 'react';
import { api, rupees, fmtDate } from '../api.js';
import { useApp } from '../App.jsx';
import { hasPermission, isAdmin } from '../permissions.js';
import { Modal } from '../components.jsx';

const STATUSES = ['Approval', 'Assigned', 'Working', 'Review', 'Completed', 'Pending Client'];
// Reuse existing badge colors by mapping project statuses onto lead-stage classes.
const STATUS_BADGE = {
  Approval: 'pending', Assigned: 'contacted', Working: 'interested',
  Review: 'follow_up', Completed: 'won', 'Pending Client': 'partial',
};

function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_BADGE[status] || 'pending'}`}>{status}</span>;
}

// Derive shown progress from completed tasks so the bar matches the
// "done_count/task_count tasks done" line. Projects with no tasks fall back to
// the manually-entered progress value.
function taskProgress(p) {
  if (p.task_count > 0) return Math.round((p.done_count / p.task_count) * 100);
  return p.progress || 0;
}

function Progress({ value }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-soft)' }}>
        <span>Progress</span><b>{pct}%</b>
      </div>
      <div style={{ height: 8, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', marginTop: 3 }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--brand, #6366f1)' }} />
      </div>
    </div>
  );
}

function AddProjectModal({ user, leads, heads, onClose, onSaved }) {
  const { showToast } = useApp();
  const [form, setForm] = useState({
    name: '', description: '', lead_id: '', service_type: '',
    budget_rupees: '', assigned_head_id: '', status: 'Working', progress: 0, start_date: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!form.name.trim()) return showToast('Project name required', 'error');
    setSaving(true);
    try {
      const budget = Math.round(Number(form.budget_rupees || 0) * 100);
      await api.post('/api/projects', {
        name: form.name.trim(),
        description: form.description || undefined,
        lead_id: form.lead_id || undefined,
        service_type: form.service_type || undefined,
        budget_paise: Number.isFinite(budget) && budget >= 0 ? budget : 0,
        assigned_head_id: form.assigned_head_id || undefined,
        status: form.status,
        progress: Number(form.progress) || 0,
        start_date: form.start_date || undefined,
      });
      showToast('Project created ✓');
      onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); } finally { setSaving(false); }
  };

  return (
    <Modal title="New project" onClose={onClose}>
      <div className="field">
        <label>Project name</label>
        <input value={form.name} onChange={set('name')} autoFocus placeholder="e.g. Acme website revamp" />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Client lead</label>
          <select value={form.lead_id} onChange={set('lead_id')}>
            <option value="">— none —</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.phone})</option>)}
          </select>
        </div>
        <div className="field">
          <label>Service type</label>
          <input value={form.service_type} onChange={set('service_type')} placeholder="web / SEO / ads…" />
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Budget (₹)</label>
          <input type="number" min="0" value={form.budget_rupees} onChange={set('budget_rupees')} placeholder="0" />
        </div>
        <div className="field">
          <label>Project head</label>
          <select value={form.assigned_head_id} onChange={set('assigned_head_id')}>
            <option value="">— unassigned —</option>
            {heads.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Status</label>
          <select value={form.status} onChange={set('status')}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Start date</label>
          <input type="date" value={form.start_date} onChange={set('start_date')} />
        </div>
      </div>
      <div className="field">
        <label>Progress: {form.progress}%</label>
        <input type="range" min="0" max="100" value={form.progress} onChange={set('progress')} />
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Create project'}</button>
      </div>
    </Modal>
  );
}

function ProjectDetails({ project, canDelete, onClose, onChanged }) {
  const { showToast } = useApp();
  const [detail, setDetail] = useState(null);
  const [taskTitle, setTaskTitle] = useState('');

  const load = () => api.get(`/api/projects/${project.id}`).then(setDetail).catch((e) => showToast(e.message, 'error'));
  useEffect(load, [project.id]);

  const addTask = async () => {
    if (!taskTitle.trim()) return;
    try {
      await api.post('/api/tasks', { title: taskTitle.trim(), project_id: project.id });
      setTaskTitle(''); load(); onChanged?.();
      showToast('Task added ✓');
    } catch (err) { showToast(err.message, 'error'); }
  };

  const remove = async () => {
    if (!confirm(`Delete project "${project.name}"? Its tasks are kept (detached).`)) return;
    try { await api.del(`/api/projects/${project.id}`); showToast('Project deleted'); onChanged?.(); onClose(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <Modal title={project.name} onClose={onClose}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <StatusBadge status={project.status} />
        {project.head_name && <span className="tl-meta">Head: {project.head_name}</span>}
        {project.budget_paise > 0 && <span className="tl-meta">Budget: {rupees(project.budget_paise)}</span>}
      </div>
      {project.description && <p style={{ fontSize: 13 }}>{project.description}</p>}
      <Progress value={taskProgress(detail || project)} />

      <div className="field" style={{ marginTop: 12 }}>
        <label>Add a task</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTask()} placeholder="What needs doing?" />
          <button className="btn" disabled={!taskTitle.trim()} onClick={addTask}>Add</button>
        </div>
      </div>

      <div className="row-list" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto' }}>
        {detail?.tasks?.length === 0 && <div className="empty">No tasks yet.</div>}
        {detail?.tasks?.map((t) => (
          <div key={t.id} className="lead-row">
            <div className="info">
              <div className="name">{t.title}</div>
              <div className="meta">{t.assigned_to_name} · {t.priority} · {t.board_status}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="modal-actions">
        {canDelete && <button className="btn secondary" style={{ color: 'var(--red)' }} onClick={remove}>Delete</button>}
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

export default function Projects() {
  const { user, showToast } = useApp();
  const [projects, setProjects] = useState(null);
  const [leads, setLeads] = useState([]);
  const [heads, setHeads] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);

  const canCreate = hasPermission(user.role, 'CREATE_PROJECT');
  const canDelete = isAdmin(user.role);

  const load = () => {
    const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    api.get(`/api/projects${q}`).then(setProjects).catch((e) => showToast(e.message, 'error'));
  };
  useEffect(load, [statusFilter]);

  useEffect(() => {
    api.get('/api/leads?limit=500').then((d) => setLeads(d.leads || d || [])).catch(() => {});
    if (isAdmin(user.role)) api.get('/api/users').then(setHeads).catch(() => {});
    else setHeads([{ id: user.id, full_name: user.full_name }]);
  }, []);

  const filtered = useMemo(() => {
    if (!projects) return [];
    const s = search.trim().toLowerCase();
    return s ? projects.filter((p) => p.name.toLowerCase().includes(s)
      || (p.lead_name || '').toLowerCase().includes(s)) : projects;
  }, [projects, search]);

  return (
    <>
      <div className="page-title">
        <h1>Projects</h1>
        {canCreate && <button className="btn" onClick={() => setAdding(true)}>+ New project</button>}
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <input style={{ flex: 1, minWidth: 180 }} placeholder="Search projects…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {!projects && <div className="empty">Loading…</div>}
        {projects && filtered.length === 0 && <div className="empty">No projects yet.</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {filtered.map((p) => (
            <div key={p.id} className="card" style={{ cursor: 'pointer', margin: 0 }} onClick={() => setOpen(p)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 8 }}>
                <b style={{ fontSize: 15 }}>{p.name}</b>
                <StatusBadge status={p.status} />
              </div>
              <div className="tl-meta" style={{ marginTop: 4 }}>
                {p.lead_name ? `Client: ${p.lead_name}` : 'No client lead'}
              </div>
              <div className="tl-meta">
                {p.head_name ? `Head: ${p.head_name}` : 'Unassigned'}
                {p.budget_paise > 0 && ` · ${rupees(p.budget_paise)}`}
              </div>
              {p.start_date && <div className="tl-meta">Start: {fmtDate(p.start_date)}</div>}
              <div className="tl-meta">{p.done_count}/{p.task_count} tasks done</div>
              <Progress value={taskProgress(p)} />
            </div>
          ))}
        </div>
      </div>

      {adding && (
        <AddProjectModal user={user} leads={leads} heads={heads}
          onClose={() => setAdding(false)} onSaved={load} />
      )}
      {open && (
        <ProjectDetails project={open} canDelete={canDelete}
          onClose={() => setOpen(null)} onChanged={load} />
      )}
    </>
  );
}
