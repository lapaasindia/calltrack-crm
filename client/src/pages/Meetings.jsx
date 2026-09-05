// Phase 5A — Meeting OS: meetings list with status/owner filters, dashboard
// counts (Today / Upcoming / Running / Completed) and an AddMeetingModal.
// All instants are UTC; the IST day for "Today" is derived via api helpers.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDateTime, todayIstDate, dtLocalToUtcIso, utcIsoToDtLocal, istDateOf } from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest, useSubmit } from '../hooks.js';
import { isAdmin } from '../permissions.js';
import { Modal, ErrorState, LoadingState, Field, LeadPicker } from '../components.jsx';

const STATUSES = ['Scheduled', 'In Progress', 'Completed', 'Cancelled'];

function StatusBadge({ status }) {
  const cls = { Scheduled: 'new', 'In Progress': 'won', Completed: 'follow_up', Cancelled: 'muted' }[status] || 'new';
  return <span className={`badge ${cls}`}>{status}</span>;
}

const activeUsers = (list) => (list || []).filter((u) => u.is_active === undefined || !!u.is_active);

export default function Meetings() {
  const { user, canWrite } = useApp();
  const navigate = useNavigate();
  const admin = isAdmin(user.role);
  const [statusFilter, setStatusFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [users, setUsers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);

  const { data: meetings, error, loading, reload } = useRequest(
    ({ signal }) => api.get('/api/meetings', { signal }), [],
  );

  useEffect(() => {
    api.get('/api/users').then((u) => setUsers(activeUsers(u))).catch(() => {});
  }, []);
  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const today = todayIstDate();
  const counts = useMemo(() => {
    let todayN = 0; let upcoming = 0; let running = 0; let completed = 0;
    for (const m of meetings || []) {
      if (m.status === 'In Progress') running += 1;
      if (m.status === 'Completed') completed += 1;
      if (m.status === 'Scheduled' || m.status === 'In Progress') {
        const d = istDateOf(m.start_at);
        if (d === today) todayN += 1;
        else if (d > today) upcoming += 1;
      }
    }
    return { todayN, upcoming, running, completed };
  }, [meetings, today]);

  const filtered = useMemo(() => (meetings || []).filter((m) => {
    if (statusFilter && m.status !== statusFilter) return false;
    if (ownerFilter && m.owner_id !== Number(ownerFilter)) return false;
    return true;
  }), [meetings, statusFilter, ownerFilter]);

  return (
    <>
      <div className="page-title">
        <h1>Meetings</h1>
        {canWrite && <button type="button" className="btn" onClick={() => setShowAdd(true)}>+ New meeting</button>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
        <StatCard label="Today" value={counts.todayN} color="var(--blue-text)" />
        <StatCard label="Upcoming" value={counts.upcoming} color="var(--brand)" />
        <StatCard label="Running" value={counts.running} color="var(--green-text)" />
        <StatCard label="Completed" value={counts.completed} color="var(--ink-soft)" />
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <select value={statusFilter} aria-label="Status" onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {admin && (
            <select value={ownerFilter} aria-label="Owner" onChange={(e) => setOwnerFilter(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>
              <option value="">All owners</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          )}
        </div>

        {error && !meetings && <ErrorState error={error} onRetry={reload} />}
        {error && meetings && <ErrorState error={error} onRetry={reload} compact />}
        {loading && !meetings && <LoadingState compact />}

        {meetings && filtered.length === 0 ? (
          <div className="empty">No meetings. Click "New meeting" to schedule one.</div>
        ) : (
          <div className="row-list">
            {filtered.map((m) => (
              <button key={m.id} type="button" className="lead-row clickable" style={{ width: '100%' }}
                onClick={() => navigate(`/meetings/${m.id}`)}>
                <div className="info">
                  <div className="name">
                    {m.title} <StatusBadge status={m.status} />
                  </div>
                  <div className="meta">
                    {fmtDateTime(m.start_at)} – {fmtDateTime(m.end_at)}
                    {m.owner_name ? ` · ${m.owner_name}` : ''}
                    {m.location ? ` · ${m.location}` : ''}
                    {m.attendees && m.attendees.length ? ` · ${m.attendees.length} attendee${m.attendees.length > 1 ? 's' : ''}` : ''}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {showAdd && (
        <AddMeetingModal users={users}
          onClose={() => setShowAdd(false)}
          onSaved={(id) => { setShowAdd(false); reload(); if (id) navigate(`/meetings/${id}`); }} />
      )}
    </>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="card" style={{ padding: '12px 14px', margin: 0 }}>
      <div style={{ fontSize: 24, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{label}</div>
    </div>
  );
}

export function AddMeetingModal({ users, onClose, onSaved }) {
  const { user, showToast } = useApp();
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState(() => {
    // Default start: next 15 min round (IST wall time for the input); end +30.
    const now = new Date();
    const step = 15 * 60 * 1000;
    const startIso = new Date(Math.ceil(now.getTime() / step) * step).toISOString();
    const endIso = new Date(Date.parse(startIso) + 30 * 60 * 1000).toISOString();
    return {
      title: '', description: '', location: '', meeting_url: '',
      start: utcIsoToDtLocal(startIso), end: utcIsoToDtLocal(endIso),
      owner_id: String(user.id), attendee_ids: [],
      lead_id: '', deal_id: '', project_id: '',
    };
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    api.get('/api/projects').then(setProjects).catch(() => {});
  }, []);

  const toggleAttendee = (id) => setForm((f) => ({
    ...f,
    attendee_ids: f.attendee_ids.includes(id)
      ? f.attendee_ids.filter((x) => x !== id)
      : [...f.attendee_ids, id],
  }));

  const [save, saving] = useSubmit(async () => {
    if (!form.title.trim()) return showToast('Title required', 'error');
    if (!form.start || !form.end) return showToast('Pick start and end times', 'error');
    const start_at = dtLocalToUtcIso(form.start);
    const end_at = dtLocalToUtcIso(form.end);
    if (!(new Date(start_at) < new Date(end_at))) return showToast('Start must be before end', 'error');
    if (form.meeting_url && !/^https?:\/\//i.test(form.meeting_url.trim())) return showToast('Meeting URL must start with http:// or https://', 'error');
    try {
      const r = await api.post('/api/meetings', {
        title: form.title.trim(),
        description: form.description || undefined,
        location: form.location || undefined,
        meeting_url: form.meeting_url.trim() || undefined,
        start_at, end_at,
        owner_id: Number(form.owner_id),
        attendee_ids: form.attendee_ids,
        lead_id: form.lead_id ? Number(form.lead_id) : undefined,
        project_id: form.project_id ? Number(form.project_id) : undefined,
      });
      showToast('Meeting scheduled ✓');
      onSaved(r.id);
    } catch (err) {
      showToast(err.message, 'error');
    }
    return undefined;
  });

  const userOptions = users.length ? users : [{ id: user.id, full_name: user.full_name }];

  return (
    <Modal title="New meeting" onClose={onClose}>
      <Field label="Title">
        <input value={form.title} onChange={set('title')} autoFocus placeholder="e.g. Sprint planning" />
      </Field>
      <Field label="Description (optional)">
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </Field>
      <div className="form-grid">
        <Field label="Start (IST)">
          <input type="datetime-local" value={form.start} onChange={set('start')} />
        </Field>
        <Field label="End (IST)">
          <input type="datetime-local" value={form.end} onChange={set('end')} />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Location (optional)">
          <input value={form.location} onChange={set('location')} placeholder="Room / address" />
        </Field>
        <Field label="Meeting URL (optional)">
          <input type="url" inputMode="url" value={form.meeting_url} onChange={set('meeting_url')} placeholder="https://…" />
        </Field>
      </div>
      <Field label="Owner">
        <select value={form.owner_id} onChange={set('owner_id')}>
          {userOptions.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
      </Field>
      <div className="field">
        <label>Attendees</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="group" aria-label="Attendees">
          {userOptions.map((u) => {
            const on = form.attendee_ids.includes(u.id);
            return (
              <button key={u.id} type="button" onClick={() => toggleAttendee(u.id)} aria-pressed={on}
                style={{
                  fontSize: 12, padding: '6px 10px', borderRadius: 999, cursor: 'pointer', minHeight: 32,
                  border: `1px solid ${on ? 'var(--brand)' : 'var(--line)'}`,
                  background: on ? 'var(--brand-soft)' : 'var(--surface)',
                  color: on ? 'var(--brand-dark)' : 'var(--ink)', fontFamily: 'inherit',
                }}>{u.full_name}</button>
            );
          })}
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="meeting-lead">Link lead (optional)</label>
          <LeadPicker id="meeting-lead" value={form.lead_id} noneLabel="None"
            onChange={(id) => setForm((f) => ({ ...f, lead_id: id }))} />
        </div>
        <Field label="Link project (optional)">
          <select value={form.project_id} onChange={set('project_id')}>
            <option value="">None</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving} onClick={save}>{saving ? 'Scheduling…' : 'Schedule meeting'}</button>
      </div>
    </Modal>
  );
}
