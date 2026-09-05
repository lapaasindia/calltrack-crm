import { Native, isNative } from './native.js';

// ---- persistent, NON-secret config via Capacitor Preferences (localStorage in the browser) ----
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

// cfg = { serverUrl, userName, role, token }. On a device the token lives ONLY
// in memory here — it is fetched from the native Keystore-backed store at boot
// (MOB-13) and never written to Preferences. The browser preview (no native
// plugin) keeps it in localStorage so the dev loop still works.
let cfg = null;
const app = document.getElementById('app');

// From native getState() → BuildConfig.VERSION_NAME. Single source of truth
// (package.json → build.gradle), no hand-maintained constant (MOB-14/EMU-10).
let appVersion = '';
let appVersionCode = 0;

const DISCONNECT_MSG = 'This phone was disconnected or the pairing expired — scan the QR again.';
const isAdminRole = (r) => r === 'super_admin' || r === 'admin' || r === 'manager';

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = `toast ${isErr ? 'err' : ''}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 4200 : 2800);
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

// MOB-18: on a real Android WebView the Capacitor bridge MUST be present. If
// it is not (someone reordered index.html's <head> or moved the CSP into a
// header), fail loudly instead of silently degrading to the browser mock.
function assertNativeBridge() {
  const ua = navigator.userAgent || '';
  if (/Android/.test(ua) && /\bwv\b/.test(ua) && !isNative) {
    throw new Error('Native bridge failed to load — the app cannot reach the call log. Reinstall the app or report this to your admin.');
  }
}

class DisconnectedError extends Error {
  constructor(m) { super(m); this.disconnected = true; }
}

async function api(path, { method = 'GET', body } = {}) {
  if (!cfg) throw new DisconnectedError('Not paired');
  const res = await fetch(`${cfg.serverUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Revoked by the admin, expired (90 days) or the account was deactivated
    // (MOB-8/EMU-4): drop to the pairing screen with a clear message — once.
    const data = await res.json().catch(() => ({}));
    const msg = data.error ? `${DISCONNECT_MSG} (${data.error})` : DISCONNECT_MSG;
    await handleDisconnected(msg);
    throw new DisconnectedError(msg);
  }
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
let pendingPairingMsg = null;

// Native getState() omits keys whose value is null (Capacitor drops them), so a
// plain object spread would keep a stale lastError/disconnectedReason around
// after native cleared it. Normalise those keys explicitly.
function mergeState(st) {
  lastState = {
    ...(lastState || {}),
    ...(st || {}),
    lastError: st?.lastError || null,
    disconnectedReason: st?.disconnectedReason || null,
    recordingsFolder: st?.recordingsFolder || null,
  };
  return lastState;
}

// ── WhatsApp (Phase 6B) ─────────────────────────────────────────────────────
// The inbox lives behind the server's whatsapp_enabled flag AND the admin-tier
// role (every screen in it is admin-only server-side, MOB-16). The unread poll
// runs for everyone (agents get notified about their own leads' messages) but
// only while the page is visible and only once the server said it is enabled.
let waEnabled = false;
let waSince = null;
let waTimer = null;

const fmtPhoneIn = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length === 10 ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : (p || '');
};
const showWaTab = () => waEnabled && cfg && isAdminRole(cfg.role);

function stopWaPoll() { if (waTimer) clearInterval(waTimer); waTimer = null; }
function startWaPoll() {
  stopWaPoll();
  if (!cfg || !waEnabled || document.visibilityState !== 'visible') return;
  waTimer = setInterval(waPoll, 30000);
}

// Poll /api/whatsapp/unread and fire a local notification for new inbound. Safe
// when whatsapp is off (server returns {enabled:false}) or the plugin is absent.
async function waPoll() {
  if (!cfg) return;
  try {
    const q = waSince ? `?since=${encodeURIComponent(waSince)}` : '';
    const res = await api(`/api/whatsapp/unread${q}`);
    const wasShown = showWaTab();
    waEnabled = !!res.enabled;
    lastState = { ...(lastState || {}), waUnread: res.count || 0 };
    if (!waEnabled) { stopWaPoll(); if (wasShown) renderChrome(), render(); return; }
    if (!waTimer && document.visibilityState === 'visible') startWaPoll();
    if (showWaTab() !== wasShown) { renderChrome(); render(); }
    else updateBadge('whatsapp', res.count || 0);
    if (!res.latest) return;
    // Advance the watermark to the newest inbound we've seen.
    const newest = res.latest.sent_at;
    if (waSince && newest <= waSince) return;
    const prev = waSince;
    waSince = newest;
    await store.set('wa_since', waSince);
    // Only notify if this is genuinely new (we had a prior watermark). De-dup is
    // via the persisted `waSince` watermark above, NOT the notification id.
    if (prev && res.latest.id) {
      const who = res.latest.display_name || fmtPhoneIn(res.latest.phone) || 'WhatsApp';
      await Native.notify({
        id: res.latest.id,
        title: `WhatsApp · ${who}`,
        body: res.latest.body || 'New message',
      });
    }
    if (route === 'whatsapp') renderWhatsApp();
  } catch (e) {
    if (e?.disconnected) stopWaPoll();
    /* offline — ignore */
  }
}

