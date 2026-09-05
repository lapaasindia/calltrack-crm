import React, { useEffect, useMemo, useState } from 'react';
import { api, rupees, fmtDate } from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest, useSubmit } from '../hooks.js';
import { hasPermission, isAdmin, isAssignable } from '../permissions.js';
import { Modal, ErrorState, LoadingState, Field, LeadPicker } from '../components.jsx';

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
      <div style={{ height: 8, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', marginTop: 3 }}
        role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--brand)' }} />
      </div>
    </div>
  );
}

function AddProjectModal({ heads, onClose, onSaved }) {
  const { showToast } = useApp();
  const [form, setForm] = useState({
    name: '', description: '', lead_id: '', service_type: '',
    budget_rupees: '', assigned_head_id: '', status: 'Working', progress: 0, start_date: '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const [save, saving] = useSubmit(async () => {
    if (!form.name.trim()) return showToast('Project name required', 'error');
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
    } catch (err) { showToast(err.message, 'error'); }
    return undefined;
  });

  return (
    <Modal title="New project" onClose={onClose}>
      <Field label="Project name">
        <input value={form.name} onChange={set('name')} autoFocus placeholder="e.g. Acme website revamp" />
      </Field>
      <Field label="Description">
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </Field>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="proj-lead">Client lead</label>
          <LeadPicker id="proj-lead" value={form.lead_id} noneLabel="— none —"
            onChange={(id) => setForm((f) => ({ ...f, lead_id: id }))} />
        </div>
        <Field label="Service type">
          <input value={form.service_type} onChange={set('service_type')} placeholder="web / SEO / ads…" />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Budget (₹)">
          <input type="number" min="0" inputMode="decimal" value={form.budget_rupees} onChange={set('budget_rupees')} placeholder="0" />
        </Field>
        <Field label="Project head">
          <select value={form.assigned_head_id} onChange={set('assigned_head_id')}>
            <option value="">— unassigned —</option>
            {heads.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Status">
          <select value={form.status} onChange={set('status')}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Start date">
          <input type="date" value={form.start_date} onChange={set('start_date')} />
        </Field>
      </div>
      <Field label={`Progress: ${form.progress}%`}>
        <input type="range" min="0" max="100" value={form.progress} onChange={set('progress')} />
      </Field>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Create project'}</button>
      </div>
    </Modal>
  );
}

