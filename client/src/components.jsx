import React, { useEffect, useState } from 'react';
import { api, renderTemplate, waLink, rupees, fmtDate, dtLocalToUtcIso, IST_OFFSET_MS } from './api.js';
import { useApp } from './App.jsx';

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function Seg({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map(([val, label]) => (
        <button key={val} type="button" className={value === val ? 'on' : ''}
          onClick={() => onChange(val)}>{label}</button>
      ))}
    </div>
  );
}

export const STAGE_LABELS = {
  new: 'New', contacted: 'Contacted', interested: 'Interested',
  follow_up: 'Follow-up', won: 'Won', lost: 'Lost',
};
export function StageBadge({ stage }) {
  return <span className={`badge ${stage}`}>{STAGE_LABELS[stage] || stage}</span>;
}

const DISPOSITIONS = [
  ['connected', '✅ Connected'], ['not_picked', '📵 Not picked'], ['busy', '⏳ Busy'],
  ['switched_off', '🔌 Switched off'], ['wrong_number', '❌ Wrong number'],
];
const CALL_TYPES = [
  ['sales', 'Sales'], ['follow_up', 'Follow-up'], ['collection', 'Payment'], ['support', 'Support'],
];
const OUTCOMES = {
  sales: [['interested', '😊 Interested'], ['not_interested', '🙅 Not interested'],
    ['callback_requested', '📞 Callback'], ['wrong_person', '🤷 Wrong person']],
  follow_up: [['interested', '😊 Interested'], ['not_interested', '🙅 Not interested'],
    ['callback_requested', '📞 Callback'], ['wrong_person', '🤷 Wrong person']],
  collection: [['payment_promised', '🤝 Promised'], ['payment_collected', '💰 Collected'],
    ['dispute', '⚠️ Dispute'], ['callback_requested', '📞 Callback']],
  support: [['resolved', '✅ Resolved'], ['open', '🔄 Still open'], ['escalated', '🆙 Escalated']],
};

// Quick follow-up presets → datetime-local value representing IST wall time
// (computed via a shifted clock read with getUTC*, so the browser's own
// timezone never leaks in).
function followUpPreset(daysAhead, hour) {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + daysAhead, hour, 0));
  return d.toISOString().slice(0, 16);
}

export function LogCallModal({ lead, defaultType = 'sales', onClose, onSaved }) {
  const { showToast } = useApp();
  const [callType, setCallType] = useState(defaultType);
  const [disposition, setDisposition] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [notes, setNotes] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!disposition) return showToast('Pick what happened on the call', 'error');
    setSaving(true);
    try {
      const body = { call_type: callType, disposition, outcome, notes };
      if (followUpAt) body.next_follow_up_at = dtLocalToUtcIso(followUpAt);
      const res = await api.post(`/api/leads/${lead.id}/calls`, body);
      showToast('Call logged ✓');
      onSaved?.(res);
      onClose();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Log call — ${lead.name}`} onClose={onClose}>
      <div className="field">
        <label>Call type</label>
        <Seg options={CALL_TYPES} value={callType} onChange={(v) => { setCallType(v); setOutcome(null); }} />
      </div>
      <div className="field">
        <label>What happened?</label>
        <Seg options={DISPOSITIONS} value={disposition} onChange={setDisposition} />
      </div>
      {disposition === 'connected' && (
        <div className="field">
          <label>Outcome</label>
          <Seg options={OUTCOMES[callType]} value={outcome} onChange={setOutcome} />
        </div>
      )}
      <div className="field">
        <label>Notes</label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="What did they say?" />
      </div>
      <div className="field">
        <label>Next follow-up</label>
        <div className="seg" style={{ marginBottom: 7 }}>
          <button type="button" className={followUpAt === followUpPreset(0, 17) ? 'on' : ''}
            onClick={() => setFollowUpAt(followUpPreset(0, 17))}>Today 5pm</button>
          <button type="button" className={followUpAt === followUpPreset(1, 11) ? 'on' : ''}
            onClick={() => setFollowUpAt(followUpPreset(1, 11))}>Tomorrow 11am</button>
          <button type="button" className={followUpAt === followUpPreset(3, 11) ? 'on' : ''}
            onClick={() => setFollowUpAt(followUpPreset(3, 11))}>In 3 days</button>
          <button type="button" className={followUpAt === followUpPreset(7, 11) ? 'on' : ''}
            onClick={() => setFollowUpAt(followUpPreset(7, 11))}>Next week</button>
          {followUpAt && <button type="button" onClick={() => setFollowUpAt('')}>✕ Clear</button>}
        </div>
        <input type="datetime-local" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save call'}</button>
      </div>
    </Modal>
  );
}

// Templates + company name are fetched once and cached for the session.
let templateCache = null;
async function loadTemplateCtx() {
  if (!templateCache) {
    const [templates, settings] = await Promise.all([
      api.get('/api/templates'), api.get('/api/settings'),
    ]);
    templateCache = { templates, company: settings.company_name };
  }
  return templateCache;
}
export function invalidateTemplateCache() { templateCache = null; }

// WhatsApp button: tap → pick template → opens wa.me with rendered message.
export function WhatsAppButton({ lead, context = {} }) {
  const { user } = useApp();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);

  const openPicker = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setData(await loadTemplateCtx());
    setOpen(true);
  };

  const ctx = {
    name: lead.name?.split(' ')[0] || lead.name,
    caller_name: user.full_name?.split(' ')[0],
    company: data?.company,
    product: context.product,
    amount_due: context.amount_due_paise != null ? rupees(context.amount_due_paise) : '',
    due_date: context.due_date ? fmtDate(context.due_date) : '',
  };

  return (
    <>
      <button className="act-btn wa" title="WhatsApp" onClick={openPicker}>💬</button>
      {open && data && (
        <Modal title={`WhatsApp ${lead.name}`} onClose={() => setOpen(false)}>
          <div className="row-list">
            {data.templates.filter((t) => {
              // Hide templates whose placeholders we can't fill in this context
              // (e.g. payment reminder when there's no amount due).
              if (t.body.includes('{amount_due}') && !ctx.amount_due) return false;
              if (t.body.includes('{due_date}') && !ctx.due_date) return false;
              return true;
            }).map((t) => {
              const text = renderTemplate(t.body, { ...ctx, company: data.company });
              return (
                <a key={t.id} className="lead-row" href={waLink(lead.phone, text)}
                  target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                  <div className="info">
                    <div className="name">{t.name}</div>
                    <div className="meta">{text.length > 110 ? `${text.slice(0, 110)}…` : text}</div>
                  </div>
                  <span style={{ fontSize: 20 }}>💬</span>
                </a>
              );
            })}
            <a className="lead-row" href={waLink(lead.phone)} target="_blank" rel="noreferrer"
              onClick={() => setOpen(false)}>
              <div className="info">
                <div className="name">No template</div>
                <div className="meta">Open a blank WhatsApp chat</div>
              </div>
              <span style={{ fontSize: 20 }}>💬</span>
            </a>
          </div>
        </Modal>
      )}
    </>
  );
}