// ===================== PAIRING =====================
// The Google code scanner (Scanner.scan) runs from a Google Play Services module
// that is downloaded on FIRST use — it is NOT bundled in the APK. If we call
// scan() before that module exists, it throws and the scan "silently" fails.
// So make sure the module is present (installing + waiting for the download to
// finish) before scanning. Resolves when ready, rejects with a readable reason.
function ensureScannerModule(Scanner) {
  if (!Scanner.isGoogleBarcodeScannerModuleAvailable) return Promise.resolve();
  return Scanner.isGoogleBarcodeScannerModuleAvailable().then(({ available }) => {
    if (available) return undefined;
    return new Promise((resolve, reject) => {
      let handle = null;
      let settled = false;
      const cleanup = () => { try { handle && handle.remove && handle.remove(); } catch { /* ignore */ } };
      const finish = (fn, v) => { if (settled) return; settled = true; cleanup(); fn(v); };
      // EMU-2: on this Capacitor build addListener() returns the {remove}
      // handle synchronously (no .then). Promise.resolve() covers both shapes.
      // ModuleInstallStatusCodes: 4 = COMPLETED, 5 = CANCELED, 6 = FAILED.
      Promise.resolve(Scanner.addListener('googleBarcodeScannerModuleInstallProgress', (e) => {
        if (e.state === 4) finish(resolve);
        else if (e.state === 5 || e.state === 6) finish(reject, new Error('Could not download the QR scanner — check internet, or type the code.'));
      })).then((h) => { handle = h; }).catch(() => { /* no listener — the timeout still guards */ });
      Promise.resolve()
        .then(() => Scanner.installGoogleBarcodeScannerModule())
        .then(() => {
          // Some builds resolve installGoogleBarcodeScannerModule only once the
          // module is present; re-check so we never hang on a missed event.
          return Scanner.isGoogleBarcodeScannerModuleAvailable().then(({ available: a }) => { if (a) finish(resolve); });
        })
        .catch((err) => finish(reject, err instanceof Error ? err : new Error(String(err?.message || err || 'Scanner install failed'))));
      setTimeout(() => finish(reject, new Error('Scanner is taking too long — type the code instead.')), 30000);
    });
  });
}

async function scanQr() {
  // @capacitor-mlkit/barcode-scanning (Google ML Kit, registers as 'BarcodeScanner').
  // Free + from Google's Maven — no JitPack token needed by anyone building the app.
  const Scanner = window.Capacitor?.Plugins?.BarcodeScanner;
  if (!Scanner) return { unavailable: true };
  try {
    await ensureScannerModule(Scanner);
    // Google code scanner UI: no custom camera overlay, returns the scanned codes.
    const res = await Scanner.scan();
    return { raw: res?.barcodes?.[0]?.rawValue || null };
  } catch (e) {
    // Surface the real reason (permission denied, no Play Services, module
    // download failed…) instead of a generic "type the code".
    return { error: (e && e.message) || 'Could not open the camera scanner' };
  }
}

