// Drives the real CallTrack app in the emulator over Chrome DevTools Protocol:
// pairs the device, seeds fake call-log rows + recording files via the debug
// plugin, then runs the REAL native sync (Kotlin reads the call log and uploads
// over HTTP). Uses Node 22's built-in WebSocket + fetch — no deps.
//
// Scenario 1: pair → seed 6 calls + 3 recordings → syncNow.
// Scenario 2 (MOB-1/EMU-1 regression): seed ANOTHER call, force-stop the app,
// relaunch it (boot runs again), and assert the call still syncs and that the
// native `pairedAt` watermark did not move.
//
// Invoked by mobile/run-e2e.sh — needs ANDROID_SERIAL (an emulator) and ADB.
import { execFileSync } from 'node:child_process';

const WS = process.argv[2];
const CODE = process.argv[3];
const SERVER = process.argv[4]; // 10.0.2.2:3462
const ADB = process.env.ADB || 'adb';
const SERIAL = process.env.ANDROID_SERIAL;
const PKG = 'com.calltrack.mobile';
if (!WS || !CODE || !SERVER || !SERIAL) {
  console.error('usage: ANDROID_SERIAL=emulator-XXXX node e2e-driver.mjs <wsUrl> <pairingCode> <host:port>');
  process.exit(2);
}

const log = (...a) => console.error('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// adb's own stderr is dropped (a pre-flush `run-as cat` retry would otherwise print a harmless error).
const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    const cdp = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`cannot connect to ${url}`)), { once: true });
    });
    await cdp.call('Runtime.enable');
    return cdp;
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = ++this.id;
      this.pending.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.call('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// Find the WebView's DevTools socket for the running app and forward it.
async function findWsUrl() {
  for (let i = 0; i < 30; i++) {
    const pid = (() => { try { return adb('shell', 'pidof', PKG); } catch { return ''; } })();
    if (pid) {
      try { adb('forward', '--remove-all'); } catch { /* ignore */ }
      try {
        adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);
        const pages = await (await fetch('http://localhost:9222/json')).json();
        const page = pages.find((p) => p.title === 'CallTrack') || pages.find((p) => p.type === 'page');
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      } catch { /* not up yet */ }
    }
    await sleep(1000);
  }
  throw new Error('WebView DevTools socket never appeared');
}

