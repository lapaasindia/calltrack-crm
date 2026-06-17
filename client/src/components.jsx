import React, { useEffect, useState } from 'react';
import { api, renderTemplate, waLink, rupees, fmtDate, dtLocalToUtcIso, utcIsoToDtLocal, IST_OFFSET_MS } from './api.js';
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

// Hot / Warm / Cold for a 0..100 lead score. Mirrors server/lib/scoring.js.
export function scoreLabel(score) {
  const s = Number(score) || 0;
  if (s >= 80) return { label: 'Hot', emoji: '🔥', color: '#dc2626' };
  if (s >= 50) return { label: 'Warm', emoji: '🌤️', color: '#d97706' };
  return { label: 'Cold', emoji: '❄️', color: '#2563eb' };
}

const FACTOR_LABELS = {
  source: 'Source quality',
  engagement: 'Call engagement',
  recency: 'Recency',
  stage: 'Stage',
  budget: 'Budget',
};

// Score pill with an on-hover breakdown of how the rule-based score was reached.
export function ScoreBadge({ score, factors }) {
  if (score == null) return null;
  const { label, emoji, color } = scoreLabel(score);
  const rows = factors
    ? Object.entries(FACTOR_LABELS)
      .filter(([k]) => factors[k] != null)
      .map(([k, lbl]) => [lbl, factors[k]])
    : [];
  return (
    <span className="score-badge" style={{ position: 'relative', display: 'inline-flex' }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 700,
        fontSize: 12, padding: '2px 8px', borderRadius: 999,
        color, background: `${color}1a`, cursor: rows.length ? 'help' : 'default',
      }} title={rows.length ? `${label} · score ${score}/100` : `${label} · score ${score}/100`}>
        {emoji} {label} {score}
      </span>
      {rows.length > 0 && (
        <span className="score-tip" style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 4,
          minWidth: 180, padding: '8px 10px', background: 'var(--card, #fff)',
          border: '1px solid var(--line)', borderRadius: 8,
          boxShadow: '0 6px 20px rgba(0,0,0,.12)', fontSize: 12,
          color: 'var(--ink)', display: 'none',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Why {score}/100</div>
          {rows.map(([lbl, val]) => (
            <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ color: 'var(--ink-soft)' }}>{lbl}</span>
              <b style={{ color: val < 0 ? 'var(--red)' : 'var(--ink)' }}>{val > 0 ? `+${val}` : val}</b>
            </div>
          ))}
        </span>
      )}
    </span>
  );
}

const INTENT_COLORS = {
  Hot: '#dc2626', Warm: '#d97706', Cold: '#2563eb',
  Informational: '#6b7280', 'Follow-up Required': '#7c3aed',
};
const SENTIMENT_LABELS = {
  positive: '😊 Positive', neutral: '😐 Neutral', negative: '🙁 Negative', mixed: '🔀 Mixed',
};

function Chip({ text, color }) {
  return (
    <span style={{
      fontSize: 12, fontWeight: 700, padding: '2px 9px', borderRadius: 999,
      color: color || 'var(--ink)', background: `${color || '#6b7280'}1a`,
    }}>{text}</span>
  );
}

// One 1..10 rating axis rendered as an inline CSS bar (NO chart lib).
function RatingBar({ label, value }) {
  if (value == null) return null;
  const pct = Math.max(0, Math.min(100, value * 10));
  const color = value >= 8 ? 'var(--green)' : value >= 5 ? 'var(--amber, #d97706)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
      <span style={{ width: 88, fontSize: 12, color: 'var(--ink-soft)' }}>{label}</span>
      <span style={{ flex: 1, height: 8, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} />
      </span>
      <b style={{ width: 34, textAlign: 'right', fontSize: 12 }}>{value}/10</b>
    </div>
  );
}

