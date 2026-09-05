import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, rupees } from '../api.js';
import { useApp } from '../ctx.js';
import { useRequest, useSubmit } from '../hooks.js';
import { isAdmin } from '../permissions.js';
import { ErrorState, LoadingState, LeadPicker, Modal } from '../components.jsx';

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

function ToggleRow({ on, onToggle, children, price }) {
  return (
    <button type="button" className={`pb-toggle-row ${on ? 'on' : ''}`} aria-pressed={on} onClick={onToggle}>
      <span className="pb-name"><span className="pb-check" aria-hidden="true">{on ? '✓' : ''}</span>{children}</span>
      <span className="pb-price">{price}</span>
    </button>
  );
}

export default function PriceBuilder() {
  const { user, showToast, canWrite } = useApp();
  const navigate = useNavigate();
  const admin = isAdmin(user.role);
  const [tierKey, setTierKey] = useState('');
  const [bandwidth, setBandwidth] = useState(0); // weekly hours
  const [svcOn, setSvcOn] = useState(() => new Set());
  const [addonOn, setAddonOn] = useState(() => new Set());
  const [term, setTerm] = useState('monthly');
  const [leadId, setLeadId] = useState('');
  const [copyFallback, setCopyFallback] = useState(null);

  const { data: catalog, error, loading, reload } = useRequest(async ({ signal }) => {
    const c = await api.get('/api/catalog', { signal });
    const tiers = (c.pricing_config && c.pricing_config.platform_tiers) || [];
    if (tiers.length) setTierKey((k) => k || tiers[0].key);
    return c;
  }, []);

  const cfg = catalog && catalog.pricing_config;
  const activeServices = useMemo(
    () => ((catalog && catalog.services) || []).filter((s) => s.is_active),
    [catalog],
  );
  const activeAddons = useMemo(
    () => ((catalog && catalog.addons) || []).filter((a) => a.is_active),
    [catalog],
  );

  const tier = ((cfg && cfg.platform_tiers) || []).find((t) => t.key === tierKey) || null;
  const multiplier = (cfg && cfg.term_multipliers && cfg.term_multipliers[term]) ?? 1;
  const bandwidthRate = (cfg && cfg.bandwidth_rate_paise) ?? 0;

  // --- compute (all paise) ---
  const platformPaise = (tier && tier.price_paise) || 0;
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
  const months = (TERMS.find((t) => t[0] === term) || [])[2] || 1;
  const termTotalPaise = monthlyPaise * months;

  const toggle = (setter) => (id) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Line items handed to the invoice flow / copied into the quote text.
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

  const termLabel = (TERMS.find((t) => t[0] === term) || [])[1] || 'Monthly';

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
      // Clipboard API needs a secure context / permission; show it to copy by hand.
      setCopyFallback(text);
    }
  };

  // Turn the live quote into a persisted invoice. A discounted billing term is
  // reflected as a separate discount line scaled by `months` so the persisted
  // subtotal equals the on-screen termTotal (full term, not one month).
  const needsLead = !admin; // the server 403s lead-less invoices for non-admins (CLIENT-21)
  const [createInvoice, creating] = useSubmit(async () => {
    const items = lineItems();
    if (!items.length) return showToast('Pick at least one item to invoice', 'error');
    if (termTotalPaise <= 0) return showToast('The quote total is ₹0 — set prices in Settings → Catalog first', 'error');
    if (needsLead && !leadId) return showToast('Pick the lead this invoice is for', 'error');
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
      if (res && res.id) navigate(`/invoices/${res.id}`);
    } catch (err) {
      showToast(err.message, 'error');
    }
    return undefined;
  });

  if (!catalog) {
    if (error) return <><div className="page-title"><h1>Price builder</h1></div><ErrorState error={error} onRetry={reload} title="Couldn't load the catalog" /></>;
    return loading ? <LoadingState label="Loading catalog…" /> : null;
  }

  const tiers = (cfg && cfg.platform_tiers) || [];

  return (
    <>
      <div className="page-title"><h1>Price builder</h1></div>
      {error && <ErrorState error={error} onRetry={reload} compact />}

      <div className="pb-grid">
        <div>
          {/* Platform tier */}
          <div className="card">
            <h2>Platform tier</h2>
            {tiers.length === 0 && (
              <div className="hint">No platform tiers configured yet (Settings → Catalog).</div>
            )}
            {tiers.map((t) => (
              <ToggleRow key={t.key} on={tierKey === t.key} onToggle={() => setTierKey(t.key)} price={`${rupees(t.price_paise)}/mo`}>
                {t.name}
              </ToggleRow>
            ))}
          </div>

          {/* Bandwidth */}
          <div className="card">
            <h2>Weekly bandwidth</h2>
            <label htmlFor="pb-bandwidth" className="sr-only">Weekly hours</label>
            <input id="pb-bandwidth" type="range" min="0" max="40" step="1" value={bandwidth}
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
              <ToggleRow key={s.id} on={svcOn.has(s.id)} onToggle={() => toggle(setSvcOn)(s.id)} price={`${rupees(s.base_price_paise)}/mo`}>
                {s.name}{s.category ? <span className="pb-price"> · {s.category}</span> : ''}
              </ToggleRow>
            ))}
          </div>

          {/* Add-ons */}
          <div className="card">
            <h2>Add-ons</h2>
            {activeAddons.length === 0 && <div className="hint">No active add-ons.</div>}
            {activeAddons.map((a) => (
              <ToggleRow key={a.id} on={addonOn.has(a.id)} onToggle={() => toggle(setAddonOn)(a.id)} price={`${rupees(a.price_paise)}/mo`}>
                {a.icon ? `${a.icon} ` : ''}{a.name}
              </ToggleRow>
            ))}
          </div>
        </div>

        {/* Live summary */}
        <div className="pb-summary">
          <h2 style={{ marginTop: 0 }}>Quote</h2>
          <div className="field">
            <label>Billing term</label>
            <div className="seg" role="group" aria-label="Billing term">
              {TERMS.map(([key, label]) => (
                <button key={key} type="button" className={term === key ? 'on' : ''} aria-pressed={term === key}
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
              <b style={{ color: 'var(--green-text)' }}>−{Math.round((1 - multiplier) * 100)}%</b>
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--line)', margin: '10px 0' }} />
          <div className="pb-line"><span>Effective monthly</span><b>{rupees(monthlyPaise)}</b></div>
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Billed for {termLabel.toLowerCase()}</div>
            <div className="pb-total">{rupees(termTotalPaise)}</div>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="pb-lead">{needsLead ? 'Lead (required for the invoice)' : 'Attach to lead (optional)'}</label>
            <LeadPicker id="pb-lead" value={leadId} allowNone={!needsLead} onChange={(id) => setLeadId(id)} />
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn secondary" style={{ flex: 1 }} onClick={copyQuote}>Copy quote</button>
            {canWrite && (
              <button type="button" className="btn" style={{ flex: 1 }}
                disabled={creating || termTotalPaise <= 0 || (needsLead && !leadId)} onClick={createInvoice}>
                {creating ? 'Creating…' : 'Create invoice'}
              </button>
            )}
          </div>
          {termTotalPaise <= 0 && <div className="hint" style={{ marginTop: 6 }}>Nothing priced yet — an invoice needs a total above ₹0.</div>}
        </div>
      </div>

      {copyFallback && (
        <Modal title="Copy the quote" onClose={() => setCopyFallback(null)}>
          <p className="modal-message">Your browser blocked automatic copying. Select the text below and copy it.</p>
          <textarea readOnly rows={10} value={copyFallback} onFocus={(e) => e.target.select()} autoFocus
            style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 13, padding: 10, borderRadius: 8, border: '1px solid var(--line)' }} />
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setCopyFallback(null)}>Done</button>
          </div>
        </Modal>
      )}
    </>
  );
}
