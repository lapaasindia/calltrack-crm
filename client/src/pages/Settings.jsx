import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, rupees, fmtDateTime } from '../api.js';
import { useApp } from '../ctx.js';
import { usePolling, useRequest, useSubmit } from '../hooks.js';
import { Modal, invalidateTemplateCache, ErrorState, Field } from '../components.jsx';
import { ROLES, ROLE_LABELS, isOwner, isAssignable } from '../permissions.js';

// In-app step-by-step setup guides, opened from a "Guide" link on the cards.
const SETUP_GUIDES = {
  drive: {
    title: '☁️ Google Drive backup — setup guide',
    intro: 'Do all of this on the office computer at http://localhost:3000 — Google only accepts "localhost" for this, not the 192.168 address. About 5–10 minutes, one time.',
    steps: [
      { t: 'Open the Google Cloud console', d: 'Go to console.cloud.google.com and sign in with the Google account whose Drive should hold the backups.' },
      { t: 'Create a project', d: 'Top bar, open the project dropdown, click New Project, name it "CallTrack Backup", click Create, and make sure it stays selected.' },
      { t: 'Enable the Drive API', d: 'Left menu, APIs & Services, Library. Search "Google Drive API" and click Enable.' },
      { t: 'Set up the consent screen', d: 'APIs & Services, OAuth consent screen. Choose External, Create. App name "CallTrack", put your email in both email fields, then Save and Continue through each step. On "Test users", click Add Users and add your Gmail, then Save.' },
      { t: 'Create the Desktop client', d: 'APIs & Services, Credentials, Create Credentials, OAuth client ID. Application type: Desktop app, Create. Copy the Client ID and Client secret.' },
      { t: 'Paste them here', d: 'Back on this page, paste the Client ID and Client secret into the fields above, then click "Save Google credentials".' },
      { t: 'Connect', d: 'Click "Connect Google Drive" and pick your account. If you see "Google hasn\'t verified this app" (it is your own app), click Advanced, then Continue, then Allow.' },
      { t: 'Set a passphrase', d: 'Choose a Backup passphrase and WRITE IT DOWN somewhere safe. If you lose it the encrypted backups cannot be recovered — there is no reset.' },
      { t: 'Test it', d: 'Click "Back up now". A "CallTrack Backups" folder appears in your Google Drive as unreadable encrypted files. After this, daily backups run automatically.' },
    ],
  },
  whatsapp: {
    title: '💬 WhatsApp inbox — setup guide',
    intro: 'Two-way WhatsApp inside CallTrack: incoming chats link to leads automatically and you reply from the CRM. The engine is already built in — no install needed. Only an admin can connect it, and it stays off until you do. Use a DEDICATED business number — this is the unofficial WhatsApp Web protocol and a personal number risks a ban.',
    steps: [
      { t: 'Use a dedicated business number', d: 'Put a dedicated business WhatsApp number on a phone that is on the office WiFi. Never a personal number — a ban would take down the office WhatsApp.' },
      { t: 'Click Connect', d: 'On this card, click "Connect WhatsApp" — a QR code appears.' },
      { t: 'Scan it', d: 'On the business phone: WhatsApp, Settings, Linked devices, Link a device, then scan the QR.' },
      { t: 'Done', d: 'Status turns "connected" and a WhatsApp item appears in the sidebar. Incoming messages link to leads, show in the timeline, and you can reply. Phone notifications on the mobile app need the Android rebuild (docs/WHATSAPP-MOBILE.md).' },
    ],
  },
};

function SetupGuideModal({ kind, onClose }) {
  const g = SETUP_GUIDES[kind];
  if (!g) return null;
  return (
    <Modal title={g.title} onClose={onClose}>
      <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>{g.intro}</p>
      <ol style={{ paddingLeft: 18, lineHeight: 1.5, margin: '8px 0' }}>
        {g.steps.map((s, i) => (
          <li key={i} style={{ marginBottom: 12 }}>
            <b>{s.t}</b>
            <div style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: 2 }}>{s.d}</div>
          </li>
        ))}
      </ol>
      <div style={{ textAlign: 'right', marginTop: 6 }}>
        <button type="button" className="btn" onClick={onClose}>Got it</button>
      </div>
    </Modal>
  );
}

