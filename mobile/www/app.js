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

// Last-resort white-screen guard — the mobile equivalent of the web app's React
// ErrorBoundary. If a render or boot error would otherwise leave a blank screen,
// show a recoverable message with a Reload button instead of a dead page.
// Strict CSP (audit H-4) allows inline STYLE attributes but not inline scripts,
// so the Reload handler is bound in JS.
function showFatal(err) {
  const msg = (err && (err.message || err.reason || err)) || 'Something went wrong';
  app.innerHTML = `<div class="empty" style="padding:32px 20px;text-align:center">
    <div class="big">⚠️</div>
    <div style="font-weight:700;margin:8px 0">Something went wrong</div>
    <div style="color:#6b7280;font-size:13px;margin-bottom:14px">Your data is safe — this screen just failed to load.</div>
    <div style="font-size:12px;color:#b91c1c;white-space:pre-wrap;word-break:break-word;margin-bottom:16px">${escapeHtml(String(msg))}</div>
    <button class="btn" id="fatal-reload" style="width:auto;margin:0 auto">Reload app</button></div>`;
  const b = app.querySelector('#fatal-reload');
  if (b) b.onclick = () => location.reload();
}

// Safety net for errors outside the render/boot try/catch (event handlers,
// timers): only step in when the screen is actually blank, so a stray late
// error can never clobber a working screen.
window.addEventListener('error', (e) => { if (!app.childElementCount) showFatal(e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { if (!app.childElementCount) showFatal(e.reason); });

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

// Audio is streamed with a short-lived, single-recording media ticket (audit
// M-2/L-1) — NOT the long-lived device token, which would persist in the
// WebView's <audio> URL history. We render the player src-less and hydrate it
// after mount: fetch a ticket via api() (Authorization header, never in a URL)
// then set the src as ?ticket=.
const audioTag = (recId) =>
  `<audio controls preload="none" style="width:100%;height:36px;margin-bottom:8px" data-rec="${recId}"></audio>`;

async function hydrateAudio(root) {
  for (const el of root.querySelectorAll('audio[data-rec]')) {
    const id = el.dataset.rec;
    try {
      const { ticket } = await api(`/api/review/audio/${id}/ticket`, { method: 'POST' });
      el.src = `${cfg.serverUrl}/api/review/audio/${id}?ticket=${encodeURIComponent(ticket)}#t=0`;
    } catch { /* leave the player empty; the rest of the row still works */ }
  }
}

const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s || 0}s`);
const fmtTime = (ms) => new Date(ms).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const todayIst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

let route = 'home';
let lastState = null;

// ── WhatsApp (Phase 6B groundwork) ─────────────────────────────────────────
// The inbox lives behind the server's whatsapp_enabled flag. We cache it so the
// tab + poll only appear when the office has WhatsApp on.
let waEnabled = false;
// Watermark of the newest inbound we've already notified about. Persisted so a
// reopen doesn't re-notify old messages.
let waSince = null;

const fmtPhoneIn = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length === 10 ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : (p || '');
};

// Poll /api/whatsapp/unread and fire a local notification for new inbound. Safe
// when whatsapp is off (server returns {enabled:false}) or the plugin is absent.
async function waPoll() {
  if (!cfg) return;
  try {
    const q = waSince ? `?since=${encodeURIComponent(waSince)}` : '';
    const res = await api(`/api/whatsapp/unread${q}`);
    waEnabled = !!res.enabled;
    if (!res.enabled || !res.latest) return;
    // Advance the watermark to the newest inbound we've seen.
    const newest = res.latest.sent_at;
    if (waSince && newest <= waSince) return;
    const prev = waSince;
    waSince = newest;
    await store.set('wa_since', waSince);
    // Only notify if this is genuinely new (we had a prior watermark). De-dup is
    // via the persisted `waSince` watermark above (we advance it before notifying
    // and only fire when newest > the previous watermark), NOT the notification
    // id — Native.notify uses res.latest.id, which is the growing wa_messages PK
    // and is distinct per message. The Native bridge also no-ops gracefully when
    // the plugin/permission is absent.
    if (prev && res.latest.id) {
      const who = res.latest.display_name || fmtPhoneIn(res.latest.phone) || 'WhatsApp';
      await Native.notify({
        id: res.latest.id,
        title: `WhatsApp · ${who}`,
        body: res.latest.body || 'New message',
      });
    }
    // Refresh the badge / inbox if it's the active view.
    if (route === 'whatsapp') renderWhatsApp();
    else { renderChrome(); render(); }
  } catch { /* offline / not paired — ignore */ }
}

// ===================== PAIRING =====================
// Returns: { raw } on success, { unavailable:true } if the plugin isn't
// installed (browser/dev), or null if the user cancelled / scan failed.
async function scanQr() {
  // @capacitor-mlkit/barcode-scanning (Google ML Kit, registers as 'BarcodeScanner').
  // Free + from Google's Maven — no JitPack token needed by anyone building the app.
  const Scanner = window.Capacitor?.Plugins?.BarcodeScanner;
  if (!Scanner) return { unavailable: true };
  try {
    // Google code scanner UI: no custom camera overlay, returns the scanned codes.
    const res = await Scanner.scan();
    return { raw: res?.barcodes?.[0]?.rawValue || null };
  } catch {
    return null; // cancelled, module unavailable, or permission denied → manual entry
  }
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
    const r = await scanQr();
    if (r?.unavailable) return toast('Scanner not available — type the code instead', true);
    if (!r?.raw) return toast('Scan cancelled — or type the code instead', true);
    try {
      const parsed = JSON.parse(r.raw);
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
        ${step(s.permissions.storage, 'Recordings access (all files)', 'Lets us read your dialer’s recordings folder', 'files', 'Allow')}
        ${step(s.permissions.mediaAudio, 'Audio access', 'Second way to find recordings (Android 13+)', 'mediaaudio', 'Allow')}
        ${step(false, 'Turn ON call recording in your dialer', 'CallTrack never records — your Phone app does. Enable it once.', 'dialerrec', 'Open')}
        ${step(s.safFolderPicked, 'Pick your recordings folder', 'Tap, then choose the folder your Phone app saves recordings to', 'safpick', 'Choose')}
        ${step(!s.batteryOptimized, 'Battery: no restrictions', 'So syncing keeps working in the background', 'battery', 'Open')}
        ${step(false, 'Auto-start (Xiaomi/Oppo/Vivo)', 'Skip on Samsung. Lets the app restart itself', 'autostart', 'Open')}
      </div>
      <button class="btn" id="done" ${s.batteryOptimized ? 'disabled' : ''}>Done — start using CallTrack</button>
      ${s.batteryOptimized ? '<div class="muted" style="text-align:center;margin-top:8px">Turn off battery restrictions above so calls keep syncing when the app is closed.</div>' : ''}
      <button class="btn ghost" id="resync" style="margin-top:10px">Sync my calls now</button>
    </div>`;
  app.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const a = b.dataset.act;
      if (a === 'perms') await Native.requestPermissions();
      else if (a === 'files') await Native.openAllFilesAccess();
      else if (a === 'mediaaudio') await Native.requestMediaAudio();
      else if (a === 'safpick') {
        const r = await Native.pickRecordingsFolder();
        if (r && r.picked) toast('Recordings folder linked');
      }
      else if (a === 'dialerrec') {
        // No public API to deep-link every OEM dialer's record toggle.
        // Open the dialer; the user flips "Call recording" on once.
        await Native.openAutostartSettings(); // falls back to app settings; replace with openDialerRecordingSettings if you add it
        toast('In your Phone app: Settings → Call recording → On', false);
      }
      else if (a === 'battery') await Native.openBatterySettings();
      else if (a === 'autostart') await Native.openAutostartSettings();
      setTimeout(renderSetup, 600);
    };
  });
  document.getElementById('done').onclick = async () => {
    if (isNative) { try { await Native.startBackgroundService(); } catch {} }
    route = 'home';
    render();
  };
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
      <h2>Today · ${escapeHtml(cfg.userName.split(' ')[0])}</h2>
      <div style="display:flex;gap:16px">
        <div><div class="muted">Calls</div><div style="font-size:24px;font-weight:800">${st.calls}${st.target ? `<span class="muted" style="font-size:14px">/${st.target.calls_target}</span>` : ''}</div></div>
        <div><div class="muted">Connects</div><div style="font-size:24px;font-weight:800">${st.connects}</div></div>
        <div><div class="muted">Deals</div><div style="font-size:24px;font-weight:800">${st.deals}</div></div>
      </div>
    </div>
    ${section('📞 Follow-ups', fu.map((f) => queueRow(f.name, f.phone,
      `${overdue(f.due_at) ? '<span class="badge over">overdue</span> ' : ''}${escapeHtml(f.reason || '')}`)).join('') || emptyRow('No follow-ups due'))}
    ${section('✅ Tasks', tasks.map((t) => queueRow(t.title, t.lead_phone,
      `${t.due_date < todayIst() ? '<span class="badge over">overdue</span> ' : ''}${escapeHtml(t.lead_name || '')}${t.source === 'ai' ? ' <span class="badge ai">AI</span>' : ''}`)).join('') || emptyRow('No tasks'))}
    ${section('💰 Payments due', pay.map((p) => queueRow(p.name, p.phone,
      `₹${Math.round((p.amount_paise - p.paid_paise) / 100).toLocaleString('en-IN')} · ${escapeHtml(p.product_name)}`)).join('') || emptyRow('Nothing due'))}`;
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
          <div class="name">${escapeHtml(c.phone)} ${c.recording_count ? '<span class="badge rec">🎙</span>' : ''}</div>
          <div class="meta">${escapeHtml(c.direction)} · ${fmtDur(c.duration_seconds)} · ${fmtTime(c.call_log_ts)}</div>
        </div>
      </div>
      <div class="btn-row" style="margin:-4px 0 10px">
        <button class="btn sm green" data-lead="${c.id}" data-phone="${escapeHtml(c.phone)}">+ Lead</button>
        <button class="btn sm ghost" data-ignore="${c.id}">Ignore</button>
        <button class="btn sm ghost" data-never="${c.id}">Never</button>
      </div>`).join('') || emptyRow('No new numbers'))}
    ${section(`✍️ What happened? (${untagged.length})`, untagged.map((c) => `
      <div class="card" style="margin-bottom:9px">
        <div class="name" style="font-weight:700">${escapeHtml(c.name)}</div>
        <div class="meta" style="color:var(--ink-soft);font-size:12.5px;margin:3px 0 9px">${fmtDur(c.duration_seconds)} · ${fmtTime(Date.parse(c.called_at))}</div>
        ${c.recording_id ? audioTag(c.recording_id) : ''}
        <div class="btn-row">
          ${['interested|😊 Interested', 'not_interested|🙅 Not', 'callback_requested|📞 Callback'].map((o) => {
            const [v, l] = o.split('|');
            return `<button class="btn sm ghost" data-tag="${c.id}" data-outcome="${v}">${l}</button>`;
          }).join('')}
        </div>
      </div>`).join('') || emptyRow('Nothing to tag'))}`;

  hydrateAudio(app.querySelector('.content'));

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
        <div class="info"><div class="name">${escapeHtml(cfg.userName)}</div>
          <div class="meta">${escapeHtml(cfg.serverUrl)}</div></div>
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
  // `name` is always plain text (lead/task/product name) — escape it (audit H-4).
  // `meta` is caller-built HTML (badges + already-escaped user text), so it is
  // intentionally NOT escaped here; callers must escape any user values they
  // interpolate into it. `phone` is digits only.
  const tel = String(phone || '').replace(/[^\d+]/g, '');
  return `<div class="row">
    <div class="info"><div class="name">${escapeHtml(name)}</div><div class="meta">${meta}</div></div>
    ${tel ? `<a class="act call" href="tel:+91${tel}">📞</a>` : ''}
  </div>`;
}
function bindCalls() { /* tel: links handled natively by the anchor */ }
function renderError(msg) {
  const content = app.querySelector('.content');
  // Listener bound in JS (not an inline onclick) so a strict CSP with no
  // 'unsafe-inline' script-src can be enforced in index.html (audit H-4).
  content.innerHTML = `<div class="empty"><div class="big">📡</div>${escapeHtml(msg)}<br><br>
    <button class="btn ghost sm" id="retry-btn" style="width:auto;margin:0 auto">Retry</button></div>`;
  const btn = content.querySelector('#retry-btn');
  if (btn) btn.onclick = () => location.reload();
}

// ===================== WHATSAPP INBOX =====================
let waActiveContact = null;

async function renderWhatsApp() {
  const c = app.querySelector('.content');
  if (!c) return;
  if (waActiveContact) return renderWaThread(c, waActiveContact);
  let contacts;
  try { contacts = await api('/api/whatsapp/contacts'); }
  catch (e) { return renderError(e.message); }
  if (!contacts.length) {
    c.innerHTML = '<div class="empty"><div class="big">💬</div>No WhatsApp conversations yet.</div>';
    return;
  }
  c.innerHTML = contacts.map((ct) => {
    const title = ct.lead_name || ct.display_name || fmtPhoneIn(ct.phone) || ct.wa_jid;
    const last = (ct.last_direction === 'outgoing' ? '↩ ' : '') + (ct.last_body || '—');
    const tag = ct.lead_id ? `<span class="badge">${escapeHtml(ct.lead_name || 'lead')}</span>` : '<span class="badge muted">not a lead</span>';
    return `<button class="wa-conv-row" data-id="${ct.id}">
      <div class="wa-conv-title">${escapeHtml(title)} ${tag}</div>
      <div class="wa-conv-sub">${escapeHtml(last)}</div>
    </button>`;
  }).join('');
  c.querySelectorAll('.wa-conv-row').forEach((b) => {
    b.onclick = () => { waActiveContact = Number(b.dataset.id); renderWhatsApp(); };
  });
}

async function renderWaThread(c, contactId) {
  let data;
  try { data = await api(`/api/whatsapp/contacts/${contactId}/messages`); }
  catch (e) { return renderError(e.message); }
  const ct = data.contact;
  const title = ct.lead_name || ct.display_name || fmtPhoneIn(ct.phone) || ct.wa_jid;
  const bubbles = data.messages.map((m) => `
    <div class="wa-b ${m.direction}">
      <div>${escapeHtml(m.body || `[${m.message_type}]`)}</div>
      <div class="wa-b-t">${fmtTime(Date.parse(m.sent_at))}</div>
    </div>`).join('');
  c.innerHTML = `
    <div class="wa-thead">
      <button class="btn ghost sm" id="wa-back" style="width:auto">← Back</button>
      <b>${escapeHtml(title)}</b>
    </div>
    <div class="wa-msgs">${bubbles}</div>
    <div class="wa-reply">
      <input id="wa-reply" placeholder="Type a reply…" />
      <button class="btn sm" id="wa-send" style="width:auto">Send</button>
    </div>`;
  c.querySelector('#wa-back').onclick = () => { waActiveContact = null; renderWhatsApp(); };
  const input = c.querySelector('#wa-reply');
  c.querySelector('#wa-send').onclick = async () => {
    const body = input.value.trim();
    if (!body) return;
    try {
      await api('/api/whatsapp/send-message', { method: 'POST', body: { contactId, body } });
      input.value = '';
      renderWaThread(c, contactId);
    } catch (e) { toast(e.message, true); }
  };
  const msgs = c.querySelector('.wa-msgs');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
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
      ${waEnabled ? tab('whatsapp', '💬', 'Chats', lastState?.waUnread || 0) : ''}
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
  try {
    if (!cfg) return await renderPairing();
    if (route === 'setup') return await renderSetup();
    renderChrome();
    // refresh review badge opportunistically
    api('/api/review/summary').then((s) => { lastState = { ...(lastState || {}), reviewCount: s.total };
      const nb = app.querySelector('[data-route="review"] .nb');
      if (s.total && !nb) renderChrome(), render(); }).catch(() => {});
    if (route === 'home') return await renderHome();
    if (route === 'review') return await renderReview();
    if (route === 'whatsapp') return await renderWhatsApp();
    if (route === 'settings') return await renderSettings();
  } catch (err) {
    // A broken screen shows the recoverable error UI instead of blanking.
    showFatal(err);
  }
}

// ===================== BOOT =====================
async function boot() {
  const saved = await store.get('cfg');
  if (saved) {
    cfg = JSON.parse(saved);
    await Native.configure({ serverUrl: cfg.serverUrl, token: cfg.token });
    lastState = await Native.getState();
    waSince = (await store.get('wa_since')) || null;
    // Ask for notification permission up front so WhatsApp alerts can fire.
    // No-ops in the browser preview / when the plugin isn't installed yet.
    await Native.requestNotificationPermission();
    // Sync on every app open — the primary path on Indian OEMs.
    if (isNative) Native.syncNow().then(async () => { lastState = await Native.getState(); render(); }).catch(() => {});
    // WhatsApp unread: poll now + on a light 30s WebView timer. The real
    // background path (foreground service polling while the app is closed) is
    // documented in docs/WHATSAPP-MOBILE.md and wired in the native module.
    waPoll();
    setInterval(waPoll, 30000);
  }
  render();
  // Refresh when the app returns to foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cfg && route !== 'setup') {
      if (isNative) doSync(); else render();
      waPoll();
    }
  });
}

boot().catch(showFatal);
