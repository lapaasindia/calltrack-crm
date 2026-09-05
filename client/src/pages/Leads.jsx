import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api, telLink, fmtDateTime } from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest, useSubmit } from '../hooks.js';
import { canSeeAllLeads, isAssignable } from '../permissions.js';
import {
  Modal, StageBadge, STAGE_LABELS, WhatsAppButton, ScoreBadge, ErrorState, LoadingState, Field, LeadLink,
} from '../components.jsx';

// Pipeline columns, in flow order. 'won' is terminal and entered only via the
// Win Deal flow (server rejects a direct PATCH to 'won').
const BOARD_STAGES = ['new', 'contacted', 'interested', 'follow_up', 'won', 'lost'];
// Cards per column. The server caps `limit` at 500; older servers ignore it
// (50) — the column footer shows "showing N of total" either way.
const BOARD_LIMIT = 100;

// Explicit "Move to…" menu on every card so touch users (no HTML5 drag on
// phones) and the desktop shell can still move leads between stages (CLIENT-16).
function MoveMenu({ stage, onMove }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="kc-move" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="btn small secondary" aria-haspopup="menu" aria-expanded={open}
        aria-label="Move to another stage" onClick={() => setOpen((o) => !o)}>Move ▾</button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-label">Move to</div>
          {BOARD_STAGES.filter((s) => s !== stage).map((s) => (
            <button key={s} type="button" role="menuitem" className="menu-item"
              onClick={() => { setOpen(false); onMove(s); }}>{STAGE_LABELS[s]}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// One pipeline board. Each column is the user's accessible leads for that
// stage (server scoping is unchanged — callers see only their own). Moving a
// card (drag on desktop, "Move ▾" anywhere) changes the lead's stage after a
// required note; moving into 'won' hands off to the Win Deal flow.
function KanbanBoard({ user, showToast, askPrompt, canWrite }) {
  const navigate = useNavigate();
  const { data: cols, error, loading, reload, setData } = useRequest(async ({ signal }) => {
    const pairs = await Promise.all(BOARD_STAGES.map(async (s) => {
      const d = await api.get(`/api/leads?stage=${s}&limit=${BOARD_LIMIT}`, { signal });
      return [s, { leads: d.leads || [], total: Number.isFinite(d.total) ? d.total : (d.leads || []).length }];
    }));
    return Object.fromEntries(pairs);
  }, []);
  const [dragId, setDragId] = useState(null);
  const [dragFrom, setDragFrom] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const moveLead = async (id, fromStage, toStage) => {
    if (!id || fromStage === toStage) return;
    // 'won' is created through the deal flow, never a bare stage flip.
    if (toStage === 'won') { navigate(`/leads/${id}?win=1`); return; }
    const note = await askPrompt({
      title: `Move to ${STAGE_LABELS[toStage]}`,
      label: toStage === 'lost' ? 'Reason for losing this lead' : 'Note',
      required: true, multiline: true, submitLabel: 'Move', danger: toStage === 'lost',
      hint: 'Added to the lead\'s notes with the stage change.',
    });
    if (note == null) return; // cancelled → nothing moves
    const body = { stage: toStage, note };
    if (toStage === 'lost') body.lost_reason = note;

    // Optimistic move; refetch afterwards to resync counts either way.
    setData((c) => {
      if (!c) return c;
      const moved = c[fromStage].leads.find((l) => l.id === id);
      return {
        ...c,
        [fromStage]: { leads: c[fromStage].leads.filter((l) => l.id !== id), total: Math.max(0, c[fromStage].total - (moved ? 1 : 0)) },
        [toStage]: { leads: moved ? [{ ...moved, stage: toStage }, ...c[toStage].leads] : c[toStage].leads, total: c[toStage].total + (moved ? 1 : 0) },
      };
    });
    try {
      await api.patch(`/api/leads/${id}`, body);
      showToast('Lead moved ✓');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      reload();
    }
  };

  const onDrop = (toStage) => {
    const id = dragId;
    const fromStage = dragFrom;
    setDropTarget(null);
    setDragId(null);
    setDragFrom(null);
    moveLead(id, fromStage, toStage);
  };

  if (!cols) {
    if (error) return <ErrorState error={error} onRetry={reload} title="Couldn't load the board" />;
    return loading ? <LoadingState label="Loading board…" /> : null;
  }

  return (
    <>
      {error && <ErrorState error={error} onRetry={reload} compact />}
      <div className="kanban">
        {BOARD_STAGES.map((stage) => {
          const col = cols[stage];
          return (
            <div
              key={stage}
              className={`kanban-col ${dropTarget === stage ? 'drop-on' : ''}`}
              onDragOver={(e) => { if (!canWrite) return; e.preventDefault(); if (dropTarget !== stage) setDropTarget(stage); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTarget(null); }}
              onDrop={() => canWrite && onDrop(stage)}
            >
              <div className="kanban-col-head">
                <span><StageBadge stage={stage} /></span>
                <span className="count" aria-label={`${col.total} leads`}>{col.total}</span>
              </div>
              <div className="kanban-cards">
                {col.leads.length === 0 && <div className="kanban-empty">{canWrite ? 'Drop leads here' : 'No leads'}</div>}
                {col.leads.map((l) => (
                  <div
                    key={l.id}
                    className={`kanban-card ${dragId === l.id ? 'dragging' : ''}`}
                    draggable={canWrite}
                    onDragStart={() => { setDragId(l.id); setDragFrom(stage); }}
                    onDragEnd={() => { setDragId(null); setDragFrom(null); setDropTarget(null); }}
                    onClick={() => navigate(`/leads/${l.id}`)}
                    title="Open the lead"
                  >
                    <div className="kc-top">
                      <div className="kc-name">
                        <LeadLink id={l.id}>{l.name}</LeadLink>
                        {l.score != null && <ScoreBadge score={l.score} />}
                      </div>
                      {canWrite && <MoveMenu stage={stage} onMove={(to) => moveLead(l.id, stage, to)} />}
                    </div>
                    <div className="kc-meta">
                      {l.phone}{l.company ? ` · ${l.company}` : ''}{l.city ? ` · ${l.city}` : ''}
                      {canSeeAllLeads(user.role) && l.assigned_to_name ? ` · 👤 ${l.assigned_to_name}` : ''}
                    </div>
                  </div>
                ))}
              </div>
              {col.total > col.leads.length && (
                <div className="kanban-col-foot">showing {col.leads.length} of {col.total}</div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function AddLeadModal({ onClose, onAdded }) {
  const { user, showToast } = useApp();
  const teamView = canSeeAllLeads(user.role);
  const [form, setForm] = useState({ name: '', phone: '', city: '', email: '', source: 'manual', notes: '' });
  const [phoneCheck, setPhoneCheck] = useState(null);
  const [users, setUsers] = useState([]);
  const [assignedTo, setAssignedTo] = useState('');
  const [existing, setExisting] = useState(null); // from a 409 on save
  const checkTimer = useRef();

  useEffect(() => {
    if (teamView) {
      api.get('/api/users').then((u) => setUsers(u.filter(isAssignable))).catch(() => {});
      setAssignedTo(String(user.id));
    }
    return () => clearTimeout(checkTimer.current);
  }, [teamView, user.id]);

  const set = (k) => (e) => {
    const v = e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
    if (k === 'phone') {
      clearTimeout(checkTimer.current);
      setPhoneCheck(null);
      setExisting(null);
      if (v.replace(/\D/g, '').length >= 10) {
        checkTimer.current = setTimeout(async () => {
          try { setPhoneCheck(await api.get(`/api/leads/check-phone?phone=${encodeURIComponent(v)}`)); }
          catch { /* non-blocking */ }
        }, 350);
      }
    }
  };

  const [save, saving] = useSubmit(async () => {
    try {
      const body = { ...form, name: form.name.trim() };
      if (teamView) body.assigned_to = assignedTo || null;
      const res = await api.post('/api/leads', body);
      showToast('Lead added ✓');
      onAdded(res.id);
    } catch (err) {
      if (err.status === 409 && err.data && err.data.existing) setExisting(err.data.existing);
      showToast(err.message, 'error');
    }
  });

  const dup = phoneCheck && phoneCheck.duplicate;
  const invalidPhone = !!(phoneCheck && phoneCheck.valid === false);
  return (
    <Modal title="Add lead" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="form-grid">
          <Field label="Name *">
            <input value={form.name} onChange={set('name')} autoFocus autoComplete="off" />
          </Field>
          <Field label="Phone *"
            error={invalidPhone ? 'Not a valid Indian mobile number' : undefined}>
            <input inputMode="tel" value={form.phone} onChange={set('phone')} placeholder="98765 43210" autoComplete="off" />
          </Field>
          {dup && dup.mine && (
            <div className="field err" style={{ gridColumn: '1 / -1' }}>
              Already exists: <Link to={`/leads/${dup.id}`}>{dup.name}</Link> ({STAGE_LABELS[dup.stage]})
            </div>
          )}
          {dup && !dup.mine && (
            <div className="field err" style={{ gridColumn: '1 / -1' }}>A lead with this number already exists (another team member's — ask admin)</div>
          )}
          {existing && (
            <div className="field err" style={{ gridColumn: '1 / -1' }}>
              Already exists: <Link to={`/leads/${existing.id}`}>{existing.name}</Link>
            </div>
          )}
          <Field label="City">
            <input value={form.city} onChange={set('city')} />
          </Field>
          <Field label="Email">
            <input type="email" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Source">
            <input value={form.source} onChange={set('source')} placeholder="manual / referral / walk-in" />
          </Field>
          {teamView && (
            <Field label="Assign to">
              <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                <option value="">Unassigned (auto-route)</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <Field label="Notes">
          <textarea rows={2} value={form.notes} onChange={set('notes')} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn"
            disabled={saving || !form.name.trim() || !form.phone.trim() || !!dup || invalidPhone}>
            {saving ? 'Saving…' : 'Add lead'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Leads() {
  const { user, showToast, askPrompt, canWrite } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [sources, setSources] = useState([]);
  const [users, setUsers] = useState([]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkTo, setBulkTo] = useState('');
  const searchTimer = useRef();
  const [searchText, setSearchText] = useState(params.get('q') || '');
  const teamView = canSeeAllLeads(user.role);

  const stage = params.get('stage') || '';
  const source = params.get('source') || '';
  const assignedTo = params.get('assigned_to') || '';
  const q = params.get('q') || '';
  const page = Number(params.get('page')) || 1;
  const view = params.get('view') === 'board' ? 'board' : 'list';

  // Functional update so a change fired from a debounced timer never
  // overwrites a newer URL (QA-6 / CLIENT-25).
  const setParam = (k, v) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v) next.set(k, v); else next.delete(k);
      if (k !== 'page') next.delete('page');
      return next;
    }, { replace: true });
  };

  const { data, error, loading, reload } = useRequest(({ signal }) => {
    const qs = new URLSearchParams();
    if (stage) qs.set('stage', stage);
    if (source) qs.set('source', source);
    if (assignedTo) qs.set('assigned_to', assignedTo);
    if (q) qs.set('q', q);
    if (page > 1) qs.set('page', page);
    return api.get(`/api/leads?${qs}`, { signal });
  }, [stage, source, assignedTo, q, page], { enabled: view === 'list' });

  useEffect(() => {
    api.get('/api/leads/sources').then(setSources).catch(() => {});
    if (teamView) api.get('/api/users').then((u) => setUsers(u.filter(isAssignable))).catch(() => {});
    return () => clearTimeout(searchTimer.current);
  }, [teamView]);

  const onSearch = (e) => {
    const v = e.target.value;
    setSearchText(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setParam('q', v.trim()), 350);
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const [bulkAssign, assigning] = useSubmit(async (to, roundRobin) => {
    try {
      await api.post('/api/leads/bulk-assign', {
        lead_ids: [...selected],
        assigned_to: to || undefined,
        round_robin: roundRobin || undefined,
      });
      showToast(`${selected.size} leads assigned ✓`);
      setSelected(new Set());
      reload();
    } catch (err) { showToast(err.message, 'error'); }
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <>
      <div className="page-title">
        <h1>Leads {view === 'list' && data ? <span style={{ color: 'var(--ink-faint)', fontSize: 15 }}>({data.total})</span> : ''}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="view-toggle" role="group" aria-label="View">
            <button type="button" className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => setParam('view', '')}>☰ List</button>
            <button type="button" className={view === 'board' ? 'on' : ''} aria-pressed={view === 'board'} onClick={() => setParam('view', 'board')}>📋 Board</button>
          </div>
          {canWrite && <button type="button" className="btn" onClick={() => setAdding(true)}>+ Add lead</button>}
        </div>
      </div>

      {view === 'board' && <KanbanBoard user={user} showToast={showToast} askPrompt={askPrompt} canWrite={canWrite} />}

      {view === 'list' && (
      <>
      <div className="filter-bar">
        <input type="search" placeholder="Search name / phone / city…" aria-label="Search leads" value={searchText} onChange={onSearch} />
        <select value={stage} aria-label="Stage" onChange={(e) => setParam('stage', e.target.value)}>
          <option value="">All stages</option>
          {Object.entries(STAGE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={source} aria-label="Source" onChange={(e) => setParam('source', e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {teamView && (
          <select value={assignedTo} aria-label="Assigned to" onChange={(e) => setParam('assigned_to', e.target.value)}>
            <option value="">Everyone</option>
            <option value="none">Unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        )}
      </div>

      {teamView && canWrite && selected.size > 0 && (
        <div className="card" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>{selected.size} selected</b>
          <select value={bulkTo} aria-label="Assign selected leads to" onChange={(e) => setBulkTo(e.target.value)}
            style={{ padding: 8, border: '1px solid var(--line)', borderRadius: 8 }}>
            <option value="">Pick team member…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
          <button type="button" className="btn small" disabled={!bulkTo || assigning} onClick={() => bulkAssign(bulkTo)}>Assign</button>
          <button type="button" className="btn small secondary" disabled={assigning} onClick={() => bulkAssign(null, true)}>Distribute equally</button>
          <button type="button" className="btn small secondary" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {error && !data && <ErrorState error={error} onRetry={reload} />}
      {error && data && <ErrorState error={error} onRetry={reload} compact />}
      {loading && !data && <LoadingState />}

      <div className="row-list">
        {data && data.leads.length === 0 && (
          <div className="card empty"><div className="big" aria-hidden="true">🔍</div>No leads match. Try changing filters or import some.</div>
        )}
        {data && data.leads.map((l) => (
          <div key={l.id} className="lead-row clickable" onClick={() => navigate(`/leads/${l.id}`)}>
            {teamView && canWrite && (
              <input type="checkbox" className="row-check" aria-label={`Select ${l.name}`}
                checked={selected.has(l.id)} onChange={() => toggleSelect(l.id)}
                onClick={(e) => e.stopPropagation()} />
            )}
            <div className="info">
              <div className="name"><LeadLink id={l.id}>{l.name}</LeadLink> <StageBadge stage={l.stage} /></div>
              <div className="meta">
                {l.phone} {l.city ? `· ${l.city}` : ''} · {l.source}
                {teamView && (l.assigned_to_name ? ` · 👤 ${l.assigned_to_name}` : ' · unassigned')}
                {l.last_call_at ? ` · last call ${fmtDateTime(l.last_call_at)}` : ' · never called'}
              </div>
            </div>
            <div className="actions" onClick={(e) => e.stopPropagation()}>
              <a className="act-btn call" href={telLink(l.phone)} title="Call" aria-label={`Call ${l.name}`}>📞</a>
              <WhatsAppButton lead={l} />
            </div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14, alignItems: 'center' }}>
          <button type="button" className="btn small secondary" disabled={page <= 1}
            onClick={() => setParam('page', String(page - 1))}>← Prev</button>
          <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
            Page {page} of {totalPages}
          </span>
          <button type="button" className="btn small secondary" disabled={page >= totalPages}
            onClick={() => setParam('page', String(page + 1))}>Next →</button>
        </div>
      )}
      </>
      )}

      {adding && (
        <AddLeadModal onClose={() => setAdding(false)}
          onAdded={(id) => { setAdding(false); navigate(`/leads/${id}`); }} />
      )}
    </>
  );
}