async function waitFor(cdp, expr, what, tries = 40) {
  for (let i = 0; i < tries; i++) {
    let v = false;
    try { v = await cdp.ev(expr); } catch { /* page reloading */ }
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Native prefs (debug build → run-as works). pairedAt must NEVER move at boot.
async function readPairedAt() {
  // apply() flushes on a background thread — poll briefly for the file/key.
  for (let i = 0; i < 20; i++) {
    try {
      const xml = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/calltrack_sync.xml');
      const m = xml.match(/name="pairedAt" value="(\d+)"/);
      if (m) return Number(m[1]);
    } catch { /* not written yet */ }
    await sleep(500);
  }
  return null;
}

// syncNow may report busy while the boot-time sync is running — wait it out.
async function syncUntilIdle(cdp) {
  for (let i = 0; i < 20; i++) {
    const r = await cdp.ev('return await window.Capacitor.Plugins.CallSync.syncNow();');
    if (!r.busy) return r;
    await sleep(1000);
  }
  throw new Error('sync stayed busy');
}

// Events must be timestamped AFTER pairing (the app only syncs calls newer
// than pairing time). +10s margin covers host/emulator clock skew.
const now = Date.now() + 10000;
const istStamp = (ms) => {
  const d = new Date(ms + 5.5 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

const out = {};
let cdp = await Cdp.connect(WS);

// MOB-18: the native bridge must be present on the emulator.
out.isNative = await cdp.ev('return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CallSync);');
if (!out.isNative) { console.log('RESULT ' + JSON.stringify({ stage: 'bridge', out })); process.exit(1); }

// 1. Pair through the real endpoint + configure the native side. Mirrors
//    app.js doPair: Preferences gets ONLY the non-secret part; the token goes
//    to the native (Keystore-backed) store via configure().
out.pair = await cdp.ev(`
  const Cap = window.Capacitor;
  const state = await Cap.Plugins.CallSync.getState();
  const res = await fetch('http://${SERVER}/api/auth/pair', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ code:'${CODE}', device_name:'Emulator Pixel', device_model: state.deviceModel, android_id: state.androidId })
  });
  const data = await res.json();
  if (!res.ok) return { ok:false, error:data.error };
  window.__token = data.token;
  await Cap.Plugins.Preferences.set({ key:'cfg', value: JSON.stringify({serverUrl:'http://${SERVER}', userName:data.user.full_name, role:data.user.role}) });
  await Cap.Plugins.CallSync.configure({ serverUrl:'http://${SERVER}', token:data.token });
  const st = await Cap.Plugins.CallSync.getState();
  return { ok:true, user:data.user.full_name, role:data.user.role, paired: st.paired, tokenStorage: st.tokenStorage, appVersion: st.appVersion, versionCode: st.versionCode };
`);
if (!out.pair.ok) { console.log('RESULT ' + JSON.stringify({ stage: 'pair', out })); cdp.close(); process.exit(1); }
log('paired as', out.pair.user, 'token storage:', out.pair.tokenStorage, 'app', out.pair.appVersion, out.pair.versionCode);
out.pairedAt0 = await readPairedAt();

// 2. A known lead phone assigned to this caller.
out.knownPhone = await cdp.ev(`
  const r = await fetch('http://${SERVER}/api/leads?page=1', { headers:{Authorization:'Bearer '+window.__token} });
  const d = await r.json();
  return d.leads && d.leads.length ? d.leads[0].phone : null;
`);

// Wipe the system call log first — pm clear doesn't touch it, so without
// this, calls from earlier test runs accumulate and skew the results.
await cdp.ev('await window.Capacitor.Plugins.DebugSeeder.clearAll(); return true;');

// 3. Seed call-log rows (real CallLog provider writes via DebugSeeder).
const calls = [
  { phone: out.knownPhone, direction: 'outgoing', duration: 95, ts: now },             // known → attach, connected
  { phone: out.knownPhone, direction: 'outgoing', duration: 0, ts: now + 2000 },       // known → attach, not_picked
  { phone: '9123456789', direction: 'incoming', duration: 130, ts: now + 4000 },   // unknown → captured
  { phone: '140', direction: 'incoming', duration: 5, ts: now + 6000 },            // invalid (short code)
  { phone: '9123456789', direction: 'outgoing', duration: 20, ts: now + 200000 },  // unknown, near ambiguous rec
  { phone: '9876500000', direction: 'outgoing', duration: 40, ts: now + 210000 },  // 2nd unknown, 10s later
];
for (const c of calls) {
  await cdp.ev(`await window.Capacitor.Plugins.DebugSeeder.seedCall({ phone:'${c.phone}', direction:'${c.direction}', duration:${c.duration}, ts:'${c.ts}' }); return true;`);
}

// 4. Seed recordings under Recordings/Call (a MEDIA dir the debug app may
//    write to under scoped storage — EMU-7): Samsung-format matching the
//    connected call, MIUI-format name for the captured call, and a no-number
//    ambiguous one near two calls.
const recs = [
  { folder: 'Recordings/Call', filename: `Call recording ${out.knownPhone}_${istStamp(now)}.m4a`, ts: now + 95000 },
  { folder: 'Recordings/Call', filename: `9123456789(In)_${istStamp(now + 4000).replace('_', '')}.mp3`, ts: now + 4000 + 130000 },
  { folder: 'Recordings/Call', filename: 'Voice.m4a', ts: now + 205000 }, // ambiguous: two calls ~10s apart, no number
];
for (const r of recs) {
  await cdp.ev(`await window.Capacitor.Plugins.DebugSeeder.seedRecording({ folder:'${r.folder}', filename:${JSON.stringify(r.filename)}, ts:'${r.ts}', sizeKb:12 }); return true;`);
}

// 5. Run the REAL native sync.
out.sync = await syncUntilIdle(cdp);
log('scenario 1 sync:', JSON.stringify(out.sync));

// ---- Scenario 2: a call logged while the app is closed must survive a relaunch.
const s2Phone = '9988776655';
await cdp.ev(`await window.Capacitor.Plugins.DebugSeeder.seedCall({ phone:'${s2Phone}', direction:'outgoing', duration:33, ts:'${now + 300000}' }); return true;`);
cdp.close();
adb('shell', 'am', 'force-stop', PKG);
await sleep(1500);
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
await sleep(3000);
cdp = await Cdp.connect(await findWsUrl());
// Boot must reconstruct the pairing from the NATIVE token (Preferences holds none).
await waitFor(cdp, "return !!document.querySelector('.tabbar');", 'app to boot into the paired UI');
out.scenario2 = { phone: s2Phone, ts: now + 300000 };
out.scenario2.sync = await syncUntilIdle(cdp);
out.scenario2.pairedAtAfter = await readPairedAt();
out.scenario2.pairedAtBefore = out.pairedAt0;
out.scenario2.state = await cdp.ev(`
  const s = await window.Capacitor.Plugins.CallSync.getState();
  return { paired: s.paired, hasToken: !!s.token, lastError: s.lastError, lastSuccessMs: s.lastSuccessMs, pendingUploads: s.pendingUploads };
`);
log('scenario 2 sync:', JSON.stringify(out.scenario2.sync), 'pairedAt', out.scenario2.pairedAtBefore, '→', out.scenario2.pairedAtAfter);

console.log('RESULT ' + JSON.stringify(out));
cdp.close();
process.exit(0);
