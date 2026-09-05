import React, { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, renderTemplate, waLink, rupees, fmtDate, dtLocalToUtcIso, utcIsoToDtLocal, IST_OFFSET_MS,
  NETWORK_ERROR_MESSAGE,
} from './api.js';
import { useApp } from './ctx.js';
import { useDebouncedValue, useSubmit } from './hooks.js';
import { isAssignable } from './permissions.js';

// ---------- Modal (dialog semantics + focus trap + iOS-safe scroll lock) ----------
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Body scroll lock that also works on iOS Safari (overflow:hidden alone does
// not stop the page behind a sheet from scrolling there). Reference counted
// so nested modals don't unlock early.
let lockCount = 0;
let lockScrollY = 0;
function lockBody() {
  if (lockCount++ > 0) return;
  lockScrollY = window.scrollY || 0;
  const b = document.body.style;
  b.position = 'fixed'; b.top = `-${lockScrollY}px`; b.left = '0'; b.right = '0'; b.width = '100%'; b.overflow = 'hidden';
}
function unlockBody() {
  if (--lockCount > 0) return;
  const b = document.body.style;
  b.position = ''; b.top = ''; b.left = ''; b.right = ''; b.width = ''; b.overflow = '';
  window.scrollTo(0, lockScrollY);
}

export function Modal({ title, onClose, children, size = '' }) {
  const boxRef = useRef(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  const downOnOverlay = useRef(false);

  useEffect(() => {
    const previous = document.activeElement;
    const box = boxRef.current;
    lockBody();
    const focusables = () => Array.from(box.querySelectorAll(FOCUSABLE))
      .filter((el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true');
    // Let React's autoFocus run first; only then place focus if nothing has it.
    const t = setTimeout(() => {
      if (box.contains(document.activeElement)) return;
      const initial = box.querySelector('[autofocus]') || focusables()[0] || box;
      if (initial && typeof initial.focus === 'function') initial.focus();
    }, 0);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) { e.preventDefault(); box.focus(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      unlockBody();
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, []);

  return (
    <div className="modal-overlay"
      onMouseDown={(e) => { downOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnOverlay.current) onClose(); }}>
      <div className={`modal ${size}`} ref={boxRef} role="dialog" aria-modal="true"
        aria-labelledby={titleId} tabIndex={-1}>
        <h3 id={titleId}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

// Replacement for window.prompt(): a labelled text field in a real dialog.
// Works in the Electron shell (prompt() throws there) and on phones. Resolve
// via onSubmit(value) / onClose() — a required field disables submit while empty.
export function PromptModal({
  title, label = 'Value', placeholder, defaultValue = '', required = false, multiline = false,
  submitLabel = 'OK', cancelLabel = 'Cancel', danger = false, hint, onSubmit, onClose,
}) {
  const [value, setValue] = useState(defaultValue || '');
  const id = useId();
  const disabled = required && !value.trim();
  const [run, saving] = useSubmit(async () => { await onSubmit(value.trim()); });
  const submit = (e) => { if (e) e.preventDefault(); if (!disabled) run(); };
  const inputProps = {
    id, value, placeholder, autoFocus: true, autoComplete: 'off',
    onChange: (e) => setValue(e.target.value),
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor={id}>{label}{required ? ' *' : ''}</label>
          {multiline
            ? <textarea rows={3} {...inputProps} />
            : <input type="text" {...inputProps} />}
          {hint && <div className="hint">{hint}</div>}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={onClose}>{cancelLabel}</button>
          <button type="submit" className={`btn ${danger ? 'danger' : ''}`} disabled={disabled || saving}>
            {saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Replacement for window.confirm() on destructive actions.
export function ConfirmModal({
  title = 'Are you sure?', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, onConfirm, onClose,
}) {
  const [run, saving] = useSubmit(async () => { await onConfirm(); });
  return (
    <Modal title={title} onClose={onClose}>
      {message && <p className="modal-message">{message}</p>}
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>{cancelLabel}</button>
        <button type="button" autoFocus className={`btn ${danger ? 'danger' : ''}`} disabled={saving} onClick={run}>
          {saving ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------- load / error states ----------
export function ErrorState({ error, onRetry, compact = false, title }) {
  const msg = typeof error === 'string' ? error : ((error && error.message) || 'Something went wrong');
  const network = !!(error && error.network) || msg === NETWORK_ERROR_MESSAGE;
  const forbidden = !!(error && error.status === 403);
  const icon = network ? '📡' : forbidden ? '🚫' : '⚠️';
  const heading = title || (network ? NETWORK_ERROR_MESSAGE : forbidden ? "You don't have access" : "Couldn't load this");
  const requestId = error && error.data && error.data.request_id;
  return (
    <div className={`card empty error-state ${compact ? 'compact' : ''}`} role="alert">
      <div className="big" aria-hidden="true">{icon}</div>
      <div className="error-title">{heading}</div>
      {msg !== heading && <div className="error-msg">{msg}</div>}
      {requestId && <div className="error-ref">Ref {requestId}</div>}
      {onRetry && (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn small" onClick={onRetry}>Try again</button>
        </div>
      )}
    </div>
  );
}

export function LoadingState({ label = 'Loading…', compact = false }) {
  return (
    <div className={`card empty loading-state ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
      {label}
    </div>
  );
}

// <Field label>: wraps ONE input/select/textarea and wires label ↔ control
// (htmlFor/id) so screen readers and tap-on-label work.
export function Field({ label, hint, error, className = '', style, children }) {
  const autoId = useId();
  const child = React.Children.only(children);
  const id = child.props.id || autoId;
  return (
    <div className={`field ${className}`} style={style}>
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(child, { id })}
      {hint && <div className="hint">{hint}</div>}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

export function Seg({ options, value, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([val, lbl]) => (
        <button key={val} type="button" className={value === val ? 'on' : ''}
          aria-pressed={value === val} onClick={() => onChange(val)}>{lbl}</button>
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
  if (s >= 80) return { label: 'Hot', emoji: '🔥', color: '#b91c1c' };
  if (s >= 50) return { label: 'Warm', emoji: '🌤️', color: '#8f4d00' };
  return { label: 'Cold', emoji: '❄️', color: '#1a56db' };
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
      <span tabIndex={rows.length ? 0 : undefined} style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 700,
        fontSize: 12, padding: '2px 8px', borderRadius: 999,
        color, background: `${color}1a`, cursor: rows.length ? 'help' : 'default',
      }} title={`${label} · score ${score}/100`}>
        {emoji} {label} {score}
      </span>
      {rows.length > 0 && (
        <span className="score-tip" style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 4,
          minWidth: 180, padding: '8px 10px', background: 'var(--card)',
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
  Hot: '#b91c1c', Warm: '#8f4d00', Cold: '#1a56db',
  Informational: '#4b5563', 'Follow-up Required': '#6b21a8',
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
  const color = value >= 8 ? 'var(--green)' : value >= 5 ? 'var(--amber)' : 'var(--red)';
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
      background: 'var(--brand-soft)', border: '1px solid var(--line)',
    }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>🤖 Call Intelligence</b>
        {ai.intent && <Chip text={ai.intent} color={INTENT_COLORS[ai.intent]} />}
        {ai.sentiment && <Chip text={SENTIMENT_LABELS[ai.sentiment] || ai.sentiment} color="#0369a1" />}
        {provider === 'sarvam' && <Chip text="Sarvam (cloud)" color="#047857" />}
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
          background: 'var(--amber-soft)', marginBottom: 8,
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
          <button type="button" className="btn small secondary" onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? 'Show English' : 'Show original'}
          </button>
        )}
      </div>
      <div style={{
        fontSize: 12.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto',
        padding: '6px 9px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8,
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

  const [save, saving] = useSubmit(async () => {
    if (!disposition) { showToast('Pick what happened on the call', 'error'); return; }
    try {
      const body = { call_type: callType, disposition, outcome, notes };
      if (followUpAt) body.next_follow_up_at = dtLocalToUtcIso(followUpAt);
      const res = await api.post(`/api/leads/${lead.id}/calls`, body);
      // The server keeps an existing follow-up when the call didn't set a new
      // one (follow_up_kept); say so, so nobody thinks it vanished.
      showToast(res && res.follow_up_kept && !followUpAt ? 'Call logged ✓ — existing follow-up kept' : 'Call logged ✓');
      if (onSaved) onSaved(res);
      onClose();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const presets = [
    [followUpPreset(0, 17), 'Today 5pm'], [followUpPreset(1, 11), 'Tomorrow 11am'],
    [followUpPreset(3, 11), 'In 3 days'], [followUpPreset(7, 11), 'Next week'],
  ];

  return (
    <Modal title={`Log call — ${lead.name}`} onClose={onClose}>
      <div className="field">
        <label>Call type</label>
        <Seg label="Call type" options={CALL_TYPES} value={callType} onChange={(v) => { setCallType(v); setOutcome(null); }} />
      </div>
      <div className="field">
        <label>What happened?</label>
        <Seg label="What happened" options={DISPOSITIONS} value={disposition} onChange={setDisposition} />
      </div>
      {disposition === 'connected' && (
        <div className="field">
          <label>Outcome</label>
          <Seg label="Outcome" options={OUTCOMES[callType]} value={outcome} onChange={setOutcome} />
        </div>
      )}
      <Field label="Notes">
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="What did they say?" />
      </Field>
      <div className="field">
        <label>Next follow-up</label>
        <div className="seg" role="group" aria-label="Follow-up presets" style={{ marginBottom: 7 }}>
          {presets.map(([val, lbl]) => (
            <button key={lbl} type="button" className={followUpAt === val ? 'on' : ''}
              aria-pressed={followUpAt === val} onClick={() => setFollowUpAt(val)}>{lbl}</button>
          ))}
          {followUpAt && <button type="button" onClick={() => setFollowUpAt('')}>✕ Clear</button>}
        </div>
        <input type="datetime-local" aria-label="Follow-up date and time" value={followUpAt}
          onChange={(e) => setFollowUpAt(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save call'}</button>
      </div>
    </Modal>
  );
}

export function TaskModal({ lead, project, onClose, onSaved }) {
  const { showToast } = useApp();
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [dueDate, setDueDate] = useState(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  const [save, saving] = useSubmit(async () => {
    try {
      await api.post('/api/tasks', {
        title: title.trim(), details, due_date: dueDate,
        lead_id: lead ? lead.id : undefined,
        project_id: project ? project.id : undefined,
      });
      showToast('Task added ✓');
      if (onSaved) onSaved();
      onClose();
    } catch (err) { showToast(err.message, 'error'); }
  });
  return (
    <Modal title={lead ? `Task for ${lead.name}` : project ? `Task in ${project.name}` : 'New task'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) save(); }}>
        <Field label="What needs doing?">
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
            placeholder="e.g. Send course brochure on WhatsApp" />
        </Field>
        <div className="form-grid">
          <Field label="Due date">
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Details (optional)">
            <input value={details} onChange={(e) => setDetails(e.target.value)} />
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={saving || !title.trim()}>{saving ? 'Adding…' : 'Add task'}</button>
        </div>
      </form>
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
  const { user, showToast, askConfirm } = useApp();
  const editing = !!block;
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(() => ({
    title: (block && block.title) || '',
    block_type: (block && block.block_type) || 'Deep Work',
    start: utcIsoToDtLocal((block && block.start_at) || (prefill && prefill.start_at) || ''),
    end: utcIsoToDtLocal((block && block.end_at) || (prefill && prefill.end_at) || ''),
    notes: (block && block.notes) || '',
    owner_id: String((block && block.owner_id) || user.id),
  }));
  const [conflict, setConflict] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (admin) api.get('/api/users').then((u) => setUsers(u.filter(isAssignable))).catch(() => {});
  }, [admin]);

  const [save, saving] = useSubmit(async () => {
    if (!form.title.trim()) return showToast('Title required', 'error');
    if (!form.start || !form.end) return showToast('Pick a start and end time', 'error');
    const start_at = dtLocalToUtcIso(form.start);
    const end_at = dtLocalToUtcIso(form.end);
    if (!(new Date(start_at) < new Date(end_at))) return showToast('Start must be before end', 'error');
    setConflict(null);
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
    }
    return undefined;
  });

  const [remove, removing] = useSubmit(async () => {
    if (!(await askConfirm({ title: 'Delete this time block?', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.del(`/api/time-blocks/${block.id}`); showToast('Time block deleted'); onSaved(); }
    catch (err) { showToast(err.message, 'error'); }
  });

  return (
    <Modal title={editing ? 'Edit time block' : 'New time block'} onClose={onClose}>
      <Field label="Title">
        <input value={form.title} onChange={set('title')} autoFocus placeholder="e.g. Focus: proposal draft" />
      </Field>
      <div className="form-grid">
        <Field label="Type">
          <select value={form.block_type} onChange={set('block_type')}>
            {BLOCK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        {admin && (
          <Field label="Owner">
            <select value={form.owner_id} onChange={set('owner_id')}>
              {(users.length ? users : [{ id: user.id, full_name: user.full_name }])
                .map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </Field>
        )}
      </div>
      <div className="form-grid">
        <Field label="Start (IST)">
          <input type="datetime-local" value={form.start} onChange={set('start')} />
        </Field>
        <Field label="End (IST)">
          <input type="datetime-local" value={form.end} onChange={set('end')} />
        </Field>
      </div>
      <Field label="Notes (optional)">
        <textarea rows={2} value={form.notes} onChange={set('notes')} />
      </Field>
      {conflict && (
        <div className="inline-warn" role="alert">⚠️ {conflict}</div>
      )}
      <div className="modal-actions">
        {editing && <button type="button" className="btn secondary danger-text" disabled={removing} onClick={remove}>Delete</button>}
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : (editing ? 'Save' : 'Create')}</button>
      </div>
    </Modal>
  );
}

// ---------- searchable lead picker (CLIENT-7) ----------
// Server-side search (/api/leads?q=&limit=20) instead of loading every lead.
// value = lead id ('' for none); onChange(id, lead). `selected` pre-fills the
// chosen row when editing.
export function LeadPicker({
  value, onChange, selected, allowNone = true, noneLabel = 'No lead',
  placeholder = 'Search by name / phone / city…', id,
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [chosen, setChosen] = useState(selected || null);
  const dq = useDebouncedValue(q, 300);
  const wrapRef = useRef(null);
  const autoId = useId();
  const listId = useId();
  const inputId = id || autoId;
  const selectedId = selected && selected.id;

  useEffect(() => { if (selected) setChosen(selected); }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const ctrl = new AbortController();
    let alive = true;
    setLoading(true); setError(null);
    const qs = new URLSearchParams({ limit: '20' });
    if (dq.trim()) qs.set('q', dq.trim());
    api.get(`/api/leads?${qs}`, { signal: ctrl.signal })
      .then((d) => { if (alive) { setResults(d.leads || []); setLoading(false); } })
      .catch((e) => { if (!alive || e.name === 'AbortError') return; setError(e); setLoading(false); });
    return () => { alive = false; ctrl.abort(); };
  }, [open, dq]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (l) => {
    setChosen(l);
    onChange(l ? l.id : '', l);
    setOpen(false);
    setQ('');
  };

  if (value && chosen) {
    return (
      <div className="lead-picker" ref={wrapRef}>
        <div className="lead-picker-chosen">
          <span className="lead-picker-name">{chosen.name}{chosen.phone ? ` · ${chosen.phone}` : ''}</span>
          <button type="button" className="btn small secondary"
            onClick={() => { setChosen(null); onChange('', null); setOpen(true); }}>Change</button>
        </div>
      </div>
    );
  }

  return (
    <div className="lead-picker" ref={wrapRef}>
      <input id={inputId} type="search" autoComplete="off" role="combobox" aria-expanded={open}
        aria-controls={listId} aria-autocomplete="list" placeholder={placeholder} value={q}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }} />
      {open && (
        <div className="lead-picker-list" id={listId} role="listbox">
          {allowNone && (
            <button type="button" role="option" aria-selected={!value} className="lead-picker-item none" onClick={() => pick(null)}>
              {noneLabel}
            </button>
          )}
          {loading && <div className="lead-picker-hint">Searching…</div>}
          {error && <div className="lead-picker-hint err">{error.message}</div>}
          {!loading && !error && results.length === 0 && <div className="lead-picker-hint">No leads match</div>}
          {results.map((l) => (
            <button type="button" key={l.id} role="option" aria-selected={String(l.id) === String(value)}
              className="lead-picker-item" onClick={() => pick(l)}>
              <span className="lead-picker-main"><b>{l.name}</b> <span>{l.phone}{l.city ? ` · ${l.city}` : ''}</span></span>
              <StageBadge stage={l.stage} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- WhatsApp templates ----------
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
  const { user, showToast } = useApp();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);

  const openPicker = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      setData(await loadTemplateCtx());
      setOpen(true);
    } catch (err) { showToast(err.message, 'error'); }
  };

  const ctx = {
    name: (lead.name && lead.name.split(' ')[0]) || lead.name,
    caller_name: user.full_name && user.full_name.split(' ')[0],
    company: data && data.company,
    product: context.product,
    amount_due: context.amount_due_paise != null ? rupees(context.amount_due_paise) : '',
    due_date: context.due_date ? fmtDate(context.due_date) : '',
  };

  return (
    <>
      <button type="button" className="act-btn wa" title="WhatsApp" aria-label={`WhatsApp ${lead.name || ''}`} onClick={openPicker}>💬</button>
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
                  <span style={{ fontSize: 20 }} aria-hidden="true">💬</span>
                </a>
              );
            })}
            <a className="lead-row" href={waLink(lead.phone)} target="_blank" rel="noreferrer"
              onClick={() => setOpen(false)}>
              <div className="info">
                <div className="name">No template</div>
                <div className="meta">Open a blank WhatsApp chat</div>
              </div>
              <span style={{ fontSize: 20 }} aria-hidden="true">💬</span>
            </a>
          </div>
        </Modal>
      )}
    </>
  );
}

// Lead name that is also a real link (keyboard reachable) inside a clickable row.
export function LeadLink({ id, children, className = 'name-link' }) {
  return <Link to={`/leads/${id}`} className={className} onClick={(e) => e.stopPropagation()}>{children}</Link>;
}
