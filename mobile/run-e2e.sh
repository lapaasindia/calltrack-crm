#!/bin/bash
# End-to-end test of the Android call-capture pipeline against a fresh server.
# Drives the REAL app in the emulator (pairing → seed call log + recordings →
# native sync → force-stop + relaunch → sync again) then asserts server state.
#
# SAFETY (MOB-6): this script wipes the device's call log, its Recordings/Call
# folder and the app's data. It therefore refuses to run unless ANDROID_SERIAL
# names an EMULATOR (checked via ro.kernel.qemu), never kills processes by
# port, and never grants MANAGE_EXTERNAL_STORAGE.
#
# Prereqs: a debug APK installed on the emulator (see docs/ANDROID-APK.md),
#          Node ≥ 22, and adb on PATH (or ADB=/path/to/adb).
#   ANDROID_SERIAL=emulator-5554 bash mobile/run-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PKG=com.calltrack.mobile
PORT="${E2E_PORT:-3462}"
E2E_DIR="${E2E_DIR:-/tmp/crm-e2e}"
ADB="${ADB:-$(command -v adb || true)}"
[ -x "${ADB:-/nonexistent}" ] || ADB="$HOME/Library/Android/sdk/platform-tools/adb"
[ -x "$ADB" ] || { echo "adb not found — set ADB=/path/to/adb"; exit 2; }
export ADB

: "${ANDROID_SERIAL:?Set ANDROID_SERIAL to the emulator serial (e.g. emulator-5554). Refusing to guess: this script wipes the call log of that device.}"
case "$ANDROID_SERIAL" in
  emulator-*) ;;
  *) echo "refusing: ANDROID_SERIAL=$ANDROID_SERIAL is not an emulator serial"; exit 2 ;;
esac
QEMU="$("$ADB" -s "$ANDROID_SERIAL" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r')"
[ "$QEMU" = "1" ] || { echo "refusing: $ANDROID_SERIAL does not report ro.kernel.qemu=1 (not an emulator)"; exit 2; }
adbs() { "$ADB" -s "$ANDROID_SERIAL" "$@"; }

INSTALLED="$(adbs shell dumpsys package $PKG 2>/dev/null | grep -m1 versionName | tr -d '\r' | sed 's/^ *//')"
[ -n "$INSTALLED" ] || { echo "refusing: $PKG is not installed on $ANDROID_SERIAL (build + adb install the debug APK first)"; exit 2; }
echo "== device $ANDROID_SERIAL, app $INSTALLED =="

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "refusing: port $PORT is already in use (set E2E_PORT to another port)"; exit 2
fi

echo "== fresh server on :$PORT ($E2E_DIR) =="
rm -rf "$E2E_DIR"
# CRM_ADMIN_PASSWORD: the seed otherwise flags admin must_change_password, which gates /api/devices.
CRM_DATA_DIR="$E2E_DIR" CRM_BACKUP_DIR="$E2E_DIR/backups" CRM_ADMIN_PASSWORD=admin123 node server/seed.js > "$E2E_DIR.seed.log" 2>&1 \
  || { echo "seed failed:"; tail -20 "$E2E_DIR.seed.log"; exit 1; }
CRM_DATA_DIR="$E2E_DIR" CRM_BACKUP_DIR="$E2E_DIR/backups" CRM_RECORDINGS_DIR="$E2E_DIR/recordings" PORT="$PORT" \
  node server/index.js > "$E2E_DIR/server.log" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; adbs forward --remove-all >/dev/null 2>&1 || true; }
trap cleanup EXIT
for i in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "server died:"; tail -20 "$E2E_DIR/server.log"; exit 1; }
  sleep 1
done
curl -sf "http://localhost:$PORT/api/health" >/dev/null || { echo "server never came up"; exit 1; }

curl -s -c "$E2E_DIR/cookies.txt" -X POST "localhost:$PORT/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' > /dev/null
PAIR_JSON=$(curl -s -b "$E2E_DIR/cookies.txt" -X POST "localhost:$PORT/api/devices/pairing-code" \
  -H 'Content-Type: application/json' -d '{"user_id":2}')
CODE=$(printf '%s' "$PAIR_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('code',''))" 2>/dev/null || true)
[ -n "$CODE" ] || { echo "no pairing code — server said: $PAIR_JSON"; exit 1; }