function PairDeviceModal({ users, onClose }) {
  const { showToast } = useApp();
  const [userId, setUserId] = useState('');
  const [pairing, setPairing] = useState(null); // {code, qr}

  const [generate, generating] = useSubmit(async () => {
    try {
      const res = await api.post('/api/devices/pairing-code', { user_id: Number(userId) });
      // The phone connects to whatever URL the QR contains, so it must be a LAN
      // address the phone can reach. window.location.origin is 127.0.0.1 in the
      // desktop app and a .local name some Android phones can't resolve — in
      // those cases use a real LAN IP the server reported.
      const host = window.location.hostname;
      const needsLan = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
      const serverUrl = (needsLan && res.urls && res.urls.length) ? res.urls[0] : window.location.origin;
      const payload = JSON.stringify({ u: serverUrl, c: res.code });
      const qr = await QRCode.toDataURL(payload, { width: 260, margin: 1 });
      setPairing({ code: res.code, qr, url: serverUrl });
    } catch (err) { showToast(err.message, 'error'); }
  });

  return (
    <Modal title="Pair a phone" onClose={onClose}>
      {!pairing ? (
        <>
          <Field label="Whose phone is this?">
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Pick team member…</option>
              {users.filter((u) => u.is_active).map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </Field>
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="btn" disabled={!userId || generating} onClick={generate}>{generating ? 'Generating…' : 'Generate code'}</button>
          </div>
        </>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <img src={pairing.qr} alt="Pairing QR" style={{ borderRadius: 12, maxWidth: '100%' }} />
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '0.15em', margin: '10px 0 4px' }}>
            {pairing.code}
          </div>
          <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, overflowWrap: 'anywhere' }}>
            In the CallTrack mobile app: <b>Scan this QR</b> (or type the code with the server
            address <b>{pairing.url}</b>). Valid for 15 minutes, works once.
          </p>
          <button type="button" className="btn block" onClick={onClose}>Done</button>
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
    username: (editing && editing.username) || '', full_name: (editing && editing.full_name) || '',
    password: '', role: (editing && editing.role) || 'caller', department: (editing && editing.department) || '',
    calls_target: editing && editing.calls_target != null ? editing.calls_target : 50,
    connects_target: editing && editing.connects_target != null ? editing.connects_target : 25,
    deals_target: editing && editing.deals_target != null ? editing.deals_target : 1,
  });
  const [showPw, setShowPw] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // One in-flight guard for the two sequential requests (CLIENT-20): a second
  // click used to POST the user again and 409 "Username already taken".
  const [save, saving] = useSubmit(async () => {
    try {
      let userId = editing && editing.id;
      if (isNew) {
        const res = await api.post('/api/users', {
          username: form.username.trim(), full_name: form.full_name.trim(),
          password: form.password, role: form.role, department: form.department,
        });
        userId = res.id;
      } else {
        const res = await api.patch(`/api/users/${userId}`, {
          full_name: form.full_name.trim(), department: form.department,
          ...(isSelf ? {} : { role: form.role }),
          ...(form.password ? { new_password: form.password } : {}),
        });
        if (form.password && res && (res.revoked_sessions || res.revoked_devices)) {
          showToast(`Password reset — ${res.revoked_sessions || 0} session(s) and ${res.revoked_devices || 0} phone(s) signed out; they must change it on next login.`);
        }
      }
      await api.put(`/api/users/${userId}/targets`, {
        calls_target: Number(form.calls_target),
        connects_target: Number(form.connects_target),
        deals_target: Number(form.deals_target),
      });
      showToast(isNew ? 'Team member added ✓' : 'Saved ✓');
      onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  });

  return (
    <Modal title={isNew ? 'Add team member' : `Edit ${editing.full_name}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} autoComplete="off">
        <div className="form-grid">
          <Field label="Username">
            <input value={form.username} onChange={set('username')} disabled={!isNew}
              autoCapitalize="none" autoCorrect="off" autoComplete="off" name="crm-new-username" />
          </Field>
          <Field label="Full name">
            <input value={form.full_name} onChange={set('full_name')} autoComplete="off" />
          </Field>
          <Field label={isNew ? 'Password' : 'New password (leave blank to keep)'}
            hint={isNew ? 'Temporary — they must change it on first login' : 'They are signed out everywhere and must change it on next login'}>
            <input type={showPw ? 'text' : 'password'} value={form.password} onChange={set('password')}
              placeholder="min 8 characters" autoComplete="new-password" name="crm-new-password" />
          </Field>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button type="button" className="btn small secondary" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}>
              {showPw ? 'Hide password' : 'Show password'}
            </button>
          </div>
          <Field label={`Role${isSelf ? ' (you can\'t change your own)' : ''}`}>
            <select value={form.role} onChange={set('role')} disabled={isSelf}>
              {/* Only an owner can grant owner-tier roles — hiding them mirrors the
                  server guard so a non-owner never picks a role that 403s. */}
              {ROLES.filter((r) => isOwner(me.role) || !isOwner(r))
                .map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </Field>
          <Field label="Department (optional)">
            <input value={form.department} onChange={set('department')} placeholder="e.g. Sales" />
          </Field>
        </div>
        <div className="section-label">Daily targets</div>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <Field label="Calls"><input inputMode="numeric" value={form.calls_target} onChange={set('calls_target')} /></Field>
          <Field label="Connects"><input inputMode="numeric" value={form.connects_target} onChange={set('connects_target')} /></Field>
          <Field label="Deals"><input inputMode="numeric" value={form.deals_target} onChange={set('deals_target')} /></Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn"
            disabled={saving || !form.full_name.trim() || (isNew && (!form.username.trim() || form.password.length < 8))}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// After deactivating someone: hand their open leads (and, with them, pending
// follow-ups + lead tasks) to a colleague via the bulk-assign endpoint.
function ReassignModal({ target, openWork, users, onClose, onDone }) {
  const { showToast } = useApp();
  const [to, setTo] = useState('');
  const [mode, setMode] = useState('one'); // one | rr
  const candidates = users.filter((u) => u.id !== target.id && isAssignable(u));

  const [run, running] = useSubmit(async () => {
    try {
      // Collect every lead still assigned to the deactivated user (paged).
      const ids = [];
      let page = 1;
      for (;;) {
        const d = await api.get(`/api/leads?assigned_to=${target.id}&limit=500&page=${page}`);
        ids.push(...(d.leads || []).map((l) => l.id));
        if (!d.leads || !d.leads.length || ids.length >= (d.total || 0)) break;
        page += 1;
        if (page > 40) break; // 20k leads — enough for one click
      }
      if (!ids.length) { showToast('No leads left to reassign'); onDone(); return; }
      await api.post('/api/leads/bulk-assign', {
        lead_ids: ids,
        assigned_to: mode === 'one' ? Number(to) : undefined,
        round_robin: mode === 'rr' || undefined,
      });
      showToast(`${ids.length} lead(s) reassigned ✓ — their follow-ups and lead tasks moved too`);
      onDone();
    } catch (err) { showToast(err.message, 'error'); }
  });

  return (
    <Modal title={`Reassign ${target.full_name}'s work`} onClose={onClose}>
      <p className="modal-message">
        Still assigned to {target.full_name}: <b>{openWork.leads || 0} lead(s)</b>, <b>{openWork.follow_ups || 0} follow-up(s)</b>, <b>{openWork.tasks || 0} task(s)</b>.
        {'\n'}Reassigning the leads moves their pending follow-ups and lead-linked tasks with them. Tasks without a lead stay put — change them on the Work board.
      </p>
      <Field label="Give the leads to">
        <select value={mode === 'rr' ? '__rr' : to} onChange={(e) => { if (e.target.value === '__rr') { setMode('rr'); } else { setMode('one'); setTo(e.target.value); } }}>
          <option value="">Pick team member…</option>
          <option value="__rr">Distribute equally (round-robin)</option>
          {candidates.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({ROLE_LABELS[u.role] || u.role})</option>)}
        </select>
      </Field>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Later</button>
        <button type="button" className="btn" disabled={running || (mode === 'one' && !to)} onClick={run}>
          {running ? 'Reassigning…' : 'Reassign leads'}
        </button>
      </div>
    </Modal>
  );
}

