#!/bin/bash
# End-to-end test of the Android call-capture pipeline against a fresh server.
# Drives the REAL app in the emulator (pairing → seed call log + recordings →
# native sync) then asserts the server state. Call log is cleared via the
# in-app DebugSeeder (the adb `content delete` path can crash the emulator).
set -e
source ~/.calltrack-build/env.sh
ROOT="/Users/sahilkhanna/Desktop/CRM FABLE"
cd "$ROOT"
PKG=com.calltrack.mobile
PORT=3462

echo "== fresh server =="
lsof -ti :$PORT | xargs kill 2>/dev/null || true
sleep 1
rm -rf /tmp/crm-e2e
CRM_DATA_DIR=/tmp/crm-e2e node server/seed.js > /dev/null 2>&1
CRM_DATA_DIR=/tmp/crm-e2e CRM_RECORDINGS_DIR=/tmp/crm-e2e/recordings PORT=$PORT \
  nohup node server/index.js > /tmp/crm-e2e.log 2>&1 & disown
sleep 2

curl -s -c /tmp/e2ec.txt -X POST localhost:$PORT/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' > /dev/null
CODE=$(curl -s -b /tmp/e2ec.txt -X POST localhost:$PORT/api/devices/pairing-code \
  -H 'Content-Type: application/json' -d '{"user_id":2}' | python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")

echo "== reset app + recordings, launch =="
adb shell rm -rf /sdcard/Recordings/Call /sdcard/MIUI/sound_recorder/call_rec 2>/dev/null || true
adb shell pm clear $PKG >/dev/null 2>&1
for p in READ_CALL_LOG READ_PHONE_STATE WRITE_CALL_LOG POST_NOTIFICATIONS; do
  adb shell pm grant $PKG android.permission.$p 2>/dev/null || true
done
adb shell appops set $PKG MANAGE_EXTERNAL_STORAGE allow 2>/dev/null || true
adb shell am start -n $PKG/.MainActivity >/dev/null 2>&1
sleep 4

PID=$(adb shell pidof $PKG | tr -d '\r')
adb forward --remove-all 2>/dev/null || true
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID >/dev/null
sleep 1
WSURL=$(curl -s http://localhost:9222/json | python3 -c \
  "import json,sys;print([p['webSocketDebuggerUrl'] for p in json.load(sys.stdin) if p.get('title')=='CallTrack'][0])")

echo "== drive app =="
node mobile/e2e-driver.mjs "$WSURL" "$CODE" "10.0.2.2:$PORT" 2>&1 | tail -1 | tee /tmp/e2e_out.json
sleep 2

echo ""
echo "== assert server state =="
KP=$(python3 -c "import json;print(json.load(open('/tmp/e2e_out.json'))['knownPhone'])")
KP=$KP node -e '
import("better-sqlite3").then(({default:D})=>{
  const db=new D("/tmp/crm-e2e/crm.sqlite",{readonly:true});
  const kp=process.env.KP;
  const lead=db.prepare("SELECT id FROM leads WHERE phone=?").get(kp);
  const calls=db.prepare("SELECT disposition,duration_seconds FROM calls WHERE lead_id=? AND source=\x27mobile\x27 ORDER BY call_log_ts").all(lead.id);
  const cap=db.prepare("SELECT DISTINCT phone FROM captured_calls ORDER BY phone").all().map(r=>r.phone);
  const recs=db.prepare("SELECT match_status FROM recordings").all();
  const matched=recs.filter(r=>r.match_status==="matched").length;
  const amb=recs.filter(r=>r.match_status==="ambiguous").length;
  const a1=calls.length===2 && calls.some(c=>c.disposition==="connected"&&c.duration_seconds===95) && calls.some(c=>c.disposition==="not_picked");
  const a2=cap.length===2 && cap.includes("9123456789") && cap.includes("9876500000");
  const a3=matched===2 && amb===1;
  console.log("  known lead calls (connected95 + not_picked):", JSON.stringify(calls), a1?"PASS":"FAIL");
  console.log("  captured unknowns (9123,9876; 140 rejected):", JSON.stringify(cap), a2?"PASS":"FAIL");
  console.log("  recordings (2 matched + 1 ambiguous): m="+matched+" a="+amb, a3?"PASS":"FAIL");
  console.log(a1&&a2&&a3 ? "\nE2E PASS" : "\nE2E FAIL");
  process.exit(a1&&a2&&a3?0:1);
})'
