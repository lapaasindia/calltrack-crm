import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, rupees, fmtDateTime, fmtDate, telLink, isOverdue, todayIstDate } from '../api.js';
import { useApp } from '../App.jsx';
import { LogCallModal, WhatsAppButton, StageBadge, TaskModal } from '../components.jsx';

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
  const { user } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [viewUser, setViewUser] = useState('me');
  const [users, setUsers] = useState([]);
  const [logging, setLogging] = useState(null); // {lead, type}
  const [addingTask, setAddingTask] = useState(false);

  const completeTask = async (task) => {
    try {
      await api.patch(`/api/tasks/${task.id}`, { status: 'done' });
      load();
    } catch { /* toast handled globally */ }
  };

  const load = useCallback(() => {
    const q = user.role === 'admin' && viewUser !== 'me' ? `?user_id=${viewUser}` : '';
    api.get(`/api/today${q}`)
      .then((d) => { setData(d); setError(null); })
      .catch((err) => setError(err.message));
  }, [user.role, viewUser]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);
  useEffect(() => {
    if (user.role === 'admin') {
      api.get('/api/users').then((u) => setUsers(u.filter((x) => x.is_active))).catch(() => {});
    }
  }, [user.role]);

  if (!data) {
    if (error) {
      return (
        <div className="card empty">
          <div className="big">📡</div>
          Could not load your queue: {error}
          <div style={{ marginTop: 10 }}><button className="btn small" onClick={load}>Try again</button></div>
        </div>
      );
    }
    return null;
  }
  const { stats } = data;
  const today = todayIstDate();

  return (
    <>
      <div className="page-title">
        <h1>Today</h1>
        {user.role === 'admin' && (
          <select value={viewUser} onChange={(e) => setViewUser(e.target.value)}
            style={{ padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 9 }}>
            <option value="me">My queue</option>
            <option value="all">Whole team</option>
            {users.filter((u) => u.role === 'caller').map((u) => (
              <option key={u.id} value={u.id}>{u.full_name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="stat-grid">
        <TargetBar label="Calls" done={stats.calls} target={stats.target?.calls_target} />
        <TargetBar label="Connects" done={stats.connects} target={stats.target?.connects_target} />
        <TargetBar label="Deals" done={stats.deals} target={stats.target?.deals_target} />
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
          <div className="card empty"><div className="big">🎉</div>No follow-ups pending. Queue is clear!</div>
        )}
        {data.followups.map((f) => {
          const overdue = isOverdue(f.due_at);
          return (
            <div key={f.follow_up_id} className="lead-row" style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/leads/${f.lead_id}`)}>
              <div className="info">
                <div className="name">{f.name} <StageBadge stage={f.stage} /></div>
                <div className="meta">
                  <span className={`badge ${overdue ? 'overdue' : 'due'}`}>
                    {overdue ? `Overdue — ${fmtDateTime(f.due_at)}` : fmtDateTime(f.due_at)}
                  </span>{' '}
                  {f.reason}{viewUser === 'all' ? ` · ${f.assigned_to_name}` : ''}
                </div>
              </div>
              <div className="actions" onClick={(e) => e.stopPropagation()}>
                <a className="act-btn call" href={telLink(f.phone)} title="Call">📞</a>
                <WhatsAppButton lead={f} />
                <button className="act-btn log" title="Log call"
                  onClick={() => setLogging({ lead: { id: f.lead_id, name: f.name }, type: 'follow_up' })}>✍️</button>
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
          const remaining = p.amount_paise - p.paid_paise;
          return (
            <div key={p.installment_id} className="lead-row" style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/leads/${p.lead_id}`)}>
              <div className="info">
                <div className="name">{p.name}</div>
                <div className="meta">
                  <span className={`badge ${overdue ? 'overdue' : 'due'}`}>
                    {overdue ? `Overdue since ${fmtDate(p.due_date)}` : `Due ${fmtDate(p.due_date)}`}
                  </span>{' '}
                  <b>{rupees(remaining)}</b> · EMI {p.seq} · {p.product_name}
                </div>
              </div>
              <div className="actions" onClick={(e) => e.stopPropagation()}>
                <a className="act-btn call" href={telLink(p.phone)} title="Call">📞</a>
                <WhatsAppButton lead={p} context={{
                  product: p.product_name, amount_due_paise: remaining, due_date: p.due_date,
                }} />
                <button className="act-btn log" title="Log call"
                  onClick={() => setLogging({ lead: { id: p.lead_id, name: p.name }, type: 'collection' })}>✍️</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="section-label">
        ✅ Tasks {data.tasks?.length > 0 && `(${data.tasks.length})`}
        <button className="btn small secondary" style={{ marginLeft: 10 }}
          onClick={() => setAddingTask(true)}>+ Add</button>
      </div>
      <div className="row-list">
        {(!data.tasks || data.tasks.length === 0) && (
          <div className="card empty">No tasks due. Add one with the + button.</div>
        )}
        {data.tasks?.map((t) => (
          <div key={t.id} className="lead-row">
            <input type="checkbox" style={{ width: 19, height: 19 }} title="Mark done"
              onChange={() => completeTask(t)} />
            <div className="info">
              <div className="name">
                {t.title}
                {t.due_date < data.date && <span className="badge overdue" style={{ marginLeft: 6 }}>overdue</span>}
                {t.source === 'ai' && <span className="badge new" style={{ marginLeft: 6 }}>AI</span>}
              </div>
              <div className="meta">
                {t.lead_id && <Link to={`/leads/${t.lead_id}`} onClick={(e) => e.stopPropagation()}><b>{t.lead_name}</b></Link>}
                {t.details ? ` · ${t.details}` : ''}{viewUser === 'all' ? ` · ${t.assigned_to_name}` : ''}
              </div>
            </div>
            {t.lead_phone && (
              <div className="actions">
                <a className="act-btn call" href={telLink(t.lead_phone)} title="Call">📞</a>
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18 }}>
        <Link to="/leads?stage=new" className="btn secondary">→ Call fresh leads</Link>
      </div>

      {addingTask && <TaskModal onClose={() => setAddingTask(false)} onSaved={load} />}

      {logging && (
        <LogCallModal lead={logging.lead} defaultType={logging.type}
          onClose={() => setLogging(null)} onSaved={load} />
      )}
    </>
  );
}
