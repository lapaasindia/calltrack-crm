import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api, telLink, fmtDateTime } from '../api.js';
import { useApp } from '../App.jsx';
import { Modal, StageBadge, STAGE_LABELS, WhatsAppButton } from '../components.jsx';

function AddLeadModal({ onClose, onAdded }) {
  const { user, showToast } = useApp();
  const [form, setForm] = useState({ name: '', phone: '', city: '', email: '', source: 'manual', notes: '' });
  const [phoneCheck, setPhoneCheck] = useState(null);
  const [users, setUsers] = useState([]);
  const [assignedTo, setAssignedTo] = useState('');
  const [saving, setSaving] = useState(false);
  const checkTimer = useRef();

  useEffect(() => {
    if (user.role === 'admin') {
      api.get('/api/users').then((u) => setUsers(u.filter((x) => x.is_active))).catch(() => {});
      setAssignedTo(String(user.id));
    }
  }, [user]);

  const set = (k) => (e) => {
    const v = e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
    if (k === 'phone') {
      clearTimeout(checkTimer.current);
      setPhoneCheck(null);
      if (v.replace(/\D/g, '').length >= 10) {
        checkTimer.current = setTimeout(async () => {
          try { setPhoneCheck(await api.get(`/api/leads/check-phone?phone=${encodeURIComponent(v)}`)); }
          catch { /* non-blocking */ }
        }, 350);
      }
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = { ...form };
      if (user.role === 'admin') body.assigned_to = assignedTo || null;
      const res = await api.post('/api/leads', body);
      showToast('Lead added ✓');
      onAdded(res.id);
    } catch (err) {
      showToast(err.message, 'error');
      setSaving(false);
    }
  };

  const dup = phoneCheck?.duplicate;
  return (
    <Modal title="Add lead" onClose={onClose}>
      <div className="form-grid">
        <div className="field">
          <label>Name *</label>
          <input value={form.name} onChange={set('name')} autoFocus />
        </div>
        <div className="field">
          <label>Phone *</label>
          <input inputMode="tel" value={form.phone} onChange={set('phone')} placeholder="98765 43210" />
          {phoneCheck && !phoneCheck.valid && <div className="err">Not a valid Indian mobile number</div>}
          {dup && dup.mine && (
            <div className="err">
              Already exists: <Link to={`/leads/${dup.id}`}>{dup.name}</Link> ({STAGE_LABELS[dup.stage]})
            </div>
          )}
          {dup && !dup.mine && (
            <div className="err">A lead with this number already exists (another team member's — ask admin)</div>
          )}
        </div>
        <div className="field">
          <label>City</label>
          <input value={form.city} onChange={set('city')} />
        </div>
        <div className="field">
          <label>Email</label>
          <input type="email" value={form.email} onChange={set('email')} />
        </div>
        <div className="field">
          <label>Source</label>
          <input value={form.source} onChange={set('source')} placeholder="manual / referral / walk-in" />
        </div>
        {user.role === 'admin' && (
          <div className="field">
            <label>Assign to</label>
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="field">
        <label>Notes</label>
        <textarea rows={2} value={form.notes} onChange={set('notes')} />
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={saving || !form.name || !form.phone || dup} onClick={save}>
          {saving ? 'Saving…' : 'Add lead'}
        </button>
      </div>
    </Modal>
  );
}

export default function Leads() {
  const { user, showToast } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [sources, setSources] = useState([]);
  const [users, setUsers] = useState([]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [bulkTo, setBulkTo] = useState('');
  const searchTimer = useRef();
  const [searchText, setSearchText] = useState(params.get('q') || '');

  const stage = params.get('stage') || '';
  const source = params.get('source') || '';
  const assignedTo = params.get('assigned_to') || '';
  const page = Number(params.get('page')) || 1;

  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const q = new URLSearchParams();
    if (stage) q.set('stage', stage);
    if (source) q.set('source', source);
    if (assignedTo) q.set('assigned_to', assignedTo);
    if (params.get('q')) q.set('q', params.get('q'));
    if (page > 1) q.set('page', page);
    api.get(`/api/leads?${q}`).then(setData).catch(() => {});
  }, [stage, source, assignedTo, page, params]);

  useEffect(() => {
    api.get('/api/leads/sources').then(setSources).catch(() => {});
    if (user.role === 'admin') {
      api.get('/api/users').then((u) => setUsers(u.filter((x) => x.is_active))).catch(() => {});
    }
  }, [user.role]);

  const onSearch = (e) => {
    setSearchText(e.target.value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setParam('q', e.target.value), 350);
  };

  const toggleSelect = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const bulkAssign = async (to, roundRobin) => {
    try {
      await api.post('/api/leads/bulk-assign', {
        lead_ids: [...selected],
        assigned_to: to || undefined,
        round_robin: roundRobin || undefined,
      });
      showToast(`${selected.size} leads assigned ✓`);
      setSelected(new Set());
      setParam('page', '');
    } catch (err) { showToast(err.message, 'error'); }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <>
      <div className="page-title">
        <h1>Leads {data ? <span style={{ color: 'var(--ink-faint)', fontSize: 15 }}>({data.total})</span> : ''}</h1>
        <button className="btn" onClick={() => setAdding(true)}>+ Add lead</button>
      </div>

      <div className="filter-bar">
        <input type="search" placeholder="Search name / phone / city…" value={searchText} onChange={onSearch} />
        <select value={stage} onChange={(e) => setParam('stage', e.target.value)}>
          <option value="">All stages</option>
          {Object.entries(STAGE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={source} onChange={(e) => setParam('source', e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {user.role === 'admin' && (
          <select value={assignedTo} onChange={(e) => setParam('assigned_to', e.target.value)}>
            <option value="">Everyone</option>
            <option value="none">Unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        )}
      </div>

      {user.role === 'admin' && selected.size > 0 && (
        <div className="card" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>{selected.size} selected</b>
          <select value={bulkTo} onChange={(e) => setBulkTo(e.target.value)}
            style={{ padding: 8, border: '1px solid var(--line)', borderRadius: 8 }}>
            <option value="">Pick caller…</option>
            {users.filter((u) => u.role === 'caller').map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
          <button className="btn small" disabled={!bulkTo} onClick={() => bulkAssign(bulkTo)}>Assign</button>
          <button className="btn small secondary" onClick={() => bulkAssign(null, true)}>Distribute equally</button>
          <button className="btn small secondary" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="row-list">
        {data?.leads.length === 0 && (
          <div className="card empty"><div className="big">🔍</div>No leads match. Try changing filters or import some.</div>
        )}
        {data?.leads.map((l) => (
          <div key={l.id} className="lead-row" style={{ cursor: 'pointer' }}
            onClick={() => navigate(`/leads/${l.id}`)}>
            {user.role === 'admin' && (
              <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleSelect(l.id)}
                onClick={(e) => e.stopPropagation()} style={{ width: 17, height: 17 }} />
            )}
            <div className="info">
              <div className="name">{l.name} <StageBadge stage={l.stage} /></div>
              <div className="meta">
                {l.phone} {l.city ? `· ${l.city}` : ''} · {l.source}
                {user.role === 'admin' && (l.assigned_to_name ? ` · 👤 ${l.assigned_to_name}` : ' · unassigned')}
                {l.last_call_at ? ` · last call ${fmtDateTime(l.last_call_at)}` : ' · never called'}
              </div>
            </div>
            <div className="actions" onClick={(e) => e.stopPropagation()}>
              <a className="act-btn call" href={telLink(l.phone)} title="Call">📞</a>
              <WhatsAppButton lead={l} />
            </div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
          <button className="btn small secondary" disabled={page <= 1}
            onClick={() => setParam('page', String(page - 1))}>← Prev</button>
          <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--ink-soft)' }}>
            Page {page} of {totalPages}
          </span>
          <button className="btn small secondary" disabled={page >= totalPages}
            onClick={() => setParam('page', String(page + 1))}>Next →</button>
        </div>
      )}

      {adding && (
        <AddLeadModal onClose={() => setAdding(false)}
          onAdded={(id) => { setAdding(false); navigate(`/leads/${id}`); }} />
      )}
    </>
  );
}
