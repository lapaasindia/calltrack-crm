import { Native, isNative } from './native.js';

// ---- persistent config via Capacitor Preferences (or localStorage in browser) ----
const Prefs = window.Capacitor?.Plugins?.Preferences;
const store = {
  async get(k) {
    if (Prefs) return (await Prefs.get({ key: k })).value;
    return localStorage.getItem(k);
  },
  async set(k, v) {
    if (Prefs) return Prefs.set({ key: k, value: v });
    return localStorage.setItem(k, v);
  },
  async remove(k) {
    if (Prefs) return Prefs.remove({ key: k });
    return localStorage.removeItem(k);
  },
};

let cfg = null; // { serverUrl, token, userName }
const app = document.getElementById('app');

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = `toast ${isErr ? 'err' : ''}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${cfg.serverUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { await unpair(); throw new Error('This phone was disconnected by the admin.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s || 0}s`);
const fmtTime = (ms) => new Date(ms).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const todayIst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

let route = 'home';
let lastState = null;

// ===================== PAIRING =====================
async function scanQr() {
  const Scanner = window.Capacitor?.Plugins?.CapacitorBarcodeScanner;
  if (!Scanner) return null;
  try {
    const res = await Scanner.scanBarcode({ hint: 17 }); // QR_CODE
    return res?.ScanResult || null;
  } catch { return null; }
}

