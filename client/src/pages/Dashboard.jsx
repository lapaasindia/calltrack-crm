// Phase 5B — Role-aware dashboard. KPI stat cards (clickable to drill into the
// relevant list), an inline-SVG bar chart (revenue/leads/deals per IST day),
// Top Performers (admin/manager only), Upcoming Follow-ups, and an AI
// Intelligence panel. Callers see only their own numbers; the server enforces
// scope — this page just renders what it gets. Money via rupees(paise); dates
// via the api.js helpers. No chart library — all visuals are inline SVG/CSS.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rupees, fmtDateTime, todayIstDate } from '../api.js';
import { useApp } from '../App.jsx';
import { isAdmin } from '../permissions.js';

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

const PRESETS = [
  { key: '7', label: '7 days', from: () => daysAgo(6) },
  { key: '30', label: '30 days', from: () => daysAgo(29) },
  { key: '90', label: '90 days', from: () => daysAgo(89) },
];

function StatCard({ label, value, sub, color = 'var(--brand)', onClick }) {
  return (
    <button
      type="button"
      className="card"
      onClick={onClick}
      style={{
        padding: '14px 16px', margin: 0, textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
        border: '1px solid var(--line)', background: 'var(--card, #fff)', width: '100%',
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>{label}</div>
      {sub != null && <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 2 }}>{sub}</div>}
    </button>
  );
}

