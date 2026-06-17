import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, todayIstDate, fmtDate } from '../api.js';
import { useApp } from '../App.jsx';
import { isAdmin } from '../permissions.js';

const GRADE_COLOR = {
  'A+': 'var(--green)', A: 'var(--green)', B: 'var(--blue)',
  C: 'var(--amber)', D: 'var(--amber)', F: 'var(--red)', 'N/A': 'var(--ink-faint)',
};

// One 0..10 skill axis as an inline CSS bar (NO chart library).
function SkillBar({ label, value }) {
  const v = value == null ? null : Math.max(0, Math.min(10, value));
  const pct = v == null ? 0 : v * 10;
  const color = v == null ? 'var(--line)' : v >= 8 ? 'var(--green)' : v >= 5 ? 'var(--amber)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <span style={{ width: 96, fontSize: 13, color: 'var(--ink-soft)' }}>{label}</span>
      <span style={{ flex: 1, height: 10, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color, transition: 'width .3s' }} />
      </span>
      <b style={{ width: 44, textAlign: 'right', fontSize: 13 }}>{v == null ? '—' : `${v}/10`}</b>
    </div>
  );
}

// 7-day overall-rating sparkline as inline SVG (NO chart library).
function Sparkline({ trend }) {
  const W = 280;
  const H = 70;
  const pad = 8;
  const pts = (trend || []).map((d, i) => ({
    x: pad + (i * (W - 2 * pad)) / Math.max(1, (trend.length - 1)),
    y: d.avg == null ? null : H - pad - ((d.avg / 10) * (H - 2 * pad)),
    raw: d,
  }));
  const drawn = pts.filter((p) => p.y != null);
  const path = drawn.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="7-day rating trend">
      {[0, 5, 10].map((g) => {
        const y = H - pad - (g / 10) * (H - 2 * pad);
        return <line key={g} x1={pad} y1={y} x2={W - pad} y2={y} stroke="var(--line)" strokeWidth="1" />;
      })}
      {drawn.length > 1 && <path d={path} fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
      {pts.map((p, i) => (p.y == null ? null : (
        <circle key={i} cx={p.x} cy={p.y} r="3.5" fill="var(--brand)">
          <title>{`${p.raw.date}: ${p.raw.avg}/10 (${p.raw.calls} call${p.raw.calls === 1 ? '' : 's'})`}</title>
        </circle>
      )))}
    </svg>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub != null && <div className="sub">{sub}</div>}
    </div>
  );
}