function renderPairing(error) {
  app.innerHTML = `
    <div class="center-screen">
      <div class="logo">Call<span>Track</span></div>
      <div class="tag">Connect this phone to your office CRM</div>
      ${error ? `<div class="err">${error}</div>` : ''}
      <button class="btn" id="scan">📷 Scan pairing QR</button>
      <div class="muted" style="text-align:center;margin:16px 0 8px">— or enter manually —</div>
      <label>Office server address</label>
      <input id="url" inputmode="url" placeholder="192.168.1.50:3000" />
      <label>Pairing code (from admin → Settings → Pair phone)</label>
      <input id="code" autocapitalize="characters" placeholder="ABC123" />
      <button class="btn ghost" id="manual" style="margin-top:18px">Connect</button>
      <div class="muted" style="margin-top:18px">
        On the office computer: open CallTrack → <b>Settings → Pair phone</b> →
        pick your name → scan the QR shown there.
      </div>
    </div>`;

  document.getElementById('scan').onclick = async () => {
    const raw = await scanQr();
    if (!raw) return toast('Could not scan — type the code instead', true);
    try {
      const parsed = JSON.parse(raw);
      await doPair(parsed.u, parsed.c);
    } catch { toast('That QR is not a CallTrack pairing code', true); }
  };
  document.getElementById('manual').onclick = () => {
    let url = document.getElementById('url').value.trim();
    const code = document.getElementById('code').value.trim();
    if (!url || !code) return toast('Enter both the address and the code', true);
    if (!/^https?:\/\//.test(url)) url = `http://${url}`;
    if (!/:\d+$/.test(url.replace(/^https?:\/\//, ''))) url += ':3000';
    doPair(url, code);
  };
}

async function doPair(serverUrl, code) {
  serverUrl = serverUrl.replace(/\/$/, '');
  try {
    const state = await Native.getState();
    const res = await fetch(`${serverUrl}/api/auth/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, device_name: deviceName(), android_id: state.androidId }),
    });
    const data = await res.json();
    if (!res.ok) return renderPairing(data.error || 'Pairing failed');
    cfg = { serverUrl, token: data.token, userName: data.user.full_name };
    await store.set('cfg', JSON.stringify(cfg));
    await Native.configure({ serverUrl, token: data.token });
    route = 'setup';
    render();
  } catch (e) {
    renderPairing(`Could not reach ${serverUrl}. Same WiFi as the office computer?`);
  }
}

function deviceName() {
  const p = window.Capacitor?.getPlatform?.() || 'browser';
  return p === 'android' ? (navigator.userAgent.match(/;\s?([^;)]+)\s?Build/)?.[1]?.trim() || 'Android phone') : 'Test phone';
}

async function unpair() {
  await store.remove('cfg');
  await Native.clearConfig();
  cfg = null;
  route = 'home';
  renderPairing();
}

// ===================== SETUP CHECKLIST =====================
async function renderSetup() {
  const s = await Native.getState();
  const step = (done, title, sub, action, btn) => `
    <div class="setup-step ${done ? 'done' : ''}">
      <div class="n">${done ? '✓' : ''}</div>
      <div class="t">${title}<small>${sub}</small></div>
      ${!done && action ? `<button class="btn sm ghost" data-act="${action}">${btn}</button>` : ''}
    </div>`;
  app.innerHTML = `
    <div class="topbar"><div class="logo">Call<span>Track</span></div></div>
    <div class="content">
      <div class="card">
        <h2>Finish setup — ${cfg.userName}</h2>
        ${step(s.permissions.callLog, 'Call log access', 'So calls attach to leads automatically', 'perms', 'Allow')}
        ${step(s.permissions.storage, 'Recordings access', 'To upload your call recordings', 'files', 'Allow')}
        ${step(!s.batteryOptimized, 'Battery: no restrictions', 'So syncing keeps working in the background', 'battery', 'Open')}
        ${step(false, 'Auto-start (Xiaomi/Oppo/Vivo)', 'Skip on Samsung. Lets the app restart itself', 'autostart', 'Open')}
      </div>
      <button class="btn" id="done">Done — start using CallTrack</button>
      <button class="btn ghost" id="resync" style="margin-top:10px">Sync my calls now</button>
    </div>`;
  app.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const a = b.dataset.act;
      if (a === 'perms') await Native.requestPermissions();
      else if (a === 'files') await Native.openAllFilesAccess();
      else if (a === 'battery') await Native.openBatterySettings();
      else if (a === 'autostart') await Native.openAutostartSettings();
      setTimeout(renderSetup, 600);
    };
  });
  document.getElementById('done').onclick = () => { route = 'home'; render(); };
  document.getElementById('resync').onclick = doSync;
}

// ===================== SYNC =====================
let syncing = false;
async function doSync() {
  if (syncing) return;
  syncing = true;
  renderChrome();
  try {
    const r = await Native.syncNow();
    lastState = await Native.getState();
    if (r.errors?.length && !isNative) toast(r.errors[0], true);
    else toast(`Synced ${r.calls} calls, ${r.recordings} recordings`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    syncing = false;
    render();
  }
}

// ===================== TABS =====================
async function renderHome() {
  let data;
  try { data = await api('/api/today'); } catch (e) { return renderError(e.message); }
  const fu = data.followups || [];
  const tasks = data.tasks || [];
  const pay = data.payments_due || [];
  const st = data.stats;
  app.querySelector('.content').innerHTML = `
    <div class="card">
      <h2>Today · ${cfg.userName.split(' ')[0]}</h2>
      <div style="display:flex;gap:16px">
        <div><div class="muted">Calls</div><div style="font-size:24px;font-weight:800">${st.calls}${st.target ? `<span class="muted" style="font-size:14px">/${st.target.calls_target}</span>` : ''}</div></div>
        <div><div class="muted">Connects</div><div style="font-size:24px;font-weight:800">${st.connects}</div></div>
        <div><div class="muted">Deals</div><div style="font-size:24px;font-weight:800">${st.deals}</div></div>
      </div>
    </div>
    ${section('📞 Follow-ups', fu.map((f) => queueRow(f.name, f.phone,
      `${overdue(f.due_at) ? '<span class="badge over">overdue</span> ' : ''}${f.reason || ''}`)).join('') || emptyRow('No follow-ups due'))}
    ${section('✅ Tasks', tasks.map((t) => queueRow(t.title, t.lead_phone,
      `${t.due_date < todayIst() ? '<span class="badge over">overdue</span> ' : ''}${t.lead_name || ''}${t.source === 'ai' ? ' <span class="badge ai">AI</span>' : ''}`)).join('') || emptyRow('No tasks'))}
    ${section('💰 Payments due', pay.map((p) => queueRow(p.name, p.phone,
      `₹${Math.round((p.amount_paise - p.paid_paise) / 100).toLocaleString('en-IN')} · ${p.product_name}`)).join('') || emptyRow('Nothing due'))}`;
  bindCalls();
}

async function renderReview() {
  let captured, untagged;
  try {
    [captured, untagged] = await Promise.all([
      api('/api/review/captured'), api('/api/review/untagged'),
    ]);
  } catch (e) { return renderError(e.message); }
  app.querySelector('.content').innerHTML = `
    ${section(`📲 New numbers (${captured.length})`, captured.map((c) => `
      <div class="row">
        <div class="info">
          <div class="name">${c.phone} ${c.recording_count ? '<span class="badge rec">🎙</span>' : ''}</div>
          <div class="meta">${c.direction} · ${fmtDur(c.duration_seconds)} · ${fmtTime(c.call_log_ts)}</div>
        </div>
      </div>
      <div class="btn-row" style="margin:-4px 0 10px">
        <button class="btn sm green" data-lead="${c.id}" data-phone="${c.phone}">+ Lead</button>
        <button class="btn sm ghost" data-ignore="${c.id}">Ignore</button>
        <button class="btn sm ghost" data-never="${c.id}">Never</button>
      </div>`).join('') || emptyRow('No new numbers'))}
    ${section(`✍️ What happened? (${untagged.length})`, untagged.map((c) => `
      <div class="card" style="margin-bottom:9px">
        <div class="name" style="font-weight:700">${c.name}</div>
        <div class="meta" style="color:var(--ink-soft);font-size:12.5px;margin:3px 0 9px">${fmtDur(c.duration_seconds)} · ${fmtTime(Date.parse(c.called_at))}</div>
        ${c.recording_id ? `<audio controls preload="none" style="width:100%;height:36px;margin-bottom:8px" src="${cfg.serverUrl}/api/review/audio/${c.recording_id}?token=${encodeURIComponent(cfg.token)}#t=0"></audio>` : ''}
        <div class="btn-row">
          ${['interested|😊 Interested', 'not_interested|🙅 Not', 'callback_requested|📞 Callback'].map((o) => {
            const [v, l] = o.split('|');
            return `<button class="btn sm ghost" data-tag="${c.id}" data-outcome="${v}">${l}</button>`;
          }).join('')}
        </div>
      </div>`).join('') || emptyRow('Nothing to tag'))}`;

  app.querySelectorAll('[data-lead]').forEach((b) => b.onclick = async () => {
    const name = prompt(`Name for ${b.dataset.phone}?`, '');
    if (name === null) return;
    try { await api(`/api/review/captured/${b.dataset.lead}/create-lead`, { method: 'POST', body: { name } }); toast('Lead created'); renderReview(); }
    catch (e) { toast(e.message, true); }
  });
  app.querySelectorAll('[data-ignore]').forEach((b) => b.onclick = () => ignoreCaptured(b.dataset.ignore, false));
  app.querySelectorAll('[data-never]').forEach((b) => b.onclick = () => ignoreCaptured(b.dataset.never, true));
  app.querySelectorAll('[data-tag]').forEach((b) => b.onclick = async () => {
    try { await api(`/api/review/calls/${b.dataset.tag}`, { method: 'PATCH', body: { outcome: b.dataset.outcome } }); toast('Saved'); renderReview(); }
    catch (e) { toast(e.message, true); }
  });
}

async function ignoreCaptured(id, always) {
  try { await api(`/api/review/captured/${id}/ignore`, { method: 'POST', body: { always } }); toast(always ? 'Ignored forever' : 'Ignored'); renderReview(); }
  catch (e) { toast(e.message, true); }
}

async function renderSettings() {
  const s = lastState || await Native.getState();
  app.querySelector('.content').innerHTML = `
    <div class="card">
      <h2>This phone</h2>
      <div class="row" style="background:var(--surface2)">
        <div class="info"><div class="name">${cfg.userName}</div>
          <div class="meta">${cfg.serverUrl}</div></div>
      </div>
      <div class="muted" style="margin-top:6px">Last sync: ${s.lastSyncMs ? fmtTime(s.lastSyncMs) : 'never'} · ${s.pendingUploads || 0} waiting to upload</div>
    </div>
    <div class="card">
      <h2>Permissions</h2>
      <div class="muted">Call log: ${s.permissions.callLog ? '✅' : '❌'} · Recordings: ${s.permissions.storage ? '✅' : '❌'} · Notifications: ${s.permissions.notifications ? '✅' : '❌'}</div>
      <button class="btn ghost sm" id="fix" style="margin-top:10px;width:auto">Fix permissions</button>
    </div>
    <button class="btn ghost" id="update">Check for app update</button>
    <button class="btn ghost" id="unpair" style="margin-top:10px;color:var(--red)">Disconnect this phone</button>
    <div class="muted" style="text-align:center;margin-top:16px">CallTrack mobile · ${isNative ? 'device' : 'browser preview'}</div>`;
  document.getElementById('fix').onclick = () => { route = 'setup'; render(); };
  document.getElementById('unpair').onclick = async () => { if (confirm('Disconnect? Your synced data stays in the CRM.')) unpair(); };
  document.getElementById('update').onclick = async () => {
    const u = await Native.checkForUpdate();
    if (u.updateAvailable) { if (confirm(`Update to v${u.versionName}?`)) Native.installUpdate(u.apkUrl); }
    else toast('You have the latest version');
  };
}

// ---- small render helpers ----
const section = (label, inner) => `<div class="section-label">${label}</div>${inner}`;
const emptyRow = (msg) => `<div class="row"><div class="info"><div class="meta">${msg}</div></div></div>`;
const overdue = (iso) => {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));
  return d < todayIst();
};
function queueRow(name, phone, meta) {
  return `<div class="row">
    <div class="info"><div class="name">${name}</div><div class="meta">${meta}</div></div>
    ${phone ? `<a class="act call" href="tel:+91${phone}">📞</a>` : ''}
  </div>`;
}
function bindCalls() { /* tel: links handled natively by the anchor */ }
function renderError(msg) {
  app.querySelector('.content').innerHTML = `<div class="empty"><div class="big">📡</div>${msg}<br><br>
    <button class="btn ghost sm" onclick="location.reload()" style="width:auto;margin:0 auto">Retry</button></div>`;
}

// ===================== CHROME + ROUTER =====================
function renderChrome() {
  const reviewBadge = (lastState?.reviewCount || 0);
  app.innerHTML = `
    <div class="topbar">
      <div class="logo">Call<span>Track</span></div>
      <button class="sync-chip" id="syncbtn">
        ${syncing ? '<span class="spin"></span> Syncing' : `<span class="dot ${syncDotClass()}"></span> ${syncLabel()}`}
      </button>
    </div>
    <div class="content"></div>
    <div class="tabbar">
      ${tab('home', '☀️', 'Today')}
      ${tab('review', '🔍', 'Review', reviewBadge)}
      ${tab('settings', '⚙️', 'Settings')}
    </div>`;
  document.getElementById('syncbtn').onclick = doSync;
  app.querySelectorAll('.tabbar button').forEach((b) => b.onclick = () => { route = b.dataset.route; render(); });
}
const tab = (r, ic, label, badge) => `
  <button data-route="${r}" class="${route === r ? 'on' : ''}">
    <span class="ic">${ic}</span>${label}
    ${badge ? `<span class="nb">${badge}</span>` : ''}
  </button>`;
function syncDotClass() {
  if (!lastState?.lastSyncMs) return 'off';
  return Date.now() - lastState.lastSyncMs > 24 * 3600000 ? 'stale' : '';
}
function syncLabel() {
  if (!lastState?.lastSyncMs) return 'Tap to sync';
  const mins = Math.round((Date.now() - lastState.lastSyncMs) / 60000);
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}

async function render() {
  if (!cfg) return renderPairing();
  if (route === 'setup') return renderSetup();
  renderChrome();
  // refresh review badge opportunistically
  api('/api/review/summary').then((s) => { lastState = { ...(lastState || {}), reviewCount: s.total };
    const nb = app.querySelector('[data-route="review"] .nb');
    if (s.total && !nb) renderChrome(), render(); }).catch(() => {});
  if (route === 'home') return renderHome();
  if (route === 'review') return renderReview();
  if (route === 'settings') return renderSettings();
}

// ===================== BOOT =====================
async function boot() {
  const saved = await store.get('cfg');
  if (saved) {
    cfg = JSON.parse(saved);
    await Native.configure({ serverUrl: cfg.serverUrl, token: cfg.token });
    lastState = await Native.getState();
    // Sync on every app open — the primary path on Indian OEMs.
    if (isNative) Native.syncNow().then(async () => { lastState = await Native.getState(); render(); }).catch(() => {});
  }
  render();
  // Refresh when the app returns to foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cfg && route !== 'setup') {
      if (isNative) doSync(); else render();
    }
  });
}

boot();
