import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime, telLink } from '../api.js';
import { useApp } from '../App.jsx';
import { Modal, StageBadge } from '../components.jsx';

const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const DIR_ICON = { incoming: '📥', outgoing: '📤', missed: '❌' };

function Audio({ id }) {
  return (
    <audio controls preload="none" style={{ height: 36, maxWidth: '100%' }}
      src={`/api/review/audio/${id}`} />
  );
}

const QUICK_OUTCOMES = [
  ['interested', '😊 Interested'], ['not_interested', '🙅 Not interested'],
  ['callback_requested', '📞 Callback'], ['wrong_person', '🤷 Wrong person'],
];

export default function Review() {
  const { showToast } = useApp();
  const [captured, setCaptured] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [untagged, setUntagged] = useState([]);
  const [naming, setNaming] = useState(null); // captured row being made a lead
  const [name, setName] = useState('');

  const load = useCallback(() => {
    api.get('/api/review/captured').then(setCaptured).catch(() => {});
    api.get('/api/review/recordings').then(setRecordings).catch(() => {});
    api.get('/api/review/untagged').then(setUntagged).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const createLead = async () => {
    try {
      const res = await api.post(`/api/review/captured/${naming.id}/create-lead`, { name });
      showToast('Lead created ✓');
      setNaming(null); setName('');
      load();
      return res;
    } catch (err) { showToast(err.message, 'error'); }
  };

  const ignore = async (row, always) => {
    try {
      await api.post(`/api/review/captured/${row.id}/ignore`, { always });
      showToast(always ? 'Number ignored forever' : 'Ignored');
      load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  // Attach a captured call to an existing lead instead of making a duplicate.
  const attachExisting = async (row, cand, asFollowUp) => {
    try {
      await api.post(`/api/review/captured/${row.id}/attach-existing`, {
        lead_id: cand.id,
        as_follow_up: asFollowUp,
        follow_up_at: asFollowUp ? new Date(Date.now() + 86400000).toISOString() : undefined,
      });
      showToast(asFollowUp ? `Logged under ${cand.name} + follow-up ✓` : `Logged under ${cand.name} ✓`);
      load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const attach = async (rec, candidate) => {
    try {
      await api.post(`/api/review/recordings/${rec.id}/attach`, {
        call_id: candidate.call_id || undefined,
        captured_call_id: candidate.captured_call_id || undefined,
      });
      showToast('Recording attached ✓');
      load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const tagCall = async (call, outcome) => {
    try {
      await api.patch(`/api/review/calls/${call.id}`, { outcome });
      showToast('Saved ✓');
      load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const empty = !captured.length && !recordings.length && !untagged.length;

  return (
    <>
      <div className="page-title"><h1>Review</h1></div>
      {empty && (
        <div className="card empty"><div className="big">✨</div>
          Nothing to review. New numbers and synced calls from the mobile app will appear here.</div>
      )}

      {captured.length > 0 && (
        <>
          <div className="section-label">📲 New numbers from synced calls ({captured.length})</div>
          <div className="row-list">
            {captured.map((c) => (
              <div key={c.id} className="lead-row">
                <div className="info">
                  <div className="name">{c.phone}
                    {c.call_count > 1 && <span className="badge new" style={{ marginLeft: 6 }}>{c.call_count} calls</span>}
                    {c.recording_count > 0 && <span className="badge due" style={{ marginLeft: 6 }}>🎙 recorded</span>}
                  </div>
                  <div className="meta">
                    {DIR_ICON[c.direction]} {c.direction} · {fmtDur(c.duration_seconds)} · {fmtDateTime(new Date(c.call_log_ts).toISOString())} · {c.user_name}
                  </div>
                  {c.lead_candidates?.length > 0 && (
                    <div className="meta" style={{ marginTop: 6 }}>
                      <span style={{ color: 'var(--ink-soft)' }}>Looks like an existing lead — log it there instead of creating a new one:</span>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        {c.lead_candidates.map((cand) => (
                          <span key={cand.id} style={{ display: 'inline-flex', gap: 4 }}>
                            <button className="btn small green" onClick={() => attachExisting(c, cand, false)}>
                              Log under {cand.name}{cand.match === 'alt_phone' ? ' (alt #)' : ''}
                            </button>
                            <button className="btn small secondary" title="Log the call and schedule a follow-up tomorrow"
                              onClick={() => attachExisting(c, cand, true)}>+ follow-up</button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="actions" style={{ flexWrap: 'wrap' }}>
                  <a className="act-btn call" href={telLink(c.phone)} title="Call back">📞</a>
                  <button className="btn small green" onClick={() => { setNaming(c); setName(''); }}>+ Lead</button>
                  <button className="btn small secondary" onClick={() => ignore(c, false)}>Ignore</button>
                  <button className="btn small secondary" title="Never show this number again"
                    onClick={() => ignore(c, true)}>Never</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {recordings.length > 0 && (
        <>
          <div className="section-label">🎙 Recordings to place ({recordings.length})</div>
          <div className="row-list">
            {recordings.map((r) => (
              <div key={r.id} className="card" style={{ marginBottom: 0 }}>
                <div className="name" style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                  {r.original_filename}
                </div>
                <div className="meta" style={{ color: 'var(--ink-soft)', fontSize: 12.5, marginBottom: 8 }}>
                  {r.duration_seconds ? `${fmtDur(r.duration_seconds)} · ` : ''}{r.user_name} · couldn't match automatically
                </div>
                <Audio id={r.id} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                  {r.candidates.map((c, i) => (
                    <button key={i} className="btn small secondary" onClick={() => attach(r, c)}>
                      → {c.label} ({c.phone}, {fmtDur(c.duration_seconds)})
                    </button>
                  ))}
                  {!r.candidates.length && <span className="meta">No nearby calls found — sync calls first.</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {untagged.length > 0 && (
        <>
          <div className="section-label">✍️ What happened on these calls? ({untagged.length})</div>
          <div className="row-list">
            {untagged.map((c) => (
              <div key={c.id} className="card" style={{ marginBottom: 0 }}>
                <div className="name" style={{ fontWeight: 700, fontSize: 14 }}>
                  <Link to={`/leads/${c.lead_id}`}>{c.name}</Link> <StageBadge stage={c.stage} />
                </div>
                <div className="meta" style={{ color: 'var(--ink-soft)', fontSize: 12.5, margin: '3px 0 8px' }}>
                  {DIR_ICON[c.direction] || '📞'} {fmtDur(c.duration_seconds || 0)} · {fmtDateTime(c.called_at)}
                </div>
                {c.recording_id && <div style={{ marginBottom: 8 }}><Audio id={c.recording_id} /></div>}
                <div className="seg">
                  {QUICK_OUTCOMES.map(([val, label]) => (
                    <button key={val} onClick={() => tagCall(c, val)}>{label}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {naming && (
        <Modal title={`New lead — ${naming.phone}`} onClose={() => setNaming(null)}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
              placeholder={`Unknown ${naming.phone}`} />
          </div>
          <div className="modal-actions">
            <button className="btn secondary" onClick={() => setNaming(null)}>Cancel</button>
            <button className="btn green" onClick={createLead}>Create lead</button>
          </div>
        </Modal>
      )}
    </>
  );
}
