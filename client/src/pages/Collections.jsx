import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rupees, fmtDate, telLink } from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest } from '../hooks.js';
import { canSeeAllLeads } from '../permissions.js';
import { WhatsAppButton, ErrorState, LoadingState, LeadLink } from '../components.jsx';

// GET /api/collections now defaults to deals with an OPEN balance; the "All
// deals" tab asks for settled ones too with ?all=1. Pending/Overdue filter the
// open set client-side.
export default function Collections() {
  const { user } = useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState('pending'); // pending | overdue | all
  const showAll = tab === 'all';
  const { data, error, loading, reload } = useRequest(
    ({ signal }) => api.get(`/api/collections${showAll ? '?all=1' : ''}`, { signal }), [showAll],
  );

  if (!data) {
    if (error) return <ErrorState error={error} onRetry={reload} />;
    return loading ? <LoadingState /> : null;
  }

  const rows = data.deals.filter((d) => {
    if (tab === 'overdue') return d.overdue;
    if (tab === 'pending') return d.pending_paise > 0;
    return true;
  });
  const total = Number.isFinite(data.total) ? data.total : data.deals.length;
  const truncated = Number.isFinite(data.limit) && total > data.deals.length;

  return (
    <>
      <div className="page-title"><h1>Payments & Collections</h1></div>

      {error && <ErrorState error={error} onRetry={reload} compact />}

      <div className="stat-grid">
        <div className="stat"><div className="label">Total deal value</div>
          <div className="value">{rupees(data.summary.total_value_paise)}</div></div>
        <div className="stat"><div className="label">Collected</div>
          <div className="value" style={{ color: 'var(--green-text)' }}>{rupees(data.summary.collected_paise)}</div></div>
        <div className="stat"><div className="label">Pending balance</div>
          <div className="value" style={{ color: data.summary.pending_paise > 0 ? 'var(--red-text)' : undefined }}>
            {rupees(data.summary.pending_paise)}</div></div>
        <div className="stat"><div className="label">Overdue deals</div>
          <div className="value" style={{ color: data.summary.overdue_count ? 'var(--red-text)' : undefined }}>
            {data.summary.overdue_count}</div>
          <div className="sub">
            {data.summary.overdue_paise != null
              ? `${rupees(data.summary.overdue_paise)} owed on past-due EMIs`
              : 'deals with a past-due EMI'}
          </div></div>
      </div>

      <div className="tabs" role="tablist" aria-label="Deals">
        {[['pending', 'Pending'], ['overdue', 'Overdue'], ['all', 'All deals']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k}
            className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div className="row-list">
        {rows.length === 0 && !loading && (
          <div className="card empty"><div className="big" aria-hidden="true">✨</div>Nothing here. All clear!</div>
        )}
        {rows.map((d) => (
          <div key={d.id} className="lead-row clickable"
            onClick={() => navigate(`/leads/${d.lead_id}`)}>
            <div className="info">
              <div className="name">
                <LeadLink id={d.lead_id}>{d.name}</LeadLink>
                {d.overdue && <span className="badge overdue" style={{ marginLeft: 6 }}>
                  Overdue since {fmtDate(d.next_due_date)}</span>}
              </div>
              <div className="meta">
                {d.product_name} · {rupees(d.deal_value_paise)} deal
                {' · '}<b style={{ color: d.pending_paise > 0 ? 'var(--red-text)' : 'var(--green-text)' }}>
                  {d.pending_paise > 0 ? `${rupees(d.pending_paise)} pending` : 'fully paid'}</b>
                {d.overdue && d.overdue_paise > 0 ? ` · ${rupees(d.overdue_paise)} overdue` : ''}
                {d.next_due_date && d.pending_paise > 0 && !d.overdue ? ` · next due ${fmtDate(d.next_due_date)}` : ''}
                {canSeeAllLeads(user.role) && d.assigned_to_name ? ` · 👤 ${d.assigned_to_name}` : ''}
              </div>
            </div>
            <div className="actions" onClick={(e) => e.stopPropagation()}>
              <a className="act-btn call" href={telLink(d.phone)} title="Call" aria-label={`Call ${d.name}`}>📞</a>
              <WhatsAppButton lead={d} context={{
                product: d.product_name,
                amount_due_paise: d.pending_paise > 0 ? d.pending_paise : null,
                due_date: d.next_due_date,
              }} />
            </div>
          </div>
        ))}
      </div>
      {truncated && (
        <div className="inline-note">Showing the first {data.deals.length} of {total} deals.</div>
      )}
    </>
  );
}
