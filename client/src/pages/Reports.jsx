import React, { useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  LineChart, Line, CartesianGrid, PieChart, Pie, Cell,
} from 'recharts';
import { api, rupees, rupeesFromRupees, todayIstDate, daysAgo } from '../api.js';
import { useApp } from '../ctx.js';
import { useDebouncedValue, useRequest } from '../hooks.js';
import { ErrorState, LoadingState } from '../components.jsx';

const COLORS = ['#4f46e5', '#0e9f6e', '#c27803', '#e02424', '#1c64f2', '#7e22ce'];

// Prefer the exact integer-paise sibling the server now sends; fall back to
// the rupee number (exact 2-dp on new servers, possibly rounded on old ones).
const money = (row, paiseKey, rupeeKey) => (
  row[paiseKey] != null ? rupees(row[paiseKey]) : rupeesFromRupees(row[rupeeKey])
);

function CsvButton({ onClick }) {
  return <button type="button" className="btn small secondary" style={{ float: 'right' }} onClick={onClick}>CSV</button>;
}

export default function Reports() {
  const { showToast } = useApp();
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(todayIstDate());
  const [period, setPeriod] = useState('today');
  const [showAllDaily, setShowAllDaily] = useState(false);
  // Typing in a date field fires per keystroke — settle before refetching five endpoints.
  const dFrom = useDebouncedValue(from, 400);
  const dTo = useDebouncedValue(to, 400);

  const summaryReq = useRequest(({ signal }) => api.get('/api/reports/summary', { signal }), []);
  const boardReq = useRequest(({ signal }) => api.get(`/api/reports/leaderboard?period=${period}`, { signal }), [period]);
  const rangeReq = useRequest(async ({ signal }) => {
    const q = `?from=${dFrom}&to=${dTo}`;
    const [trend, agentDaily, funnel, products, sources] = await Promise.all([
      api.get(`/api/reports/daily-trend${q}`, { signal }),
      api.get(`/api/reports/agent-daily${q}`, { signal }),
      api.get(`/api/reports/funnel${q}`, { signal }),
      api.get(`/api/reports/revenue-by-product${q}`, { signal }),
      api.get(`/api/reports/sources${q}`, { signal }),
    ]);
    return { trend, agentDaily, funnel, products, sources };
  }, [dFrom, dTo]);

  const summary = summaryReq.data;
  const leaderboard = boardReq.data;
  const range = rangeReq.data;
  const trend = (range && range.trend) || [];
  const agentDaily = (range && range.agentDaily) || [];
  const funnel = range && range.funnel;
  const products = (range && range.products) || [];
  const sources = (range && range.sources) || [];

  const csv = (path) => `${path}?from=${dFrom}&to=${dTo}&format=csv`;

  // Download via fetch + Blob, not a plain <a href> to the CSV endpoint. The
  // blob path downloads consistently across the browser, the desktop app, and
  // the Android WebView, and lets us set a clear, date-stamped filename.
  const downloadCsv = async (path, name) => {
    try {
      const res = await fetch(csv(path), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}-${dFrom}-to-${dTo}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      showToast(`Could not download the CSV — ${e.message}`, 'error');
    }
  };

  const dailyRows = showAllDaily ? agentDaily : agentDaily.slice(0, 60);

  return (
    <>
      <div className="page-title"><h1>Reports</h1></div>

      {summaryReq.error && !summary && <ErrorState error={summaryReq.error} onRetry={summaryReq.reload} compact />}
      {summary && (
        <div className="stat-grid">
          <div className="stat"><div className="label">Calls today</div>
            <div className="value">{summary.calls_today}</div>
            <div className="sub">{summary.connects_today} connected</div></div>
          <div className="stat"><div className="label">Deals today</div>
            <div className="value">{summary.deals_today}</div>
            <div className="sub">{rupees(summary.deal_value_today_paise)}</div></div>
          <div className="stat"><div className="label">Collected this month</div>
            <div className="value" style={{ color: 'var(--green-text)' }}>{rupees(summary.collected_month_paise)}</div></div>
          <div className="stat"><div className="label">Overdue EMIs</div>
            <div className="value" style={{ color: summary.overdue_installments ? 'var(--red-text)' : undefined }}>
              {summary.overdue_installments}</div>
            <div className="sub">{rupees(summary.overdue_amount_paise)} still owed on past-due installments</div></div>
        </div>
      )}

      <div className="card">
        <h2>🏆 Leaderboard</h2>
        <div className="tabs" role="tablist" aria-label="Leaderboard period">
          {['today', 'week', 'month'].map((p) => (
            <button key={p} type="button" role="tab" aria-selected={period === p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>
              {p === 'today' ? 'Today' : p === 'week' ? 'This week' : 'This month'}
            </button>
          ))}
        </div>
        {boardReq.error && !leaderboard && <ErrorState error={boardReq.error} onRetry={boardReq.reload} compact />}
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>Caller</th><th className="num">Calls</th><th className="num">Connects</th>
              <th className="num">Connect %</th><th className="num">Leads</th>
              <th className="num">Deals</th><th className="num">Collected</th>
            </tr></thead>
            <tbody>
              {leaderboard && leaderboard.rows.map((r, i) => (
                <tr key={r.id}>
                  <td>{['🥇', '🥈', '🥉'][i] || ''} <b>{r.full_name}</b></td>
                  <td className="num">{r.dials}{r.calls_target_period ? ` / ${r.calls_target_period}` : ''}</td>
                  <td className="num">{r.connects}{r.connects_target_period ? ` / ${r.connects_target_period}` : ''}</td>
                  <td className="num">{r.connect_rate}%</td>
                  <td className="num">{r.unique_leads}</td>
                  <td className="num">{r.deals}{r.deals_target_period ? ` / ${r.deals_target_period}` : ''}</td>
                  <td className="num">{rupees(r.collected_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="filter-bar">
        <label htmlFor="rep-from" style={{ fontSize: 13, color: 'var(--ink-soft)', fontWeight: 600 }}>Period:</label>
        <input id="rep-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span aria-hidden="true">→</span>
        <input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        {rangeReq.loading && <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>Updating…</span>}
      </div>

      {rangeReq.error && !range && <ErrorState error={rangeReq.error} onRetry={rangeReq.reload} />}
      {rangeReq.error && range && <ErrorState error={rangeReq.error} onRetry={rangeReq.reload} compact />}
      {rangeReq.loading && !range && <LoadingState compact />}

      <div className="card">
        <h2>📈 Daily activity</h2>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={trend} margin={{ top: 5, right: 10, bottom: 0, left: -18 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e3e6ef" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="dials" name="Calls" stroke="#4f46e5" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="connects" name="Connects" stroke="#0e9f6e" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="deals" name="Deals" stroke="#c27803" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h2>🔻 Funnel ({funnel && funnel.period ? `${funnel.period.from} → ${funnel.period.to}` : `${dFrom} → ${dTo}`})
          <CsvButton onClick={() => downloadCsv('/api/reports/funnel', 'funnel')} /></h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={(funnel && funnel.rows) || []} margin={{ top: 5, right: 10, bottom: 0, left: -18 }}>
            <XAxis dataKey="stage" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="leads" name="Leads" radius={[6, 6, 0, 0]}>
              {((funnel && funnel.rows) || []).map((r, i) => <Cell key={r.stage || i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h2>💰 Revenue by product
          <CsvButton onClick={() => downloadCsv('/api/reports/revenue-by-product', 'revenue-by-product')} /></h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <ResponsiveContainer width={220} height={200}>
            <PieChart>
              <Pie data={products} dataKey="collected_rupees" nameKey="product" innerRadius={45} outerRadius={80}>
                {products.map((p, i) => <Cell key={p.product} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => rupeesFromRupees(v)} />
            </PieChart>
          </ResponsiveContainer>
          <div className="table-wrap" style={{ flex: 1, minWidth: 260 }}>
            <table className="data">
              <thead><tr><th>Product</th><th className="num">Deals</th><th className="num">Deal value</th><th className="num">Collected</th></tr></thead>
              <tbody>
                {products.map((p, i) => (
                  <tr key={p.product}>
                    <td><span style={{ color: COLORS[i % COLORS.length] }} aria-hidden="true">●</span> {p.product}</td>
                    <td className="num">{p.deals}</td>
                    <td className="num">{money(p, 'deal_value_paise', 'deal_value_rupees')}</td>
                    <td className="num">{money(p, 'collected_paise', 'collected_rupees')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>📣 Lead sources
          <CsvButton onClick={() => downloadCsv('/api/reports/sources', 'lead-sources')} /></h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Contacted</th>
              <th className="num">Interested</th><th className="num">Won</th><th className="num">Win rate</th></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.source}>
                  <td><b>{s.source}</b></td>
                  <td className="num">{s.leads}</td>
                  <td className="num">{s.contacted}</td>
                  <td className="num">{s.interested}</td>
                  <td className="num">{s.won}</td>
                  <td className="num">{s.win_rate_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>👥 Agent activity by day
          <CsvButton onClick={() => downloadCsv('/api/reports/agent-daily', 'agent-activity')} /></h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Day</th><th>Agent</th><th className="num">Calls</th><th className="num">Connects</th>
              <th className="num">Connect %</th><th className="num">Leads</th><th className="num">Deals</th>
              <th className="num">Deal value</th></tr></thead>
            <tbody>
              {dailyRows.map((r) => (
                <tr key={`${r.day}-${r.agent}`}>
                  <td>{r.day}</td><td>{r.agent}</td>
                  <td className="num">{r.dials}</td><td className="num">{r.connects}</td>
                  <td className="num">{r.connect_rate_pct}%</td><td className="num">{r.unique_leads}</td>
                  <td className="num">{r.deals}</td>
                  <td className="num">{money(r, 'deal_value_paise', 'deal_value_rupees')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {agentDaily.length > 60 && (
          <div className="inline-note" style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span>Showing {dailyRows.length} of {agentDaily.length} rows (the CSV always has all of them).</span>
            <button type="button" className="btn small secondary" onClick={() => setShowAllDaily((v) => !v)}>
              {showAllDaily ? 'Show first 60' : `Show all ${agentDaily.length}`}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