function ProjectDetails({ project, canDelete, onClose, onChanged }) {
  const { showToast, askConfirm, canWrite } = useApp();
  const [taskTitle, setTaskTitle] = useState('');
  // useRequest owns the effect; nothing is ever returned as a "cleanup" (CLIENT-4).
  const { data: detail, error, reload } = useRequest(
    ({ signal }) => api.get(`/api/projects/${project.id}`, { signal }), [project.id],
  );
  const shown = detail || project;

  const [addTask, adding] = useSubmit(async () => {
    if (!taskTitle.trim()) return;
    try {
      await api.post('/api/tasks', { title: taskTitle.trim(), project_id: project.id });
      setTaskTitle(''); reload(); if (onChanged) onChanged();
      showToast('Task added ✓');
    } catch (err) { showToast(err.message, 'error'); }
  });

  const [update, updating] = useSubmit(async (body) => {
    try {
      await api.patch(`/api/projects/${project.id}`, body);
      reload(); if (onChanged) onChanged();
    } catch (err) { showToast(err.message, 'error'); }
  });

  const [remove, removing] = useSubmit(async () => {
    const ok = await askConfirm({
      title: `Delete project "${project.name}"?`,
      message: 'Its tasks are kept (detached from the project).',
      confirmLabel: 'Delete project', danger: true,
    });
    if (!ok) return;
    try { await api.del(`/api/projects/${project.id}`); showToast('Project deleted'); if (onChanged) onChanged(); onClose(); }
    catch (err) { showToast(err.message, 'error'); }
  });

  return (
    <Modal title={project.name} onClose={onClose}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <StatusBadge status={shown.status} />
        {shown.head_name && <span className="tl-meta">Head: {shown.head_name}</span>}
        {shown.budget_paise > 0 && <span className="tl-meta">Budget: {rupees(shown.budget_paise)}</span>}
      </div>
      {shown.description && <p style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{shown.description}</p>}
      {error && <ErrorState error={error} onRetry={reload} compact />}

      {canWrite ? (
        <div className="form-grid">
          <Field label="Status">
            <select value={shown.status} disabled={updating} onChange={(e) => update({ status: e.target.value })}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label={`Manual progress: ${shown.progress || 0}%`}
            hint={shown.task_count > 0 ? 'Shown progress follows completed tasks while the project has tasks.' : undefined}>
            <input type="range" min="0" max="100" defaultValue={shown.progress || 0} disabled={updating}
              onMouseUp={(e) => update({ progress: Number(e.target.value) })}
              onTouchEnd={(e) => update({ progress: Number(e.target.value) })}
              onKeyUp={(e) => update({ progress: Number(e.target.value) })} />
          </Field>
        </div>
      ) : null}
      <Progress value={taskProgress(shown)} />

      {canWrite && (
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="proj-task">Add a task</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="proj-task" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTask()} placeholder="What needs doing?" />
            <button type="button" className="btn" disabled={!taskTitle.trim() || adding} onClick={addTask}>Add</button>
          </div>
        </div>
      )}

      <div className="row-list" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto' }}>
        {detail && detail.tasks && detail.tasks.length === 0 && <div className="empty">No tasks yet.</div>}
        {detail && detail.tasks && detail.tasks.map((t) => (
          <div key={t.id} className="lead-row">
            <div className="info">
              <div className="name">{t.title}</div>
              <div className="meta">{t.assigned_to_name} · {t.priority} · {t.board_status}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="modal-actions">
        {canDelete && <button type="button" className="btn secondary danger-text" disabled={removing} onClick={remove}>Delete</button>}
        <button type="button" className="btn" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

export default function Projects() {
  const { user, canWrite } = useApp();
  const [heads, setHeads] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);

  const canCreate = canWrite && hasPermission(user.role, 'CREATE_PROJECT');
  const canDelete = canWrite && isAdmin(user.role);

  const { data: projects, error, loading, reload } = useRequest(({ signal }) => {
    const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    return api.get(`/api/projects${q}`, { signal });
  }, [statusFilter]);

  useEffect(() => {
    // Every role may list colleagues now (slim {id, full_name, role} for non-admins).
    api.get('/api/users').then((u) => setHeads(u.filter(isAssignable)))
      .catch(() => setHeads([{ id: user.id, full_name: user.full_name }]));
  }, [user.id, user.full_name]);

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
        {canCreate && <button type="button" className="btn" onClick={() => setAdding(true)}>+ New project</button>}
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <input style={{ flex: 1, minWidth: 180 }} type="search" placeholder="Search projects…" aria-label="Search projects"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={statusFilter} aria-label="Status" onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {error && !projects && <ErrorState error={error} onRetry={reload} />}
        {error && projects && <ErrorState error={error} onRetry={reload} compact />}
        {loading && !projects && <LoadingState compact />}
        {projects && filtered.length === 0 && <div className="empty">No projects yet.</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {filtered.map((p) => (
            <button type="button" key={p.id} className="card" style={{ margin: 0 }} aria-label={`Open project ${p.name}`} onClick={() => setOpen(p)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 8 }}>
                <b style={{ fontSize: 15, minWidth: 0, overflowWrap: 'anywhere' }}>{p.name}</b>
                <StatusBadge status={p.status} />
              </div>
              <div className="tl-meta" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
                {p.lead_name ? `Client: ${p.lead_name}` : 'No client lead'}
              </div>
              <div className="tl-meta">
                {p.head_name ? `Head: ${p.head_name}` : 'Unassigned'}
                {p.budget_paise > 0 && ` · ${rupees(p.budget_paise)}`}
              </div>
              {p.start_date && <div className="tl-meta">Start: {fmtDate(p.start_date)}</div>}
              <div className="tl-meta">{p.done_count}/{p.task_count} tasks done</div>
              <Progress value={taskProgress(p)} />
            </button>
          ))}
        </div>
      </div>

      {adding && (
        <AddProjectModal heads={heads}
          onClose={() => setAdding(false)} onSaved={reload} />
      )}
      {open && (
        <ProjectDetails project={open} canDelete={canDelete}
          onClose={() => setOpen(null)} onChanged={reload} />
      )}
    </>
  );
}
