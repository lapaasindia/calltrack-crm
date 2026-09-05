import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  api, rupees, fmtDateTime, fmtDate, telLink, todayIstDate, dtLocalToUtcIso, utcIsoToDtLocal, goBack,
} from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest, useSubmit } from '../hooks.js';
import { isAdmin, isAssignable } from '../permissions.js';
import {
  Modal, Seg, StageBadge, STAGE_LABELS, LogCallModal, WhatsAppButton, TaskModal,
  ScoreBadge, AiIntelPanel, TranscriptToggle, ErrorState, LoadingState, Field,
} from '../components.jsx';

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
// Stages a lead can be moved to directly from its page (won → deal flow,
// lost → reason prompt).
const OPEN_STAGES = [['new', 'New'], ['contacted', 'Contacted'], ['interested', 'Interested'], ['follow_up', 'Follow-up']];

// Stable ids for editable/removable rows (CLIENT-28).
let rowSeq = 0;
const rowId = () => `r${++rowSeq}`;

function WinDealModal({ lead, onClose, onSaved }) {
  const { showToast } = useApp();
  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState('');
  const [value, setValue] = useState('');
  const [emiCount, setEmiCount] = useState(1);
  const [installments, setInstallments] = useState([]);

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
        id: rowId(),
        amount_rupees: (i === emiCount - 1 ? total - per * (emiCount - 1) : per) / 100,
        due_date: d.toISOString().slice(0, 10),
      });
    }
    setInstallments(rows);
  }, [emiCount, value]);

  const setInst = (id, k, v) => {
    setInstallments((rows) => rows.map((r) => (r.id === id ? { ...r, [k]: v } : r)));
  };

  const total = Math.round(Number(value) * 100);
  const schedTotal = installments.reduce((s, r) => s + Math.round(Number(r.amount_rupees) * 100), 0);
  const mismatch = emiCount >= 2 && total !== schedTotal;

  const [save, saving] = useSubmit(async () => {
    try {
      await api.post(`/api/leads/${lead.id}/deals`, {
        product_id: Number(productId),
        deal_value_rupees: Number(value),
        installments: emiCount >= 2 ? installments.map(({ amount_rupees, due_date }) => ({ amount_rupees, due_date })) : [],
      });
      showToast('Deal won! 🎉');
      onSaved();
      onClose();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  return (
    <Modal title={`Win deal — ${lead.name}`} onClose={onClose}>
      {products.length === 0 ? (
        <div className="field">
          <div className="err">
            No active products yet. Add one in <b>Settings → Products</b> before winning a deal.
          </div>
        </div>
      ) : (
        <Field label="Product / program">
          <select value={productId} onChange={(e) => pickProduct(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name} — {rupees(p.price_paise)}</option>
            ))}
          </select>
        </Field>
      )}
      <div className="form-grid">
        <Field label="Deal value (₹)" hint="Edit if you gave a discount">
          <input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Payment plan">
          <select value={emiCount} onChange={(e) => setEmiCount(Number(e.target.value))}>
            <option value={1}>Full payment</option>
            {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} installments</option>)}
          </select>
        </Field>
      </div>
      {emiCount >= 2 && (
        <div className="field">
          <label>EMI schedule</label>
          {installments.map((r, i) => (
            <div key={r.id} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input style={{ flex: 1 }} inputMode="numeric" aria-label={`EMI ${i + 1} amount`} value={r.amount_rupees}
                onChange={(e) => setInst(r.id, 'amount_rupees', e.target.value)} />
              <input style={{ flex: 1.4 }} type="date" aria-label={`EMI ${i + 1} due date`} value={r.due_date}
                onChange={(e) => setInst(r.id, 'due_date', e.target.value)} />
            </div>
          ))}
          {mismatch && (
            <div className="err">
              Schedule adds to {rupees(schedTotal)}, deal is {rupees(total)}
            </div>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn green" disabled={saving || !productId || !(total > 0) || mismatch} onClick={save}>
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
  const [instId, setInstId] = useState(pendingInst[0] && pendingInst[0].id ? String(pendingInst[0].id) : '');
  const [reference, setReference] = useState('');
  const [receivedDate, setReceivedDate] = useState(todayIstDate());

  const [save, saving] = useSubmit(async () => {
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
    }
  });

  return (
    <Modal title={`Record payment — ${deal.product_name}`} onClose={onClose}>
      <div className="form-grid">
        <Field label={`Amount (₹) — pending ${rupees(deal.pending_paise)}`}>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <Field label="Method">
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="upi">UPI</option><option value="cash">Cash</option>
            <option value="bank_transfer">Bank transfer</option><option value="card">Card</option>
            <option value="cheque">Cheque</option><option value="other">Other</option>
          </select>
        </Field>
        {pendingInst.length > 0 && (
          <Field label="Against EMI">
            <select value={instId} onChange={(e) => setInstId(e.target.value)}>
              <option value="">No specific EMI</option>
              {pendingInst.map((i) => (
                <option key={i.id} value={i.id}>EMI {i.seq} — {rupees(i.amount_paise)} due {fmtDate(i.due_date)}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Received on">
          <input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} />
        </Field>
        <Field label="Reference (UTR / receipt no.)">
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn green" disabled={saving || !(Number(amount) > 0)} onClick={save}>
          {saving ? 'Saving…' : 'Record payment'}
        </button>
      </div>
    </Modal>
  );
}

// Generate a GST invoice for a won lead. Seeds Bill To + line items from the
// lead / its first deal; live subtotal/GST/total are computed CLIENT-SIDE in
// integer paise (gst_percent from settings) and shown to the paisa.
function GenerateInvoiceModal({ lead, onClose }) {
  const { showToast } = useApp();
  const navigate = useNavigate();
  const [gstPercent, setGstPercent] = useState(18);
  const [billTo, setBillTo] = useState({
    bill_to_name: lead.name || '',
    bill_to_email: lead.email || '',
    bill_to_phone: lead.phone || '',
    bill_to_address: lead.city || '',
  });
  const deal = lead.deals && lead.deals[0];
  const [rows, setRows] = useState(() => {
    if (deal) {
      return [{ id: rowId(), description: deal.product_name, qty: 1, unit_rupees: String(deal.deal_value_paise / 100) }];
    }
    return [{ id: rowId(), description: 'Consulting Services', qty: 1, unit_rupees: '' }];
  });

  useEffect(() => {
    api.get('/api/settings').then((s) => setGstPercent(Number(s.gst_percent != null ? s.gst_percent : 18))).catch(() => {});
  }, []);

  const setRow = (id, k, v) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [k]: v } : r)));
  const addRow = () => setRows((rs) => [...rs, { id: rowId(), description: '', qty: 1, unit_rupees: '' }]);
  const removeRow = (id) => setRows((rs) => rs.filter((r) => r.id !== id));

  // All paise. Blank/invalid unit → 0 for the preview.
  const unitPaise = (r) => Math.round(Number(r.unit_rupees) * 100) || 0;
  const lineAmount = (r) => (Number.isInteger(Number(r.qty)) && Number(r.qty) > 0 ? Number(r.qty) : 1) * unitPaise(r);
  const subtotal = rows.reduce((s, r) => s + lineAmount(r), 0);
  const tax = Math.round((subtotal * gstPercent) / 100);
  const total = subtotal + tax;

  const valid = rows.length > 0
    && rows.every((r) => r.description.trim() && unitPaise(r) >= 0)
    && subtotal > 0;

  const [create, saving] = useSubmit(async () => {
    try {
      const res = await api.post('/api/invoices', {
        lead_id: lead.id,
        deal_id: deal ? deal.id : null,
        ...billTo,
        items: rows.map((r) => ({
          description: r.description.trim(),
          qty: Number.isInteger(Number(r.qty)) && Number(r.qty) > 0 ? Number(r.qty) : 1,
          unit_price_paise: unitPaise(r),
        })),
      });
      showToast('Invoice created ✓ — open or print it from the invoice page');
      onClose();
      navigate(`/invoices/${res.id}`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  return (
    <Modal title={`Generate invoice — ${lead.name}`} onClose={onClose}>
      <div className="form-grid">
        <Field label="Bill to (name)">
          <input value={billTo.bill_to_name}
            onChange={(e) => setBillTo((v) => ({ ...v, bill_to_name: e.target.value }))} />
        </Field>
        <Field label="Phone">
          <input value={billTo.bill_to_phone} inputMode="tel"
            onChange={(e) => setBillTo((v) => ({ ...v, bill_to_phone: e.target.value }))} />
        </Field>
        <Field label="Email">
          <input value={billTo.bill_to_email} type="email"
            onChange={(e) => setBillTo((v) => ({ ...v, bill_to_email: e.target.value }))} />
        </Field>
        <Field label="Address">
          <input value={billTo.bill_to_address}
            onChange={(e) => setBillTo((v) => ({ ...v, bill_to_address: e.target.value }))} />
        </Field>
      </div>

      <div className="field">
        <label>Line items</label>
        {rows.map((r, i) => (
          <div key={r.id} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <input style={{ flex: 2 }} placeholder="Description" aria-label={`Line ${i + 1} description`} value={r.description}
              onChange={(e) => setRow(r.id, 'description', e.target.value)} />
            <input style={{ width: 64 }} inputMode="numeric" placeholder="Qty" aria-label={`Line ${i + 1} quantity`} value={r.qty}
              onChange={(e) => setRow(r.id, 'qty', e.target.value)} />
            <input style={{ flex: 1 }} inputMode="decimal" placeholder="₹ unit" aria-label={`Line ${i + 1} unit price`} value={r.unit_rupees}
              onChange={(e) => setRow(r.id, 'unit_rupees', e.target.value)} />
            <button type="button" className="btn small secondary" disabled={rows.length === 1} aria-label={`Remove line ${i + 1}`}
              onClick={() => removeRow(r.id)}>✕</button>
          </div>
        ))}
        <button type="button" className="btn small secondary" onClick={addRow}>+ Add line</button>
      </div>

      <div style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <div className="pb-line"><span>Subtotal</span><b>{rupees(subtotal)}</b></div>
        <div className="pb-line"><span>GST ({gstPercent}%)</span><b>{rupees(tax)}</b></div>
        <div className="pb-line"><span><b>Total Due</b></span><b style={{ fontSize: 17 }}>{rupees(total)}</b></div>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving || !valid} onClick={create}>
          {saving ? 'Creating…' : 'Create invoice'}
        </button>
      </div>
    </Modal>
  );
}

function FollowUpModal({ lead, onClose, onSaved }) {
  const { showToast } = useApp();
  const existing = lead.follow_up;
  // Reschedule pre-fills the current due date/reason so the admin sees what
  // they're changing (and isn't forced to retype the time from scratch).
  const [dueAt, setDueAt] = useState(existing ? utcIsoToDtLocal(existing.due_at) : '');
  const [reason, setReason] = useState((existing && existing.reason) || '');
  const [save, saving] = useSubmit(async () => {
    try {
      await api.put(`/api/leads/${lead.id}/follow-up`, {
        due_at: dtLocalToUtcIso(dueAt), reason: reason || 'Follow-up',
      });
      showToast(existing ? 'Follow-up rescheduled ✓' : 'Follow-up scheduled ✓');
      onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  });
  return (
    <Modal title={existing ? 'Reschedule follow-up' : 'Schedule follow-up'} onClose={onClose}>
      <Field label="When (IST)">
        <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} autoFocus />
      </Field>
      <Field label="Reason">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Send payment link" />
      </Field>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={!dueAt || saving} onClick={save}>{saving ? 'Saving…' : existing ? 'Reschedule' : 'Schedule'}</button>
      </div>
    </Modal>
  );
}

// Edit the lead's core fields (QA-8) through the existing PATCH. A duplicate
// phone answers 409 → look the other lead up so the user can jump to it.
function EditLeadModal({ lead, onClose, onSaved }) {
  const { showToast } = useApp();
  const [form, setForm] = useState({
    name: lead.name || '', phone: lead.phone || '', alt_phone: lead.alt_phone || '',
    email: lead.email || '', city: lead.city || '', source: lead.source || '', notes: lead.notes || '',
  });
  const [dupOf, setDupOf] = useState(null);
  const set = (k) => (e) => { const v = e.target.value; setForm((f) => ({ ...f, [k]: v })); if (k === 'phone') setDupOf(null); };

  const [save, saving] = useSubmit(async () => {
    const body = {};
    for (const k of ['name', 'alt_phone', 'email', 'city', 'source', 'notes']) {
      if ((form[k] || '') !== (lead[k] || '')) body[k] = form[k];
    }
    if (form.phone.trim() !== (lead.phone || '')) body.phone = form.phone.trim();
    if (body.name !== undefined && !body.name.trim()) { showToast('Name is required', 'error'); return; }
    if (!Object.keys(body).length) { onClose(); return; }
    try {
      await api.patch(`/api/leads/${lead.id}`, body);
      showToast('Lead updated ✓');
      onSaved(); onClose();
    } catch (err) {
      if (err.status === 409 && body.phone) {
        try {
          const chk = await api.get(`/api/leads/check-phone?phone=${encodeURIComponent(body.phone)}`);
          if (chk && chk.duplicate) setDupOf(chk.duplicate);
        } catch { /* fall through to the toast */ }
      }
      showToast(err.message, 'error');
    }
  });

  return (
    <Modal title="Edit lead" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="form-grid">
          <Field label="Name *"><input value={form.name} onChange={set('name')} autoFocus /></Field>
          <Field label="Phone *" error={dupOf ? undefined : undefined}>
            <input inputMode="tel" value={form.phone} onChange={set('phone')} />
          </Field>
          {dupOf && (
            <div className="field err" style={{ gridColumn: '1 / -1' }}>
              Another lead already has this number: {dupOf.mine
                ? <Link to={`/leads/${dupOf.id}`} onClick={onClose}>{dupOf.name}</Link>
                : 'another team member\'s lead — ask an admin'}
            </div>
          )}
          <Field label="Alt phone"><input inputMode="tel" value={form.alt_phone} onChange={set('alt_phone')} /></Field>
          <Field label="Email"><input type="email" value={form.email} onChange={set('email')} /></Field>
          <Field label="City"><input value={form.city} onChange={set('city')} /></Field>
          <Field label="Source"><input value={form.source} onChange={set('source')} /></Field>
        </div>
        <Field label="Notes"><textarea rows={4} value={form.notes} onChange={set('notes')} /></Field>
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={saving || !form.name.trim() || !form.phone.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function LeadDetail() {
  const { id } = useParams();
  const { user, showToast, askConfirm, askPrompt, canWrite } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [modal, setModal] = useState(null); // 'call' | 'win' | 'followup' | 'invoice' | 'task' | 'edit' | {payment: deal}
  const [users, setUsers] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [transcribingId, setTranscribingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const teamView = isAdmin(user.role);

  const { data: lead, error, loading, reload } = useRequest(
    ({ signal }) => api.get(`/api/leads/${id}`, { signal }), [id],
  );
  const load = reload;
  const suggestionsLoaded = useRef(null);
  useEffect(() => {
    suggestionsLoaded.current = id;
    api.get(`/api/ai/suggestions?lead_id=${id}`).then((s) => { if (suggestionsLoaded.current === id) setSuggestions(s); }).catch(() => {});
    return () => { suggestionsLoaded.current = null; };
  }, [id, lead]);

  const transcribeCloud = async (recordingId) => {
    const ok = await askConfirm({
      title: 'Send this recording to Sarvam (cloud)?',
      message: 'Hindi transcription for this ONE recording. This is the only time audio leaves the office. Continue?',
      confirmLabel: 'Send to Sarvam',
    });
    if (!ok) return;
    setTranscribingId(recordingId);
    try {
      await api.post(`/api/recordings/${recordingId}/transcribe-cloud`);
      showToast('Transcribed with Sarvam ✓');
      load();
    } catch (err) { showToast(err.message, 'error'); }
    finally { setTranscribingId(null); }
  };

  const actSuggestion = async (s, action) => {
    if (busyId) return;
    setBusyId(s.id);
    try {
      await api.post(`/api/ai/suggestions/${s.id}/${action}`);
      load();
    } catch (err) { showToast(err.message, 'error'); }
    finally { setBusyId(null); }
  };

  // Deep-link from the Kanban board: dropping a lead into "Won" navigates here
  // with ?win=1 to open the Win Deal flow directly. Consume the param once so a
  // refresh doesn't reopen it.
  useEffect(() => {
    if (searchParams.get('win') === '1') {
      setModal('win');
      const next = new URLSearchParams(searchParams);
      next.delete('win');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  useEffect(() => {
    if (teamView) {
      api.get('/api/users').then((u) => setUsers(u.filter(isAssignable))).catch(() => {});
    }
    // Only the admin tier receives ai_cloud_enabled; everyone else gets the
    // public subset, so the button simply stays hidden for them.
    api.get('/api/settings').then((s) => setCloudEnabled(!!s.ai_cloud_enabled)).catch(() => {});
  }, [teamView]);

  if (!lead) {
    if (error) {
      return (
        <>
          <div className="page-title">
            <h1><button type="button" className="back-btn" aria-label="Back" onClick={() => goBack(navigate, '/leads')}>←</button> Lead</h1>
          </div>
          <ErrorState error={error} onRetry={reload} />
        </>
      );
    }
    return loading ? <LoadingState /> : null;
  }

  const setStage = async (stage) => {
    if (stage === lead.stage) return;
    if (stage === 'won') { setModal('win'); return; }
    const body = { stage };
    if (stage === 'lost') {
      const reason = await askPrompt({
        title: 'Mark lead as lost', label: 'Reason for losing this lead', required: true, multiline: true,
        submitLabel: 'Mark lost', danger: true,
      });
      if (reason == null) return; // cancelled — nothing changes (CLIENT-5)
      body.lost_reason = reason || 'Not specified';
    } else {
      const note = await askPrompt({
        title: `Move to ${STAGE_LABELS[stage]}`, label: 'Note (optional)', multiline: true, submitLabel: 'Move',
      });
      if (note == null) return;
      if (note) body.note = note;
    }
    try {
      await api.patch(`/api/leads/${lead.id}`, body);
      showToast(stage === 'lost' ? 'Marked as lost' : `Moved to ${STAGE_LABELS[stage]} ✓`);
      load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const reassign = async (to) => {
    try {
      await api.patch(`/api/leads/${lead.id}`, { assigned_to: to ? Number(to) : null });
      showToast('Reassigned ✓'); load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const cancelFollowUp = async () => {
    const ok = await askConfirm({
      title: 'Cancel this follow-up?',
      message: `${fmtDateTime(lead.follow_up.due_at)} — ${lead.follow_up.reason}\n\nThe lead drops out of the Today queue until you schedule another one.`,
      confirmLabel: 'Cancel follow-up', cancelLabel: 'Keep it', danger: true,
    });
    if (!ok) return;
    try { await api.del(`/api/leads/${lead.id}/follow-up`); showToast('Follow-up cancelled'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const deletePayment = async (p, deal) => {
    const after = rupees(deal.pending_paise + p.amount_paise);
    const ok = await askConfirm({
      title: `Delete this payment of ${rupees(p.amount_paise)}?`,
      message: `Pending balance will go back up to ${after}.`,
      confirmLabel: 'Delete payment', danger: true,
    });
    if (!ok) return;
    try { await api.del(`/api/payments/${p.id}`); showToast('Payment deleted'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const timeline = [
    ...lead.calls.map((c) => ({ kind: 'call', at: c.called_at, c })),
    ...lead.events.map((e) => ({ kind: 'event', at: e.changed_at, e })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  const openStage = !['won', 'lost'].includes(lead.stage);

  return (
    <>
      <div className="page-title">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="back-btn" aria-label="Back" onClick={() => goBack(navigate, '/leads')}>←</button>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{lead.name}</span> <StageBadge stage={lead.stage} />
          <ScoreBadge score={lead.score} factors={lead.score_factors} />
        </h1>
        <div className="actions">
          <a className="act-btn call" href={telLink(lead.phone)} title="Call" aria-label={`Call ${lead.name}`}>📞</a>
          <WhatsAppButton lead={lead} context={lead.deals[0] ? {
            product: lead.deals[0].product_name,
            amount_due_paise: lead.deals[0].pending_paise > 0 ? lead.deals[0].pending_paise : null,
          } : {}} />
        </div>
      </div>

      {error && <ErrorState error={error} onRetry={reload} compact />}

      <div className="card">
        <div className="meta" style={{ fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.8, overflowWrap: 'anywhere' }}>
          📱 <b style={{ color: 'var(--ink)' }}>{lead.phone}</b>
          {lead.alt_phone && <> · alt: {lead.alt_phone}</>}
          {lead.city && <> · 📍 {lead.city}</>}
          {lead.email && <> · ✉️ {lead.email}</>}
          <br />
          Source: <b style={{ color: 'var(--ink)' }}>{lead.source}</b>
          {' · '}Assigned: <b style={{ color: 'var(--ink)' }}>{lead.assigned_to_name || 'unassigned'}</b>
          {lead.stage === 'lost' && lead.lost_reason && <> · Lost: {lead.lost_reason}</>}
          {lead.notes && <><br /><span style={{ whiteSpace: 'pre-wrap' }}>📝 {lead.notes}</span></>}
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {canWrite && (
            <button type="button" className="btn small secondary" onClick={() => setModal('edit')}>✏️ Edit details</button>
          )}
          {teamView && canWrite && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--ink-soft)' }}>
              Assign to
              <select value={lead.assigned_to || ''} onChange={(e) => reassign(e.target.value)}
                style={{ padding: 7, border: '1px solid var(--line)', borderRadius: 8, fontSize: 13, minHeight: 36 }}>
                <option value="">Unassigned</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      {lead.follow_up && (
        <div className="card" style={{ borderLeft: '4px solid var(--brand)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 200 }}>
            <b>⏰ Follow-up:</b> {fmtDateTime(lead.follow_up.due_at)} — {lead.follow_up.reason}
          </span>
          {canWrite && (
            <span style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn small secondary" onClick={() => setModal('followup')}>Reschedule</button>
              <button type="button" className="btn small secondary danger-text" onClick={cancelFollowUp}>Cancel follow-up</button>
            </span>
          )}
        </div>
      )}

      {canWrite && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button type="button" className="btn" onClick={() => setModal('call')}>✍️ Log call</button>
            {openStage && (
              <button type="button" className="btn green" onClick={() => setModal('win')}>🏆 Win deal</button>
            )}
            {lead.stage === 'won' && (
              <button type="button" className="btn green" onClick={() => setModal('win')}>+ Another deal</button>
            )}
            {(lead.stage === 'won' || lead.deals.length > 0) && (
              <button type="button" className="btn secondary" onClick={() => setModal('invoice')}>🧾 Generate invoice</button>
            )}
            {!lead.follow_up && (
              <button type="button" className="btn secondary" onClick={() => setModal('followup')}>⏰ Schedule follow-up</button>
            )}
            <button type="button" className="btn secondary" onClick={() => setModal('task')}>✅ Add task</button>
            {openStage && (
              <button type="button" className="btn secondary danger-text" onClick={() => setStage('lost')}>Mark lost</button>
            )}
            {lead.stage === 'lost' && (
              <button type="button" className="btn secondary" onClick={() => setStage('interested')}>Reopen lead</button>
            )}
          </div>
          {openStage && (
            <div className="field" style={{ marginBottom: 14 }}>
              <label>Stage</label>
              <Seg label="Stage" options={OPEN_STAGES} value={lead.stage} onChange={setStage} />
            </div>
          )}
        </>
      )}

      {suggestions.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--brand)' }}>
          <h2>🤖 AI suggestions from call recordings</h2>
          <div className="row-list">
            {suggestions.map((s) => (
              <div key={s.id} className="lead-row" style={{ padding: '10px 12px' }}>
                <div className="info">
                  <div className="name" style={{ fontSize: 14 }}>{s.label}</div>
                  {s.summary && <div className="meta">{s.summary}</div>}
                </div>
                {canWrite && (
                  <div className="actions">
                    <button type="button" className="btn small green" disabled={busyId === s.id} onClick={() => actSuggestion(s, 'accept')}>Accept</button>
                    <button type="button" className="btn small secondary" disabled={busyId === s.id} aria-label="Dismiss suggestion" onClick={() => actSuggestion(s, 'dismiss')}>✕</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {lead.deals.map((deal) => (
        <div className="card" key={deal.id}>
          <h2>💼 {deal.product_name} — {rupees(deal.deal_value_paise)}
            {' '}<span className={`badge ${deal.status === 'completed' ? 'paid' : deal.status === 'cancelled' ? 'lost' : 'pending'}`}>{deal.status}</span>
          </h2>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
            <div><div className="tl-meta">Collected</div><b style={{ color: 'var(--green-text)' }}>{rupees(deal.paid_paise)}</b></div>
            <div><div className="tl-meta">Pending</div><b style={{ color: deal.pending_paise > 0 ? 'var(--red-text)' : 'var(--green-text)' }}>{rupees(deal.pending_paise)}</b></div>
            <div><div className="tl-meta">Won on</div><b>{fmtDate(deal.won_date)}</b></div>
          </div>
          {deal.installments.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>EMI</th><th className="num">Amount</th><th>Due</th><th>Status</th></tr></thead>
                <tbody>
                  {deal.installments.map((i) => {
                    const overdue = i.due_date < todayIstDate() && ['pending', 'partial'].includes(i.status);
                    return (
                      <tr key={i.id}>
                        <td>#{i.seq}</td>
                        <td className="num">{rupees(i.amount_paise)}</td>
                        <td>{fmtDate(i.due_date)}</td>
                        <td><span className={`badge ${overdue ? 'overdue' : i.status}`}>{overdue ? 'overdue' : i.status}</span></td>
                      </tr>
                    );
                  })}
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
                        {teamView && canWrite && (
                          <td><button type="button" className="btn small secondary" aria-label="Delete payment" onClick={() => deletePayment(p, deal)}>✕</button></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {canWrite && deal.pending_paise > 0 && deal.status !== 'cancelled' && (
            <button type="button" className="btn green" style={{ marginTop: 10 }}
              onClick={() => setModal({ payment: deal })}>💰 Record payment</button>
          )}
        </div>
      ))}

      <div className="card">
        <h2>Timeline</h2>
        <div className="timeline">
          {timeline.length === 0 && <div className="empty">No activity yet. Log the first call!</div>}
          {timeline.map((t) => t.kind === 'call' ? (
            <div className="tl-item" key={`c${t.c.id}`}>
              <div className="tl-icon" aria-hidden="true">📞</div>
              <div className="tl-body">
                <div className="tl-title">
                  {DISPOSITION_LABELS[t.c.disposition]} · {TYPE_LABELS[t.c.call_type]}
                  {t.c.outcome && <> → <b>{OUTCOME_LABELS[t.c.outcome] || t.c.outcome}</b></>}
                </div>
                <div className="tl-meta">
                  {fmtDateTime(t.c.called_at)} · {t.c.user_name}
                  {t.c.auto_logged ? ' · auto-logged' : ''}
                </div>
                {t.c.notes && <div className="tl-notes">{t.c.notes}</div>}
                {t.c.recording_id && (
                  <>
                    <audio controls preload="none" style={{ height: 34, marginTop: 6, maxWidth: '100%' }}
                      src={`/api/review/audio/${t.c.recording_id}`} />
                    <AiIntelPanel ai={t.c.recording_ai} provider={t.c.recording_provider} />
                    {!t.c.recording_ai && t.c.recording_summary && (
                      <div className="tl-notes">🤖 {t.c.recording_summary}</div>
                    )}
                    <TranscriptToggle transcript={t.c.recording_transcript}
                      translation={t.c.recording_translation} />
                    {cloudEnabled && canWrite && (
                      <div style={{ marginTop: 6 }}>
                        <button type="button" className="btn small secondary" disabled={transcribingId === t.c.recording_id}
                          onClick={() => transcribeCloud(t.c.recording_id)}>
                          {transcribingId === t.c.recording_id ? 'Transcribing…' : '☁️ Transcribe with Sarvam (cloud)'}
                        </button>
                        <span className="tl-meta" style={{ marginLeft: 8 }}>audio leaves the office</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="tl-item" key={`e${t.e.id}`}>
              <div className="tl-icon" style={{ background: 'var(--amber-soft)', color: 'var(--amber-text)' }} aria-hidden="true">🔀</div>
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
      {modal === 'invoice' && <GenerateInvoiceModal lead={lead} onClose={() => setModal(null)} />}
      {modal === 'followup' && <FollowUpModal lead={lead} onClose={() => setModal(null)} onSaved={load} />}
      {modal === 'task' && <TaskModal lead={lead} onClose={() => setModal(null)} onSaved={load} />}
      {modal === 'edit' && <EditLeadModal lead={lead} onClose={() => setModal(null)} onSaved={load} />}
      {modal && modal.payment && (
        <PaymentModal deal={modal.payment} onClose={() => setModal(null)} onSaved={load} />
      )}
    </>
  );
}
