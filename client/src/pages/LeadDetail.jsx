import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, rupees, fmtDateTime, fmtDate, telLink, todayIstDate, dtLocalToUtcIso } from '../api.js';
import { useApp } from '../App.jsx';
import { Modal, Seg, StageBadge, STAGE_LABELS, LogCallModal, WhatsAppButton } from '../components.jsx';

const DISPOSITION_LABELS = {
  connected: '✅ Connected', not_picked: '📵 Not picked', busy: '⏳ Busy',
  switched_off: '🔌 Switched off', wrong_number: '❌ Wrong number',
};
const OUTCOME_LABELS = {
  interested: 'Interested', not_interested: 'Not interested', callback_requested: 'Callback requested',
  wrong_person: 'Wrong person', payment_promised: 'Payment promised', payment_collected: 'Payment collected',
  dispute: 'Dispute', resolved: 'Resolved', open: 'Still open', escalated: 'Escalated',
};
const TYPE_LABELS = { sales: 'Sales', follow_up: 'Follow-up', collection: 'Payment', support: 'Support' };

function WinDealModal({ lead, onClose, onSaved }) {
  const { showToast } = useApp();
  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState('');
  const [value, setValue] = useState('');
  const [emiCount, setEmiCount] = useState(1);
  const [installments, setInstallments] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/api/products').then((p) => {
      setProducts(p);
      if (p.length) { setProductId(String(p[0].id)); setValue(String(p[0].price_paise / 100)); }
    }).catch(() => {});
  }, []);

  const pickProduct = (id) => {
    setProductId(id);
    const p = products.find((x) => String(x.id) === id);
    if (p) setValue(String(p.price_paise / 100));
  };

  // Rebuild a default schedule whenever EMI count or value changes.
  useEffect(() => {
    const total = Math.round(Number(value) * 100);
    if (!Number.isFinite(total) || total <= 0 || emiCount < 2) { setInstallments([]); return; }
    const per = Math.floor(total / emiCount / 100) * 100;
    const rows = [];
    // Pure UTC calendar math: parsing the IST date without 'Z' would shift it
    // by the browser offset, and setMonth() overflows month-ends (31 Jan + 1
    // month = 3 Mar) — clamp to the target month's last day instead.
    const [y, m, day] = todayIstDate().split('-').map(Number);
    for (let i = 0; i < emiCount; i++) {
      const lastDay = new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate();
      const d = new Date(Date.UTC(y, m - 1 + i, Math.min(day, lastDay)));
      rows.push({
        amount_rupees: (i === emiCount - 1 ? total - per * (emiCount - 1) : per) / 100,
        due_date: d.toISOString().slice(0, 10),
      });
    }
    setInstallments(rows);
  }, [emiCount, value]);

  const setInst = (i, k, v) => {
    setInstallments((rows) => rows.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  };

  const total = Math.round(Number(value) * 100);
  const schedTotal = installments.reduce((s, r) => s + Math.round(Number(r.amount_rupees) * 100), 0);
  const mismatch = emiCount >= 2 && total !== schedTotal;

  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/api/leads/${lead.id}/deals`, {
        product_id: Number(productId),
        deal_value_rupees: Number(value),
        installments: emiCount >= 2 ? installments : [],
      });
      showToast('Deal won! 🎉');
      onSaved();
      onClose();
    } catch (err) {
      showToast(err.message, 'error');
      setSaving(false);
    }
  };

  return (
    <Modal title={`Win deal — ${lead.name}`} onClose={onClose}>
      <div className="field">
        <label>Product / program</label>
        <select value={productId} onChange={(e) => pickProduct(e.target.value)}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name} — {rupees(p.price_paise)}</option>
          ))}
        </select>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Deal value (₹)</label>
          <input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
          <div className="hint">Edit if you gave a discount</div>
        </div>
        <div className="field">
          <label>Payment plan</label>
          <select value={emiCount} onChange={(e) => setEmiCount(Number(e.target.value))}>
            <option value={1}>Full payment</option>
            {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} installments</option>)}
          </select>
        </div>
      </div>
      {emiCount >= 2 && (
        <div className="field">
          <label>EMI schedule</label>
          {installments.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input style={{ flex: 1 }} inputMode="numeric" value={r.amount_rupees}
                onChange={(e) => setInst(i, 'amount_rupees', e.target.value)} />
              <input style={{ flex: 1.4 }} type="date" value={r.due_date}
                onChange={(e) => setInst(i, 'due_date', e.target.value)} />
            </div>
          ))}
          {mismatch && (
            <div className="err">
              Schedule adds to ₹{(schedTotal / 100).toLocaleString('en-IN')}, deal is ₹{(total / 100).toLocaleString('en-IN')}
            </div>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn green" disabled={saving || !productId || !(total > 0) || mismatch} onClick={save}>
          {saving ? 'Saving…' : 'Mark as Won 🏆'}
        </button>
      </div>
    </Modal>
  );
}

function PaymentModal({ deal, onClose, onSaved }) {
  const { showToast } = useApp();
  const pendingInst = deal.installments.filter((i) => ['pending', 'partial'].includes(i.status));
  const [amount, setAmount] = useState(() => {
    if (pendingInst.length) {
      const i = pendingInst[0];
      const paid = deal.payments.filter((p) => p.installment_id === i.id)
        .reduce((s, p) => s + p.amount_paise, 0);
      return String((i.amount_paise - paid) / 100);
    }
    return String(deal.pending_paise / 100);
  });
  const [method, setMethod] = useState('upi');
  const [instId, setInstId] = useState(pendingInst[0]?.id ? String(pendingInst[0].id) : '');
  const [reference, setReference] = useState('');
  const [receivedDate, setReceivedDate] = useState(todayIstDate());
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/api/deals/${deal.id}/payments`, {
        amount_rupees: Number(amount), method,
        installment_id: instId ? Number(instId) : null,
        reference, received_date: receivedDate,
      });
      showToast('Payment recorded ✓');
      onSaved();
      onClose();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Record payment — ${deal.product_name}`} onClose={onClose}>
      <div className="form-grid">
        <div className="field">
          <label>Amount (₹) — pending {rupees(deal.pending_paise)}</label>
          <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="upi">UPI</option><option value="cash">Cash</option>
            <option value="bank_transfer">Bank transfer</option><option value="card">Card</option>
            <option value="cheque">Cheque</option><option value="other">Other</option>
          </select>
        </div>
        {pendingInst.length > 0 && (
          <div className="field">
            <label>Against EMI</label>
            <select value={instId} onChange={(e) => setInstId(e.target.value)}>
              <option value="">No specific EMI</option>
              {pendingInst.map((i) => (
                <option key={i.id} value={i.id}>EMI {i.seq} — {rupees(i.amount_paise)} due {fmtDate(i.due_date)}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>Received on</label>
          <input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Reference (UTR / receipt no.)</label>
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn green" disabled={saving || !(Number(amount) > 0)} onClick={save}>
          {saving ? 'Saving…' : 'Record payment'}
        </button>
      </div>
    </Modal>
  );
}

function FollowUpModal({ lead, onClose, onSaved }) {
  const { showToast } = useApp();
  const [dueAt, setDueAt] = useState('');
  const [reason, setReason] = useState('');
  const save = async () => {
    try {
      await api.put(`/api/leads/${lead.id}/follow-up`, {
        due_at: dtLocalToUtcIso(dueAt), reason: reason || 'Follow-up',
      });
      showToast('Follow-up scheduled ✓');
      onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  };
  return (
    <Modal title="Schedule follow-up" onClose={onClose}>
      <div className="field">
        <label>When</label>
        <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>Reason</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Send payment link" />
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!dueAt} onClick={save}>Schedule</button>
      </div>
    </Modal>
  );
}

export default function LeadDetail() {
  const { id } = useParams();
  const { user, showToast } = useApp();
  const navigate = useNavigate();
  const [lead, setLead] = useState(null);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // 'call' | 'win' | 'followup' | {payment: deal}
  const [users, setUsers] = useState([]);

  const load = useCallback(() => {
    api.get(`/api/leads/${id}`).then(setLead).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (user.role === 'admin') {
      api.get('/api/users').then((u) => setUsers(u.filter((x) => x.is_active))).catch(() => {});
    }
  }, [user.role]);

  if (error) return <div className="card empty"><div className="big">🚫</div>{error}</div>;
  if (!lead) return null;

  const setStage = async (stage) => {
    if (stage === 'won') return setModal('win');
    let lost_reason;
    if (stage === 'lost') {
      lost_reason = window.prompt('Reason for losing this lead?') || 'Not specified';
      if (lost_reason === null) return;
    }
    try {
      await api.patch(`/api/leads/${lead.id}`, { stage, lost_reason });
      load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const reassign = async (to) => {
    try {
      await api.patch(`/api/leads/${lead.id}`, { assigned_to: to ? Number(to) : null });
      showToast('Reassigned ✓'); load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const deletePayment = async (p, deal) => {
    const after = rupees(deal.pending_paise + p.amount_paise);
    if (!window.confirm(
      `Delete this payment of ${rupees(p.amount_paise)}?\n\nPending balance will go back up to ${after}.`
    )) return;
    try { await api.del(`/api/payments/${p.id}`); showToast('Payment deleted'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const timeline = [
    ...lead.calls.map((c) => ({ kind: 'call', at: c.called_at, c })),
    ...lead.events.map((e) => ({ kind: 'event', at: e.changed_at, e })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <>
      <div className="page-title">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <a onClick={() => navigate(-1)} style={{ cursor: 'pointer' }}>←</a>
          {lead.name} <StageBadge stage={lead.stage} />
        </h1>
        <div className="actions">
          <a className="act-btn call" href={telLink(lead.phone)} title="Call">📞</a>
          <WhatsAppButton lead={lead} context={lead.deals[0] ? {
            product: lead.deals[0].product_name,
            amount_due_paise: lead.deals[0].pending_paise > 0 ? lead.deals[0].pending_paise : null,
          } : {}} />
        </div>
      </div>

      <div className="card">
        <div className="meta" style={{ fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.8 }}>
          📱 <b style={{ color: 'var(--ink)' }}>{lead.phone}</b>
          {lead.alt_phone && <> · alt: {lead.alt_phone}</>}
          {lead.city && <> · 📍 {lead.city}</>}
          {lead.email && <> · ✉️ {lead.email}</>}
          <br />
          Source: <b style={{ color: 'var(--ink)' }}>{lead.source}</b>
          {' · '}Assigned: <b style={{ color: 'var(--ink)' }}>{lead.assigned_to_name || 'unassigned'}</b>
          {lead.stage === 'lost' && lead.lost_reason && <> · Lost: {lead.lost_reason}</>}
          {lead.notes && <><br />📝 {lead.notes}</>}
        </div>
        {user.role === 'admin' && (
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={lead.assigned_to || ''} onChange={(e) => reassign(e.target.value)}
              style={{ padding: 7, border: '1px solid var(--line)', borderRadius: 8, fontSize: 13 }}>
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </div>
        )}
      </div>

      {lead.follow_up && (
        <div className="card" style={{ borderLeft: '4px solid var(--brand)' }}>
          <b>⏰ Follow-up:</b> {fmtDateTime(lead.follow_up.due_at)} — {lead.follow_up.reason}
          <button className="btn small secondary" style={{ marginLeft: 10 }}
            onClick={() => setModal('followup')}>Reschedule</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <button className="btn" onClick={() => setModal('call')}>✍️ Log call</button>
        {!['won', 'lost'].includes(lead.stage) && (
          <button className="btn green" onClick={() => setModal('win')}>🏆 Win deal</button>
        )}
        {lead.stage === 'won' && (
          <button className="btn green" onClick={() => setModal('win')}>+ Another deal</button>
        )}
        {!lead.follow_up && (
          <button className="btn secondary" onClick={() => setModal('followup')}>⏰ Schedule follow-up</button>
        )}
        {lead.stage !== 'lost' && lead.stage !== 'won' && (
          <button className="btn secondary" onClick={() => setStage('lost')}>Mark lost</button>
        )}
        {lead.stage === 'lost' && (
          <button className="btn secondary" onClick={() => setStage('interested')}>Reopen lead</button>
        )}
      </div>

      {lead.deals.map((deal) => (
        <div className="card" key={deal.id}>
          <h2>💼 {deal.product_name} — {rupees(deal.deal_value_paise)}
            {' '}<span className={`badge ${deal.status === 'completed' ? 'paid' : deal.status === 'cancelled' ? 'lost' : 'pending'}`}>{deal.status}</span>
          </h2>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
            <div><div className="tl-meta">Collected</div><b style={{ color: 'var(--green)' }}>{rupees(deal.paid_paise)}</b></div>
            <div><div className="tl-meta">Pending</div><b style={{ color: deal.pending_paise > 0 ? 'var(--red)' : 'var(--green)' }}>{rupees(deal.pending_paise)}</b></div>
            <div><div className="tl-meta">Won on</div><b>{fmtDate(deal.won_date)}</b></div>
          </div>
          {deal.installments.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>EMI</th><th className="num">Amount</th><th>Due</th><th>Status</th></tr></thead>
                <tbody>
                  {deal.installments.map((i) => (
                    <tr key={i.id}>
                      <td>#{i.seq}</td>
                      <td className="num">{rupees(i.amount_paise)}</td>
                      <td>{fmtDate(i.due_date)}</td>
                      <td><span className={`badge ${i.due_date < todayIstDate() && ['pending', 'partial'].includes(i.status) ? 'overdue' : i.status}`}>
                        {i.due_date < todayIstDate() && ['pending', 'partial'].includes(i.status) ? 'overdue' : i.status}
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {deal.payments.length > 0 && (
            <>
              <div className="section-label">Payments</div>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {deal.payments.map((p) => (
                      <tr key={p.id}>
                        <td>{fmtDate(p.received_date)}</td>
                        <td className="num"><b>{rupees(p.amount_paise)}</b></td>
                        <td>{p.method}{p.reference ? ` · ${p.reference}` : ''}</td>
                        <td>{p.recorded_by_name}</td>
                        {user.role === 'admin' && (
                          <td><button className="btn small secondary" onClick={() => deletePayment(p, deal)}>✕</button></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {deal.pending_paise > 0 && deal.status !== 'cancelled' && (
            <button className="btn green" style={{ marginTop: 10 }}
              onClick={() => setModal({ payment: deal })}>💰 Record payment</button>
          )}
        </div>
      ))}

      <div className="card">
        <h2>Timeline</h2>
        <div className="timeline">
          {timeline.length === 0 && <div className="empty">No activity yet. Log the first call!</div>}
          {timeline.map((t, i) => t.kind === 'call' ? (
            <div className="tl-item" key={`c${t.c.id}`}>
              <div className="tl-icon">📞</div>
              <div className="tl-body">
                <div className="tl-title">
                  {DISPOSITION_LABELS[t.c.disposition]} · {TYPE_LABELS[t.c.call_type]}
                  {t.c.outcome && <> → <b>{OUTCOME_LABELS[t.c.outcome] || t.c.outcome}</b></>}
                </div>
                <div className="tl-meta">{fmtDateTime(t.c.called_at)} · {t.c.user_name}</div>
                {t.c.notes && <div className="tl-notes">{t.c.notes}</div>}
              </div>
            </div>
          ) : (
            <div className="tl-item" key={`e${t.e.id}`}>
              <div className="tl-icon" style={{ background: 'var(--amber-soft)', color: 'var(--amber)' }}>🔀</div>
              <div className="tl-body">
                <div className="tl-title">
                  {t.e.from_stage ? `${STAGE_LABELS[t.e.from_stage]} → ` : ''}{STAGE_LABELS[t.e.to_stage]}
                </div>
                <div className="tl-meta">{fmtDateTime(t.e.changed_at)} · {t.e.user_name}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {modal === 'call' && (
        <LogCallModal lead={lead}
          defaultType={lead.stage === 'won' ? 'support' : lead.stage === 'follow_up' ? 'follow_up' : 'sales'}
          onClose={() => setModal(null)} onSaved={load} />
      )}
      {modal === 'win' && <WinDealModal lead={lead} onClose={() => setModal(null)} onSaved={load} />}
      {modal === 'followup' && <FollowUpModal lead={lead} onClose={() => setModal(null)} onSaved={load} />}
      {modal?.payment && (
        <PaymentModal deal={modal.payment} onClose={() => setModal(null)} onSaved={load} />
      )}
    </>
  );
}
