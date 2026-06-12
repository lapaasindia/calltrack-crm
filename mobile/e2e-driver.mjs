// Drives the real CallTrack app in the emulator over Chrome DevTools Protocol:
// pairs the device, seeds fake call-log rows + recording files via the debug
// plugin, then runs the REAL native sync (Kotlin reads the call log and uploads
// over HTTP). Uses Node 22's built-in WebSocket — no deps.
const WS = process.argv[2];
const CODE = process.argv[3];
const SERVER = process.argv[4]; // 10.0.2.2:3462

const ws = new WebSocket(WS);
let id = 0;
const pending = new Map();
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
async function ev(expr) {
  const r = await call('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

// Events must be timestamped AFTER pairing (the app only syncs calls newer
// than pairing time). +10s margin covers host/emulator clock skew.
const now = Date.now() + 10000;
const istStamp = (ms) => {
  const d = new Date(ms + 5.5 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await call('Runtime.enable');
const out = {};

// 1. Pair through the real endpoint + configure native side.
out.pair = await ev(`
  const Cap = window.Capacitor;
  const state = await Cap.Plugins.CallSync.getState();
  const res = await fetch('http://${SERVER}/api/auth/pair', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ code:'${CODE}', device_name:'Emulator Pixel', android_id: state.androidId })
  });
  const data = await res.json();
  if (!res.ok) return { ok:false, error:data.error };
  window.__token = data.token;
  await Cap.Plugins.Preferences.set({ key:'cfg', value: JSON.stringify({serverUrl:'http://${SERVER}', token:data.token, userName:data.user.full_name}) });
  await Cap.Plugins.CallSync.configure({ serverUrl:'http://${SERVER}', token:data.token });
  return { ok:true, user:data.user.full_name };
`);
if (!out.pair.ok) { console.log(JSON.stringify({ stage: 'pair', out })); ws.close(); process.exit(1); }

// 2. A known lead phone assigned to this caller.
const knownPhone = await ev(`
  const r = await fetch('http://${SERVER}/api/leads?page=1', { headers:{Authorization:'Bearer '+window.__token} });
  const d = await r.json();
  return d.leads && d.leads.length ? d.leads[0].phone : null;
`);
out.knownPhone = knownPhone;

// Wipe the system call log first — pm clear doesn't touch it, so without
// this, calls from earlier test runs accumulate and skew the results.
await ev(`await window.Capacitor.Plugins.DebugSeeder.clearAll(); return true;`);

// 3. Seed call-log rows (real CallLog provider writes via DebugSeeder).
const calls = [
  { phone: knownPhone, direction: 'outgoing', duration: 95, ts: now },             // known → attach, connected
  { phone: knownPhone, direction: 'outgoing', duration: 0, ts: now + 2000 },       // known → attach, not_picked
  { phone: '9123456789', direction: 'incoming', duration: 130, ts: now + 4000 },   // unknown → captured
  { phone: '140', direction: 'incoming', duration: 5, ts: now + 6000 },            // invalid (short code)
  { phone: '9123456789', direction: 'outgoing', duration: 20, ts: now + 200000 },  // unknown, near ambiguous rec
  { phone: '9876500000', direction: 'outgoing', duration: 40, ts: now + 210000 },  // 2nd unknown, 10s later
];
for (const c of calls) {
  await ev(`await window.Capacitor.Plugins.DebugSeeder.seedCall({ phone:'${c.phone}', direction:'${c.direction}', duration:${c.duration}, ts:'${c.ts}' }); return true;`);
}

// 4. Seed recordings: Samsung-format matching the connected call, MIUI-format
//    for the captured call, and a no-number ambiguous one near two calls.
const recs = [
  { folder: 'Recordings/Call', filename: `Call recording ${knownPhone}_${istStamp(now)}.m4a`, ts: now + 95000 },
  { folder: 'MIUI/sound_recorder/call_rec', filename: `9123456789(In)_${istStamp(now + 4000).replace('_', '')}.mp3`, ts: now + 4000 + 130000 },
  { folder: 'Recordings/Call', filename: `Voice.m4a`, ts: now + 205000 }, // ambiguous: two calls ~10s apart, no number
];
for (const r of recs) {
  await ev(`await window.Capacitor.Plugins.DebugSeeder.seedRecording({ folder:'${r.folder}', filename:${JSON.stringify(r.filename)}, ts:'${r.ts}', sizeKb:12 }); return true;`);
}

// 5. Run the REAL native sync.
out.sync = await ev(`return await window.Capacitor.Plugins.CallSync.syncNow();`);

console.log(JSON.stringify(out));
ws.close();
process.exit(0);
