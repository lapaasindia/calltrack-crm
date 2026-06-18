import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  LineChart, Line, CartesianGrid, PieChart, Pie, Cell,
} from 'recharts';
import { api, rupees, todayIstDate } from '../api.js';

const COLORS = ['#4f46e5', '#0e9f6e', '#c27803', '#e02424', '#1c64f2', '#7e22ce'];

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

export default function Reports() {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(todayIstDate());
  const [period, setPeriod] = useState('today');
  const [summary, setSummary] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [trend, setTrend] = useState([]);
  const [agentDaily, setAgentDaily] = useState([]);
  const [funnel, setFunnel] = useState(null);
  const [products, setProducts] = useState([]);
  const [sources, setSources] = useState([]);

  useEffect(() => { api.get('/api/reports/summary').then(setSummary).catch(() => {}); }, []);
  useEffect(() => {
    api.get(`/api/reports/leaderboard?period=${period}`).then(setLeaderboard).catch(() => {});
  }, [period]);
  useEffect(() => {
    const q = `?from=${from}&to=${to}`;
    api.get(`/api/reports/daily-trend${q}`).then(setTrend).catch(() => {});
    api.get(`/api/reports/agent-daily${q}`).then(setAgentDaily).catch(() => {});
    api.get(`/api/reports/funnel${q}`).then(setFunnel).catch(() => {});
    api.get(`/api/reports/revenue-by-product${q}`).then(setProducts).catch(() => {});
    api.get(`/api/reports/sources${q}`).then(setSources).catch(() => {});
  }, [from, to]);

  const csv = (path) => `${path}?from=${from}&to=${to}&format=csv`;

  // Download via fetch + blob, NOT a plain <a href> navigation: the desktop app
  // blocks in-window navigations to /api (security 'will-navigate'), which is
  // why the old links did nothing there. A blob download behaves the same in the
  // browser, the desktop app, and the WebView.
  const downloadCsv = async (path, name) => {
    try {
      const res = await fetch(csv(path), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}-${from}-to-${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      alert(`Could not download the CSV — ${e.message}`);
    }
  };

  return (
    <>
      <div className="page-title"><h1>Reports</h1></div>

      {summary && (
        <div className="stat-grid">
          <div className="stat"><div className="label">Calls today</div>
            <div className="value">{summary.calls_today}</div>
            <div className="sub">{summary.connects_today} connected</div></div>
          <div className="stat"><div className="label">Deals today</div>
            <div className="value">{summary.deals_today}</div>
            <div className="sub">{rupees(summary.deal_value_today_paise)}</div></div>
          <div className="stat"><div className="label">Collected this month</div>
            <div className="value" style={{ color: 'var(--green)' }}>{rupees(summary.collected_month_paise)}</div></div>
          <div className="stat"><div className="label">Overdue payments</div>
            <div className="value" style={{ color: summary.overdue_installments ? 'var(--red)' : undefined }}>
              {summary.overdue_installments}</div>
            <div className="sub">{rupees(summary.overdue_amount_paise)}</div></div>
        </div>
      )}

      <div className="card">
        <h2>🏆 Leaderboard</h2>
        <div className="tabs">
          {['today', 'week', 'month'].map((p) => (
            <button key={p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>
              {p === 'today' ? 'Today' : p === 'week' ? 'This week' : 'This month'}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>Caller</th><th className="num">Calls</th><th className="num">Connects</th>
              <th className="num">Connect %</th><th className="num">Leads</th>
              <th className="num">Deals</th><th className="num">Collected</th>
            </tr></thead>
            <tbody>
              {leaderboard?.rows.map((r, i) => (
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
        <label style={{ fontSize: 13, color: 'var(--ink-soft)', fontWeight: 600 }}>Period:</label>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      <div className="card">
        <h2>📈 Daily activity</h2>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={trend} margin={{ top: 5, right: 10, bottom: 0, left: -18 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
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
        <h2>🔻 Funnel ({funnel?.period?.from} → {funnel?.period?.to})
          <button className="btn small secondary" style={{ float: 'right' }} onClick={() => downloadCsv('/api/reports/funnel', 'funnel')}>CSV</button></h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={funnel?.rows || []} margin={{ top: 5, right: 10, bottom: 0, left: -18 }}>
            <XAxis dataKey="stage" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="leads" name="Leads" radius={[6, 6, 0, 0]}>
              {(funnel?.rows || []).map((r, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h2>💰 Revenue by product
          <button className="btn small secondary" style={{ float: 'right' }} onClick={() => downloadCsv('/api/reports/revenue-by-product', 'revenue-by-product')}>CSV</button></h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <ResponsiveContainer width={220} height={200}>
            <PieChart>
              <Pie data={products} dataKey="collected_rupees" nameKey="product" innerRadius={45} outerRadius={80}>
                {products.map((p, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => `₹${Number(v).toLocaleString('en-IN')}`} />
            </PieChart>
          </ResponsiveContainer>
          <div className="table-wrap" style={{ flex: 1, minWidth: 260 }}>
            <table className="data">
              <thead><tr><th>Product</th><th className="num">Deals</th><th className="num">Deal value</th><th className="num">Collected</th></tr></thead>
              <tbody>
                {products.map((p, i) => (
                  <tr key={p.product}>
                    <td><span style={{ color: COLORS[i % COLORS.length] }}>●</span> {p.product}</td>
                    <td className="num">{p.deals}</td>
                    <td className="num">₹{Number(p.deal_value_rupees).toLocaleString('en-IN')}</td>
                    <td className="num">₹{Number(p.collected_rupees).toLocaleString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>📣 Lead sources
          <button className="btn small secondary" style={{ float: 'right' }} onClick={() => downloadCsv('/api/reports/sources', 'lead-sources')}>CSV</button></h2>
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
          <button className="btn small secondary" style={{ float: 'right' }} onClick={() => downloadCsv('/api/reports/agent-daily', 'agent-activity')}>CSV</button></h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Day</th><th>Agent</th><th className="num">Calls</th><th className="num">Connects</th>
              <th className="num">Connect %</th><th className="num">Leads</th><th className="num">Deals</th>
              <th className="num">Deal value</th></tr></thead>
            <tbody>
              {agentDaily.slice(0, 60).map((r, i) => (
                <tr key={i}>
                  <td>{r.day}</td><td>{r.agent}</td>
                  <td className="num">{r.dials}</td><td className="num">{r.connects}</td>
                  <td className="num">{r.connect_rate_pct}%</td><td className="num">{r.unique_leads}</td>
                  <td className="num">{r.deals}</td>
                  <td className="num">₹{Number(r.deal_value_rupees).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