function ProductModal({ product, onClose, onSaved }) {
  const { showToast } = useApp();
  const [form, setForm] = useState({
    name: (product && product.name) || '',
    price_rupees: product ? product.price_paise / 100 : '',
    description: (product && product.description) || '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [save, saving] = useSubmit(async () => {
    try {
      if (product) await api.patch(`/api/products/${product.id}`, form);
      else await api.post('/api/products', form);
      showToast('Saved ✓'); onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  });
  return (
    <Modal title={product ? 'Edit product' : 'Add product'} onClose={onClose}>
      <Field label="Name"><input value={form.name} onChange={set('name')} autoFocus /></Field>
      <Field label="Price (₹)"><input inputMode="decimal" value={form.price_rupees} onChange={set('price_rupees')} /></Field>
      <Field label="Description"><input value={form.description} onChange={set('description')} /></Field>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving || !form.name || !(Number(form.price_rupees) >= 0)} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

// Catalog service editor. base_price stored in paise; a ₹0 service is allowed.
function ServiceModal({ service, onClose, onSaved }) {
  const { showToast } = useApp();
  const m = (service && service.term_multipliers) || { monthly: 1, quarterly: 0.94, annual: 0.86 };
  const [form, setForm] = useState({
    name: (service && service.name) || '',
    category: (service && service.category) || '',
    base_price_rupees: service ? service.base_price_paise / 100 : 0,
    monthly: m.monthly ?? 1, quarterly: m.quarterly ?? 0.94, annual: m.annual ?? 0.86,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [save, saving] = useSubmit(async () => {
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
  });
  return (
    <Modal title={service ? 'Edit service' : 'Add service'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Name"><input value={form.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Category (optional)"><input value={form.category} onChange={set('category')} /></Field>
      </div>
      <Field label="Base price (₹/mo)" hint="₹0 is allowed (e.g. a free tier)." style={{ maxWidth: 200 }}>
        <input inputMode="decimal" value={form.base_price_rupees} onChange={set('base_price_rupees')} />
      </Field>
      <div className="section-label">Term multipliers</div>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <Field label="Monthly"><input inputMode="decimal" value={form.monthly} onChange={set('monthly')} /></Field>
        <Field label="Quarterly"><input inputMode="decimal" value={form.quarterly} onChange={set('quarterly')} /></Field>
        <Field label="Annual"><input inputMode="decimal" value={form.annual} onChange={set('annual')} /></Field>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving || !form.name || !(Number(form.base_price_rupees) >= 0)} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

// Catalog add-on editor. price stored in paise; a ₹0 add-on is allowed.
function AddonModal({ addon, onClose, onSaved }) {
  const { showToast } = useApp();
  const [form, setForm] = useState({
    name: (addon && addon.name) || '', icon: (addon && addon.icon) || '',
    price_rupees: addon ? addon.price_paise / 100 : 0,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [save, saving] = useSubmit(async () => {
    try {
      const body = {
        name: form.name, icon: form.icon || null,
        price_paise: Math.round(Number(form.price_rupees) * 100),
      };
      if (addon) await api.put(`/api/catalog/addons/${addon.id}`, body);
      else await api.post('/api/catalog/addons', body);
      showToast('Saved ✓'); onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  });
  return (
    <Modal title={addon ? 'Edit add-on' : 'Add add-on'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Name"><input value={form.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Icon (optional emoji)"><input value={form.icon} onChange={set('icon')} /></Field>
      </div>
      <Field label="Price (₹/mo)" hint="₹0 is allowed." style={{ maxWidth: 200 }}>
        <input inputMode="decimal" value={form.price_rupees} onChange={set('price_rupees')} />
      </Field>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving || !form.name || !(Number(form.price_rupees) >= 0)} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

function TemplateModal({ template, onClose, onSaved }) {
  const { showToast } = useApp();
  const [form, setForm] = useState({
    name: (template && template.name) || '', category: (template && template.category) || 'custom', body: (template && template.body) || '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [save, saving] = useSubmit(async () => {
    try {
      if (template) await api.patch(`/api/templates/${template.id}`, form);
      else await api.post('/api/templates', form);
      invalidateTemplateCache();
      showToast('Saved ✓'); onSaved(); onClose();
    } catch (err) { showToast(err.message, 'error'); }
  });
  return (
    <Modal title={template ? 'Edit template' : 'Add WhatsApp template'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Name"><input value={form.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Category">
          <select value={form.category} onChange={set('category')}>
            <option value="intro">Intro</option><option value="follow_up">Follow-up</option>
            <option value="payment_reminder">Payment reminder</option>
            <option value="support">Support</option><option value="custom">Custom</option>
          </select>
        </Field>
      </div>
      <Field label="Message" hint={`Placeholders: {name} {product} {amount_due} {due_date} {caller_name} {company}`}>
        <textarea rows={4} value={form.body} onChange={set('body')} />
      </Field>
      <div className="modal-actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={saving || !form.name || !form.body} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

const fmtBytes = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const b = Number(n);
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
};

// Owner-only operability snapshot (GET /api/ops/health). Hidden entirely when
// the endpoint is missing (older server) or refused.
function OpsHealthCard() {
  const { data, error, reload } = useRequest(({ signal }) => api.get('/api/ops/health', { signal }), []);
  const paths = useRequest(({ signal }) => api.get('/api/settings/paths', { signal }), []);
  if (error && (error.status === 404 || error.status === 403)) return null;
  if (!data && !error) return null;
  const lag = data && (data.event_loop_lag_ms != null ? data.event_loop_lag_ms : (data.event_loop_lag && data.event_loop_lag.p99));
  const bad = (cond) => (cond ? 'v bad' : 'v');
  return (
    <div className="card">
      <h2>🩺 Ops health{' '}
        <button type="button" className="btn small secondary" style={{ float: 'right' }} onClick={reload}>Refresh</button></h2>
      {error && !data && <ErrorState error={error} onRetry={reload} compact />}
      {data && (
        <div className="kv-grid">
          <div><div className="k">Version</div><div className="v">{data.version || '—'}</div></div>
          <div><div className="k">Uptime</div><div className="v">{data.uptime_s != null ? `${Math.floor(data.uptime_s / 3600)}h ${Math.floor((data.uptime_s % 3600) / 60)}m` : '—'}</div></div>
          <div><div className="k">Database check</div><div className={bad(data.db_quick_check && data.db_quick_check !== 'ok')}>{data.db_quick_check || '—'}{data.db_quick_check_at ? ` · ${fmtDateTime(data.db_quick_check_at)}` : ''}</div></div>
          <div><div className="k">Schema version</div><div className="v">{data.db_schema_version ?? '—'}</div></div>
          <div><div className="k">Database size</div><div className="v">{fmtBytes(data.db_bytes)} · WAL {fmtBytes(data.wal_bytes)}</div></div>
          <div><div className="k">Last local backup</div><div className={bad(!data.last_backup)}>{data.last_backup && data.last_backup.at ? `${fmtDateTime(data.last_backup.at)} · ${fmtBytes(data.last_backup.bytes)}` : 'never'}</div></div>
          <div><div className="k">Last cloud backup</div><div className="v">{data.last_cloud_backup && data.last_cloud_backup.at ? fmtDateTime(data.last_cloud_backup.at) : 'never'}</div></div>
          <div><div className="k">Last maintenance</div><div className="v">{data.last_maintenance && (data.last_maintenance.at || data.last_maintenance.ran_at) ? fmtDateTime(data.last_maintenance.at || data.last_maintenance.ran_at) : (data.last_maintenance ? 'done' : 'not yet')}</div></div>
          <div><div className="k">AI queue</div><div className="v">{data.ai_queue ? `${data.ai_queue.pending} waiting · ${data.ai_queue.processing} processing` : '—'}</div></div>
          <div><div className="k">Event-loop lag (p99)</div><div className={bad(lag > 200)}>{lag != null ? `${Math.round(lag)} ms` : '—'}</div></div>
          <div><div className="k">Free disk</div><div className={bad(data.free_disk_gb != null && data.free_disk_gb < 2)}>{data.free_disk_gb != null ? `${data.free_disk_gb} GB` : '—'}</div></div>
          <div><div className="k">Memory (RSS)</div><div className="v">{data.memory_rss_mb != null ? `${data.memory_rss_mb} MB` : '—'}</div></div>
          <div><div className="k">Background jobs</div><div className="v">{Array.isArray(data.jobs) && data.jobs.length ? data.jobs.map((j) => `${j.name} (${Math.round((j.running_ms || 0) / 1000)}s)`).join(', ') : 'idle'}</div></div>
          {paths.data && typeof paths.data === 'object' && Object.entries(paths.data).slice(0, 6).map(([k, v]) => (
            typeof v === 'string' ? <div key={k}><div className="k">{k.replace(/_/g, ' ')}</div><div className="v" style={{ fontWeight: 500, fontSize: 12 }}>{v}</div></div> : null
          ))}
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const { user, showToast, askConfirm } = useApp();
  const [users, setUsers] = useState([]);
  const [products, setProducts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [devices, setDevices] = useState([]);
  const [ai, setAi] = useState(null);
  const [settings, setSettings] = useState(null);
  const [companyName, setCompanyName] = useState('');
  const [invoice, setInvoice] = useState({ company_legal_name: '', company_address: '', company_gstin: '', gst_percent: 18 });
  const [cloud, setCloud] = useState({ ai_cloud_enabled: false, has_sarvam_key: false, sarvam_api_key: '' });
  const [quotaMb, setQuotaMb] = useState('');
  const [backup, setBackup] = useState(null); // /api/backup/status
  const [driveCreds, setDriveCreds] = useState({ client_id: '', client_secret: '' });
  const [passphrase, setPassphrase] = useState('');
  const [routingRules, setRoutingRules] = useState([]);
  const [newRule, setNewRule] = useState({ subject: '', assigned_to: '' });
  const [catalog, setCatalog] = useState({ services: [], addons: [], pricing_config: null });
  const [pricingForm, setPricingForm] = useState(null);
  const [wa, setWa] = useState(null); // WhatsApp session status
  const [guide, setGuide] = useState(null); // 'drive' | 'whatsapp' — in-app setup guide
  const [modal, setModal] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null); // key of the action in flight

  const loadCatalog = useCallback(() => api.get('/api/catalog').then((c) => {
    setCatalog(c);
    setPricingForm({
      platform_tiers: ((c.pricing_config && c.pricing_config.platform_tiers) || []).map((t) => ({
        key: t.key, name: t.name, price_rupees: (t.price_paise || 0) / 100,
      })),
      bandwidth_rate_rupees: ((c.pricing_config && c.pricing_config.bandwidth_rate_paise) || 0) / 100,
      term_multipliers: { ...((c.pricing_config && c.pricing_config.term_multipliers) || { monthly: 1, quarterly: 0.94, annual: 0.86 }) },
    });
  }), []);

  const load = useCallback(() => {
    setLoadError(null);
    const fail = (err) => setLoadError((e) => e || err);
    api.get('/api/users').then(setUsers).catch(fail);
    api.get('/api/routing-rules').then(setRoutingRules).catch(fail);
    loadCatalog().catch(fail);
    api.get('/api/products?all=1').then(setProducts).catch(fail);
    api.get('/api/templates?all=1').then(setTemplates).catch(fail);
    api.get('/api/devices').then(setDevices).catch(fail);
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
        gst_percent: s.gst_percent != null ? s.gst_percent : 18,
      });
      // Leave the key field blank — it's never returned; has_sarvam_key tells us it's set.
      setCloud({ ai_cloud_enabled: !!s.ai_cloud_enabled, has_sarvam_key: !!s.has_sarvam_key, sarvam_api_key: '' });
      setQuotaMb(s.upload_daily_quota_mb != null ? String(s.upload_daily_quota_mb) : '');
    }).catch(fail);
  }, [loadCatalog]);
  useEffect(() => { load(); }, [load]);

  // One helper for every "click → request → reload" action: in-flight guard +
  // toast on failure.
  const act = async (key, fn) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); } catch (err) { showToast(err.message, 'error'); } finally { setBusy(null); }
  };

  const toggleAi = (enabled) => act('ai', async () => {
    await api.put('/api/ai/settings', { enabled }); showToast(enabled ? 'AI transcription on' : 'AI off'); load();
  });

  const revokeDevice = async (d) => {
    const ok = await askConfirm({
      title: `Disconnect ${d.device_name}?`, message: `${d.user_name}'s phone stops syncing immediately.`, confirmLabel: 'Disconnect', danger: true,
    });
    if (!ok) return;
    act(`dev-${d.id}`, async () => { await api.post(`/api/devices/${d.id}/revoke`); load(); });
  };

  const [reassign, setReassign] = useState(null); // { target, openWork }
  const toggleUser = async (u) => {
    if (u.is_active) {
      const ok = await askConfirm({
        title: `Deactivate ${u.full_name}?`,
        message: 'They are signed out everywhere and their paired phone is disconnected. Leads, follow-ups and tasks stay assigned until you reassign them (you will be asked next).',
        confirmLabel: 'Deactivate', danger: true,
      });
      if (!ok) return;
    }
    act(`user-${u.id}`, async () => {
      const res = await api.patch(`/api/users/${u.id}`, { is_active: u.is_active ? 0 : 1 });
      load();
      const ow = res && res.open_work;
      if (u.is_active && ow && ((ow.leads || 0) + (ow.follow_ups || 0) + (ow.tasks || 0)) > 0) {
        setReassign({ target: u, openWork: ow });
      } else if (u.is_active) {
        showToast(`${u.full_name} deactivated — nothing left to reassign`);
      }
    });
  };

  const toggleProduct = (p) => act(`prod-${p.id}`, async () => { await api.patch(`/api/products/${p.id}`, { is_active: p.is_active ? 0 : 1 }); load(); });

  const saveCompany = () => act('company', async () => {
    await api.put('/api/settings', { company_name: companyName });
    invalidateTemplateCache();
    showToast('Saved ✓');
  });

  const saveInvoice = () => act('invoice', async () => {
    await api.put('/api/settings', {
      company_legal_name: invoice.company_legal_name,
      company_address: invoice.company_address,
      company_gstin: invoice.company_gstin,
      gst_percent: Number(invoice.gst_percent),
    });
    showToast('Invoice details saved ✓'); load();
  });

  const saveCloud = () => act('cloud', async () => {
    const body = { ai_cloud_enabled: cloud.ai_cloud_enabled };
    // Only send the key if the user typed one (empty field would otherwise clear it).
    if (cloud.sarvam_api_key.trim()) body.sarvam_api_key = cloud.sarvam_api_key.trim();
    await api.put('/api/settings', body);
    showToast('Cloud AI settings saved ✓'); load();
  });

  const clearSarvamKey = () => act('cloud', async () => { await api.put('/api/settings', { sarvam_api_key: '' }); showToast('Sarvam key removed ✓'); load(); });

  const saveQuota = () => act('quota', async () => {
    const n = Number(quotaMb);
    if (!Number.isFinite(n) || n < 0) { showToast('Enter a number of MB (0 = unlimited)', 'error'); return; }
    await api.put('/api/settings', { upload_daily_quota_mb: n });
    showToast('Upload quota saved ✓');
    load();
  });

  const addRoutingRule = () => act('rule', async () => {
    if (!newRule.subject.trim()) { showToast('Subject required', 'error'); return; }
    await api.post('/api/routing-rules', {
      subject: newRule.subject.trim(),
      assigned_to: newRule.assigned_to ? Number(newRule.assigned_to) : null,
    });
    setNewRule({ subject: '', assigned_to: '' });
    showToast('Routing rule added ✓'); load();
  });

  const deleteRoutingRule = async (rule) => {
    const ok = await askConfirm({ title: `Delete the routing rule for "${rule.subject}"?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    act(`rule-${rule.id}`, async () => { await api.del(`/api/routing-rules/${rule.id}`); load(); });
  };

  const backupNow = () => act('backup', async () => {
    const res = await api.post('/api/settings/backup-now');
    const f = res && res.file;
    showToast(f && f.bytes ? `Backup created ✓ (${fmtBytes(f.bytes)}${f.ms ? `, ${f.ms} ms` : ''})` : 'Backup created ✓');
    load();
  });

  // ── Cloud Backup (Google Drive) ──────────────────────────────────────────
  const loadBackup = () => api.get('/api/backup/status').then(setBackup).catch(() => {});

  const saveDriveCreds = () => act('drive', async () => {
    await api.post('/api/backup/google/credentials', {
      client_id: driveCreds.client_id.trim(),
      client_secret: driveCreds.client_secret.trim(),
    });
    setDriveCreds({ client_id: '', client_secret: '' });
    showToast('Google OAuth credentials saved ✓'); loadBackup();
  });

  const connectDrive = () => act('drive', async () => {
    const res = await api.post('/api/backup/google/connect');
    window.open(res.url, '_blank', 'noopener');
    showToast('Approve access in the new tab, then click "Refresh status".');
  });

  const savePassphrase = async () => {
    if (passphrase.length < 8) { showToast('Passphrase must be at least 8 characters', 'error'); return; }
    if (!(backup && backup.hasPassphrase)) {
      const ok = await askConfirm({
        title: 'Write this passphrase down',
        message: 'If you lose it, your off-site backups are PERMANENTLY UNRECOVERABLE — there is no reset. Continue?',
        confirmLabel: 'I wrote it down', danger: true,
      });
      if (!ok) return;
    }
    act('pass', async () => {
      await api.post('/api/backup/passphrase', { passphrase });
      setPassphrase('');
      showToast(backup && backup.hasPassphrase ? 'Passphrase verified ✓' : 'Passphrase set ✓'); loadBackup();
    });
  };

  const runCloudBackup = () => act('cloud-backup', async () => {
    const res = await api.post('/api/backup/run-now', passphrase ? { passphrase } : {});
    if (res.ok) showToast(`Backed up ${res.files} file(s) to Google Drive ✓`);
    else showToast(res.error || 'Backup did not complete', 'error');
    setPassphrase(''); loadBackup();
  });

  const disconnectDrive = async () => {
    const ok = await askConfirm({
      title: 'Stop syncing to Google Drive?', message: 'Your existing Drive backups and tokens are kept — you can reconnect anytime.', confirmLabel: 'Pause syncing',
    });
    if (!ok) return;
    act('drive', async () => { await api.post('/api/backup/disconnect'); showToast('Cloud backup paused'); loadBackup(); });
  };

  // ── Service catalog ──────────────────────────────────────────────────────
  const toggleService = (s) => act(`svc-${s.id}`, async () => { await api.put(`/api/catalog/services/${s.id}`, { is_active: s.is_active ? 0 : 1 }); await loadCatalog(); });
  const deleteService = async (s) => {
    const ok = await askConfirm({ title: `Delete service "${s.name}"?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    act(`svc-${s.id}`, async () => { await api.del(`/api/catalog/services/${s.id}`); showToast('Service deleted ✓'); await loadCatalog(); });
  };
  const toggleAddon = (a) => act(`addon-${a.id}`, async () => { await api.put(`/api/catalog/addons/${a.id}`, { is_active: a.is_active ? 0 : 1 }); await loadCatalog(); });
  const deleteAddon = async (a) => {
    const ok = await askConfirm({ title: `Delete add-on "${a.name}"?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    act(`addon-${a.id}`, async () => { await api.del(`/api/catalog/addons/${a.id}`); showToast('Add-on deleted ✓'); await loadCatalog(); });
  };
  const savePricing = () => act('pricing', async () => {
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
    showToast('Pricing config saved ✓'); await loadCatalog();
  });

  const clearDemo = async () => {
    const ok = await askConfirm({
      title: 'Remove all demo leads?', message: 'Their calls, deals and payments go too. Your real data stays.', confirmLabel: 'Remove demo data', danger: true,
    });
    if (!ok) return;
    act('demo', async () => { const res = await api.post('/api/settings/clear-demo-data'); showToast(`Removed ${res.removed} demo leads ✓`); });
  };

  // ── WhatsApp (Baileys) ────────────────────────────────────────────────────
  const loadWa = useCallback(() => api.get('/api/whatsapp/status').then(setWa).catch(() => {}), []);
  // While pairing (qr_pending/connecting), poll for the QR + status until the
  // session resolves to connected/error/disconnected — only while visible.
  const pairing = !!(wa && ['qr_pending', 'connecting'].includes(wa.status));
  usePolling(loadWa, 3000, [loadWa], { enabled: pairing });

  const waStart = () => act('wa', async () => {
    await api.post('/api/whatsapp/start');
    showToast('Pairing started — scan the QR with your WhatsApp business number.');
    loadWa();
  });
  const waLogout = async () => {
    const ok = await askConfirm({ title: 'Disconnect WhatsApp?', message: 'Incoming messages stop syncing until you reconnect.', confirmLabel: 'Disconnect', danger: true });
    if (!ok) return;
    act('wa', async () => { await api.post('/api/whatsapp/logout'); showToast('WhatsApp disconnected'); loadWa(); });
  };
  const waReset = async () => {
    const ok = await askConfirm({
      title: 'Reset WhatsApp?', message: 'This deletes ALL synced WhatsApp contacts, messages, and the saved login. Leads stay.', confirmLabel: 'Reset everything', danger: true,
    });
    if (!ok) return;
    act('wa', async () => { await api.post('/api/whatsapp/reset'); showToast('WhatsApp reset ✓'); loadWa(); });
  };

  const owner = isOwner(user.role);
  const assignable = users.filter(isAssignable);

  return (
    <>
      <div className="page-title">
        <h1>Settings</h1>
        {owner && <Link className="btn small secondary" to="/audit">📜 Audit log</Link>}
      </div>

      {loadError && <ErrorState error={loadError} onRetry={load} compact title="Some settings could not be loaded" />}

      <div className="card">
        <h2>👥 Team {' '}
          <button type="button" className="btn small" style={{ float: 'right' }}
            onClick={() => setModal({ user: null })}>+ Add member</button></h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th>
              <th className="num">Targets (calls/connects/deals)</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.45 }}>
                  <td><b>{u.full_name}</b>{!u.is_active && ' (inactive)'}{u.department ? ` · ${u.department}` : ''}</td>
                  <td>{u.username}</td>
                  <td>{ROLE_LABELS[u.role] || u.role}</td>
                  <td className="num">{u.calls_target ?? '—'} / {u.connects_target ?? '—'} / {u.deals_target ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn small secondary" onClick={() => setModal({ user: u })}>Edit</button>{' '}
                    {u.id !== user.id && (
                      <button type="button" className="btn small secondary" disabled={busy === `user-${u.id}`} onClick={() => toggleUser(u)}>
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
            <thead><tr><th>Subject / source</th><th>Assign to</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {routingRules.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.subject}</b></td>
                  <td>{r.assigned_to_name || <span style={{ color: 'var(--ink-faint)' }}>— (unset)</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn small secondary" disabled={busy === `rule-${r.id}`} onClick={() => deleteRoutingRule(r)}>Delete</button>
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
          <Field label="Subject or source">
            <input value={newRule.subject}
              placeholder="e.g. Enterprise, Website, Facebook"
              onChange={(e) => setNewRule((r) => ({ ...r, subject: e.target.value }))} />
          </Field>
          <Field label="Assign to">
            <select value={newRule.assigned_to}
              onChange={(e) => setNewRule((r) => ({ ...r, assigned_to: e.target.value }))}>
              <option value="">Pick team member…</option>
              {assignable.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </Field>
          <div className="field">
            <button type="button" className="btn small" disabled={busy === 'rule'} onClick={addRoutingRule}>+ Add rule</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>📦 Products {' '}
          <button type="button" className="btn small" style={{ float: 'right' }}
            onClick={() => setModal({ product: null })}>+ Add product</button></h2>
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {products.map((p) => (
                <tr key={p.id} style={{ opacity: p.is_active ? 1 : 0.45 }}>
                  <td><b>{p.name}</b>{p.description ? ` — ${p.description}` : ''}</td>
                  <td className="num">{rupees(p.price_paise)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn small secondary" onClick={() => setModal({ product: p })}>Edit</button>{' '}
                    <button type="button" className="btn small secondary" disabled={busy === `prod-${p.id}`} onClick={() => toggleProduct(p)}>
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
            <button type="button" className="btn small" onClick={() => setModal({ service: null })}>+ Service</button>
            <button type="button" className="btn small" onClick={() => setModal({ addon: null })}>+ Add-on</button>
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
                    <button type="button" className="btn small secondary" onClick={() => setModal({ service: s })}>Edit</button>{' '}
                    <button type="button" className="btn small secondary" disabled={busy === `svc-${s.id}`} onClick={() => toggleService(s)}>{s.is_active ? 'Hide' : 'Show'}</button>{' '}
                    <button type="button" className="btn small secondary" disabled={busy === `svc-${s.id}`} onClick={() => deleteService(s)}>Delete</button>
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
                    <button type="button" className="btn small secondary" onClick={() => setModal({ addon: a })}>Edit</button>{' '}
                    <button type="button" className="btn small secondary" disabled={busy === `addon-${a.id}`} onClick={() => toggleAddon(a)}>{a.is_active ? 'Hide' : 'Show'}</button>{' '}
                    <button type="button" className="btn small secondary" disabled={busy === `addon-${a.id}`} onClick={() => deleteAddon(a)}>Delete</button>
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
              <div key={t.key || i} className="form-grid" style={{ gridTemplateColumns: '1fr 160px', alignItems: 'end' }}>
                <Field label="Tier name">
                  <input value={t.name}
                    onChange={(e) => setPricingForm((p) => ({
                      ...p, platform_tiers: p.platform_tiers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    }))} />
                </Field>
                <Field label="Price (₹/mo)">
                  <input inputMode="decimal" value={t.price_rupees}
                    onChange={(e) => setPricingForm((p) => ({
                      ...p, platform_tiers: p.platform_tiers.map((x, j) => (j === i ? { ...x, price_rupees: e.target.value } : x)),
                    }))} />
                </Field>
              </div>
            ))}
            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr', marginTop: 4 }}>
              <Field label="Bandwidth ₹/hr">
                <input inputMode="decimal" value={pricingForm.bandwidth_rate_rupees}
                  onChange={(e) => setPricingForm((p) => ({ ...p, bandwidth_rate_rupees: e.target.value }))} /></Field>
              <Field label="×Monthly">
                <input inputMode="decimal" value={pricingForm.term_multipliers.monthly}
                  onChange={(e) => setPricingForm((p) => ({ ...p, term_multipliers: { ...p.term_multipliers, monthly: e.target.value } }))} /></Field>
              <Field label="×Quarterly">
                <input inputMode="decimal" value={pricingForm.term_multipliers.quarterly}
                  onChange={(e) => setPricingForm((p) => ({ ...p, term_multipliers: { ...p.term_multipliers, quarterly: e.target.value } }))} /></Field>
              <Field label="×Annual">
                <input inputMode="decimal" value={pricingForm.term_multipliers.annual}
                  onChange={(e) => setPricingForm((p) => ({ ...p, term_multipliers: { ...p.term_multipliers, annual: e.target.value } }))} /></Field>
            </div>
            <button type="button" className="btn small" disabled={busy === 'pricing'} onClick={savePricing}>Save pricing config</button>
          </>
        )}
      </div>

      <div className="card">
        <h2>💬 WhatsApp templates {' '}
          <button type="button" className="btn small" style={{ float: 'right' }}
            onClick={() => setModal({ template: null })}>+ Add template</button></h2>
        <div className="row-list">
          {templates.map((t) => (
            <div key={t.id} className="lead-row">
              <div className="info">
                <div className="name">{t.name} <span className="badge new">{t.category}</span></div>
                <div className="meta">{t.body}</div>
              </div>
              <button type="button" className="btn small secondary" onClick={() => setModal({ template: t })}>Edit</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>📱 Paired phones (call sync) {' '}
          <button type="button" className="btn small" style={{ float: 'right' }}
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
              <thead><tr><th>Phone</th><th>Team member</th><th>Last sync</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} style={{ opacity: d.revoked_at ? 0.45 : 1 }}>
                    <td><b>{d.device_name}</b>{d.revoked_at && ' (disconnected)'}</td>
                    <td>{d.user_name}</td>
                    <td>{d.last_seen_at ? fmtDateTime(d.last_seen_at) : 'never'}</td>
                    <td>{!d.revoked_at && (
                      <button type="button" className="btn small secondary" disabled={busy === `dev-${d.id}`} onClick={() => revokeDevice(d)}>Disconnect</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {owner && (
          <div className="form-grid" style={{ marginTop: 12, alignItems: 'end', maxWidth: 520 }}>
            <Field label="Daily recording upload quota per phone (MB)"
              hint="Each paired phone may upload this much per IST day (server default 2048 MB). Phones get 'retry tomorrow' when it is used up.">
              <input inputMode="numeric" value={quotaMb} placeholder="2048" onChange={(e) => setQuotaMb(e.target.value)} />
            </Field>
            <div className="field">
              <button type="button" className="btn small" disabled={busy === 'quota' || quotaMb === ''} onClick={saveQuota}>Save quota</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>🏢 Business</h2>
        <div className="field" style={{ maxWidth: 360 }}>
          <label htmlFor="company-name">Company name (used in WhatsApp messages)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="company-name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            <button type="button" className="btn small" disabled={busy === 'company'} onClick={saveCompany}>Save</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>🧾 Invoice details</h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Used on GST invoices generated by the CRM.
        </p>
        <div className="form-grid">
          <Field label="Legal company name">
            <input value={invoice.company_legal_name}
              onChange={(e) => setInvoice((v) => ({ ...v, company_legal_name: e.target.value }))} />
          </Field>
          <Field label="GSTIN">
            <input value={invoice.company_gstin} autoCapitalize="characters"
              onChange={(e) => setInvoice((v) => ({ ...v, company_gstin: e.target.value }))} />
          </Field>
        </div>
        <Field label="Registered address">
          <textarea rows={2} value={invoice.company_address}
            onChange={(e) => setInvoice((v) => ({ ...v, company_address: e.target.value }))} />
        </Field>
        <Field label="Default GST %" style={{ maxWidth: 180 }}>
          <input inputMode="decimal" value={invoice.gst_percent}
            onChange={(e) => setInvoice((v) => ({ ...v, gst_percent: e.target.value }))} />
        </Field>
        <button type="button" className="btn small" disabled={busy === 'invoice'} onClick={saveInvoice}>Save invoice details</button>
      </div>

      <div className="card">
        <h2>🤖 AI call transcription</h2>
        {ai && (
          <>
            <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
              Transcribes call recordings and suggests lead updates, follow-ups and tasks —
              runs entirely on this computer, nothing sent to the internet.
              {!ai.model_present && <b style={{ color: 'var(--red-text)' }}> Model not installed on this computer.</b>}
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className={`btn ${ai.enabled ? 'secondary' : 'green'}`} disabled={!ai.model_present || busy === 'ai'}
                onClick={() => toggleAi(!ai.enabled)}>
                {ai.enabled ? 'Turn off' : 'Turn on'}
              </button>
              <span className="meta" style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                Status: <b>{ai.enabled ? 'ON' : 'off'}</b>
                {ai.enabled && ai.queue && ` · ${ai.queue.pending} waiting, ${ai.queue.processing} processing · ${ai.whisper_model}`}
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
          <label htmlFor="sarvam-key">Sarvam API key {cloud.has_sarvam_key && <span className="badge won">set</span>}</label>
          <input id="sarvam-key" type="password" autoComplete="off" value={cloud.sarvam_api_key}
            placeholder={cloud.has_sarvam_key ? '•••••••• (leave blank to keep)' : 'Paste your Sarvam key'}
            onChange={(e) => setCloud((c) => ({ ...c, sarvam_api_key: e.target.value }))} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn small" disabled={busy === 'cloud'} onClick={saveCloud}>Save cloud settings</button>
          {cloud.has_sarvam_key && (
            <button type="button" className="btn small secondary" disabled={busy === 'cloud'} onClick={clearSarvamKey}>Remove key</button>
          )}
        </div>
      </div>

      {owner && (
      <div className="card">
        <h2>💬 WhatsApp inbox (Baileys){' '}
          <button type="button" className="linklike" onClick={() => setGuide('whatsapp')} style={{ fontSize: 14 }}>📖 Guide</button>
        </h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Two-way WhatsApp chat, embedded in this server. Incoming messages link to leads by phone
          and appear in the lead timeline. <b>Use a dedicated business number</b> — this is the
          unofficial WhatsApp Web protocol and carries a real account-ban risk on a personal number.
          The phone must stay on the office WiFi for messages to sync.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span className="meta" style={{ fontSize: 13 }}>
            Status: <b>{(wa && wa.status) || 'disconnected'}</b>
            {wa && wa.phone_number ? ` · +91 ${wa.phone_number}` : ''}
            {wa && wa.display_name ? ` · ${wa.display_name}` : ''}
          </span>
          {wa && wa.status === 'connected'
            ? <span className="badge won">connected</span>
            : <span className="badge pending">{(wa && wa.status) || 'off'}</span>}
        </div>

        {wa && wa.status === 'qr_pending' && wa.qr_code && (
          <div style={{ textAlign: 'center', margin: '6px 0 12px' }}>
            <img src={wa.qr_code} alt="WhatsApp pairing QR" style={{ width: 240, height: 240, borderRadius: 12 }} />
            <div className="hint">
              On the WhatsApp business phone: <b>Settings → Linked devices → Link a device</b>, then scan this code.
            </div>
          </div>
        )}
        {wa && wa.engine_installed === false && (
          <p style={{ color: 'var(--ink-soft)', fontSize: 13, background: 'var(--bg-soft)', padding: 10, borderRadius: 8 }}>
            The WhatsApp engine isn't installed on this computer. WhatsApp is meant to run on the{' '}
            <b>main office computer only</b> — install it there with <code>npm run whatsapp:install</code>,
            then reload this page. Leaving it off means no one can run WhatsApp from this machine.
          </p>
        )}
        {wa && wa.last_error && wa.status === 'error' && (
          <p style={{ color: 'var(--red-text)', fontSize: 13 }}>
            {wa.last_error.includes('unavailable') || wa.last_error.includes('not installed')
              ? 'The WhatsApp engine isn\'t installed on this computer. Run npm run whatsapp:install on the office computer, then try again.'
              : wa.last_error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(!wa || wa.status !== 'connected') && (!wa || wa.engine_installed !== false) && (
            <button type="button" className="btn green" disabled={busy === 'wa'} onClick={waStart}>
              {wa && wa.status === 'qr_pending' ? 'Restart pairing' : 'Connect WhatsApp'}
            </button>
          )}
          {wa && (wa.status === 'connected' || wa.enabled) && (
            <button type="button" className="btn secondary" disabled={busy === 'wa'} onClick={waLogout}>Disconnect / turn off</button>
          )}
          <button type="button" className="btn secondary" disabled={busy === 'wa'} onClick={waReset}>Reset (wipe chats + login)</button>
        </div>
      </div>
      )}

      <div className="card">
        <h2>🛟 Data safety</h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Last backup: <b>{settings && settings.last_backup && settings.last_backup.at ? fmtDateTime(settings.last_backup.at) : 'never yet'}</b>
          {settings && settings.last_backup && settings.last_backup.bytes ? ` (${fmtBytes(settings.last_backup.bytes)})` : ''}
          {' '}— backups run automatically every day into the <code>backups/</code> folder.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn secondary" disabled={busy === 'backup'} onClick={backupNow}>{busy === 'backup' ? 'Backing up…' : 'Back up now'}</button>
          <button type="button" className="btn secondary" disabled={busy === 'demo'} onClick={clearDemo}>Clear demo data</button>
        </div>
      </div>

      {owner && <OpsHealthCard />}

      {owner && (
      <div className="card">
        <h2>☁️ Cloud Backup (Google Drive){' '}
          <button type="button" className="linklike" onClick={() => setGuide('drive')} style={{ fontSize: 14 }}>📖 Guide</button>
        </h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
          Encrypts a daily copy of all your data and uploads it to your own Google Drive — off-site,
          so a stolen or dead computer doesn't lose everything. Files are <b>AES-256 encrypted on this
          computer first</b>; Google only ever stores ciphertext it cannot read.
        </p>

        {!(backup && backup.hasClientCredentials) && (
          <div className="field-group" style={{ marginBottom: 10 }}>
            <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: 0 }}>
              One-time setup: create a Google Cloud <b>Desktop</b> OAuth client and paste its id + secret
              here.{' '}<button type="button" className="linklike" onClick={() => setGuide('drive')}>Open the step-by-step Guide →</button>
            </p>
            <div className="form-grid">
              <Field label="OAuth client ID">
                <input value={driveCreds.client_id} autoComplete="off"
                  onChange={(e) => setDriveCreds((c) => ({ ...c, client_id: e.target.value }))} />
              </Field>
              <Field label="OAuth client secret">
                <input type="password" value={driveCreds.client_secret} autoComplete="off"
                  onChange={(e) => setDriveCreds((c) => ({ ...c, client_secret: e.target.value }))} />
              </Field>
            </div>
            <button type="button" className="btn small" onClick={saveDriveCreds}
              disabled={busy === 'drive' || !driveCreds.client_id.trim() || !driveCreds.client_secret.trim()}>
              Save Google credentials
            </button>
          </div>
        )}

        {backup && backup.hasClientCredentials && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            {backup.connected ? (
              <>
                <span className="badge won">Drive connected</span>
                <button type="button" className="btn small secondary" disabled={busy === 'drive'} onClick={disconnectDrive}>Pause syncing</button>
              </>
            ) : (
              <button type="button" className="btn small green" disabled={busy === 'drive'} onClick={connectDrive}>Connect Google Drive</button>
            )}
            <button type="button" className="btn small secondary" onClick={loadBackup}>Refresh status</button>
          </div>
        )}

        <div className="field" style={{ maxWidth: 460 }}>
          <label htmlFor="backup-pass">
            Backup passphrase {backup && backup.hasPassphrase && <span className="badge won">set</span>}
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="backup-pass" type="password" autoComplete="new-password" value={passphrase}
              placeholder={backup && backup.hasPassphrase ? 'Re-enter to verify / unlock for this session' : 'Choose a strong passphrase (min 8 chars)'}
              onChange={(e) => setPassphrase(e.target.value)} />
            <button type="button" className="btn small" onClick={savePassphrase} disabled={busy === 'pass' || passphrase.length < 8}>
              {backup && backup.hasPassphrase ? 'Verify' : 'Set'}
            </button>
          </div>
          <div className="hint" style={{ color: 'var(--red-text)', fontWeight: 600 }}>
            ⚠️ Write this passphrase down and store it safely. If you lose it, your backups are
            <b> permanently unrecoverable</b> — there is no reset and no recovery.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          <button type="button" className="btn" disabled={busy === 'cloud-backup' || !(backup && backup.connected)}
            onClick={runCloudBackup}>{busy === 'cloud-backup' ? 'Backing up…' : 'Back up now'}</button>
          <span className="meta" style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
            {backup && backup.lastCloudBackup
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
      {reassign && (
        <ReassignModal target={reassign.target} openWork={reassign.openWork} users={users}
          onClose={() => setReassign(null)} onDone={() => { setReassign(null); load(); }} />)}
      {guide && <SetupGuideModal kind={guide} onClose={() => setGuide(null)} />}
    </>
  );
}