// MOB-3: a scanned/typed server address must be an office-LAN address over
// http(s). Returns the normalised origin (scheme://host[:port]) or throws.
const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
function validatePairingUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('The pairing code has no server address');
  let u;
  try { u = new URL(raw.trim()); } catch { throw new Error(`"${raw.slice(0, 60)}" is not a valid server address`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The server address must start with http:// or https://');
  if (u.username || u.password) throw new Error('The server address must not contain a username or password');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateV4 = PRIVATE_V4.test(host) && host.split('.').every((o) => Number(o) <= 255);
  // Plain http is only ever safe on the office network (the bearer token would
  // travel in clear); an https server (a cloud/Coolify deployment behind TLS)
  // may live on any hostname — TLS protects the token and the pairing code.
  const ok = u.protocol === 'https:' || privateV4 || host === 'localhost' || host.endsWith('.local');
  if (!ok) {
    throw new Error(`"${host}" is not an office-network address. Over plain http CallTrack only pairs with a server on your own WiFi (192.168.x.x, 10.x.x.x, 172.16–31.x.x or name.local); an internet server must use https://.`);
  }
  return `${u.protocol}//${u.host}`;
}

function renderPairing(error) {
  pendingPairingMsg = null;
  app.innerHTML = `
    <div class="center-screen">
      <div class="logo">Call<span>Track</span></div>
      <div class="tag">Connect this phone to your office CRM</div>
      ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
      <button class="btn" id="scan">📷 Scan pairing QR</button>
      <div class="muted" style="text-align:center;margin:16px 0 8px">— or enter manually —</div>
      <label>Office server address</label>
      <input id="url" inputmode="url" placeholder="192.168.1.50:3000 or https://crm.yourcompany.com" />
      <label>Pairing code (from admin → Settings → Pair phone)</label>
      <input id="code" autocapitalize="characters" placeholder="ABC123" />
      <button class="btn ghost" id="manual" style="margin-top:18px">Connect</button>
      <div class="muted" style="margin-top:18px">
        On the office computer: open CallTrack → <b>Settings → Pair phone</b> →
        pick your name → scan the QR shown there.
      </div>
      <div class="muted" style="text-align:center;margin-top:20px;font-size:12px;opacity:.65">App version v${escapeHtml(appVersion || '?')}</div>
    </div>`;

  document.getElementById('scan').onclick = async () => {
    const r = await scanQr();
    if (r?.unavailable) return toast('Scanner not available on this phone — type the code instead', true);
    if (r?.error) return toast(r.error, true);
    if (!r?.raw) return toast('Scan cancelled — or type the code instead', true);
    let parsed;
    try { parsed = JSON.parse(r.raw); } catch { return toast('That QR is not a CallTrack pairing code', true); }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.c !== 'string') return toast('That QR is not a CallTrack pairing code', true);
    doPair(parsed.u, parsed.c);
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

async function doPair(rawUrl, code) {
  let serverUrl;
  try { serverUrl = validatePairingUrl(rawUrl); } catch (e) { return renderPairing(e.message); }
  const host = serverUrl.replace(/^https?:\/\//, '');
  // Confirm BEFORE the one-time code is spent, so a hostile QR sticker never
  // silently redirects this phone's call log (MOB-3). The user's name is only
  // known after the exchange, so it is echoed right after.
  if (!confirm(`Pair this phone with ${host}?\n\nOnly continue if this is your office CallTrack server.`)) return;
  try {
    const state = await Native.getState();
    const res = await fetch(`${serverUrl}/api/auth/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        device_name: deviceName(state),
        device_model: state.deviceModel || undefined,   // MOB-20 (server may ignore it)
        android_id: state.androidId,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return renderPairing(data.error || 'Pairing failed');
    if (!data.token || !data.user) return renderPairing('Unexpected reply from the server — is that really CallTrack?');
    cfg = { serverUrl, userName: data.user.full_name || data.user.username || 'Caller', role: data.user.role || 'caller', token: data.token };
    // Persist only the non-secret part; the token goes to the native store.
    await store.set('cfg', JSON.stringify(isNative ? { serverUrl, userName: cfg.userName, role: cfg.role } : cfg));
    await Native.configure({ serverUrl, token: data.token });
    toast(`Paired as ${cfg.userName}`);
    route = 'setup';
    render();
    // EMU-12: start syncing straight away (pairedAt is set now, so the
    // catch-up window is "from this moment").
    if (isNative) backgroundSync();
    waPoll();
    maybeCheckForUpdate();
  } catch (e) {
    renderPairing(`Could not reach ${host}. Same WiFi as the office computer?`);
  }
}

function deviceName(state) {
  const p = window.Capacitor?.getPlatform?.() || 'browser';
  if (p !== 'android') return 'Test phone';
  return (state && state.deviceModel) || 'Android phone';
}

let disconnecting = false;
async function handleDisconnected(msg) {
  if (disconnecting) return;
  disconnecting = true;
  try { await unpair(msg || DISCONNECT_MSG); } finally { disconnecting = false; }
}

async function unpair(message) {
  stopWaPoll();
  await store.remove('cfg');
  try { await Native.clearConfig(); } catch { /* best effort */ }
  cfg = null;
  lastState = null;
  waEnabled = false;
  route = 'home';
  renderPairing(message);
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
  // EMU-15: a step that cannot apply on this phone is shown as informational,
  // never as a red ✗, and never blocks Done.
  const stepNA = (title, note) => `
    <div class="setup-step na">
      <div class="n">–</div>
      <div class="t">${title}<small><span class="na-note">Not needed on this phone</span> — ${note}</small></div>
    </div>`;
  const folderSub = s.safFolderPicked
    ? `Linked: ${escapeHtml(s.recordingsFolder || 'folder')}`
    : 'Tap, then choose the folder your Phone app saves call recordings to (e.g. Recordings/Call)';
  app.innerHTML = `
    <div class="topbar"><div class="logo">Call<span>Track</span></div></div>
    <div class="content">
      <div class="card">
        <h2>Finish setup — ${escapeHtml(cfg.userName)}</h2>
        ${step(s.permissions.callLog, 'Call log access', 'So calls attach to leads automatically', 'perms', 'Allow')}
        ${step(s.permissions.mediaAudio, 'Audio access', 'Lets us find your dialer’s recordings', 'mediaaudio', 'Allow')}
        ${s.oemDialer
          ? step(false, 'Turn ON call recording in your dialer', 'CallTrack never records — your Phone app does. Enable it once (Phone app → Settings → Call recording).', 'dialerrec', 'Open')
          : stepNA('Call recording in the dialer', 'this phone’s dialer cannot record calls; calls still attach to leads')}
        ${step(s.safFolderPicked, 'Recordings folder', folderSub, 'safpick', 'Choose')}
        ${step(!s.batteryOptimized, 'Battery: no restrictions', 'So syncing keeps working in the background', 'battery', 'Open')}
        ${s.hasAutostartScreen
          ? step(false, 'Auto-start', 'Lets the app restart itself after a reboot or a battery clean-up', 'autostart', 'Open')
          : stepNA('Auto-start', 'no auto-start manager on this phone')}
      </div>
      <button class="btn" id="done" ${s.batteryOptimized ? 'disabled' : ''}>Done — start using CallTrack</button>
      ${s.batteryOptimized ? '<div class="muted" style="text-align:center;margin-top:8px">Turn off battery restrictions above so calls keep syncing when the app is closed.</div>' : ''}
      <button class="btn ghost" id="resync" style="margin-top:10px">Sync my calls now</button>
    </div>`;
  app.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const a = b.dataset.act;
      try {
        if (a === 'perms') await Native.requestPermissions();
        else if (a === 'mediaaudio') await Native.requestMediaAudio();
        else if (a === 'safpick') {
          const r = await Native.pickRecordingsFolder();
          if (r && r.picked) toast(`Recordings folder linked: ${r.name || ''}`);
          else if (r && r.error) toast(r.error, true);
        } else if (a === 'dialerrec') {
          await Native.openDialerSettings();
          toast('In your Phone app: Settings → Call recording → On', false);
        } else if (a === 'battery') await Native.openBatterySettings();
        else if (a === 'autostart') {
          const r = await Native.openAutostartSettings();
          if (r && !r.oem) toast('No auto-start screen on this phone — nothing to do here', false);
        }
      } catch (e) { toast(e.message || 'Could not open that screen', true); }
      // Re-render now (permission prompts resolve in-app) and again when the
      // app returns from a system screen (visibilitychange → EMU-8).
      if (route === 'setup') renderSetup();
    };
  });
  document.getElementById('done').onclick = async () => {
    if (isNative) {
      try {
        const r = await Native.startBackgroundService();
        if (r && r.started === false) toast('Background sync could not start — calls still sync each time you open the app', true);
      } catch { /* ignore */ }
    }
    route = 'home';
    render();
    doSync(); // EMU-12
  };
  document.getElementById('resync').onclick = doSync;
}

// ===================== SYNC =====================
let syncing = false;

// Fire-and-forget native sync used from boot/pairing: updates state + chip,
// re-renders Today only if it is showing (MOB-24).
function backgroundSync() {
  return Native.syncNow().then(async (r) => {
    mergeState(await Native.getState());
    if (r?.unpaired || (lastState.paired === false && isNative)) { await handleDisconnected(lastState.disconnectedReason); return; }
    if (route === 'home') render(); else renderChip();
    refreshBadge();
  }).catch(() => {});
}

async function doSync() {
  if (syncing) return;
  syncing = true;
  renderChip();
  let unpaired = false;
  try {
    const r = await Native.syncNow();
    mergeState(await Native.getState());
    if (r.unpaired || (isNative && lastState.paired === false)) unpaired = true;
    else if (r.busy) toast('Sync already running…');
    else if (r.errors?.length) toast(r.errors[0], true);            // MOB-2/EMU-3: errors are shown on the device
    else toast(`Synced ${r.calls} calls, ${r.recordings} recordings`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    syncing = false;
    if (unpaired) await handleDisconnected(lastState?.disconnectedReason);
    else if (route === 'home' || route === 'settings') { render(); refreshBadge(); }
    else { renderChip(); refreshBadge(); }
  }
}

// ===================== TABS =====================
async function renderHome() {
  let data;
  try { data = await api('/api/today'); } catch (e) { return renderError(e.message, e); }
  const content = app.querySelector('.content');
  if (!content) return;
  const fu = data.followups || [];
  const tasks = data.tasks || [];
  const pay = data.payments_due || [];
  const st = data.stats || {};
  content.innerHTML = `
    <div class="card">
      <h2>Today · ${escapeHtml(String(cfg.userName || '').split(' ')[0])}</h2>
      <div style="display:flex;gap:16px">
        <div><div class="muted">Calls</div><div style="font-size:24px;font-weight:800">${st.calls || 0}${st.target ? `<span class="muted" style="font-size:14px">/${st.target.calls_target}</span>` : ''}</div></div>
        <div><div class="muted">Connects</div><div style="font-size:24px;font-weight:800">${st.connects || 0}</div></div>
        <div><div class="muted">Deals</div><div style="font-size:24px;font-weight:800">${st.deals || 0}</div></div>
      </div>
      ${lastState?.lastError ? `<div class="err-line">⚠ Last sync: ${escapeHtml(lastState.lastError)}</div>` : ''}
    </div>
    ${section('📞 Follow-ups', fu.map((f) => queueRow(f.name, f.phone,
      `${overdue(f.due_at) ? '<span class="badge over">overdue</span> ' : ''}${escapeHtml(f.reason || '')}`)).join('') || emptyRow('No follow-ups due'))}
    ${section('✅ Tasks', tasks.map((t) => queueRow(t.title, t.lead_phone,
      `${t.due_date < todayIst() ? '<span class="badge over">overdue</span> ' : ''}${escapeHtml(t.lead_name || '')}${t.source === 'ai' ? ' <span class="badge ai">AI</span>' : ''}`)).join('') || emptyRow('No tasks'))}
    ${section('💰 Payments due', pay.map((p) => queueRow(p.name, p.phone,
      `₹${Math.round((p.amount_paise - p.paid_paise) / 100).toLocaleString('en-IN')} · ${escapeHtml(p.product_name)}`)).join('') || emptyRow('Nothing due'))}`;
}

// Audio is streamed with a short-lived, single-recording media ticket (audit
// M-2/L-1) — NOT the long-lived device token. The ticket is minted when the
// user presses Play (MOB-21), not for every row up front, and re-minted once
// if playback errors (expired ticket, dropped connection).
const recPlayer = (recId) =>
  `<div class="rec-player" data-rec="${recId}">
     <button class="btn sm ghost" data-play="${recId}">▶ Play recording</button>
     <audio controls preload="none" style="width:100%;height:36px" hidden></audio>
   </div>`;

function bindAudio(root) {
  root.querySelectorAll('.rec-player[data-rec]').forEach((box) => {
    const id = box.dataset.rec;
    const btn = box.querySelector('[data-play]');
    const el = box.querySelector('audio');
    let retried = false;
    const mint = async () => {
      btn.disabled = true;
      try {
        const { ticket } = await api(`/api/review/audio/${id}/ticket`, { method: 'POST' });
        el.src = `${cfg.serverUrl}/api/review/audio/${id}?ticket=${encodeURIComponent(ticket)}`;
        el.hidden = false;
        btn.hidden = true;
        el.load();
        el.play().catch(() => { /* user gesture consumed elsewhere — controls still work */ });
      } catch (e) {
        btn.disabled = false;
        if (!e?.disconnected) toast(e.message || 'Could not load the recording', true);
      }
    };
    btn.onclick = () => mint();
    el.addEventListener('playing', () => { retried = false; });
    el.addEventListener('error', () => {
      if (retried) { toast('This recording cannot be played on this phone', true); return; }
      retried = true;
      mint();
    });
  });
}

async function renderReview() {
  let captured, untagged;
  try {
    [captured, untagged] = await Promise.all([
      api('/api/review/captured'), api('/api/review/untagged'),
    ]);
  } catch (e) { return renderError(e.message, e); }
  const content = app.querySelector('.content');
  if (!content) return;
  content.innerHTML = `
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
        ${c.recording_id ? recPlayer(c.recording_id) : ''}
        <div class="btn-row">
          ${['interested|😊 Interested', 'not_interested|🙅 Not', 'callback_requested|📞 Callback'].map((o) => {
            const [v, l] = o.split('|');
            return `<button class="btn sm ghost" data-tag="${c.id}" data-outcome="${v}">${l}</button>`;
          }).join('')}
        </div>
      </div>`).join('') || emptyRow('Nothing to tag'))}`;

  bindAudio(content);
  // EMU-11: the badge counts exactly what this tab lists.
  updateBadge('review', captured.length + untagged.length);
  lastState = { ...(lastState || {}), reviewCount: captured.length + untagged.length };

  const after = () => { renderReview(); };
  content.querySelectorAll('[data-lead]').forEach((b) => b.onclick = async () => {
    const name = prompt(`Name for ${b.dataset.phone}?`, '');
    if (name === null) return;
    try { await api(`/api/review/captured/${b.dataset.lead}/create-lead`, { method: 'POST', body: { name } }); toast('Lead created'); after(); }
    catch (e) { if (!e.disconnected) toast(e.message, true); }
  });
  content.querySelectorAll('[data-ignore]').forEach((b) => b.onclick = () => ignoreCaptured(b.dataset.ignore, false));
  content.querySelectorAll('[data-never]').forEach((b) => b.onclick = () => ignoreCaptured(b.dataset.never, true));
  content.querySelectorAll('[data-tag]').forEach((b) => b.onclick = async () => {
    try { await api(`/api/review/calls/${b.dataset.tag}`, { method: 'PATCH', body: { outcome: b.dataset.outcome } }); toast('Saved'); after(); }
    catch (e) { if (!e.disconnected) toast(e.message, true); }
  });
}

async function ignoreCaptured(id, always) {
  try {
    const r = await api(`/api/review/captured/${id}/ignore`, { method: 'POST', body: { always } });
    toast(always && r?.always !== false ? 'Ignored forever' : 'Ignored');
    renderReview();
  } catch (e) { if (!e.disconnected) toast(e.message, true); }
}

async function renderSettings() {
  const s = mergeState(await Native.getState());
  const content = app.querySelector('.content');
  if (!content) return;
  const perm = (ok) => (ok ? '✅' : '❌');
  content.innerHTML = `
    <div class="card">
      <h2>This phone</h2>
      <div class="row" style="background:var(--surface2)">
        <div class="info"><div class="name">${escapeHtml(cfg.userName)}</div>
          <div class="meta">${escapeHtml(cfg.serverUrl)}${cfg.role ? ` · ${escapeHtml(cfg.role)}` : ''}</div></div>
      </div>
      <div class="muted" style="margin-top:6px">Last successful sync: ${s.lastSuccessMs ? fmtTime(s.lastSuccessMs) : 'never'}</div>
      <div class="muted">Last attempt: ${s.lastSyncMs ? fmtTime(s.lastSyncMs) : 'never'} · ${s.pendingUploads || 0} recording${s.pendingUploads === 1 ? '' : 's'} waiting to upload</div>
      ${s.lastError ? `<div class="err-line">⚠ ${escapeHtml(s.lastError)}</div>` : ''}
      ${s.serviceEnabled === false && isNative ? '<div class="err-line">Background sync is off — finish setup to turn it on.</div>' : ''}
    </div>
    <div class="card">
      <h2>Permissions</h2>
      <div class="muted">Call log: ${perm(s.permissions?.callLog)} · Audio: ${perm(s.permissions?.mediaAudio)} · Notifications: ${perm(s.permissions?.notifications)}</div>
      <div class="muted" style="margin-top:4px">Recordings folder: ${s.safFolderPicked ? `${escapeHtml(s.recordingsFolder || 'linked')} ✅` : 'not linked ❌'}</div>
      <button class="btn ghost sm" id="fix" style="margin-top:10px;width:auto">Fix permissions / setup</button>
    </div>
    <button class="btn ghost" id="update">Check for app update</button>
    <button class="btn ghost" id="unpair" style="margin-top:10px;color:var(--red)">Disconnect this phone</button>
    <div class="muted" style="text-align:center;margin-top:16px">CallTrack mobile v${escapeHtml(appVersion || '?')}${appVersionCode ? ` (${appVersionCode})` : ''} · ${isNative ? 'device' : 'browser preview'}${isNative && s.tokenStorage ? ` · token: ${escapeHtml(s.tokenStorage)}` : ''}</div>`;
  document.getElementById('fix').onclick = () => { route = 'setup'; render(); };
  document.getElementById('unpair').onclick = async () => { if (confirm('Disconnect? Your synced data stays in the CRM.')) unpair(); };
  document.getElementById('update').onclick = async () => {
    const u = await Native.checkForUpdate();
    if (u.updateAvailable) { if (confirm(`Update to v${u.versionName}?`)) Native.installUpdate(u.apkUrl); }
    else if (u.error) toast(`Could not check for updates: ${u.error}`, true);
    else toast('You have the latest version');
  };
}

// MOB-14: check for an update once a day on boot (not only from Settings).
async function maybeCheckForUpdate() {
  if (!isNative || !cfg) return;
  try {
    const last = Number(await store.get('last_update_check')) || 0;
    if (Date.now() - last < 24 * 3600000) return;
    await store.set('last_update_check', String(Date.now()));
    const u = await Native.checkForUpdate();
    if (u.updateAvailable && confirm(`A new CallTrack version (v${u.versionName}) is available. Download it now?`)) {
      Native.installUpdate(u.apkUrl);
    }
  } catch { /* offline — try again tomorrow */ }
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
// Null-safe (MOB-8): after a 401 the pairing screen has no .content — do nothing.
function renderError(msg, err) {
  if (err?.disconnected || !cfg) return;
  const content = app.querySelector('.content');
  if (!content) return;
  content.innerHTML = `<div class="empty"><div class="big">📡</div>${escapeHtml(msg)}<br><br>
    <button class="btn ghost sm" id="retry-btn" style="width:auto;margin:0 auto">Retry</button></div>`;
  const btn = content.querySelector('#retry-btn');
  if (btn) btn.onclick = () => render();
}

// ===================== WHATSAPP INBOX =====================
let waActiveContact = null;

async function renderWhatsApp() {
  const c = app.querySelector('.content');
  if (!c) return;
  if (waActiveContact) return renderWaThread(c, waActiveContact);
  let contacts;
  try { contacts = await api('/api/whatsapp/contacts'); }
  catch (e) { return renderError(e.message, e); }
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
  catch (e) { return renderError(e.message, e); }
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
    } catch (e) { if (!e.disconnected) toast(e.message, true); }
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
  app.innerHTML = `
    <div class="topbar">
      <div class="logo">Call<span>Track</span></div>
      <button class="sync-chip" id="syncbtn">${chipInner()}</button>
    </div>
    <div class="content"></div>
    <div class="tabbar">
      ${tab('home', '☀️', 'Today')}
      ${tab('review', '🔍', 'Review', lastState?.reviewCount || 0)}
      ${showWaTab() ? tab('whatsapp', '💬', 'Chats', lastState?.waUnread || 0) : ''}
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

// Update ONE tab badge in place — no full re-render (MOB-24/EMU-11).
function updateBadge(routeName, n) {
  const btn = app.querySelector(`.tabbar [data-route="${routeName}"]`);
  if (!btn) return;
  let nb = btn.querySelector('.nb');
  if (!n) { if (nb) nb.remove(); return; }
  if (!nb) { nb = document.createElement('span'); nb.className = 'nb'; btn.appendChild(nb); }
  nb.textContent = String(n);
}
let badgeInflight = false;
async function refreshBadge() {
  if (!cfg || badgeInflight) return;
  badgeInflight = true;
  try {
    const s = await api('/api/review/summary');
    const n = (s.captured || 0) + (s.untagged || 0);   // only what the Review tab lists
    lastState = { ...(lastState || {}), reviewCount: n };
    updateBadge('review', n);
  } catch { /* offline / disconnected */ }
  finally { badgeInflight = false; }
}

// Chip: green only after a SUCCESSFUL sync (MOB-2/EMU-3); red when the last
// attempt failed; amber when the last success is more than a day old.
function chipInner() {
  if (syncing) return '<span class="spin"></span> Syncing';
  return `<span class="dot ${syncDotClass()}"></span> ${syncLabel()}`;
}
function renderChip() {
  const b = document.getElementById('syncbtn');
  if (!b) return;
  b.innerHTML = chipInner();
  b.classList.toggle('err', !!lastState?.lastError && !syncing);
}
function syncDotClass() {
  const s = lastState;
  if (s?.lastError) return 'err';
  if (!s?.lastSuccessMs) return 'off';
  return Date.now() - s.lastSuccessMs > 24 * 3600000 ? 'stale' : '';
}
function syncLabel() {
  const s = lastState;
  if (!s?.lastSuccessMs) return s?.lastError ? 'Sync failed' : 'Tap to sync';
  const mins = Math.round((Date.now() - s.lastSuccessMs) / 60000);
  const ago = mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  return s.lastError ? `Failed · ok ${ago}` : ago;
}

// Coalesced router (MOB-24): a render requested while one is in flight runs
// once more afterwards instead of racing it for the DOM.
let rendering = false;
let renderQueued = false;
async function render() {
  if (rendering) { renderQueued = true; return; }
  rendering = true;
  try {
    await renderOnce();
  } catch (err) {
    // A broken screen shows the recoverable error UI instead of blanking.
    if (!err?.disconnected) showFatal(err);
  } finally {
    rendering = false;
    if (renderQueued) { renderQueued = false; render(); }
  }
}
async function renderOnce() {
  if (!cfg) return renderPairing(pendingPairingMsg);
  if (route === 'setup') return renderSetup();
  renderChrome();
  if (route !== 'review') refreshBadge(); // review computes its own count
  if (route === 'home') return renderHome();
  if (route === 'review') return renderReview();
  if (route === 'whatsapp') return renderWhatsApp();
  if (route === 'settings') return renderSettings();
}

// ===================== BOOT =====================
async function boot() {
  assertNativeBridge();
  let st = null;
  try { st = await Native.getState(); } catch { st = null; }
  appVersion = st?.appVersion || '';
  appVersionCode = st?.versionCode || 0;
  mergeState(st);

  const saved = await store.get('cfg');
  let parsed = null;
  if (saved) { try { parsed = JSON.parse(saved); } catch { parsed = null; } }

  if (parsed && isNative) {
    // Older builds persisted the token in Preferences: move it into the native
    // store once and strip it (MOB-13). This is the ONLY boot-time configure().
    if (parsed.token && !st?.paired) {
      try { await Native.configure({ serverUrl: parsed.serverUrl, token: parsed.token }); st = await Native.getState(); } catch { /* fall through */ }
    }
    if (parsed.token) {
      delete parsed.token;
      await store.set('cfg', JSON.stringify(parsed));
    }
    if (st?.paired && st.token) {
      cfg = { ...parsed, serverUrl: st.serverUrl || parsed.serverUrl, token: st.token };
      // NOTE: no Native.configure() here — the native side already holds the
      // config and App.onCreate re-arms the periodic job; calling it from boot
      // is what used to move pairedAt on every launch (MOB-1/EMU-1).
    } else {
      // Native side lost the pairing (admin revoke → 401 in a background sync,
      // token expiry, or a cleared store): show the pairing screen with why.
      await store.remove('cfg');
      cfg = null;
      pendingPairingMsg = st?.disconnectedReason || DISCONNECT_MSG;
    }
  } else if (parsed) {
    cfg = parsed; // browser preview
  }

  if (cfg) {
    waSince = (await store.get('wa_since')) || null;
    // Ask for notification permission up front so WhatsApp alerts can fire.
    // No-ops in the browser preview / when the plugin isn't installed yet.
    await Native.requestNotificationPermission();
    // Sync on every app open — the primary path on Indian OEMs.
    if (isNative) backgroundSync();
    waPoll();              // discovers waEnabled and arms the 30 s timer if so
    maybeCheckForUpdate(); // once a day
  }
  await render();

  // Foreground refresh — from BOTH visibilitychange (real background→foreground)
  // and the native resume event (return from a translucent system dialog such
  // as the battery-exemption prompt, which never changes visibilityState —
  // EMU-8). The two can fire together, so coalesce within 1.5 s.
  let lastForeground = Date.now();
  const onForeground = () => {
    const now = Date.now();
    if (now - lastForeground < 1500) return;
    lastForeground = now;
    if (!cfg) return;
    if (route === 'setup') { render(); return; }
    if (isNative) doSync(); else render();
    waPoll();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { stopWaPoll(); return; }
    onForeground();
  });
  Native.onResume(onForeground);
}

boot().catch(showFatal);
