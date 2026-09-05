import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, rupees, fmtDate, fmtDateTime, goBack, printUrl } from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest, useSubmit } from '../hooks.js';
import { isAdmin } from '../permissions.js';
import { ErrorState, LoadingState } from '../components.jsx';

const STATUSES = ['draft', 'sent', 'paid', 'cancelled'];
const STATUS_BADGE = { draft: 'pending', sent: 'follow_up', paid: 'paid', cancelled: 'lost' };

export default function InvoiceDetail() {
  const { id } = useParams();
  const { user, showToast, askConfirm, canWrite } = useApp();
  const navigate = useNavigate();
  const [printing, setPrinting] = useState(false);
  const { data: invoice, error, loading, reload } = useRequest(
    ({ signal }) => api.get(`/api/invoices/${id}`, { signal }), [id],
  );

  const [setStatus, savingStatus] = useSubmit(async (status) => {
    try {
      await api.patch(`/api/invoices/${id}`, { status });
      showToast('Invoice updated ✓');
      reload();
    } catch (err) { showToast(err.message, 'error'); }
  });

  const [remove, removing] = useSubmit(async () => {
    const ok = await askConfirm({
      title: `Delete invoice ${invoice.invoice_number}?`,
      message: 'It is cancelled and hidden from the list; its number stays reserved (GST numbering never rewinds).',
      confirmLabel: 'Delete invoice', danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/invoices/${id}`);
      showToast('Invoice deleted');
      navigate('/invoices', { replace: true });
    } catch (err) { showToast(err.message, 'error'); }
  });

  const print = async () => {
    setPrinting(true);
    try { await printUrl(`/api/invoices/${invoice.id}/html`); }
    catch (err) { showToast(err.message, 'error'); }
    finally { setPrinting(false); }
  };

  const back = () => goBack(navigate, '/invoices');

  if (!invoice) {
    if (error) {
      return (
        <>
          <div className="page-title"><h1><button type="button" className="back-btn" aria-label="Back" onClick={back}>←</button> Invoice</h1></div>
          <ErrorState error={error} onRetry={reload} />
        </>
      );
    }
    return loading ? <LoadingState /> : null;
  }

  return (
    <>
      <div className="page-title">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="back-btn" aria-label="Back" onClick={back}>←</button>
          {invoice.invoice_number}
          <span className={`badge ${STATUS_BADGE[invoice.status] || 'pending'}`}>{invoice.status}</span>
        </h1>
        <div className="actions" style={{ flexWrap: 'wrap' }}>
          <a className="btn secondary" href={`/api/invoices/${invoice.id}/html`} target="_blank" rel="noreferrer">
            Open
          </a>
          <button type="button" className="btn" disabled={printing} onClick={print}>
            🖨️ {printing ? 'Preparing…' : 'Print'}
          </button>
        </div>
      </div>

      {error && <ErrorState error={error} onRetry={reload} compact />}

      <div className="card">
        <div className="meta" style={{ fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.9, overflowWrap: 'anywhere' }}>
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
                  <td style={{ overflowWrap: 'anywhere' }}>{it.description}</td>
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

      {canWrite && (
        <div className="card">
          <h2>Status</h2>
          <div className="seg" role="group" aria-label="Invoice status" style={{ marginBottom: 10 }}>
            {STATUSES.map((s) => (
              <button key={s} type="button" className={invoice.status === s ? 'on' : ''} aria-pressed={invoice.status === s}
                disabled={savingStatus} onClick={() => setStatus(s)}>{s}</button>
            ))}
          </div>
          {isAdmin(user.role) && (
            <button type="button" className="btn small secondary danger-text" disabled={removing} onClick={remove}>🗑️ Delete invoice</button>
          )}
        </div>
      )}
    </>
  );
}
