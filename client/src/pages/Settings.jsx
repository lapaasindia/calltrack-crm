import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, rupees, fmtDateTime } from '../api.js';
import { useApp } from '../App.jsx';
import { Modal, invalidateTemplateCache } from '../components.jsx';
import { ROLES, ROLE_LABELS, isOwner } from '../permissions.js';

function PairDeviceModal({ users, onClose }) {
  const { showToast } = useApp();
  const [userId, setUserId] = useState('');
  const [pairing, setPairing] = useState(null); // {code, qr}

  const generate = async () => {
    try {
      const res = await api.post('/api/devices/pairing-code', { user_id: Number(userId) });
      // The phone connects to whatever URL the QR contains, so it must be a LAN
      // address the phone can reach. window.location.origin is 127.0.0.1 in the
      // desktop app and a .local name some Android phones can't resolve — in
      // those cases use a real LAN IP the server reported.
      const host = window.location.hostname;
      const needsLan = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
      const serverUrl = (needsLan && res.urls?.length) ? res.urls[0] : window.location.origin;
      const payload = JSON.stringify({ u: serverUrl, c: res.code });
      const qr = await QRCode.toDataURL(payload, { width: 260, margin: 1 });
      setPairing({ code: res.code, qr, url: serverUrl });
    } catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <Modal title="Pair a phone" onClose={onClose}>
      {!pairing ? (
        <>
          <div className="field">
            <label>Whose phone is this?</label>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Pick team member…</option>
              {users.filter((u) => u.is_active).map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </div>
          <div className="modal-actions">
            <button className="btn secondary" onClick={onClose}>Cancel</button>
            <button className="btn" disabled={!userId} onClick={generate}>Generate code</button>
          </div>
        </>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <img src={pairing.qr} alt="Pairing QR" style={{ borderRadius: 12 }} />
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '0.15em', margin: '10px 0 4px' }}>
            {pairing.code}
          </div>
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>
            In the CallTrack mobile app: <b>Scan this QR</b> (or type the code with the server
            address <b>{pairing.url}</b>). Valid for 15 minutes, works once.
          </p>
          <button className="btn block" onClick={onClose}>Done</button>
        </div>
      )}
    </Modal>
  );
}

