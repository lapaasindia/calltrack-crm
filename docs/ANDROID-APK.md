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
build needs **zero credentials** for anyone.

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
Bump `versionCode` + `versionName` in `mobile/android/app/build.gradle` first for a
real release (and keep them in step with the desktop/server version).

## Publish to the office team (auto-updater)
Copy the **release** APK into `data/apk/` and update `data/apk/version.json`:
```json
{ "versionCode": 3, "versionName": "1.2.0", "sha256": "<sha>", "size": <bytes> }
```
The phone app polls `GET /api/app-version` and offers the update when its installed
`versionCode` is lower; it downloads from `GET /download/calltrack.apk`.
> ⚠️ Always serve a **release-signed** APK here. A debug-signed APK cannot install
> over a release-signed one (signature mismatch), so it would break updates.

## Install on a phone
- **LAN link:** open `http://<office-Mac-LAN-IP>:3000/download/calltrack.apk` in the
  phone's browser (phone on office WiFi) → download → tap → allow "install from this
  source" → Install.
- **USB:** `~/Library/Android/sdk/platform-tools/adb install -r <apk>`.
- **Debug builds:** if a release-signed CallTrack is already installed, **uninstall it
  first** (`adb uninstall com.calltrack.mobile`) — the signatures differ.

## What's in 1.2.0
Call-capture sync · QR pairing (ML Kit, no token) · WhatsApp **Chats** tab + local
notifications (`@capacitor/local-notifications`) · all 6 server-side phases behind it.
See [WHATSAPP-MOBILE.md](WHATSAPP-MOBILE.md) for the notification details and
[ANDROID-FIXES.md](ANDROID-FIXES.md) for the call-capture/background-sync internals.
