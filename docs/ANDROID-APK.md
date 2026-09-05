# Building & installing the Android app (APK)

The CallTrack phone app is a **Capacitor** WebView (`mobile/www`) wrapping the same
LAN server the desktop/browser use. App id: `com.calltrack.mobile`. It adds
call-capture sync, QR pairing, and (1.2.0+) a WhatsApp **Chats** tab with local
notifications.

> **The APK is a build artifact — it is NOT committed to this repo** (`*.apk` is
> gitignored). It's distributed two ways: a **GitHub Release** asset, and the office
> server's auto-updater at `GET /download/calltrack.apk` (served from `data/apk/`).

---

## Prerequisites (one-time, on a Mac)
- **Android Studio + SDK** (or the command-line tools). `adb` should work.
- **JDK 17** — *not* a newer JDK. Gradle 8.2.1 (this project) does **not** support
  JDK 21/25. Install with `brew install openjdk@17`. Its home is
  `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`.
- Node deps installed (`npm install`) so the Capacitor plugins are present.

There is **no JitPack token / paid dependency** needed: the QR scanner uses Google
**ML Kit** (`@capacitor-mlkit/barcode-scanning`, from Google's free Maven), so the
build needs **zero credentials** for anyone. (The old JitPack / google-services
blocks were removed from the Gradle files.)

## Build a debug APK (for testing)
```bash
npm install
npx cap sync android                 # copies mobile/www + wires the native plugins
cd mobile/android
JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" \
  ./gradlew assembleDebug --no-daemon
# → app/build/outputs/apk/debug/app-debug.apk  (debug-signed)
```

## Build a signed RELEASE APK (for distribution)
The release `signingConfig` reads the keystore + password from the environment
(keystore lives at `~/.calltrack-build/calltrack-release.keystore`, alias `calltrack`):
```bash
export CALLTRACK_KEYSTORE="$HOME/.calltrack-build/calltrack-release.keystore"
export CALLTRACK_KEYSTORE_PASS="<keystore password>"
cd mobile/android
JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" \
  ./gradlew assembleRelease --no-daemon
# → app/build/outputs/apk/release/app-release.apk  (release-signed)
```
**Versioning is single-sourced:** `app/build.gradle` reads `version` from the root
`package.json` — `versionName` is that string and `versionCode` is
`major*10000 + minor*100 + patch` (1.2.2 → **10202**; older APKs used 1–4, so the
scheme is strictly larger and the in-app updater always sees a newer code). Bump
`package.json` for a release; never hand-edit the version in Gradle. The app shows
the same value in its pairing footer and Settings (read from the native
`BuildConfig`, not a JS constant).

`assembleRelease` **fails immediately** when `CALLTRACK_KEYSTORE` is unset — an
unsigned release APK cannot be installed anywhere.

## Publish to the office team (auto-updater)
Copy the **release** APK into `data/apk/` and update `data/apk/version.json`:
```bash
node scripts/publish-apk.js mobile/android/app/build/outputs/apk/release/app-release.apk 10202 1.2.2
# → data/apk/calltrack.apk + data/apk/version.json
#   { "versionCode": 10202, "versionName": "1.2.2", "sha256": "<sha>", "size": <bytes> }
```
The phone app checks `GET /api/app-version` once a day on open (and from Settings →
Check for app update) and offers the update when its installed `versionCode` is
lower; the APK is opened in the phone's browser from `GET /download/calltrack.apk`
and the user taps the finished download to install (no in-app installer, so the
app no longer declares `REQUEST_INSTALL_PACKAGES`).
> ⚠️ Always serve a **release-signed** APK here. A debug-signed APK cannot install
> over a release-signed one (signature mismatch), so it would break updates.

## Install on a phone
- **LAN link:** open `http://<office-Mac-LAN-IP>:3000/download/calltrack.apk` in the
  phone's browser (phone on office WiFi) → download → tap → allow "install from this
  source" → Install.
- **USB:** `~/Library/Android/sdk/platform-tools/adb install -r <apk>`.
- **Debug builds:** if a release-signed CallTrack is already installed, **uninstall it
  first** (`adb uninstall com.calltrack.mobile`) — the signatures differ.

## Emulator end-to-end test
```bash
ANDROID_SERIAL=emulator-5554 bash mobile/run-e2e.sh     # needs the debug APK installed
```
Refuses to run against anything that is not an emulator (it wipes the call log),
starts its own server on :3462, drives the app over CDP (`mobile/e2e-driver.mjs`),
and asserts two scenarios: the normal pair → seed → sync flow, and a call logged
**before** a force-stop + relaunch (regression test for the old "pairedAt moves on
every launch" bug).

## What's in 1.2.2 (mobile)
Call-capture sync with a sane watermark (only calls after pairing, cursor moves only
on server-accepted rows, 200-row batches) · streaming recording uploads with a
sha256 pre-check (`HEAD /api/sync/recordings/:sha`), 80 MB cap and "still being
written" guard · errors shown on the phone (toast + Settings) · admin revoke /
expiry → pairing screen, background service stopped · pairing-URL LAN check +
confirmation · token in Keystore-backed storage · version from `package.json` ·
QR scanner module install fixed · WhatsApp tab admin-only · Chats poll only while
visible. See [WHATSAPP-MOBILE.md](WHATSAPP-MOBILE.md) for the notification details and
[ANDROID-FIXES.md](ANDROID-FIXES.md) for the call-capture/background-sync internals.