function UserModal({ user: editing, onClose, onSaved }) {
  const { showToast } = useApp();
  const isNew = !editing;
  const { user: me } = useApp();
  const isSelf = !isNew && editing.id === me.id;
  const [form, setForm] = useState({
    username: editing?.username || '', full_name: editing?.full_name || '',
    password: '', role: editing?.role || 'caller', department: editing?.department || '',
    calls_target: editing?.calls_target ?? 50,
    connects_target: editing?.connects_target ?? 25,
    deals_target: editing?.deals_target ?? 1,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    try {
      let userId = editing?.id;
      if (isNew) {
        const res = await api.post('/api/users', {
          username: form.username, full_name: form.full_name,
          password: form.password, role: form.role, department: form.department,
        });
        userId = res.id;
      } else {
        await api.patch(`/api/users/${userId}`, {
          full_name: form.full_name, department: form.department,
          ...(isSelf ? {} : { role: form.role }),
          ...(form.password ? { new_password: form.password } : {}),
        });
      }
      await api.put(`/api/users/${userId}/targets`, {
        calls_target: Number(form.calls_target),
        connects_target: Number(form.connects_target),
        deals_target: Number(form.deals_target),
      });
      showToast(isNew ? 'Team member added ✓' : 'Saved ✓');
      onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <Modal title={isNew ? 'Add team member' : `Edit ${editing.full_name}`} onClose={onClose}>
      <div className="form-grid">
        <div className="field">
          <label>Username</label>
          <input value={form.username} onChange={set('username')} disabled={!isNew}
            autoCapitalize="none" autoCorrect="off" />
        </div>
        <div className="field">
          <label>Full name</label>
          <input value={form.full_name} onChange={set('full_name')} />
        </div>
        <div className="field">
          <label>{isNew ? 'Password' : 'New password (leave blank to keep)'}</label>
          <input value={form.password} onChange={set('password')} placeholder="min 6 characters" />
        </div>
        <div className="field">
          <label>Role{isSelf && ' (you can’t change your own)'}</label>
          <select value={form.role} onChange={set('role')} disabled={isSelf}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Department (optional)</label>
          <input value={form.department} onChange={set('department')} placeholder="e.g. Sales" />
        </div>
      </div>
      <div className="section-label">Daily targets</div>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <div className="field"><label>Calls</label>
          <input inputMode="numeric" value={form.calls_target} onChange={set('calls_target')} /></div>
        <div className="field"><label>Connects</label>
          <input inputMode="numeric" value={form.connects_target} onChange={set('connects_target')} /></div>
        <div className="field"><label>Deals</label>
          <input inputMode="numeric" value={form.deals_target} onChange={set('deals_target')} /></div>
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save}
          disabled={!form.full_name || (isNew && (!form.username || form.password.length < 6))}>Save</button>
      </div>
    </Modal>
  );
}

function ProductModal({ product, onClose, onSaved }) {
  const { showToast } = useApp();
  const [form, setForm] = useState({
    name: product?.name || '',
    price_rupees: product ? product.price_paise / 100 : '',
    description: product?.description || '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    try {
      if (product) await api.patch(`/api/products/${product.id}`, form);
      else await api.post('/api/products', form);
      showToast('Saved ✓'); onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  };
  return (
    <Modal title={product ? 'Edit product' : 'Add product'} onClose={onClose}>
      <div className="field"><label>Name</label><input value={form.name} onChange={set('name')} /></div>
      <div className="field"><label>Price (₹)</label>
        <input inputMode="numeric" value={form.price_rupees} onChange={set('price_rupees')} /></div>
      <div className="field"><label>Description</label>
        <input value={form.description} onChange={set('description')} /></div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!form.name || !(Number(form.price_rupees) >= 0)} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

// Catalog service editor. base_price stored in paise; a ₹0 service is allowed.
function ServiceModal({ service, onClose, onSaved }) {
  const { showToast } = useApp();
  const m = service?.term_multipliers || { monthly: 1, quarterly: 0.94, annual: 0.86 };
  const [form, setForm] = useState({
    name: service?.name || '',
    category: service?.category || '',
    base_price_rupees: service ? service.base_price_paise / 100 : 0,
    monthly: m.monthly ?? 1, quarterly: m.quarterly ?? 0.94, annual: m.annual ?? 0.86,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    try {
      const body = {
        name: form.name,
        category: form.category || null,
        base_price_paise: Math.round(Number(form.base_price_rupees) * 100),
        term_multipliers: { monthly: Number(form.monthly), quarterly: Number(form.quarterly), annual: Number(form.annual) },
      };
      if (service) await api.put(`/api/catalog/services/${service.id}`, body);
      else await api.post('/api/catalog/services', body);
      showToast('Saved ✓'); onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  };
  return (
    <Modal title={service ? 'Edit service' : 'Add service'} onClose={onClose}>
      <div className="form-grid">
        <div className="field"><label>Name</label><input value={form.name} onChange={set('name')} autoFocus /></div>
        <div className="field"><label>Category (optional)</label><input value={form.category} onChange={set('category')} /></div>
      </div>
      <div className="field" style={{ maxWidth: 200 }}>
        <label>Base price (₹/mo)</label>
        <input inputMode="decimal" value={form.base_price_rupees} onChange={set('base_price_rupees')} />
        <div className="hint">₹0 is allowed (e.g. a free tier).</div>
      </div>
      <div className="section-label">Term multipliers</div>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <div className="field"><label>Monthly</label><input inputMode="decimal" value={form.monthly} onChange={set('monthly')} /></div>
        <div className="field"><label>Quarterly</label><input inputMode="decimal" value={form.quarterly} onChange={set('quarterly')} /></div>
        <div className="field"><label>Annual</label><input inputMode="decimal" value={form.annual} onChange={set('annual')} /></div>
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!form.name || !(Number(form.base_price_rupees) >= 0)} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

// Catalog add-on editor. price stored in paise; a ₹0 add-on is allowed.
function AddonModal({ addon, onClose, onSaved }) {
  const { showToast } = useApp();
  const [form, setForm] = useState({
    name: addon?.name || '', icon: addon?.icon || '',
    price_rupees: addon ? addon.price_paise / 100 : 0,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    try {
      const body = {
        name: form.name, icon: form.icon || null,
        price_paise: Math.round(Number(form.price_rupees) * 100),
      };
      if (addon) await api.put(`/api/catalog/addons/${addon.id}`, body);
      else await api.post('/api/catalog/addons', body);
      showToast('Saved ✓'); onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  };
  return (
    <Modal title={addon ? 'Edit add-on' : 'Add add-on'} onClose={onClose}>
      <div className="form-grid">
        <div className="field"><label>Name</label><input value={form.name} onChange={set('name')} autoFocus /></div>
        <div className="field"><label>Icon (optional emoji)</label><input value={form.icon} onChange={set('icon')} /></div>
      </div>
      <div className="field" style={{ maxWidth: 200 }}>
        <label>Price (₹/mo)</label>
        <input inputMode="decimal" value={form.price_rupees} onChange={set('price_rupees')} />
        <div className="hint">₹0 is allowed.</div>
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!form.name || !(Number(form.price_rupees) >= 0)} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

function TemplateModal({ template, onClose, onSaved }) {
  const { showToast } = useApp();
  const [form, setForm] = useState({
    name: template?.name || '', category: template?.category || 'custom', body: template?.body || '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    try {
      if (template) await api.patch(`/api/templates/${template.id}`, form);
      else await api.post('/api/templates', form);
      invalidateTemplateCache();
      showToast('Saved ✓'); onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  };
  return (
    <Modal title={template ? 'Edit template' : 'Add WhatsApp template'} onClose={onClose}>
      <div className="form-grid">
        <div className="field"><label>Name</label><input value={form.name} onChange={set('name')} /></div>
        <div className="field"><label>Category</label>
          <select value={form.category} onChange={set('category')}>
            <option value="intro">Intro</option><option value="follow_up">Follow-up</option>
            <option value="payment_reminder">Payment reminder</option>
            <option value="support">Support</option><option value="custom">Custom</option>
          </select></div>
      </div>
      <div className="field">
        <label>Message</label>
        <textarea rows={4} value={form.body} onChange={set('body')} />
        <div className="hint">
          Placeholders: {'{name} {product} {amount_due} {due_date} {caller_name} {company}'}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!form.name || !form.body} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

export default function Settings() {
  const { user, showToast } = useApp();
  const [users, setUsers] = useState([]);
  const [products, setProducts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [devices, setDevices] = useState([]);
  const [ai, setAi] = useState(null);
  const [settings, setSettings] = useState(null);
  const [companyName, setCompanyName] = useState('');
  const [invoice, setInvoice] = useState({ company_legal_name: '', company_address: '', company_gstin: '', gst_percent: 18 });
  const [cloud, setCloud] = useState({ ai_cloud_enabled: false, has_sarvam_key: false, sarvam_api_key: '' });
  const [backup, setBackup] = useState(null); // /api/backup/status
  const [driveCreds, setDriveCreds] = useState({ client_id: '', client_secret: '' });
  const [passphrase, setPassphrase] = useState('');
  const [routingRules, setRoutingRules] = useState([]);
  const [newRule, setNewRule] = useState({ subject: '', assigned_to: '' });
  const [catalog, setCatalog] = useState({ services: [], addons: [], pricing_config: null });
  const [pricingForm, setPricingForm] = useState(null);
  const [wa, setWa] = useState(null); // WhatsApp session status
  const [modal, setModal] = useState(null);

  const loadCatalog = () => api.get('/api/catalog').then((c) => {
    setCatalog(c);
    setPricingForm({
      platform_tiers: (c.pricing_config?.platform_tiers || []).map((t) => ({
        key: t.key, name: t.name, price_rupees: (t.price_paise || 0) / 100,
      })),
      bandwidth_rate_rupees: (c.pricing_config?.bandwidth_rate_paise || 0) / 100,
      term_multipliers: { ...(c.pricing_config?.term_multipliers || { monthly: 1, quarterly: 0.94, annual: 0.86 }) },
    });
  }).catch(() => {});

  const load = () => {
    api.get('/api/users').then(setUsers).catch(() => {});
    api.get('/api/routing-rules').then(setRoutingRules).catch(() => {});
    loadCatalog();
    api.get('/api/products?all=1').then(setProducts).catch(() => {});
    api.get('/api/templates?all=1').then(setTemplates).catch(() => {});
    api.get('/api/devices').then(setDevices).catch(() => {});
    api.get('/api/ai/status').then(setAi).catch(() => {});
    api.get('/api/backup/status').then(setBackup).catch(() => {});
    api.get('/api/whatsapp/status').then(setWa).catch(() => {});
    api.get('/api/settings').then((s) => {
      setSettings(s);
      setCompanyName(s.company_name);
      setInvoice({
        company_legal_name: s.company_legal_name || '',
        company_address: s.company_address || '',
        company_gstin: s.company_gstin || '',
        gst_percent: s.gst_percent ?? 18,
      });
      // Leave the key field blank — it's never returned; has_sarvam_key tells us it's set.
      setCloud({ ai_cloud_enabled: !!s.ai_cloud_enabled, has_sarvam_key: !!s.has_sarvam_key, sarvam_api_key: '' });
    }).catch(() => {});
  };
  useEffect(load, []);

  const toggleAi = async (enabled) => {
    try { await api.put('/api/ai/settings', { enabled }); showToast(enabled ? 'AI transcription on' : 'AI off'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const revokeDevice = async (d) => {
    if (!window.confirm(`Disconnect ${d.device_name} (${d.user_name})? The phone stops syncing immediately.`)) return;
    try { await api.post(`/api/devices/${d.id}/revoke`); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const toggleUser = async (u) => {
    try {
      await api.patch(`/api/users/${u.id}`, { is_active: u.is_active ? 0 : 1 });
      load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const toggleProduct = async (p) => {
    try { await api.patch(`/api/products/${p.id}`, { is_active: p.is_active ? 0 : 1 }); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const saveCompany = async () => {
    try {
      await api.put('/api/settings', { company_name: companyName });
      invalidateTemplateCache();
      showToast('Saved ✓');
    } catch (err) { showToast(err.message, 'error'); }
  };

  const saveInvoice = async () => {
    try {
      await api.put('/api/settings', {
        company_legal_name: invoice.company_legal_name,
        company_address: invoice.company_address,
        company_gstin: invoice.company_gstin,
        gst_percent: Number(invoice.gst_percent),
      });
      showToast('Invoice details saved ✓'); load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const saveCloud = async () => {
    try {
      const body = { ai_cloud_enabled: cloud.ai_cloud_enabled };
      // Only send the key if the user typed one (empty field would otherwise clear it).
      if (cloud.sarvam_api_key.trim()) body.sarvam_api_key = cloud.sarvam_api_key.trim();
      await api.put('/api/settings', body);
      showToast('Cloud AI settings saved ✓'); load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const clearSarvamKey = async () => {
    try { await api.put('/api/settings', { sarvam_api_key: '' }); showToast('Sarvam key removed ✓'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const addRoutingRule = async () => {
    if (!newRule.subject.trim()) { showToast('Subject required', 'error'); return; }
    try {
      await api.post('/api/routing-rules', {
        subject: newRule.subject.trim(),
        assigned_to: newRule.assigned_to ? Number(newRule.assigned_to) : null,
      });
      setNewRule({ subject: '', assigned_to: '' });
      showToast('Routing rule added ✓'); load();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const deleteRoutingRule = async (rule) => {
    if (!window.confirm(`Delete the routing rule for "${rule.subject}"?`)) return;
    try { await api.del(`/api/routing-rules/${rule.id}`); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const backupNow = async () => {
    try { await api.post('/api/settings/backup-now'); showToast('Backup created ✓'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  // ── Cloud Backup (Google Drive) ──────────────────────────────────────────
  const loadBackup = () => api.get('/api/backup/status').then(setBackup).catch(() => {});

  const saveDriveCreds = async () => {
    try {
      await api.post('/api/backup/google/credentials', {
        client_id: driveCreds.client_id.trim(),
        client_secret: driveCreds.client_secret.trim(),
      });
      setDriveCreds({ client_id: '', client_secret: '' });
      showToast('Google OAuth credentials saved ✓'); loadBackup();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const connectDrive = async () => {
    try {
      const res = await api.post('/api/backup/google/connect');
      window.open(res.url, '_blank', 'noopener');
      showToast('Approve access in the new tab, then click "Refresh status".');
    } catch (err) { showToast(err.message, 'error'); }
  };

  const savePassphrase = async () => {
    if (passphrase.length < 8) { showToast('Passphrase must be at least 8 characters', 'error'); return; }
    if (!backup?.hasPassphrase
      && !window.confirm('IMPORTANT: write this passphrase down somewhere safe.\n\nIf you lose it, your off-site backups are PERMANENTLY UNRECOVERABLE — there is no reset. Continue?')) return;
    try {
      await api.post('/api/backup/passphrase', { passphrase });
      setPassphrase('');
      showToast(backup?.hasPassphrase ? 'Passphrase verified ✓' : 'Passphrase set ✓'); loadBackup();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const runCloudBackup = async () => {
    try {
      const res = await api.post('/api/backup/run-now',
        passphrase ? { passphrase } : {});
      if (res.ok) showToast(`Backed up ${res.files} file(s) to Google Drive ✓`);
      else showToast(res.error || 'Backup did not complete', 'error');
      setPassphrase(''); loadBackup();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const disconnectDrive = async () => {
    if (!window.confirm('Stop syncing to Google Drive? Your existing Drive backups and tokens are kept — you can reconnect anytime.')) return;
    try { await api.post('/api/backup/disconnect'); showToast('Cloud backup paused'); loadBackup(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  // ── Service catalog ──────────────────────────────────────────────────────
  const toggleService = async (s) => {
    try { await api.put(`/api/catalog/services/${s.id}`, { is_active: s.is_active ? 0 : 1 }); loadCatalog(); }
    catch (err) { showToast(err.message, 'error'); }
  };
  const deleteService = async (s) => {
    if (!window.confirm(`Delete service "${s.name}"?`)) return;
    try { await api.del(`/api/catalog/services/${s.id}`); showToast('Service deleted ✓'); loadCatalog(); }
    catch (err) { showToast(err.message, 'error'); }
  };
  const toggleAddon = async (a) => {
    try { await api.put(`/api/catalog/addons/${a.id}`, { is_active: a.is_active ? 0 : 1 }); loadCatalog(); }
    catch (err) { showToast(err.message, 'error'); }
  };
  const deleteAddon = async (a) => {
    if (!window.confirm(`Delete add-on "${a.name}"?`)) return;
    try { await api.del(`/api/catalog/addons/${a.id}`); showToast('Add-on deleted ✓'); loadCatalog(); }
    catch (err) { showToast(err.message, 'error'); }
  };
  const savePricing = async () => {
    try {
      await api.put('/api/catalog/pricing-config', {
        platform_tiers: pricingForm.platform_tiers.map((t) => ({
          key: t.key, name: t.name, price_paise: Math.round(Number(t.price_rupees) * 100),
        })),
        bandwidth_rate_paise: Math.round(Number(pricingForm.bandwidth_rate_rupees) * 100),
        term_multipliers: {
          monthly: Number(pricingForm.term_multipliers.monthly),
          quarterly: Number(pricingForm.term_multipliers.quarterly),
          annual: Number(pricingForm.term_multipliers.annual),
        },
      });
      showToast('Pricing config saved ✓'); loadCatalog();
    } catch (err) { showToast(err.message, 'error'); }
  };

  const clearDemo = async () => {
    if (!window.confirm('Remove all demo leads and their calls/deals/payments? Your real data stays.')) return;
    try {
      const res = await api.post('/api/settings/clear-demo-data');
      showToast(`Removed ${res.removed} demo leads ✓`);
    } catch (err) { showToast(err.message, 'error'); }
  };

  // ── WhatsApp (Baileys) ────────────────────────────────────────────────────
  const loadWa = () => api.get('/api/whatsapp/status').then(setWa).catch(() => {});

  // While pairing (qr_pending/connecting), poll for the QR + status until the
  // session resolves to connected/error/disconnected.
  useEffect(() => {
    if (!wa || !['qr_pending', 'connecting'].includes(wa.status)) return undefined;
    const iv = setInterval(loadWa, 3000);
    return () => clearInterval(iv);
  }, [wa?.status]);

  const waStart = async () => {
    try {
      await api.post('/api/whatsapp/start');
      showToast('Pairing started — scan the QR with your WhatsApp business number.');
      loadWa();
    } catch (err) { showToast(err.message, 'error'); }
  };
  const waLogout = async () => {
    if (!window.confirm('Disconnect WhatsApp? Incoming messages will stop syncing until you reconnect.')) return;
    try { await api.post('/api/whatsapp/logout'); showToast('WhatsApp disconnected'); loadWa(); }
    catch (err) { showToast(err.message, 'error'); }
  };
  const waReset = async () => {
    if (!window.confirm('Reset WhatsApp? This deletes ALL synced WhatsApp contacts, messages, and the saved login. Leads stay. Continue?')) return;
    try { await api.post('/api/whatsapp/reset'); showToast('WhatsApp reset ✓'); loadWa(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <>
      <div className="page-title"><h1>Settings</h1></div>

      <div className="card">
        <h2>👥 Team {' '}
          <button className="btn small" style={{ float: 'right' }}
            onClick={() => setModal({ user: null })}>+ Add member</button></h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th>
              <th className="num">Targets (calls/connects/deals)</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.45 }}>
                  <td><b>{u.full_name}</b>{!u.is_active && ' (inactive)'}{u.department ? ` · ${u.department}` : ''}</td>
                  <td>{u.username}</td>
                  <td>{ROLE_LABELS[u.role] || u.role}</td>
                  <td className="num">{u.calls_target ?? '—'} / {u.connects_target ?? '—'} / {u.deals_target ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small secondary" onClick={() => setModal({ user: u })}>Edit</button>{' '}
                    {u.id !== user.id && (
                      <button className="btn small secondary" onClick={() => toggleUser(u)}>
                        {u.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>🧭 Lead routing rules</h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          When an admin adds a lead without picking an owner, it's routed by these rules
          (matched on the lead's <b>subject</b>, then its <b>source</b>). Unmatched leads
          fall back to round-robin among active agents/callers.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Subject / source</th><th>Assign to</th><th></th></tr></thead>
            <tbody>
              {routingRules.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.subject}</b></td>
                  <td>{r.assigned_to_name || <span style={{ color: 'var(--ink-faint)' }}>— (unset)</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small secondary" onClick={() => deleteRoutingRule(r)}>Delete</button>
                  </td>
                </tr>
              ))}
              {routingRules.length === 0 && (
                <tr><td colSpan={3} style={{ color: 'var(--ink-soft)' }}>No routing rules yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="form-grid" style={{ marginTop: 10, alignItems: 'end' }}>
          <div className="field">
            <label>Subject or source</label>
            <input value={newRule.subject}
              placeholder="e.g. Enterprise, Website, Facebook"
              onChange={(e) => setNewRule((r) => ({ ...r, subject: e.target.value }))} />
          </div>
          <div className="field">
            <label>Assign to</label>
            <select value={newRule.assigned_to}
              onChange={(e) => setNewRule((r) => ({ ...r, assigned_to: e.target.value }))}>
              <option value="">Pick team member…</option>
              {users.filter((u) => u.is_active).map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <button className="btn small" onClick={addRoutingRule}>+ Add rule</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>📦 Products {' '}
          <button className="btn small" style={{ float: 'right' }}
            onClick={() => setModal({ product: null })}>+ Add product</button></h2>
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {products.map((p) => (
                <tr key={p.id} style={{ opacity: p.is_active ? 1 : 0.45 }}>
                  <td><b>{p.name}</b>{p.description ? ` — ${p.description}` : ''}</td>
                  <td className="num">{rupees(p.price_paise)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small secondary" onClick={() => setModal({ product: p })}>Edit</button>{' '}
                    <button className="btn small secondary" onClick={() => toggleProduct(p)}>
                      {p.is_active ? 'Hide' : 'Show'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>🧰 Service catalog {' '}
          <span style={{ float: 'right', display: 'inline-flex', gap: 6 }}>
            <button className="btn small" onClick={() => setModal({ service: null })}>+ Service</button>
            <button className="btn small" onClick={() => setModal({ addon: null })}>+ Add-on</button>
          </span></h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Powers the internal <b>Price builder</b>. The existing Products list above still drives deals.
        </p>
        <div className="section-label">Services</div>
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {catalog.services.map((s) => (
                <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.45 }}>
                  <td><b>{s.name}</b>{s.category ? ` · ${s.category}` : ''}</td>
                  <td className="num">{rupees(s.base_price_paise)}/mo</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small secondary" onClick={() => setModal({ service: s })}>Edit</button>{' '}
                    <button className="btn small secondary" onClick={() => toggleService(s)}>{s.is_active ? 'Hide' : 'Show'}</button>{' '}
                    <button className="btn small secondary" onClick={() => deleteService(s)}>Delete</button>
                  </td>
                </tr>
              ))}
              {catalog.services.length === 0 && (
                <tr><td colSpan={3} style={{ color: 'var(--ink-soft)' }}>No services yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="section-label" style={{ marginTop: 12 }}>Add-ons</div>
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {catalog.addons.map((a) => (
                <tr key={a.id} style={{ opacity: a.is_active ? 1 : 0.45 }}>
                  <td><b>{a.icon ? `${a.icon} ` : ''}{a.name}</b></td>
                  <td className="num">{rupees(a.price_paise)}/mo</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small secondary" onClick={() => setModal({ addon: a })}>Edit</button>{' '}
                    <button className="btn small secondary" onClick={() => toggleAddon(a)}>{a.is_active ? 'Hide' : 'Show'}</button>{' '}
                    <button className="btn small secondary" onClick={() => deleteAddon(a)}>Delete</button>
                  </td>
                </tr>
              ))}
              {catalog.addons.length === 0 && (
                <tr><td colSpan={3} style={{ color: 'var(--ink-soft)' }}>No add-ons yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {pricingForm && (
          <>
            <div className="section-label" style={{ marginTop: 14 }}>Platform tiers &amp; pricing config</div>
            {pricingForm.platform_tiers.map((t, i) => (
              <div key={i} className="form-grid" style={{ gridTemplateColumns: '1fr 160px', alignItems: 'end' }}>
                <div className="field">
                  <label>Tier name</label>
                  <input value={t.name}
                    onChange={(e) => setPricingForm((p) => ({
                      ...p, platform_tiers: p.platform_tiers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    }))} />
                </div>
                <div className="field">
                  <label>Price (₹/mo)</label>
                  <input inputMode="decimal" value={t.price_rupees}
                    onChange={(e) => setPricingForm((p) => ({
                      ...p, platform_tiers: p.platform_tiers.map((x, j) => (j === i ? { ...x, price_rupees: e.target.value } : x)),
                    }))} />
                </div>
              </div>
            ))}
            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr', marginTop: 4 }}>
              <div className="field"><label>Bandwidth ₹/hr</label>
                <input inputMode="decimal" value={pricingForm.bandwidth_rate_rupees}
                  onChange={(e) => setPricingForm((p) => ({ ...p, bandwidth_rate_rupees: e.target.value }))} /></div>
              <div className="field"><label>×Monthly</label>
                <input inputMode="decimal" value={pricingForm.term_multipliers.monthly}
                  onChange={(e) => setPricingForm((p) => ({ ...p, term_multipliers: { ...p.term_multipliers, monthly: e.target.value } }))} /></div>
              <div className="field"><label>×Quarterly</label>
                <input inputMode="decimal" value={pricingForm.term_multipliers.quarterly}
                  onChange={(e) => setPricingForm((p) => ({ ...p, term_multipliers: { ...p.term_multipliers, quarterly: e.target.value } }))} /></div>
              <div className="field"><label>×Annual</label>
                <input inputMode="decimal" value={pricingForm.term_multipliers.annual}
                  onChange={(e) => setPricingForm((p) => ({ ...p, term_multipliers: { ...p.term_multipliers, annual: e.target.value } }))} /></div>
            </div>
            <button className="btn small" onClick={savePricing}>Save pricing config</button>
          </>
        )}
      </div>

      <div className="card">
        <h2>💬 WhatsApp templates {' '}
          <button className="btn small" style={{ float: 'right' }}
            onClick={() => setModal({ template: null })}>+ Add template</button></h2>
        <div className="row-list">
          {templates.map((t) => (
            <div key={t.id} className="lead-row">
              <div className="info">
                <div className="name">{t.name} <span className="badge new">{t.category}</span></div>
                <div className="meta">{t.body}</div>
              </div>
              <button className="btn small secondary" onClick={() => setModal({ template: t })}>Edit</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>📱 Paired phones (call sync) {' '}
          <button className="btn small" style={{ float: 'right' }}
            onClick={() => setModal({ pair: true })}>+ Pair phone</button></h2>
        {devices.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
            No phones paired yet. Install the CallTrack mobile app on a caller's Android phone
            and pair it here — their calls and recordings will sync automatically.
          </p>
        )}
        {devices.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Phone</th><th>Team member</th><th>Last sync</th><th></th></tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} style={{ opacity: d.revoked_at ? 0.45 : 1 }}>
                    <td><b>{d.device_name}</b>{d.revoked_at && ' (disconnected)'}</td>
                    <td>{d.user_name}</td>
                    <td>{d.last_seen_at ? fmtDateTime(d.last_seen_at) : 'never'}</td>
                    <td>{!d.revoked_at && (
                      <button className="btn small secondary" onClick={() => revokeDevice(d)}>Disconnect</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>🏢 Business</h2>
        <div className="field" style={{ maxWidth: 360 }}>
          <label>Company name (used in WhatsApp messages)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            <button className="btn small" onClick={saveCompany}>Save</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>🧾 Invoice details</h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Used on GST invoices generated by the CRM.
        </p>
        <div className="form-grid">
          <div className="field">
            <label>Legal company name</label>
            <input value={invoice.company_legal_name}
              onChange={(e) => setInvoice((v) => ({ ...v, company_legal_name: e.target.value }))} />
          </div>
          <div className="field">
            <label>GSTIN</label>
            <input value={invoice.company_gstin} autoCapitalize="characters"
              onChange={(e) => setInvoice((v) => ({ ...v, company_gstin: e.target.value }))} />
          </div>
        </div>
        <div className="field">
          <label>Registered address</label>
          <textarea rows={2} value={invoice.company_address}
            onChange={(e) => setInvoice((v) => ({ ...v, company_address: e.target.value }))} />
        </div>
        <div className="field" style={{ maxWidth: 180 }}>
          <label>Default GST %</label>
          <input inputMode="decimal" value={invoice.gst_percent}
            onChange={(e) => setInvoice((v) => ({ ...v, gst_percent: e.target.value }))} />
        </div>
        <button className="btn small" onClick={saveInvoice}>Save invoice details</button>
      </div>

      <div className="card">
        <h2>🤖 AI call transcription</h2>
        {ai && (
          <>
            <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
              Transcribes call recordings and suggests lead updates, follow-ups and tasks —
              runs entirely on this computer, nothing sent to the internet.
              {!ai.model_present && <b style={{ color: 'var(--red)' }}> Model not installed on this computer.</b>}
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className={`btn ${ai.enabled ? 'secondary' : 'green'}`} disabled={!ai.model_present}
                onClick={() => toggleAi(!ai.enabled)}>
                {ai.enabled ? 'Turn off' : 'Turn on'}
              </button>
              <span className="meta" style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                Status: <b>{ai.enabled ? 'ON' : 'off'}</b>
                {ai.enabled && ` · ${ai.queue.pending} waiting, ${ai.queue.processing} processing · ${ai.whisper_model}`}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>☁️ Cloud AI (Sarvam — Hindi/Hinglish)</h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Optional. When enabled, you can re-transcribe a single recording with Sarvam for higher
          Hindi/Hinglish accuracy. <b>That one file leaves the office</b> — local transcription stays the default.
        </p>
        <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}>
          <input type="checkbox" checked={cloud.ai_cloud_enabled} style={{ width: 'auto' }}
            onChange={(e) => setCloud((c) => ({ ...c, ai_cloud_enabled: e.target.checked }))} />
          <span>Allow sending opted-in recordings to Sarvam</span>
        </label>
        <div className="field" style={{ maxWidth: 420 }}>
          <label>Sarvam API key {cloud.has_sarvam_key && <span className="badge won">set</span>}</label>
          <input type="password" autoComplete="off" value={cloud.sarvam_api_key}
            placeholder={cloud.has_sarvam_key ? '•••••••• (leave blank to keep)' : 'Paste your Sarvam key'}
            onChange={(e) => setCloud((c) => ({ ...c, sarvam_api_key: e.target.value }))} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn small" onClick={saveCloud}>Save cloud settings</button>
          {cloud.has_sarvam_key && (
            <button className="btn small secondary" onClick={clearSarvamKey}>Remove key</button>
          )}
        </div>
      </div>

      {isOwner(user.role) && (
      <div className="card">
        <h2>💬 WhatsApp inbox (Baileys)</h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Two-way WhatsApp chat, embedded in this server. Incoming messages link to leads by phone
          and appear in the lead timeline. <b>Use a dedicated business number</b> — this is the
          unofficial WhatsApp Web protocol and carries a real account-ban risk on a personal number.
          The phone must stay on the office WiFi for messages to sync.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span className="meta" style={{ fontSize: 13 }}>
            Status: <b>{wa?.status || 'disconnected'}</b>
            {wa?.phone_number ? ` · +91 ${wa.phone_number}` : ''}
            {wa?.display_name ? ` · ${wa.display_name}` : ''}
          </span>
          {wa?.status === 'connected'
            ? <span className="badge won">connected</span>
            : <span className="badge pending">{wa?.status || 'off'}</span>}
        </div>

        {wa?.status === 'qr_pending' && wa?.qr_code && (
          <div style={{ textAlign: 'center', margin: '6px 0 12px' }}>
            <img src={wa.qr_code} alt="WhatsApp pairing QR" style={{ width: 240, height: 240, borderRadius: 12 }} />
            <div className="hint">
              On the WhatsApp business phone: <b>Settings → Linked devices → Link a device</b>, then scan this code.
            </div>
          </div>
        )}
        {wa && wa.engine_installed === false && (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13, background: 'var(--bg-soft, rgba(0,0,0,0.04))', padding: 10, borderRadius: 8 }}>
            The WhatsApp engine isn’t installed on this computer. WhatsApp is meant to run on the{' '}
            <b>main office computer only</b> — install it there with <code>npm run whatsapp:install</code>,
            then reload this page. Leaving it off means no one can run WhatsApp from this machine.
          </p>
        )}
        {wa?.last_error && wa?.status === 'error' && (
          <p style={{ color: 'var(--red)', fontSize: 13 }}>
            {wa.last_error.includes('unavailable') || wa.last_error.includes('not installed')
              ? 'The WhatsApp engine isn’t installed on this computer. Run npm run whatsapp:install on the office computer, then try again.'
              : wa.last_error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {wa?.status !== 'connected' && wa?.engine_installed !== false && (
            <button className="btn green" onClick={waStart}>
              {wa?.status === 'qr_pending' ? 'Restart pairing' : 'Connect WhatsApp'}
            </button>
          )}
          {(wa?.status === 'connected' || wa?.enabled) && (
            <button className="btn secondary" onClick={waLogout}>Disconnect / turn off</button>
          )}
          <button className="btn secondary" onClick={waReset}>Reset (wipe chats + login)</button>
        </div>
      </div>
      )}

      <div className="card">
        <h2>🛟 Data safety</h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Last backup: <b>{settings?.last_backup ? fmtDateTime(settings.last_backup.at) : 'never yet'}</b>
          {' '}— backups run automatically every day into the <code>backups/</code> folder.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn secondary" onClick={backupNow}>Back up now</button>
          <button className="btn secondary" onClick={clearDemo}>Clear demo data</button>
        </div>
      </div>

      {isOwner(user.role) && (
      <div className="card">
        <h2>☁️ Cloud Backup (Google Drive)</h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Encrypts a daily copy of all your data and uploads it to your own Google Drive — off-site,
          so a stolen or dead computer doesn’t lose everything. Files are <b>AES-256 encrypted on this
          computer first</b>; Google only ever stores ciphertext it cannot read.
        </p>

        {!backup?.hasClientCredentials && (
          <div className="field-group" style={{ marginBottom: 10 }}>
            <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: 0 }}>
              One-time setup: create a Google Cloud <b>Desktop</b> OAuth client (see
              {' '}<code>docs/GOOGLE-DRIVE-BACKUP.md</code>) and paste its id + secret here.
            </p>
            <div className="form-grid">
              <div className="field">
                <label>OAuth client ID</label>
                <input value={driveCreds.client_id} autoComplete="off"
                  onChange={(e) => setDriveCreds((c) => ({ ...c, client_id: e.target.value }))} />
              </div>
              <div className="field">
                <label>OAuth client secret</label>
                <input type="password" value={driveCreds.client_secret} autoComplete="off"
                  onChange={(e) => setDriveCreds((c) => ({ ...c, client_secret: e.target.value }))} />
              </div>
            </div>
            <button className="btn small" onClick={saveDriveCreds}
              disabled={!driveCreds.client_id.trim() || !driveCreds.client_secret.trim()}>
              Save Google credentials
            </button>
          </div>
        )}

        {backup?.hasClientCredentials && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            {backup?.connected ? (
              <>
                <span className="badge won">Drive connected</span>
                <button className="btn small secondary" onClick={disconnectDrive}>Pause syncing</button>
              </>
            ) : (
              <button className="btn small green" onClick={connectDrive}>Connect Google Drive</button>
            )}
            <button className="btn small secondary" onClick={loadBackup}>Refresh status</button>
          </div>
        )}

        <div className="field" style={{ maxWidth: 460 }}>
          <label>
            Backup passphrase {backup?.hasPassphrase && <span className="badge won">set</span>}
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" autoComplete="new-password" value={passphrase}
              placeholder={backup?.hasPassphrase ? 'Re-enter to verify / unlock for this session' : 'Choose a strong passphrase (min 8 chars)'}
              onChange={(e) => setPassphrase(e.target.value)} />
            <button className="btn small" onClick={savePassphrase} disabled={passphrase.length < 8}>
              {backup?.hasPassphrase ? 'Verify' : 'Set'}
            </button>
          </div>
          <div className="hint" style={{ color: 'var(--red)', fontWeight: 600 }}>
            ⚠️ Write this passphrase down and store it safely. If you lose it, your backups are
            <b> permanently unrecoverable</b> — there is no reset and no recovery.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          <button className="btn" disabled={!backup?.connected}
            onClick={runCloudBackup}>Back up now</button>
          <span className="meta" style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
            {backup?.lastCloudBackup
              ? (backup.lastCloudBackup.ok
                ? `Last off-site backup: ${fmtDateTime(backup.lastCloudBackup.at)} · ${backup.lastCloudBackup.files} file(s)`
                : `Last attempt ${fmtDateTime(backup.lastCloudBackup.at)} failed: ${backup.lastCloudBackup.error || 'unknown error'}`)
              : 'No off-site backup yet'}
          </span>
        </div>
      </div>
      )}

      {modal && 'user' in modal && (
        <UserModal user={modal.user} onClose={() => setModal(null)} onSaved={load} />)}
      {modal && 'product' in modal && (
        <ProductModal product={modal.product} onClose={() => setModal(null)} onSaved={load} />)}
      {modal && 'service' in modal && (
        <ServiceModal service={modal.service} onClose={() => setModal(null)} onSaved={loadCatalog} />)}
      {modal && 'addon' in modal && (
        <AddonModal addon={modal.addon} onClose={() => setModal(null)} onSaved={loadCatalog} />)}
      {modal && 'template' in modal && (
        <TemplateModal template={modal.template} onClose={() => setModal(null)} onSaved={load} />)}
      {modal && 'pair' in modal && (
        <PairDeviceModal users={users} onClose={() => { setModal(null); load(); }} />)}
    </>
  );
}
