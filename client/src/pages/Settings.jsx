import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, rupees, fmtDateTime } from '../api.js';
import { useApp } from '../App.jsx';
import { Modal, invalidateTemplateCache } from '../components.jsx';

function PairDeviceModal({ users, onClose }) {
  const { showToast } = useApp();
  const [userId, setUserId] = useState('');
  const [pairing, setPairing] = useState(null); // {code, qr}

  const generate = async () => {
    try {
      const res = await api.post('/api/devices/pairing-code', { user_id: Number(userId) });
      const payload = JSON.stringify({ u: window.location.origin, c: res.code });
      const qr = await QRCode.toDataURL(payload, { width: 260, margin: 1 });
      setPairing({ code: res.code, qr });
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
            address <b>{window.location.origin}</b>). Valid for 15 minutes, works once.
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
  const [form, setForm] = useState({
    username: editing?.username || '', full_name: editing?.full_name || '',
    password: '', role: editing?.role || 'caller',
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
          password: form.password, role: form.role,
        });
        userId = res.id;
      } else {
        await api.patch(`/api/users/${userId}`, {
          full_name: form.full_name,
          ...(form.password ? { new_password: form.password } : {}),
        });
      }
      await api.put(`/api/users/${userId}/targets`, {
        calls_target: Number(form.calls_target),
        connects_target: Number(form.connects_target),
        deals_target: Number(form.deals_target),
      });
      showToast(isNew ? 'Caller added ✓' : 'Saved ✓');
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
        {isNew && (
          <div className="field">
            <label>Role</label>
            <select value={form.role} onChange={set('role')}>
              <option value="caller">Caller</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        )}
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
  const [modal, setModal] = useState(null);

  const load = () => {
    api.get('/api/users').then(setUsers).catch(() => {});
    api.get('/api/products?all=1').then(setProducts).catch(() => {});
    api.get('/api/templates?all=1').then(setTemplates).catch(() => {});
    api.get('/api/devices').then(setDevices).catch(() => {});
    api.get('/api/ai/status').then(setAi).catch(() => {});
    api.get('/api/settings').then((s) => { setSettings(s); setCompanyName(s.company_name); }).catch(() => {});
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

  const backupNow = async () => {
    try { await api.post('/api/settings/backup-now'); showToast('Backup created ✓'); load(); }
    catch (err) { showToast(err.message, 'error'); }
  };

  const clearDemo = async () => {
    if (!window.confirm('Remove all demo leads and their calls/deals/payments? Your real data stays.')) return;
    try {
      const res = await api.post('/api/settings/clear-demo-data');
      showToast(`Removed ${res.removed} demo leads ✓`);
    } catch (err) { showToast(err.message, 'error'); }
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
                  <td><b>{u.full_name}</b>{!u.is_active && ' (inactive)'}</td>
                  <td>{u.username}</td>
                  <td>{u.role}</td>
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

      {modal && 'user' in modal && (
        <UserModal user={modal.user} onClose={() => setModal(null)} onSaved={load} />)}
      {modal && 'product' in modal && (
        <ProductModal product={modal.product} onClose={() => setModal(null)} onSaved={load} />)}
      {modal && 'template' in modal && (
        <TemplateModal template={modal.template} onClose={() => setModal(null)} onSaved={load} />)}
      {modal && 'pair' in modal && (
        <PairDeviceModal users={users} onClose={() => { setModal(null); load(); }} />)}
    </>
  );
}
