import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, rupees, fmtDate, fmtDateTime } from '../api.js';
import { useApp } from '../App.jsx';
import { isAdmin } from '../permissions.js';

const STATUSES = ['draft', 'sent', 'paid', 'cancelled'];
const STATUS_BADGE = { draft: 'pending', sent: 'follow_up', paid: 'paid', cancelled: 'lost' };

export default function InvoiceDetail() {
  const { id } = useParams();
  const { user, showToast } = useApp();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.get(`/api/invoices/${id}`).then(setInvoice).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const setStatus = async (status) => {
    try {
      await api.patch(`/api/invoices/${id}`, { status });
      showToast('Invoice updated ✓');
      load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const remove = async () => {
    if (!window.confirm(`Delete invoice ${invoice.invoice_number}? This cannot be undone.`)) return;
    try {
      await api.del(`/api/invoices/${id}`);
      showToast('Invoice deleted');
      navigate('/invoices');
    } catch (err) { showToast(err.message, 'error'); }
  };

  if (error) return <div className="card empty"><div className="big">🚫</div>{error}</div>;
  if (!invoice) return null;

  return (
    <>
      <div className="page-title">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <a onClick={() => navigate(-1)} style={{ cursor: 'pointer' }}>←</a>
          {invoice.invoice_number}
          <span className={`badge ${STATUS_BADGE[invoice.status] || 'pending'}`}>{invoice.status}</span>
        </h1>
        <div className="actions">
          <a className="btn" href={`/api/invoices/${invoice.id}/html`} target="_blank" rel="noreferrer">
            🖨️ Open / Print
          </a>
        </div>
      </div>

      <div className="card">
        <div className="meta" style={{ fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.9 }}>
          <b style={{ color: 'var(--ink)' }}>{invoice.bill_to_name || '—'}</b>
          {invoice.lead_id && <> · <Link to={`/leads/${invoice.lead_id}`}>View lead</Link></>}
          <br />
          {invoice.bill_to_phone && <>📱 {invoice.bill_to_phone} </>}
          {invoice.bill_to_email && <> · ✉️ {invoice.bill_to_email}</>}
          {invoice.bill_to_address && <><br />📍 {invoice.bill_to_address}</>}
          <br />
          Issued: <b style={{ color: 'var(--ink)' }}>{fmtDate(invoice.issue_date)}</b>
          {' · '}Due: <b style={{ color: 'var(--ink)' }}>{fmtDate(invoice.due_date)}</b>
          {' · '}Created {fmtDateTime(invoice.created_at)}
          {invoice.notes && <><br />📝 {invoice.notes}</>}
        </div>
      </div>

      <div className="card">
        <h2>Line items</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {(invoice.items || []).map((it) => (
                <tr key={it.id}>
                  <td>{it.description}</td>
                  <td className="num">{it.qty}</td>
                  <td className="num">{rupees(it.unit_price_paise)}</td>
                  <td className="num">{rupees(it.amount_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ maxWidth: 320, marginLeft: 'auto', marginTop: 12 }}>
          <div className="pb-line"><span>Subtotal</span><b>{rupees(invoice.subtotal_paise)}</b></div>
          <div className="pb-line"><span>GST ({invoice.gst_percent}%)</span><b>{rupees(invoice.tax_paise)}</b></div>
          <div style={{ borderTop: '2px solid var(--ink)', margin: '8px 0', paddingTop: 8 }} className="pb-line">
            <span><b>Total Due</b></span><b style={{ fontSize: 18 }}>{rupees(invoice.total_paise)}</b>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Status</h2>
        <div className="seg" style={{ marginBottom: 10 }}>
          {STATUSES.map((s) => (
            <button key={s} type="button" className={invoice.status === s ? 'on' : ''}
              onClick={() => setStatus(s)}>{s}</button>
          ))}
        </div>
        {isAdmin(user.role) && (
          <button className="btn small secondary" onClick={remove}>🗑️ Delete invoice</button>
        )}
      </div>
    </>
  );
}
