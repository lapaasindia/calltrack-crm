// Phase 5A — Meeting OS: meetings list with status/owner filters, dashboard
// counts (Today / Upcoming / Running / Completed) and an AddMeetingModal.
// All instants are UTC; the IST day for "Today" is derived via api helpers.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDateTime, todayIstDate, dtLocalToUtcIso, utcIsoToDtLocal } from '../api.js';
import { useApp } from '../App.jsx';
import { isAdmin } from '../permissions.js';
import { Modal } from '../components.jsx';

const STATUSES = ['Scheduled', 'In Progress', 'Completed', 'Cancelled'];

// IST 'YYYY-MM-DD' of a UTC instant.
function istDateOf(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));
}

function StatusBadge({ status }) {
  const map = {
    Scheduled: { bg: 'var(--blue-soft)', fg: 'var(--blue)' },
    'In Progress': { bg: 'var(--green-soft)', fg: 'var(--green)' },
    Completed: { bg: 'var(--brand-soft)', fg: 'var(--brand)' },
    Cancelled: { bg: '#f3f4f6', fg: '#6b7280' },
  };
  const c = map[status] || map.Scheduled;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
      background: c.bg, color: c.fg, whiteSpace: 'nowrap',
    }}>{status}</span>
  );
}

export default function Meetings() {
  const { user, showToast } = useApp();
  const navigate = useNavigate();
  const admin = isAdmin(user.role);
  const [meetings, setMeetings] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [users, setUsers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(() => {
    api.get('/api/meetings')
      .then(setMeetings)
      .catch((e) => showToast(e.message, 'error'));
  }, [showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/users').then(setUsers).catch(() => {});
  }, []);
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const today = todayIstDate();
  const counts = useMemo(() => {
    let todayN = 0; let upcoming = 0; let running = 0; let completed = 0;
    for (const m of meetings) {
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

  const filtered = useMemo(() => meetings.filter((m) => {
    if (statusFilter && m.status !== statusFilter) return false;
    if (ownerFilter && m.owner_id !== Number(ownerFilter)) return false;
    return true;
  }), [meetings, statusFilter, ownerFilter]);

  return (
    <>
      <div className="page-title">
        <h1>Meetings</h1>
        <button className="btn" onClick={() => setShowAdd(true)}>+ New meeting</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
        <StatCard label="Today" value={counts.todayN} color="var(--blue)" />
        <StatCard label="Upcoming" value={counts.upcoming} color="var(--brand)" />
        <StatCard label="Running" value={counts.running} color="var(--green)" />
        <StatCard label="Completed" value={counts.completed} color="var(--ink-soft)" />
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {admin && (
            <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>
              <option value="">All owners</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          )}
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--ink-faint)' }}>
            No meetings. Click "New meeting" to schedule one.
          </div>
        ) : (
          <div className="row-list">
            {filtered.map((m) => (
              <button key={m.id} className="lead-row" style={{ width: '100%', textAlign: 'left' }}
                onClick={() => navigate(`/meetings/${m.id}`)}>
                <div className="info">
                  <div className="name" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {m.title} <StatusBadge status={m.status} />
                  </div>
                  <div className="meta">
                    {fmtDateTime(m.start_at)} – {fmtDateTime(m.end_at)}
                    {m.owner_name ? ` · ${m.owner_name}` : ''}
                    {m.location ? ` · ${m.location}` : ''}
                    {m.attendees?.length ? ` · ${m.attendees.length} attendee${m.attendees.length > 1 ? 's' : ''}` : ''}
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
          onSaved={(id) => { setShowAdd(false); load(); if (id) navigate(`/meetings/${id}`); }} />
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
  const [leads, setLeads] = useState([]);
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
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    api.get('/api/leads?limit=200').then((r) => setLeads(Array.isArray(r) ? r : (r.leads || []))).catch(() => {});
    api.get('/api/projects').then(setProjects).catch(() => {});
  }, []);

  const toggleAttendee = (id) => setForm((f) => ({
    ...f,
    attendee_ids: f.attendee_ids.includes(id)
      ? f.attendee_ids.filter((x) => x !== id)
      : [...f.attendee_ids, id],
  }));

  const save = async () => {
    if (!form.title.trim()) return showToast('Title required', 'error');
    if (!form.start || !form.end) return showToast('Pick start and end times', 'error');
    const start_at = dtLocalToUtcIso(form.start);
    const end_at = dtLocalToUtcIso(form.end);
    if (!(new Date(start_at) < new Date(end_at))) return showToast('Start must be before end', 'error');
    setSaving(true);
    try {
      const r = await api.post('/api/meetings', {
        title: form.title.trim(),
        description: form.description || undefined,
        location: form.location || undefined,
        meeting_url: form.meeting_url || undefined,
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
    } finally { setSaving(false); }
  };

  const userOptions = users.length ? users : [{ id: user.id, full_name: user.full_name }];

  return (
    <Modal title="New meeting" onClose={onClose}>
      <div className="field">
        <label>Title</label>
        <input value={form.title} onChange={set('title')} autoFocus placeholder="e.g. Sprint planning" />
      </div>
      <div className="field">
        <label>Description (optional)</label>
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Start (IST)</label>
          <input type="datetime-local" value={form.start} onChange={set('start')} />
        </div>
        <div className="field">
          <label>End (IST)</label>
          <input type="datetime-local" value={form.end} onChange={set('end')} />
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Location (optional)</label>
          <input value={form.location} onChange={set('location')} placeholder="Room / address" />
        </div>
        <div className="field">
          <label>Meeting URL (optional)</label>
          <input value={form.meeting_url} onChange={set('meeting_url')} placeholder="https://…" />
        </div>
      </div>
      <div className="field">
        <label>Owner</label>
        <select value={form.owner_id} onChange={set('owner_id')}>
          {userOptions.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Attendees</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {userOptions.map((u) => (
            <button key={u.id} type="button" onClick={() => toggleAttendee(u.id)}
              style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${form.attendee_ids.includes(u.id) ? 'var(--brand)' : 'var(--line)'}`,
                background: form.attendee_ids.includes(u.id) ? 'var(--brand-soft)' : 'var(--surface)',
                color: form.attendee_ids.includes(u.id) ? 'var(--brand)' : 'var(--ink)',
              }}>{u.full_name}</button>
          ))}
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Link lead (optional)</label>
          <select value={form.lead_id} onChange={set('lead_id')}>
            <option value="">None</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Link project (optional)</label>
          <select value={form.project_id} onChange={set('project_id')}>
            <option value="">None</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={saving} onClick={save}>Schedule meeting</button>
      </div>
    </Modal>
  );
}
