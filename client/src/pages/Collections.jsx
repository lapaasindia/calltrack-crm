import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rupees, fmtDate, telLink } from '../api.js';
import { useApp } from '../App.jsx';
import { WhatsAppButton } from '../components.jsx';

export default function Collections() {
  const { user } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('pending'); // pending | overdue | all

  useEffect(() => { api.get('/api/collections').then(setData).catch(() => {}); }, []);
  if (!data) return null;

  const rows = data.deals.filter((d) => {
    if (tab === 'overdue') return d.overdue;
    if (tab === 'pending') return d.pending_paise > 0;
    return true;
  });

  return (
    <>
      <div className="page-title"><h1>Payments & Collections</h1></div>

      <div className="stat-grid">
        <div className="stat"><div className="label">Total deal value</div>
          <div className="value">{rupees(data.summary.total_value_paise)}</div></div>
        <div className="stat"><div className="label">Collected</div>
          <div className="value" style={{ color: 'var(--green)' }}>{rupees(data.summary.collected_paise)}</div></div>
        <div className="stat"><div className="label">Pending</div>
          <div className="value" style={{ color: data.summary.pending_paise > 0 ? 'var(--red)' : undefined }}>
            {rupees(data.summary.pending_paise)}</div></div>
        <div className="stat"><div className="label">Overdue deals</div>
          <div className="value" style={{ color: data.summary.overdue_count ? 'var(--red)' : undefined }}>
            {data.summary.overdue_count}</div></div>
      </div>

      <div className="tabs">
        <button className={tab === 'pending' ? 'on' : ''} onClick={() => setTab('pending')}>Pending</button>
        <button className={tab === 'overdue' ? 'on' : ''} onClick={() => setTab('overdue')}>Overdue</button>
        <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All deals</button>
      </div>

      <div className="row-list">
        {rows.length === 0 && (
          <div className="card empty"><div className="big">✨</div>Nothing here. All clear!</div>
        )}
        {rows.map((d) => (
          <div key={d.id} className="lead-row" style={{ cursor: 'pointer' }}
            onClick={() => navigate(`/leads/${d.lead_id}`)}>
            <div className="info">
              <div className="name">
                {d.name}
                {d.overdue && <span className="badge overdue" style={{ marginLeft: 6 }}>
                  Overdue since {fmtDate(d.next_due_date)}</span>}
              </div>
              <div className="meta">
                {d.product_name} · {rupees(d.deal_value_paise)} deal
                {' · '}<b style={{ color: d.pending_paise > 0 ? 'var(--red)' : 'var(--green)' }}>
                  {d.pending_paise > 0 ? `${rupees(d.pending_paise)} pending` : 'fully paid'}</b>
                {d.next_due_date && d.pending_paise > 0 && !d.overdue ? ` · next due ${fmtDate(d.next_due_date)}` : ''}
                {user.role === 'admin' && d.assigned_to_name ? ` · 👤 ${d.assigned_to_name}` : ''}
              </div>
            </div>
            <div className="actions" onClick={(e) => e.stopPropagation()}>
              <a className="act-btn call" href={telLink(d.phone)} title="Call">📞</a>
              <WhatsAppButton lead={d} context={{
                product: d.product_name,
                amount_due_paise: d.pending_paise > 0 ? d.pending_paise : null,
                due_date: d.next_due_date,
              }} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