// Inline-SVG grouped bar chart for the per-day trend. Revenue is shown as its
// own scale (rupees) alongside count bars (leads/deals) — kept simple: two
// normalized bar groups so a glance reveals momentum, exact figures on hover.
function TrendChart({ trend }) {
  const data = trend || [];
  const W = 720; const H = 200; const padL = 8; const padR = 8; const padB = 22; const padT = 8;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = Math.max(data.length, 1);
  const slot = innerW / n;
  const barW = Math.max(2, Math.min(14, slot / 4));

  const maxRevenue = Math.max(1, ...data.map((d) => d.revenuePaise || 0));
  const maxCount = Math.max(1, ...data.map((d) => Math.max(d.leads || 0, d.deals || 0)));

  if (!data.length) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--ink-faint)' }}>No activity in this range.</div>;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Trend chart" style={{ display: 'block' }}>
      {/* baseline */}
      <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="var(--line)" strokeWidth="1" />
      {data.map((d, i) => {
        const x = padL + i * slot + slot / 2;
        const revH = ((d.revenuePaise || 0) / maxRevenue) * innerH;
        const leadH = ((d.leads || 0) / maxCount) * innerH;
        const dealH = ((d.deals || 0) / maxCount) * innerH;
        const base = padT + innerH;
        const showLabel = data.length <= 31 ? (i % Math.ceil(data.length / 10) === 0) : (i % Math.ceil(data.length / 12) === 0);
        return (
          <g key={d.day}>
            <title>{`${d.day}\nRevenue: ${rupees(d.revenuePaise || 0)}\nLeads: ${d.leads || 0}\nDeals: ${d.deals || 0}`}</title>
            <rect x={x - barW * 1.5} y={base - revH} width={barW} height={revH} rx="1" fill="var(--green)" />
            <rect x={x - barW / 2} y={base - leadH} width={barW} height={leadH} rx="1" fill="var(--blue)" />
            <rect x={x + barW / 2} y={base - dealH} width={barW} height={dealH} rx="1" fill="var(--brand)" />
            {showLabel && (
              <text x={x} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--ink-faint)">
                {d.day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Legend() {
  const item = (color, label) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--ink-soft)' }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
      {item('var(--green)', 'Revenue')}
      {item('var(--blue)', 'Leads')}
      {item('var(--brand)', 'Deals won')}
    </div>
  );
}

const SENTIMENT_COLOR = {
  positive: 'var(--green)', neutral: 'var(--ink-soft)', negative: 'var(--red)', mixed: 'var(--amber)',
};

function SentimentBar({ sentiment }) {
  const total = Object.values(sentiment || {}).reduce((a, b) => a + b, 0);
  if (!total) return <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>No analyzed calls yet.</div>;
  return (
    <div>
      <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', border: '1px solid var(--line)' }}>
        {Object.entries(sentiment).map(([k, v]) => (
          v > 0 ? <div key={k} title={`${k}: ${v}`} style={{ width: `${(v / total) * 100}%`, background: SENTIMENT_COLOR[k] }} /> : null
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
        {Object.entries(sentiment).map(([k, v]) => (
          <span key={k} style={{ fontSize: 11, color: 'var(--ink-soft)' }}>
            <span style={{ color: SENTIMENT_COLOR[k] }}>●</span> {k} {v}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user, showToast } = useApp();
  const navigate = useNavigate();
  const admin = isAdmin(user.role);
  const [preset, setPreset] = useState('30');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => {
    const p = PRESETS.find((x) => x.key === preset) || PRESETS[1];
    return { from: p.from(), to: todayIstDate() };
  }, [preset]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/api/dashboard?from=${range.from}&to=${range.to}`)
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch((e) => { if (alive) { setLoading(false); } showToast(e.message, 'error'); });
    return () => { alive = false; };
  }, [range.from, range.to, showToast]);

  const k = data?.kpis;

  return (
    <>
      <div className="page-title">
        <h1>Dashboard</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                style={{
                  padding: '6px 12px', border: 0, cursor: 'pointer', fontSize: 13,
                  background: preset === p.key ? 'var(--brand)' : 'transparent',
                  color: preset === p.key ? '#fff' : 'var(--ink-soft)',
                }}
              >{p.label}</button>
            ))}
          </div>
          <button className="btn" onClick={() => window.open('/api/dashboard/weekly.html', '_blank', 'noopener')}>
            🖨️ Weekly report
          </button>
        </div>
      </div>

      {loading && !data && <div className="card" style={{ padding: 24 }}>Loading…</div>}

      {k && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 14 }}>
            <StatCard label="Total leads" value={k.totalLeads} color="var(--blue)" onClick={() => navigate('/leads')} />
            <StatCard label="Pipeline value" value={rupees(k.pipelineValuePaise)} color="var(--brand)" onClick={() => navigate('/leads')} />
            <StatCard label={`Revenue (${data.range.from.slice(5)}–${data.range.to.slice(5)})`} value={rupees(k.revenuePaise)} color="var(--green)" onClick={() => navigate('/collections')} />
            <StatCard label="Active projects" value={k.activeProjects} color="var(--amber)" onClick={() => navigate('/projects')} />
            <StatCard label="Calls" value={k.callsInRange} sub={`${k.connectsInRange} connected`} color="var(--ink)" onClick={() => navigate('/leads')} />
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3 style={{ margin: 0 }}>Daily trend</h3>
              <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{data.scope === 'team' ? 'Company-wide' : 'Your activity'}</span>
            </div>
            <TrendChart trend={data.trend} />
            <Legend />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: admin ? '1fr 1fr' : '1fr', gap: 14, marginTop: 14, alignItems: 'start' }}>
            {admin && (
              <div className="card">
                <h3 style={{ marginTop: 0 }}>Top performers</h3>
                {data.topPerformers.length === 0 ? (
                  <div style={{ color: 'var(--ink-faint)', fontSize: 13 }}>No activity in this range.</div>
                ) : (
                  <div className="row-list">
                    {data.topPerformers.map((p, i) => (
                      <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                        <span style={{ width: 22, textAlign: 'center', fontWeight: 800, color: i === 0 ? 'var(--amber)' : 'var(--ink-faint)' }}>
                          {i === 0 ? '🏆' : i + 1}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{p.full_name}</div>
                          <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                            {p.calls} calls · {p.connects} connects · {p.deals} deals · {p.leads} leads
                          </div>
                        </div>
                        <div style={{ fontWeight: 700, color: 'var(--green)', whiteSpace: 'nowrap' }}>{rupees(p.revenuePaise)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="card">
              <h3 style={{ marginTop: 0 }}>Upcoming follow-ups <span style={{ fontSize: 12, color: 'var(--ink-faint)', fontWeight: 400 }}>(next 7 days)</span></h3>
              {data.upcomingFollowups.length === 0 ? (
                <div style={{ color: 'var(--ink-faint)', fontSize: 13 }}>Nothing scheduled. 🎉</div>
              ) : (
                <div className="row-list">
                  {data.upcomingFollowups.map((f) => (
                    <button
                      key={f.id}
                      className="lead-row"
                      style={{ width: '100%', textAlign: 'left' }}
                      onClick={() => navigate(`/leads/${f.lead_id}`)}
                    >
                      <div className="info">
                        <div className="name">{f.lead_name}</div>
                        <div className="meta">
                          {fmtDateTime(f.due_at)}
                          {admin && f.owner_name ? ` · ${f.owner_name}` : ''}
                          {f.reason ? ` · ${f.reason}` : ''}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <h3 style={{ margin: 0 }}>Call intelligence</h3>
              <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                {data.intelligence.analyzedCount} analyzed
                {data.intelligence.avgRating != null && ` · avg rating ${data.intelligence.avgRating}/10`}
              </span>
            </div>
            <div style={{ margin: '12px 0' }}>
              <SentimentBar sentiment={data.intelligence.sentiment} />
            </div>
            {data.intelligence.recent.length > 0 && (
              <div className="row-list" style={{ marginTop: 8 }}>
                {data.intelligence.recent.map((r) => (
                  <button
                    key={r.id}
                    className="lead-row"
                    style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => r.lead_id && navigate(`/leads/${r.lead_id}`)}
                  >
                    <div className="info">
                      <div className="name" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        {r.lead_name || 'Unmatched call'}
                        {r.intent && <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 999, background: 'var(--brand-soft)', color: 'var(--brand)' }}>{r.intent}</span>}
                        {r.sentiment && <span style={{ fontSize: 11, color: SENTIMENT_COLOR[String(r.sentiment).toLowerCase()] || 'var(--ink-soft)' }}>● {r.sentiment}</span>}
                        {r.overall != null && <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{r.overall}/10</span>}
                      </div>
                      {r.summary && <div className="meta" style={{ whiteSpace: 'normal' }}>{r.summary}</div>}
                      {r.coaching && <div className="meta" style={{ color: 'var(--amber)', whiteSpace: 'normal' }}>💡 {r.coaching}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