function ReportCard({ card }) {
  if (!card) return null;
  const grade = card.grade || 'N/A';
  return (
    <>
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <div style={{
          width: 96, height: 96, borderRadius: 18, display: 'grid', placeItems: 'center',
          background: 'var(--surface)', border: `3px solid ${GRADE_COLOR[grade]}`,
        }}>
          <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, color: GRADE_COLOR[grade] }}>{grade}</div>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2 style={{ margin: '0 0 4px' }}>{card.user_name || 'Your'} report card</h2>
          <div style={{ color: 'var(--ink-soft)', fontSize: 14 }}>{fmtDate(card.date)}</div>
          <div style={{ marginTop: 6, fontSize: 14 }}>
            {card.avgRating != null
              ? <>Average call rating <b>{card.avgRating}/10</b> across {card.analyzedCalls} analyzed call{card.analyzedCalls === 1 ? '' : 's'}.</>
              : <span style={{ color: 'var(--ink-soft)' }}>No analyzed calls yet today — log calls with recordings to get coached.</span>}
          </div>
        </div>
        {card.currentStreak > 0 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 30 }}>🔥</div>
            <div style={{ fontWeight: 800, fontSize: 22 }}>{card.currentStreak}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>day streak</div>
          </div>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Calls today" value={card.callsToday} sub={`${card.connected} connected`} />
        <Stat label="Connect rate" value={card.conversionRate == null ? '—' : `${card.conversionRate}%`} />
        <Stat label="Positive calls" value={card.positivePct == null ? '—' : `${card.positivePct}%`} sub="by sentiment" />
        <Stat label="Hot leads" value={card.hotLeads?.length || 0} sub="to chase today" />
      </div>

      <div className="card">
        <h2>📈 Skills</h2>
        <SkillBar label="Overall" value={card.avgRating} />
        <SkillBar label="Engagement" value={card.engagement} />
        <SkillBar label="Conversion" value={card.conversion} />
        <SkillBar label="Clarity" value={card.clarity} />
      </div>

      <div className="card">
        <h2>🗓️ 7-day trend</h2>
        <Sparkline trend={card.ratingTrend} />
        <div style={{ color: 'var(--ink-soft)', fontSize: 12, marginTop: 4 }}>Average overall rating per day (out of 10).</div>
      </div>

      <div className="two-col" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <div className="card">
          <h2 style={{ color: 'var(--green)' }}>✅ Strengths</h2>
          {card.topStrengths?.length
            ? <ul style={{ margin: 0, paddingLeft: 18 }}>{card.topStrengths.map((s, i) => (
              <li key={i} style={{ marginBottom: 4 }}>{s.text} {s.count > 1 && <span style={{ color: 'var(--ink-faint)' }}>×{s.count}</span>}</li>
            ))}</ul>
            : <div style={{ color: 'var(--ink-soft)' }}>No strengths captured yet.</div>}
        </div>
        <div className="card">
          <h2 style={{ color: 'var(--red)' }}>🎯 Focus areas</h2>
          {card.topFocusAreas?.length
            ? <ul style={{ margin: 0, paddingLeft: 18 }}>{card.topFocusAreas.map((s, i) => (
              <li key={i} style={{ marginBottom: 4 }}>{s.text} {s.count > 1 && <span style={{ color: 'var(--ink-faint)' }}>×{s.count}</span>}</li>
            ))}</ul>
            : <div style={{ color: 'var(--ink-soft)' }}>No focus areas captured yet.</div>}
        </div>
      </div>

      {card.hotLeads?.length > 0 && (
        <div className="card">
          <h2>🔥 Hot leads</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Lead</th><th>Phone</th><th>Intent</th><th>Score</th></tr></thead>
              <tbody>
                {card.hotLeads.map((l) => (
                  <tr key={l.id}>
                    <td><Link to={`/leads/${l.id}`}>{l.name}</Link></td>
                    <td>{l.phone}</td>
                    <td>{l.ai_intent || '—'}</td>
                    <td><b>{l.ai_score ?? l.score ?? '—'}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function LearningForm({ onSaved }) {
  const { showToast } = useApp();
  const [learning, setLearning] = useState('');
  const [win, setWin] = useState('');
  const [challenge, setChallenge] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!learning.trim()) { showToast('Write at least one learning', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/api/coaching/learnings', {
        learning: learning.trim(), win: win.trim() || undefined, challenge: challenge.trim() || undefined,
      });
      setLearning(''); setWin(''); setChallenge('');
      showToast('Logged ✓');
      onSaved?.();
    } catch (err) { showToast(err.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="card">
      <h2>📝 Daily learning check-in</h2>
      <form onSubmit={submit}>
        <div className="field">
          <label>What did you learn today? *</label>
          <textarea rows={2} value={learning} onChange={(e) => setLearning(e.target.value)}
            placeholder="One thing you'll do differently on the next call…" />
        </div>
        <div className="form-grid">
          <div className="field">
            <label>A win 🎉</label>
            <input value={win} onChange={(e) => setWin(e.target.value)} placeholder="e.g. closed a tough objection" />
          </div>
          <div className="field">
            <label>A challenge 😤</label>
            <input value={challenge} onChange={(e) => setChallenge(e.target.value)} placeholder="e.g. pricing pushback" />
          </div>
        </div>
        <button className="btn" disabled={saving}>{saving ? 'Saving…' : 'Log today\'s learning'}</button>
      </form>
    </div>
  );
}

function LearningHistory({ items }) {
  if (!items?.length) return null;
  const SRC = { manual: '✍️', daily_check_in: '📝', deal_closed: '💰' };
  return (
    <div className="card">
      <h2>📚 Recent learnings</h2>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.slice(0, 12).map((l) => (
          <li key={l.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span>{SRC[l.source] || '•'}</span>
              <div style={{ flex: 1 }}>
                <div>{l.learning}</div>
                {(l.win || l.challenge) && (
                  <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>
                    {l.win && <span style={{ color: 'var(--green)' }}>🎉 {l.win}</span>}
                    {l.win && l.challenge && '  ·  '}
                    {l.challenge && <span style={{ color: 'var(--red)' }}>😤 {l.challenge}</span>}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{fmtDate(l.entry_date)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MEDAL = ['🏆', '🥈', '🥉'];

function Leaderboard({ onPick, selectedId }) {
  const [board, setBoard] = useState(null);
  useEffect(() => {
    api.get('/api/coaching/leaderboard').then((d) => setBoard(d.leaderboard)).catch(() => setBoard([]));
  }, []);
  if (!board) return null;
  return (
    <div className="card">
      <h2>🏅 Team leaderboard <span style={{ fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)' }}>(last 7 days)</span></h2>
      {board.length === 0
        ? <div style={{ color: 'var(--ink-soft)' }}>No agents/callers to rank yet.</div>
        : (
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>Member</th><th>Avg rating</th><th>Grade</th><th>Calls</th></tr></thead>
              <tbody>
                {board.map((m, i) => (
                  <tr key={m.user_id}
                    onClick={() => onPick(m.user_id)}
                    style={{ cursor: 'pointer', background: m.user_id === selectedId ? 'var(--brand-soft)' : undefined }}>
                    <td style={{ fontSize: 18 }}>{MEDAL[i] || (i + 1)}</td>
                    <td><b>{m.user_name}</b></td>
                    <td>{m.avgRating == null ? '—' : `${m.avgRating}/10`}</td>
                    <td>{m.grade}</td>
                    <td>{m.analyzedCalls}/{m.callsTotal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

export default function Coaching() {
  const { user } = useApp();
  const admin = isAdmin(user.role);
  const [viewUserId, setViewUserId] = useState(user.id);
  const [card, setCard] = useState(null);
  const [learnings, setLearnings] = useState([]);

  const loadLearnings = useCallback(() => {
    const q = viewUserId === user.id ? '' : `?user_id=${viewUserId}`;
    api.get(`/api/coaching/learnings${q}`).then(setLearnings).catch(() => setLearnings([]));
  }, [viewUserId, user.id]);

  useEffect(() => {
    setCard(null);
    const q = viewUserId === user.id ? '' : `?user_id=${viewUserId}`;
    api.get(`/api/coaching/daily${q}`).then(setCard).catch(() => setCard(null));
    loadLearnings();
  }, [viewUserId, user.id, loadLearnings]);

  const viewingSelf = viewUserId === user.id;

  return (
    <>
      <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1>Coaching</h1>
        {!viewingSelf && (
          <button className="btn small secondary" onClick={() => setViewUserId(user.id)}>← Back to my card</button>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--ink-soft)', fontSize: 13 }}>{todayIstDate()}</span>
      </div>

      {admin && <Leaderboard onPick={setViewUserId} selectedId={viewUserId} />}

      <ReportCard card={card} />

      {viewingSelf && <LearningForm onSaved={loadLearnings} />}
      <LearningHistory items={learnings} />
    </>
  );
}
