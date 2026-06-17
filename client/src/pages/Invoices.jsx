import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rupees, fmtDate } from '../api.js';
import { useApp } from '../App.jsx';

const STATUS_FILTERS = [
  ['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['paid', 'Paid'], ['cancelled', 'Cancelled'],
];
const STATUS_BADGE = {
  draft: 'pending', sent: 'follow_up', paid: 'paid', cancelled: 'lost',
};

export default function Invoices() {
  const { showToast } = useApp();
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState(null);
  const [status, setStatus] = useState('');

  const load = () => {
    const q = status ? `?status=${status}` : '';
    api.get(`/api/invoices${q}`).then(setInvoices).catch((e) => showToast(e.message, 'error'));
  };
  useEffect(load, [status]);

  return (
    <>
      <div className="page-title">
        <h1>Invoices</h1>
      </div>

      <div className="card">
        <div className="seg" style={{ marginBottom: 12 }}>
          {STATUS_FILTERS.map(([val, label]) => (
            <button key={val} type="button" className={status === val ? 'on' : ''}
              onClick={() => setStatus(val)}>{label}</button>
          ))}
        </div>

        {!invoices && <div className="empty">Loading…</div>}
        {invoices && invoices.length === 0 && (
          <div className="empty">
            No invoices yet. Generate one from a won lead, or from the Price builder.
          </div>
        )}
        {invoices && invoices.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th><th>Bill to</th><th className="num">Total</th>
                  <th>Status</th><th>Issued</th><th></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/invoices/${inv.id}`)}>
                    <td><b>{inv.invoice_number}</b></td>
                    <td>{inv.bill_to_name || inv.lead_name || '—'}</td>
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