echo "== reset app + recordings, launch =="
adbs shell am force-stop $PKG >/dev/null 2>&1 || true
adbs shell rm -rf /sdcard/Recordings/Call >/dev/null 2>&1 || true
adbs shell pm clear $PKG >/dev/null 2>&1
# Runtime grants the app would otherwise prompt for. WRITE_CALL_LOG exists only
# in the debug manifest (DebugSeeder). No MANAGE_EXTERNAL_STORAGE (audit M-8).
for p in READ_CALL_LOG WRITE_CALL_LOG POST_NOTIFICATIONS READ_MEDIA_AUDIO; do
  adbs shell pm grant $PKG android.permission.$p 2>/dev/null || true
done
adbs logcat -c >/dev/null 2>&1 || true
adbs shell am start -n $PKG/.MainActivity >/dev/null 2>&1
sleep 4

PID=$(adbs shell pidof $PKG | tr -d '\r')
[ -n "$PID" ] || { echo "app did not start"; exit 1; }
adbs forward --remove-all >/dev/null 2>&1 || true
adbs forward tcp:9222 "localabstract:webview_devtools_remote_$PID" >/dev/null
sleep 1
WSURL=$(curl -s http://localhost:9222/json | python3 -c \
  "import json,sys;print([p['webSocketDebuggerUrl'] for p in json.load(sys.stdin) if p.get('title')=='CallTrack'][0])")

echo "== drive app (driver log: $E2E_DIR/driver.log) =="
# No `| tail -1`: the driver's stderr is shown and a driver failure fails the run.
node mobile/e2e-driver.mjs "$WSURL" "$CODE" "10.0.2.2:$PORT" 2>&1 | tee "$E2E_DIR/driver.log"
RESULT="$(grep '^RESULT ' "$E2E_DIR/driver.log" | tail -1 | cut -d' ' -f2-)"
[ -n "$RESULT" ] || { echo "driver produced no RESULT line"; exit 1; }
printf '%s' "$RESULT" > "$E2E_DIR/result.json"
sleep 2

echo ""
echo "== assert server state =="
E2E_DB="$E2E_DIR/crm.sqlite" E2E_RESULT="$E2E_DIR/result.json" node -e '
import("better-sqlite3").then(({default:D})=>{
  const fs=require("node:fs");
  const out=JSON.parse(fs.readFileSync(process.env.E2E_RESULT,"utf8"));
  const db=new D(process.env.E2E_DB,{readonly:true});
  const kp=out.knownPhone;
  const lead=db.prepare("SELECT id FROM leads WHERE phone=?").get(kp);
  const calls=db.prepare("SELECT disposition,duration_seconds FROM calls WHERE lead_id=? AND source=\x27mobile\x27 ORDER BY call_log_ts").all(lead.id);
  const cap=db.prepare("SELECT DISTINCT phone FROM captured_calls ORDER BY phone").all().map(r=>r.phone);
  const recs=db.prepare("SELECT match_status FROM recordings").all();
  const matched=recs.filter(r=>r.match_status==="matched").length;
  const amb=recs.filter(r=>r.match_status==="ambiguous").length;
  const s2=out.scenario2||{};
  const a0=out.isNative===true;
  const a1=calls.length===2 && calls.some(c=>c.disposition==="connected"&&c.duration_seconds===95) && calls.some(c=>c.disposition==="not_picked");
  const a2=cap.includes("9123456789") && cap.includes("9876500000") && !cap.includes("140");
  const a3=matched===2 && amb===1;
  const a4=cap.includes(s2.phone) && !!s2.sync && (s2.sync.errors||[]).length===0;
  const a5=s2.pairedAtBefore>0 && s2.pairedAtBefore===s2.pairedAtAfter;
  const a6=!!s2.state && s2.state.paired===true && s2.state.hasToken===true;
  console.log("  native bridge present (MOB-18):", out.isNative, a0?"PASS":"FAIL");
  console.log("  known lead calls (connected95 + not_picked):", JSON.stringify(calls), a1?"PASS":"FAIL");
  console.log("  captured unknowns (9123,9876; 140 rejected):", JSON.stringify(cap), a2?"PASS":"FAIL");
  console.log("  recordings (2 matched + 1 ambiguous): m="+matched+" a="+amb, a3?"PASS":"FAIL");
  console.log("  scenario 2: call seeded BEFORE relaunch synced ("+s2.phone+"):", JSON.stringify(s2.sync), a4?"PASS":"FAIL");
  console.log("  scenario 2: pairedAt unchanged across relaunch (MOB-1):", s2.pairedAtBefore, "→", s2.pairedAtAfter, a5?"PASS":"FAIL");
  console.log("  scenario 2: pairing rebuilt from the native token store:", JSON.stringify(s2.state), a6?"PASS":"FAIL");
  const ok=a0&&a1&&a2&&a3&&a4&&a5&&a6;
  console.log(ok ? "\nE2E PASS" : "\nE2E FAIL");
  process.exit(ok?0:1);
})'
