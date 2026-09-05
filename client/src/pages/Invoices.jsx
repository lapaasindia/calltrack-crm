import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, rupees, fmtDate } from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest } from '../hooks.js';
import { ErrorState, LoadingState } from '../components.jsx';

const STATUS_FILTERS = [
  ['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['paid', 'Paid'], ['cancelled', 'Cancelled'],
];
const STATUS_BADGE = {
  draft: 'pending', sent: 'follow_up', paid: 'paid', cancelled: 'lost',
};

export default function Invoices() {
  const { admin } = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  // 'deleted' = invoices removed with "Delete invoice" (soft-cancelled, number
  // kept reserved); the server lists them only for admins with ?deleted=1.
  const showDeleted = status === 'deleted';
  const { data: invoices, error, loading, reload } = useRequest(({ signal }) => {
    const q = showDeleted ? '?deleted=1' : (status ? `?status=${status}` : '');
    return api.get(`/api/invoices${q}`, { signal });
  }, [status]);

  return (
    <>
      <div className="page-title">
        <h1>Invoices</h1>
      </div>

      <div className="card">
        <div className="seg" role="group" aria-label="Status filter" style={{ marginBottom: 12 }}>
          {STATUS_FILTERS.map(([val, label]) => (
            <button key={val} type="button" className={status === val ? 'on' : ''} aria-pressed={status === val}
              onClick={() => setStatus(val)}>{label}</button>
          ))}
          {admin && (
            <button type="button" className={showDeleted ? 'on' : ''} aria-pressed={showDeleted}
              onClick={() => setStatus('deleted')}>Deleted</button>
          )}
        </div>

        {error && !invoices && <ErrorState error={error} onRetry={reload} />}
        {error && invoices && <ErrorState error={error} onRetry={reload} compact />}
        {loading && !invoices && <LoadingState compact />}
        {invoices && invoices.length === 0 && (
          <div className="empty">
            {showDeleted ? 'No deleted invoices.' : 'No invoices yet. Generate one from a won lead, or from the Price builder.'}
          </div>
        )}
        {invoices && invoices.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th><th>Bill to</th><th className="num">Total</th>
                  <th>Status</th><th>Issued</th><th><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="clickable"
                    onClick={() => navigate(`/invoices/${inv.id}`)}>
                    <td><Link to={`/invoices/${inv.id}`} onClick={(e) => e.stopPropagation()}><b>{inv.invoice_number}</b></Link></td>
                    <td style={{ overflowWrap: 'anywhere' }}>{inv.bill_to_name || inv.lead_name || '—'}</td>
                    <td className="num">{rupees(inv.total_paise)}</td>
                    <td><span className={`badge ${STATUS_BADGE[inv.status] || 'pending'}`}>{inv.status}</span></td>
                    <td>{fmtDate(inv.issue_date)}</td>
                    <td className="num">
                      <a className="btn small secondary" href={`/api/invoices/${inv.id}/html`}
                        target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
