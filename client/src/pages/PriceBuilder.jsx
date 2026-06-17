import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rupees } from '../api.js';
import { useApp } from '../App.jsx';

// Internal price builder. Reads the service catalog + pricing config and lets
// any authed user assemble a quote: platform tier + weekly bandwidth + services
// + add-ons + billing term → a live INR total, all computed CLIENT-SIDE in
// integer paise. No public exposure; no chart lib (plain CSS only).
//
// total_paise = round((platformBase + Σservices + Σaddons
//                       + bandwidthHours * bandwidthRate * 4) * termMultiplier)
// (×4 ≈ weeks per month; the term multiplier then scales monthly → the term.)

const TERMS = [
  ['monthly', 'Monthly', 1],
  ['quarterly', 'Quarterly', 3],
  ['annual', 'Annual', 12],
];

export default function PriceBuilder() {
  const { showToast } = useApp();
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState(null);
  const [tierKey, setTierKey] = useState('');
  const [bandwidth, setBandwidth] = useState(0); // weekly hours
  const [svcOn, setSvcOn] = useState(() => new Set());
  const [addonOn, setAddonOn] = useState(() => new Set());
  const [term, setTerm] = useState('monthly');
  const [leads, setLeads] = useState([]);
  const [leadId, setLeadId] = useState('');

  useEffect(() => {
    api.get('/api/catalog').then((c) => {
      setCatalog(c);
      const tiers = c.pricing_config?.platform_tiers || [];
      if (tiers.length) setTierKey(tiers[0].key);
    }).catch(() => {});
    // For optionally attaching the quote to a lead. Scoped server-side.
    api.get('/api/leads').then((d) => setLeads(d.leads || [])).catch(() => {});
  }, []);

  const cfg = catalog?.pricing_config;
  const activeServices = useMemo(
    () => (catalog?.services || []).filter((s) => s.is_active),
    [catalog],
  );
  const activeAddons = useMemo(
    () => (catalog?.addons || []).filter((a) => a.is_active),
    [catalog],
  );

  const tier = (cfg?.platform_tiers || []).find((t) => t.key === tierKey) || null;
  const multiplier = cfg?.term_multipliers?.[term] ?? 1;
  const bandwidthRate = cfg?.bandwidth_rate_paise ?? 0;

  // --- compute (all paise) ---
  const platformPaise = tier?.price_paise || 0;
  const servicesPaise = activeServices
    .filter((s) => svcOn.has(s.id))
    .reduce((sum, s) => sum + s.base_price_paise, 0);
  const addonsPaise = activeAddons
    .filter((a) => addonOn.has(a.id))
    .reduce((sum, a) => sum + a.price_paise, 0);
  const bandwidthPaise = Math.round(bandwidth * bandwidthRate * 4);
  const monthlyBasePaise = platformPaise + servicesPaise + addonsPaise + bandwidthPaise;

  // Per-month price after the term discount, and the amount billed for the term.
  const monthlyPaise = Math.round(monthlyBasePaise * multiplier);
  const months = TERMS.find((t) => t[0] === term)?.[2] || 1;
  const termTotalPaise = monthlyPaise * months;

  const toggle = (setter) => (id) => setter((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Line items handed to the invoice flow (3B) / copied into the quote text.
  // description + unit_price_paise are what POST /api/invoices expects.
  // Each monthly line is billed `qty = months` times so the persisted subtotal
  // covers the FULL term (not a single month) — matching the on-screen total.
  const lineItems = () => {
    const items = [];
    if (tier && platformPaise >= 0 && tierKey) {
      items.push({ description: `Platform — ${tier.name}`, qty: months, unit_price_paise: platformPaise });
    }
    if (bandwidth > 0 && bandwidthPaise > 0) {
      items.push({ description: `Bandwidth — ${bandwidth} hrs/week`, qty: months, unit_price_paise: bandwidthPaise });
    }
    for (const s of activeServices.filter((x) => svcOn.has(x.id))) {
      items.push({ description: s.name, qty: months, unit_price_paise: s.base_price_paise });
    }
    for (const a of activeAddons.filter((x) => addonOn.has(x.id))) {
      items.push({ description: a.name, qty: months, unit_price_paise: a.price_paise });
    }
    return items;
  };

  const termLabel = TERMS.find((t) => t[0] === term)?.[1];

  const quoteText = () => {
    const lines = [];
    lines.push('Quote');
    lines.push('-----');
    if (tier && tierKey) lines.push(`Platform: ${tier.name} — ${rupees(platformPaise)}/mo`);
    if (bandwidth > 0) lines.push(`Bandwidth: ${bandwidth} hrs/week — ${rupees(bandwidthPaise)}/mo`);
    for (const s of activeServices.filter((x) => svcOn.has(x.id))) {
      lines.push(`Service: ${s.name} — ${rupees(s.base_price_paise)}/mo`);
    }
    for (const a of activeAddons.filter((x) => addonOn.has(x.id))) {
      lines.push(`Add-on: ${a.name} — ${rupees(a.price_paise)}/mo`);
    }
    lines.push('-----');
    lines.push(`Billing term: ${termLabel}${multiplier !== 1 ? ` (${Math.round((1 - multiplier) * 100)}% off)` : ''}`);
    lines.push(`Effective monthly: ${rupees(monthlyPaise)}`);
    lines.push(`Billed for ${termLabel.toLowerCase()}: ${rupees(termTotalPaise)}`);
    return lines.join('\n');
  };

  const copyQuote = async () => {
    const text = quoteText();
    try {
      await navigator.clipboard.writeText(text);
      showToast('Quote copied ✓');
    } catch {
      // Clipboard API needs a secure context / permission; fall back to prompt.
      window.prompt('Copy the quote below:', text);
    }
  };

  // Turn the live quote into a persisted invoice (Phase 3B). Each toggled
  // platform/bandwidth/service/add-on becomes a line item billed for the full
  // term (qty = months); GST comes from settings server-side. A discounted
  // billing term is reflected as a separate discount line scaled by `months`
  // so the persisted subtotal equals the on-screen termTotal (full term, not
  // one month): months*base + months*(perMonthAfterDiscount - base) = termTotal.
  const createInvoice = async () => {
    const items = lineItems();
    if (!items.length) return showToast('Pick at least one item to invoice', 'error');
    if (multiplier !== 1) {
      const discountPaise = (monthlyPaise - monthlyBasePaise) * months; // negative, full term
      items.push({
        description: `${termLabel} discount (${Math.round((1 - multiplier) * 100)}% off)`,
        qty: 1,
        unit_price_paise: discountPaise,
      });
    }
    const payload = {
      lead_id: leadId ? Number(leadId) : null,
      items,
      notes: `Generated from price builder — ${termLabel} plan.`,
    };
    try {
      const res = await api.post('/api/invoices', payload);
      showToast('Invoice created ✓');
      if (res?.id) navigate(`/invoices/${res.id}`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  if (!catalog) return <div className="card empty"><div className="big">🧮</div>Loading catalog…</div>;

  return (
    <>
      <div className="page-title"><h1>Price builder</h1></div>

      <div className="pb-grid">
        <div>
          {/* Platform tier */}
          <div className="card">
            <h2>Platform tier</h2>
            {(cfg?.platform_tiers || []).length === 0 && (
              <div className="hint">No platform tiers configured yet (Settings → Catalog).</div>
            )}
            {(cfg?.platform_tiers || []).map((t) => (
              <div key={t.key} className={`pb-toggle-row ${tierKey === t.key ? 'on' : ''}`}
                onClick={() => setTierKey(t.key)}>
                <span className="pb-name">{t.name}</span>
                <span className="pb-price">{rupees(t.price_paise)}/mo</span>
              </div>
            ))}
          </div>

          {/* Bandwidth */}
          <div className="card">
            <h2>Weekly bandwidth</h2>
            <input type="range" min="0" max="40" step="1" value={bandwidth}
              onChange={(e) => setBandwidth(Number(e.target.value))} style={{ width: '100%' }} />
            <div className="pb-line">
              <span>{bandwidth} hrs/week</span>
              <b>{rupees(bandwidthPaise)}/mo</b>
            </div>
            <div className="hint">Rate: {rupees(bandwidthRate)}/hr × 4 weeks</div>
          </div>

          {/* Services */}
          <div className="card">
            <h2>Services</h2>
            {activeServices.length === 0 && <div className="hint">No active services.</div>}
            {activeServices.map((s) => (
              <div key={s.id} className={`pb-toggle-row ${svcOn.has(s.id) ? 'on' : ''}`}
                onClick={() => toggle(setSvcOn)(s.id)}>
                <span className="pb-name">
                  <input type="checkbox" checked={svcOn.has(s.id)} readOnly style={{ marginRight: 8 }} />
                  {s.name}{s.category ? <span className="pb-price"> · {s.category}</span> : ''}
                </span>
                <span className="pb-price">{rupees(s.base_price_paise)}/mo</span>
              </div>
            ))}
          </div>

          {/* Add-ons */}
          <div className="card">
            <h2>Add-ons</h2>
            {activeAddons.length === 0 && <div className="hint">No active add-ons.</div>}
            {activeAddons.map((a) => (
              <div key={a.id} className={`pb-toggle-row ${addonOn.has(a.id) ? 'on' : ''}`}
                onClick={() => toggle(setAddonOn)(a.id)}>
                <span className="pb-name">
                  <input type="checkbox" checked={addonOn.has(a.id)} readOnly style={{ marginRight: 8 }} />
                  {a.icon ? `${a.icon} ` : ''}{a.name}
                </span>
                <span className="pb-price">{rupees(a.price_paise)}/mo</span>
              </div>
            ))}
          </div>
        </div>

        {/* Live summary */}
        <div className="pb-summary">
          <h2 style={{ marginTop: 0 }}>Quote</h2>
          <div className="field">
            <label>Billing term</label>
            <div className="seg">
              {TERMS.map(([key, label]) => (
                <button key={key} type="button" className={term === key ? 'on' : ''}
                  onClick={() => setTerm(key)}>{label}</button>
              ))}
            </div>
          </div>

          <div className="pb-line"><span>Platform</span><b>{rupees(platformPaise)}</b></div>
          <div className="pb-line"><span>Bandwidth</span><b>{rupees(bandwidthPaise)}</b></div>
          <div className="pb-line"><span>Services</span><b>{rupees(servicesPaise)}</b></div>
          <div className="pb-line"><span>Add-ons</span><b>{rupees(addonsPaise)}</b></div>
          {multiplier !== 1 && (
            <div className="pb-line">
              <span>{termLabel} discount</span>
              <b style={{ color: 'var(--green)' }}>−{Math.round((1 - multiplier) * 100)}%</b>
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--line)', margin: '10px 0' }} />
          <div className="pb-line"><span>Effective monthly</span><b>{rupees(monthlyPaise)}</b></div>
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Billed for {termLabel.toLowerCase()}</div>
            <div className="pb-total">{rupees(termTotalPaise)}</div>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label>Attach to lead (optional)</label>
            <select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
              <option value="">No lead</option>
              {leads.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.phone}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn secondary" style={{ flex: 1 }} onClick={copyQuote}>Copy quote</button>
            <button className="btn" style={{ flex: 1 }} onClick={createInvoice}>Create invoice</button>
          </div>
        </div>
      </div>
    </>
  );
}