// AI / Call Intelligence panel for one analyzed recording. ai = parsed ai_json.
export function AiIntelPanel({ ai, provider }) {
  if (!ai || typeof ai !== 'object') return null;
  const rating = ai.rating && typeof ai.rating === 'object' ? ai.rating : {};
  const strengths = Array.isArray(ai.strengths) ? ai.strengths.slice(0, 3) : [];
  const improvements = Array.isArray(ai.improvements) ? ai.improvements.slice(0, 3) : [];

  return (
    <div style={{
      marginTop: 8, padding: 10, borderRadius: 10,
      background: 'var(--brand-soft, #f5f3ff)', border: '1px solid var(--line)',
    }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>🤖 Call Intelligence</b>
        {ai.intent && <Chip text={ai.intent} color={INTENT_COLORS[ai.intent]} />}
        {ai.sentiment && <Chip text={SENTIMENT_LABELS[ai.sentiment] || ai.sentiment} color="#0ea5e9" />}
        {provider === 'sarvam' && <Chip text="Sarvam (cloud)" color="#059669" />}
      </div>

      {ai.summary && <div style={{ fontSize: 13, marginBottom: 8 }}>{ai.summary}</div>}

      {(rating.clarity != null || rating.engagement != null
        || rating.conversion != null || rating.overall != null) && (
        <div style={{ marginBottom: 8 }}>
          <RatingBar label="Clarity" value={rating.clarity} />
          <RatingBar label="Engagement" value={rating.engagement} />
          <RatingBar label="Conversion" value={rating.conversion} />
          <RatingBar label="Overall" value={rating.overall} />
        </div>
      )}

      {(strengths.length > 0 || improvements.length > 0) && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
          {strengths.length > 0 && (
            <div style={{ flex: 1, minWidth: 160 }}>
              <div className="tl-meta" style={{ fontWeight: 700, color: 'var(--green)' }}>Strengths</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
                {strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {improvements.length > 0 && (
            <div style={{ flex: 1, minWidth: 160 }}>
              <div className="tl-meta" style={{ fontWeight: 700, color: 'var(--red)' }}>To improve</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
                {improvements.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {ai.coaching && (
        <div style={{
          fontSize: 12.5, padding: '6px 9px', borderRadius: 8,
          background: 'var(--amber-soft, #fef3c7)', marginBottom: 8,
        }}>💡 <b>Coaching:</b> {ai.coaching}</div>
      )}
    </div>
  );
}

// Hindi/original transcript + English translation with a toggle. Only the
// translation toggle appears when a separate translation exists (Sarvam path).
export function TranscriptToggle({ transcript, translation }) {
  const [showOriginal, setShowOriginal] = useState(false);
  if (!transcript && !translation) return null;
  const hasBoth = transcript && translation && transcript !== translation;
  const text = showOriginal ? transcript : (translation || transcript);
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span className="tl-meta" style={{ fontWeight: 700 }}>
          {hasBoth ? (showOriginal ? 'Transcript (original)' : 'Transcript (English)') : 'Transcript'}
        </span>
        {hasBoth && (
          <button className="btn small secondary" onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? 'Show English' : 'Show original'}
          </button>
        )}
      </div>
      <div style={{
        fontSize: 12.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto',
        padding: '6px 9px', background: 'var(--card, #fff)', border: '1px solid var(--line)', borderRadius: 8,
      }}>{text}</div>
    </div>
  );
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

export function TaskModal({ lead, onClose, onSaved }) {
  const { showToast } = useApp();
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [dueDate, setDueDate] = useState(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  const save = async () => {
    try {
      await api.post('/api/tasks', {
        title, details, due_date: dueDate, lead_id: lead?.id || undefined,
      });
      showToast('Task added ✓');
      onSaved?.(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  };
  return (
    <Modal title={lead ? `Task for ${lead.name}` : 'New task'} onClose={onClose}>
      <div className="field">
        <label>What needs doing?</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
          placeholder="e.g. Send course brochure on WhatsApp" />
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Due date</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Details (optional)</label>
          <input value={details} onChange={(e) => setDetails(e.target.value)} />
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!title.trim()} onClick={save}>Add task</button>
      </div>
    </Modal>
  );
}

const BLOCK_TYPES = [
  'Deep Work', 'Meeting Prep', 'Client Work', 'Admin', 'Break', 'Out of Office',
];

// Create / edit a time block. start/end are entered as IST wall time via
// datetime-local inputs and converted to UTC instants on save. A 409 conflict
// from the server is surfaced inline. `block` = edit an existing row; `prefill`
// = {start_at,end_at,block_date} from an empty-slot click on the calendar.
export function TimeBlockDialog({ block, prefill, admin, onClose, onSaved }) {
  const { user, showToast } = useApp();
  const editing = !!block;
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(() => ({
    title: block?.title || '',
    block_type: block?.block_type || 'Deep Work',
    start: utcIsoToDtLocal(block?.start_at || prefill?.start_at || ''),
    end: utcIsoToDtLocal(block?.end_at || prefill?.end_at || ''),
    notes: block?.notes || '',
    owner_id: String(block?.owner_id || user.id),
  }));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (admin) api.get('/api/users').then(setUsers).catch(() => {});
  }, [admin]);

  const save = async () => {
    if (!form.title.trim()) return showToast('Title required', 'error');
    if (!form.start || !form.end) return showToast('Pick a start and end time', 'error');
    const start_at = dtLocalToUtcIso(form.start);
    const end_at = dtLocalToUtcIso(form.end);
    if (!(new Date(start_at) < new Date(end_at))) return showToast('Start must be before end', 'error');
    setSaving(true); setConflict(null);
    const body = {
      title: form.title.trim(), block_type: form.block_type,
      start_at, end_at, notes: form.notes || undefined,
    };
    if (admin && form.owner_id) body.owner_id = Number(form.owner_id);
    try {
      if (editing) await api.put(`/api/time-blocks/${block.id}`, body);
      else await api.post('/api/time-blocks', body);
      showToast(editing ? 'Time block updated ✓' : 'Time block created ✓');
      onSaved();
    } catch (err) {
      if (err.status === 409) setConflict(err.message);
      else showToast(err.message, 'error');
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!confirm('Delete this time block?')) return;
    try { await api.del(`/api/time-blocks/${block.id}`); showToast('Time block deleted'); onSaved(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <Modal title={editing ? 'Edit time block' : 'New time block'} onClose={onClose}>
      <div className="field">
        <label>Title</label>
        <input value={form.title} onChange={set('title')} autoFocus placeholder="e.g. Focus: proposal draft" />
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Type</label>
          <select value={form.block_type} onChange={set('block_type')}>
            {BLOCK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {admin && (
          <div className="field">
            <label>Owner</label>
            <select value={form.owner_id} onChange={set('owner_id')}>
              {(users.length ? users : [{ id: user.id, full_name: user.full_name }])
                .map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Start (IST)</label>
          <input type="datetime-local" value={form.start} onChange={set('start')} />
        </div>
        <div className="field">
          <label>End (IST)</label>
          <input type="datetime-local" value={form.end} onChange={set('end')} />
        </div>
      </div>
      <div className="field">
        <label>Notes (optional)</label>
        <textarea rows={2} value={form.notes} onChange={set('notes')} />
      </div>
      {conflict && (
        <div style={{
          fontSize: 12.5, fontWeight: 600, color: 'var(--red)', background: 'var(--red-soft)',
          border: '1px solid var(--red)', borderRadius: 8, padding: '7px 10px', marginBottom: 10,
        }}>⚠️ {conflict}</div>
      )}
      <div className="modal-actions">
        {editing && <button className="btn secondary" style={{ color: 'var(--red)' }} onClick={remove}>Delete</button>}
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : (editing ? 'Save' : 'Create')}</button>
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
