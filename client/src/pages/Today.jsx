import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, rupees, fmtDateTime, fmtDate, telLink, isOverdue, todayIstDate } from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest } from '../hooks.js';
import { canSeeAllLeads, isAssignable } from '../permissions.js';
import { LogCallModal, WhatsAppButton, StageBadge, TaskModal, ErrorState, LoadingState, LeadLink } from '../components.jsx';

function TargetBar({ label, done, target }) {
  const pct = target ? Math.min(100, Math.round((done / target) * 100)) : 0;
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{done}{target ? <span style={{ fontSize: 14, color: 'var(--ink-faint)' }}> / {target}</span> : null}</div>
      {target > 0 && <div className={`progress ${pct >= 100 ? 'green' : ''}`}><div style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

export default function Today() {
  const { user, showToast, canWrite } = useApp();
  const navigate = useNavigate();
  const teamView = canSeeAllLeads(user.role);
  const [viewUser, setViewUser] = useState('me');
  const [users, setUsers] = useState([]);
  const [logging, setLogging] = useState(null); // {lead, type}
  const [addingTask, setAddingTask] = useState(false);
  const [doneIds, setDoneIds] = useState(() => new Set()); // optimistic "mark done"

  const { data, error, loading, reload } = useRequest(({ signal }) => {
    const q = teamView && viewUser !== 'me' ? `?user_id=${viewUser}` : '';
    return api.get(`/api/today${q}`, { signal });
  }, [teamView, viewUser]);

  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [reload]);
  useEffect(() => {
    if (teamView) {
      api.get('/api/users').then((u) => setUsers(u.filter(isAssignable).filter((x) => x.id !== user.id))).catch(() => {});
    }
  }, [teamView, user.id]);

  // Controlled checkbox with rollback (CLIENT-25): tick immediately, untick if
  // the PATCH fails, and let the reload drop the row when it succeeds.
  const completeTask = async (task) => {
    setDoneIds((s) => new Set(s).add(task.id));
    try {
      await api.patch(`/api/tasks/${task.id}`, { status: 'done' });
      reload();
    } catch (err) {
      setDoneIds((s) => { const n = new Set(s); n.delete(task.id); return n; });
      showToast(err.message, 'error');
    }
  };

  if (!data) {
    if (error) return <ErrorState error={error} onRetry={reload} title="Could not load your queue" />;
    return loading ? <LoadingState /> : null;
  }
  const { stats } = data;
  const today = todayIstDate();

  return (
    <>
      <div className="page-title">
        <h1>Today</h1>
        {teamView && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink-soft)' }}>
            <span className="sr-only">Queue for</span>
            <select value={viewUser} onChange={(e) => setViewUser(e.target.value)} aria-label="Queue for"
              style={{ padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 9, minHeight: 40 }}>
              <option value="me">My queue</option>
              <option value="all">Whole team</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && <ErrorState error={error} onRetry={reload} compact />}

      <div className="stat-grid">
        <TargetBar label="Calls" done={stats.calls} target={stats.target && stats.target.calls_target} />
        <TargetBar label="Connects" done={stats.connects} target={stats.target && stats.target.connects_target} />
        <TargetBar label="Deals" done={stats.deals} target={stats.target && stats.target.deals_target} />
        <div className="stat">
          <div className="label">Leads touched</div>
          <div className="value">{stats.unique_leads}</div>
        </div>
      </div>

      <div className="section-label">
        📞 Follow-ups {data.followups.length > 0 && `(${data.followups.length})`}
      </div>
      <div className="row-list">
        {data.followups.length === 0 && (
          <div className="card empty"><div className="big" aria-hidden="true">🎉</div>No follow-ups pending. Queue is clear!</div>
        )}
        {data.followups.map((f) => {
          const overdue = isOverdue(f.due_at);
          return (
            <div key={f.follow_up_id} className="lead-row clickable"
              onClick={() => navigate(`/leads/${f.lead_id}`)}>
              <div className="info">
                <div className="name"><LeadLink id={f.lead_id}>{f.name}</LeadLink> <StageBadge stage={f.stage} /></div>
                <div className="meta">
                  <span className={`badge ${overdue ? 'overdue' : 'due'}`}>
                    {overdue ? `Overdue — ${fmtDateTime(f.due_at)}` : fmtDateTime(f.due_at)}
                  </span>{' '}
                  {f.reason}{viewUser === 'all' ? ` · ${f.assigned_to_name}` : ''}
                </div>
              </div>
              <div className="actions" onClick={(e) => e.stopPropagation()}>
                <a className="act-btn call" href={telLink(f.phone)} title="Call" aria-label={`Call ${f.name}`}>📞</a>
                <WhatsAppButton lead={f} />
                {canWrite && (
                  <button type="button" className="act-btn log" title="Log call" aria-label={`Log call with ${f.name}`}
                    onClick={() => setLogging({ lead: { id: f.lead_id, name: f.name }, type: 'follow_up' })}>✍️</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="section-label">
        💰 Payments due {data.payments_due.length > 0 && `(${data.payments_due.length})`}
      </div>
      <div className="row-list">
        {data.payments_due.length === 0 && (
          <div className="card empty">No payments due today.</div>
        )}
        {data.payments_due.map((p) => {
          const overdue = p.due_date < today;
          // Server-computed due_paise (linked + FIFO unlinked payments applied);
          // older servers only send amount/paid.
          const remaining = p.due_paise != null ? p.due_paise : p.amount_paise - p.paid_paise;
          return (
            <div key={p.installment_id} className="lead-row clickable"
              onClick={() => navigate(`/leads/${p.lead_id}`)}>
              <div className="info">
                <div className="name"><LeadLink id={p.lead_id}>{p.name}</LeadLink></div>
                <div className="meta">
                  <span className={`badge ${overdue ? 'overdue' : 'due'}`}>
                    {overdue ? `Overdue since ${fmtDate(p.due_date)}` : `Due ${fmtDate(p.due_date)}`}
                  </span>{' '}
                  <b>{rupees(remaining)}</b> · EMI {p.seq} · {p.product_name}
                </div>
              </div>
              <div className="actions" onClick={(e) => e.stopPropagation()}>
                <a className="act-btn call" href={telLink(p.phone)} title="Call" aria-label={`Call ${p.name}`}>📞</a>
                <WhatsAppButton lead={p} context={{
                  product: p.product_name, amount_due_paise: remaining, due_date: p.due_date,
                }} />
                {canWrite && (
                  <button type="button" className="act-btn log" title="Log call" aria-label={`Log call with ${p.name}`}
                    onClick={() => setLogging({ lead: { id: p.lead_id, name: p.name }, type: 'collection' })}>✍️</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="section-label">
        ✅ Tasks {data.tasks && data.tasks.length > 0 && `(${data.tasks.length})`}
        {canWrite && (
          <button type="button" className="btn small secondary" style={{ marginLeft: 10 }}
            onClick={() => setAddingTask(true)}>+ Add</button>
        )}
      </div>
      <div className="row-list">
        {(!data.tasks || data.tasks.length === 0) && (
          <div className="card empty">No tasks due. Add one with the + button.</div>
        )}
        {data.tasks && data.tasks.map((t) => (
          <div key={t.id} className="lead-row">
            <input type="checkbox" className="row-check" aria-label={`Mark "${t.title}" done`}
              checked={doneIds.has(t.id)} disabled={!canWrite || doneIds.has(t.id)}
              onChange={() => completeTask(t)} />
            <div className="info">
              <div className="name">
                {t.title}
                {t.due_date < data.date && <span className="badge overdue" style={{ marginLeft: 6 }}>overdue</span>}
                {t.source === 'ai' && <span className="badge new" style={{ marginLeft: 6 }}>AI</span>}
              </div>
              <div className="meta">
                {t.lead_id && <Link to={`/leads/${t.lead_id}`}><b>{t.lead_name}</b></Link>}
                {t.details ? ` · ${t.details}` : ''}{viewUser === 'all' ? ` · ${t.assigned_to_name}` : ''}
              </div>
            </div>
            {t.lead_phone && (
              <div className="actions">
                <a className="act-btn call" href={telLink(t.lead_phone)} title="Call" aria-label={`Call ${t.lead_name || ''}`}>📞</a>
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18 }}>
        <Link to="/leads?stage=new" className="btn secondary">→ Call fresh leads</Link>
      </div>

      {addingTask && <TaskModal onClose={() => setAddingTask(false)} onSaved={reload} />}

      {logging && (
        <LogCallModal lead={logging.lead} defaultType={logging.type}
          onClose={() => setLogging(null)} onSaved={reload} />
      )}
    </>
  );
}
