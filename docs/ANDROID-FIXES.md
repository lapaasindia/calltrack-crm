# CallTrack — Android App Fixes (build-ready)

Exact, build-ready changes for the three Android-app issues that **cannot be built or tested without Android Studio + a real device** (no Android SDK/emulator exists in the dev environment these were authored in). The code below was written against the project's *actual* current files, so it should drop in with minimal adjustment — but it has **not been compiler-checked**; build it, fix any IDE nits, and run the device checklists.

## Status of the 7 tester-reported issues

| Done & verified server-side (live on `main`) | Needs this guide + an Android build |
|---|---|
| ✅ Lead → deal conversion (fresh-install product seed) | 📱 QR pairing camera scan (§A) |
| ✅ Repeat caller → "attach to existing lead" chooser | 📱 Near-real-time background sync (§B) |
| ✅ Recording playback — server `?token=` (mobile `app.js` already updated) | 📱 Recording capture / Pixel 7 (§C) |

> **Recording playback (§ done):** the server + `mobile/www/app.js` changes are merged. It only needs the APK rebuilt (below) to take effect on phones. Watch for OEM `.amr`/`.3gp` files some WebViews can't decode — a possible transcode follow-up.

## Prerequisites & ground rules

- **Capacitor project root is the repo root** (`/Users/sahilkhanna/Desktop/CRM FABLE`), not `mobile/`. `package.json`, `node_modules`, and the `cap` CLI live at the root; `webDir: mobile/www`, `android.path: mobile/android`. **Run all `npm` / `npx cap` commands from the repo root.**
- **Edit `mobile/www/*` and `mobile/android/app/src/main/*` (source).** Never edit `mobile/android/app/src/main/assets/public/*` — it's a generated copy refreshed by `npx cap sync` (and is gitignored).
- Pin every Capacitor plugin to a **Capacitor 6**–compatible version (project is on `@capacitor/* ^6.2.1`). A stray `@latest` will pull Capacitor 7/8 and break the AGP-8.2 / `compileSdk 34` build.
- After **any** `mobile/www` change, run `npx cap sync android` before building so the generated copy and native plugin wiring stay in step.

## Build & ship the APK (after applying any section)

```bash
cd "/Users/sahilkhanna/Desktop/CRM FABLE"
npm install                               # pulls @capacitor/barcode-scanner@1.0.4

# QR scanner: its native AAR is on JitPack, which now needs a token.
# Put your free token (jitpack.io → sign in with GitHub) in ~/.gradle/gradle.properties:
#   jitpackToken=jp_xxxxxxxx          (or:  export JITPACK_TOKEN=jp_xxxxxxxx)
# Without it the build fails at :app:checkDebugAarMetadata with HTTP 401.

npx cap sync android                      # copy web assets + regenerate native plugin wiring
# build (Android Studio: Build > Generate Signed Bundle/APK, or CLI):
cd mobile/android && ./gradlew assembleRelease
```

> **Release build / R8:** the release buildType has `minifyEnabled false`, so **R8/ProGuard does not run** — no keep rules are needed for the new foreground service, receiver, or worker. (Verified here: §B + §C compile to a debug APK with zero errors.) If you ever set `minifyEnabled true`, those components are still safe — they're kept by AGP's manifest-derived rules plus AndroidX WorkManager / Capacitor consumer ProGuard rules. The only thing blocking a full build is the JitPack token above.

Then ship it the same way 1.1.x was shipped:
1. Copy the signed APK to `data/apk/calltrack.apk` (the server serves it at `/download/calltrack.apk`) and bump `data/apk/version.json` (`versionCode`/`versionName`) so paired phones see the update.
2. Bump the version in **all four** places — `package.json`, `client/package.json`, `server/app.js` `APP_VERSION`, and `mobile/android/app/build.gradle` (`versionCode` + `versionName`) — suggest **1.2.0** (these are user-facing feature changes).
3. Rebuild desktop installers (`npm run dist`) and re-cut the GitHub release with the new APK as `CallTrack-CRM-1.2.0-android.apk`; update the README download links (heading + each link's version, per the standing rule).

---

# Fix: Pairing-QR camera scan (install `@capacitor/barcode-scanner`, pin to Capacitor 6)

## 1. Root-cause recap

`mobile/www/app.js → scanQr()` calls `window.Capacitor.Plugins.CapacitorBarcodeScanner`, but that plugin is **not installed** (`capacitor.plugins.json` lists only `@capacitor/preferences`) — so `Scanner` is `undefined`, `scanQr()` returns `null` before any camera code runs, and the QR button always falls back to "Could not scan." There is also **no `CAMERA` permission** in `AndroidManifest.xml`.

> **Project layout note (important):** the Capacitor project root is the **repo root** `/Users/sahilkhanna/Desktop/CRM FABLE`, not `mobile/`. `node_modules`, `package.json`, `capacitor.config.json`, and the `cap` CLI all live at the repo root (`webDir: mobile/www`, `android.path: mobile/android`). Run **all** `npm` / `npx cap` commands from the repo root.

## 2. Choosing the correct version (Capacitor 6) — do NOT auto-resolve to 2.x/3.x

This project pins `@capacitor/*` to `^6.2.1`. Verified against the npm registry:

| `@capacitor/barcode-scanner` | `peerDependencies.@capacitor/core` | Use here? |
|---|---|---|
| `1.0.4` (and all `1.0.x`) | `^6.0.0` | ✅ **Yes — highest Cap-6 release** |
| `2.0.0`–`2.2.6` | `>=7.0.0` (one even `>=8.0.0`) | ❌ Cap 7+ |
| `3.0.0`–`3.0.2` / `latest` | `>=8.0.0` | ❌ Cap 8+ |

`latest` is `3.0.2`. **Never** `npm install @capacitor/barcode-scanner` without a pin — npm will pull `3.0.2`, whose peer requires Capacitor 8 and will (a) emit `ERESOLVE`/peer warnings and (b) ship Kotlin/Gradle expectations that break this Cap-6 / AGP-8.2 / `compileSdk 34` project.

**Pin to `1.0.4` exactly.** API verified from the 1.0.4 type defs — it matches the existing `scanQr()` byte-for-byte:

```ts
scanBarcode(options: { hint: number; ... }): Promise<{ ScanResult: string }>
```

So `Scanner.scanBarcode({ hint: 17 })` → `res.ScanResult` is **already correct**. No change to the call signature is required (only optional hardening below).

## 3. EXACT changes

> ⚠️ **JitPack token REQUIRED (verified by an actual build, 2026-06-16).** This plugin's native lib `com.github.outsystems:osbarcode-android` is hosted on **JitPack**, which now rejects anonymous requests with `HTTP 401 ("no token provided")`. The build will fail at `:app:checkDebugAarMetadata` without a token. Fix (already wired into `mobile/android/build.gradle` — the JitPack repo block reads a token):
> 1. Go to **https://jitpack.io**, sign in with GitHub, and copy your auth token (Account/profile → it looks like `jp_xxxxxxxx`).
> 2. Add it to **`~/.gradle/gradle.properties`** on the build machine: `jitpackToken=jp_xxxxxxxx` (or `export JITPACK_TOKEN=jp_xxxxxxxx`).
> 3. Re-run the build. (§B sync and §C recording build fine WITHOUT this — only the QR scanner needs it.)

### 3a. Install the plugin (repo root)

```bash
cd "/Users/sahilkhanna/Desktop/CRM FABLE"
npm install @capacitor/barcode-scanner@1.0.4 --save-exact
```

`--save-exact` writes `"@capacitor/barcode-scanner": "1.0.4"` (no caret) into the root `package.json` `dependencies`, preventing a future `npm install` from drifting into `1.x` dev builds. After it lands, confirm the peer is satisfied:

```bash
node -p "require('./node_modules/@capacitor/barcode-scanner/package.json').peerDependencies"
# expect: { '@capacitor/core': '^6.0.0' }
```

### 3b. Sync (regenerates the 3 generated gradle/json files — do NOT hand-edit them)

```bash
cd "/Users/sahilkhanna/Desktop/CRM FABLE"
npx cap sync android
```

`cap sync` copies `mobile/www` → `mobile/android/app/src/main/assets/public/` **and** regenerates these (treat as read-only):

**`mobile/android/app/src/main/assets/capacitor.plugins.json`** should become:
```json
[
  {
    "pkg": "@capacitor/barcode-scanner",
    "classpath": "com.capacitorjs.barcodescanner.CapacitorBarcodeScannerPlugin"
  },
  {
    "pkg": "@capacitor/preferences",
    "classpath": "com.capacitorjs.plugins.preferences.PreferencesPlugin"
  }
]
```
> The registered plugin name is `CapacitorBarcodeScanner` (`@CapacitorPlugin(name = "CapacitorBarcodeScanner")`), which is exactly what `window.Capacitor.Plugins.CapacitorBarcodeScanner` in `scanQr()` looks up. No `MainActivity.kt` change needed — the Capacitor 6 bridge auto-registers plugins listed in `capacitor.plugins.json`; the explicit `registerPlugin(CallSyncPlugin::class.java)` in `MainActivity.kt` is only for your local plugin.

**`mobile/android/capacitor.settings.gradle`** should gain:
```gradle
include ':capacitor-barcode-scanner'
project(':capacitor-barcode-scanner').projectDir = new File('../../node_modules/@capacitor/barcode-scanner/android')
```

**`mobile/android/app/capacitor.build.gradle`** should gain:
```gradle
    implementation project(':capacitor-barcode-scanner')
```

> ⚠️ If `cap sync` does NOT update these (e.g. it's ever run from inside `mobile/` with a stray config), that's the tell. Re-run from the repo root. Do not patch them by hand — the next sync would overwrite your edits.

### 3c. Add the CAMERA permission — `mobile/android/app/src/main/AndroidManifest.xml`

The plugin's own manifest is empty (`<manifest />`), so it does **not** merge a `CAMERA` permission for you — you must add it. Insert these two lines into the top permission block (after the existing `READ_EXTERNAL_STORAGE` line, before `<application>`):

```xml
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
```

Resulting top block:
```xml
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
        android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />

    <application
```
- `required="false"` keeps the app installable on the rare phone with no camera (they can still pair via the manual code path). Do not set `true` — it would hide the app from such devices on the Play Store, and there's no upside here.
- The plugin requests the runtime CAMERA permission itself when its scanner Activity launches (it bundles `androidx.camera`), so you do **not** need to add CAMERA to `CallSyncPlugin.kt`'s permission flow. The manifest declaration is the only Android-side requirement.

> Edit ONLY `mobile/android/app/src/main/AndroidManifest.xml`. Do not touch any copy under `app/build/` (generated).

### 3d. JS — `scanQr()` works as-is; optional hardening (`mobile/www/app.js`)

Current code is functionally correct against 1.0.4. Two optional improvements: (1) fix the misleading comment — `17` is `ALL`, not `QR_CODE`; (2) distinguish "scanner unavailable" from "user cancelled" so the toast text is accurate. Replace `scanQr()` (lines 55–62):

```js
// ===================== PAIRING =====================
// Returns: { raw } on success, { unavailable:true } if the plugin isn't
// installed (browser/dev), or null if the user cancelled / scan failed.
async function scanQr() {
  const Scanner = window.Capacitor?.Plugins?.CapacitorBarcodeScanner;
  if (!Scanner) return { unavailable: true };
  try {
    // hint 17 = ALL barcode types (CapacitorBarcodeScannerTypeHint.ALL).
    // The pairing QR is a QR code; ALL also reads it and is more forgiving.
    const res = await Scanner.scanBarcode({ hint: 17 });
    return { raw: res?.ScanResult || null };
  } catch {
    return null; // cancelled or camera/permission denied
  }
}
```

And update the click handler in `renderPairing()` (the `document.getElementById('scan').onclick` block, lines 83–90) to match the new return shape:

```js
  document.getElementById('scan').onclick = async () => {
    const r = await scanQr();
    if (r?.unavailable) return toast('Scanner not available — type the code instead', true);
    if (!r?.raw) return toast('Scan cancelled — or type the code instead', true);
    try {
      const parsed = JSON.parse(r.raw);
      await doPair(parsed.u, parsed.c);
    } catch { toast('That QR is not a CallTrack pairing code', true); }
  };
```

> If you skip the hardening, the **only** required JS change is none — the original `scanQr()` already calls the right API. The hardening just improves the error message. If you DO apply it, you must change both the function and its caller together (the return shape changed from a string to an object). After editing `mobile/www/app.js`, re-run `npx cap sync android` so the change is copied into `assets/public/`.

## 4. GMS vs non-GMS (AOSP) caveat

The 1.0.4 plugin bundles **both** scanning backends (`com.google.zxing:core:3.4.1` and `com.google.mlkit:barcode-scanning:17.2.0`) plus `androidx.camera`. Default backend is **ZXing**, selected via `options.android.scanningLibrary` (`"zxing"` default, `"mlkit"` opt-in).

- **ZXing (default)** is pure-Java and works on **GMS and non-GMS/AOSP** devices (many Indian-market OEM/ROM variants ship without full Google Play Services). Keep the default — do **not** pass `scanningLibrary: "mlkit"`. MLKit's barcode model depends on Google Play Services and can fail to download/init on AOSP devices.
- **Plugin API quirk (verified in 1.0.4 `CapacitorBarcodeScannerPlugin.kt`):** the Android side reads `scanningLibrary` from `call.getObject("native")?.getJSObject("android")`, i.e. nested under a `native` key — **not** the top-level `android` key shown in the TypeScript `web` examples. Since you're keeping the ZXing default, just **don't pass any `android`/`native` option** and you get ZXing. (Documenting this so nobody wastes time trying to force `mlkit` and finding it ignored.)
- MLKit `17.2.0` and `androidx.camera 1.4.0` compile fine against this project's `compileSdk 34` / `minSdk 26` (manifest `minSdkVersion 26` in `app/build.gradle`; note `variables.gradle` says `minSdkVersion = 22` but the app module overrides to 26 — the plugin defaults to `rootProject.ext.minSdkVersion`, i.e. 22, which merges fine under the app's 26).

**Version-compat flags (Capacitor 6):**
- 1.0.4 peer is `@capacitor/core ^6.0.0` — exact match to your `6.2.1`. ✅
- Plugin gradle pins `com.android.tools.build:gradle:8.2.2` and `kotlin 1.9.22`; both align with this project (AGP 8.2-era, Java/Kotlin target 17). ✅
- The plugin pulls an OutSystems Azure Maven repo (`com.github.outsystems:osbarcode-android`) — the first sync/build needs network access to that repo and to `mavenCentral()`/`google()`. The plugin's own `android/build.gradle` declares that repo, so Gradle resolves it automatically; **no edit to the app's root `build.gradle` repositories is required.** If you build fully offline, pre-warm the Gradle cache once while online.

## 5. Exact command sequence (copy/paste, repo root)

```bash
cd "/Users/sahilkhanna/Desktop/CRM FABLE"

# 1. Install pinned plugin
npm install @capacitor/barcode-scanner@1.0.4 --save-exact

# 2. (verify peer is Cap 6)
node -p "require('./node_modules/@capacitor/barcode-scanner/package.json').peerDependencies"

# 3. Edit mobile/android/app/src/main/AndroidManifest.xml  -> add CAMERA (section 3c)
# 4. (optional) Edit mobile/www/app.js  -> scanQr() hardening (section 3d)

# 5. Sync (regenerates plugins.json + the 2 gradle files, copies www -> assets/public)
npx cap sync android

# 6. Open in Android Studio and build, OR from CLI:
cd mobile/android
./gradlew assembleDebug
# release: ./gradlew assembleRelease   (needs CALLTRACK_KEYSTORE env, see app/build.gradle)
```

In Android Studio: **File → Sync Project with Gradle Files**, then **Build → Build APK(s)** (or Run ▶ onto a device). Accept any prompt to download the OutSystems/MLKit/CameraX dependencies on first sync.

## 6. Device TEST CHECKLIST

**Devices to cover (Indian calling-team reality):**
- One **Samsung** (full GMS) — baseline.
- One **Xiaomi/Redmi or Realme/Oppo/Vivo** (MIUI/ColorOS/FuncOS) — aggressive permission UX; confirm the camera permission dialog appears and the scanner opens.
- If available, one **non-GMS / AOSP-ish ROM** device — confirms ZXing path works without Play Services.
- Android version spread: at least one Android 10–12 and one Android 13+ (runtime-permission model differs).

**Steps & expected observations:**
1. **Fresh install → first launch.** App shows the pairing screen (logo + "Scan pairing QR" + manual fields). No crash.
2. On the office computer open CallTrack → **Settings → Pair phone** → pick a user name → a QR is shown.
3. Tap **📷 Scan pairing QR** on the phone.
   - **Expected:** Android shows a **CAMERA permission prompt** the first time. Tap **Allow** → the scanner camera view opens (live preview). *(Before this fix it instantly toasted "Could not scan.")*
4. Point at the QR.
   - **Expected:** scanner auto-detects, closes, and the app proceeds through `doPair()` → moves to the **Setup checklist** screen for that user (`route='setup'`). Toast/no error.
5. **Cancel test:** tap Scan, then back out of the scanner without scanning.
   - **Expected:** returns to pairing screen with toast **"Scan cancelled — or type the code instead"** (if hardening applied) — *not* "Scanner not available."
6. **Permission-denied test:** tap Scan, **Deny** the camera prompt.
   - **Expected:** scanner closes, app stays on pairing screen, toast shown, app does not crash. Re-tapping Scan re-prompts (or shows the OS "denied" behavior). Manual code entry still works as a fallback.
7. **Manual fallback still works:** type the server address (e.g. `192.168.1.50:3000`) + pairing code → **Connect** → pairs successfully. (Confirms we didn't regress the non-camera path.)
8. **Invalid QR test:** scan any non-CallTrack QR (e.g. a URL).
   - **Expected:** toast **"That QR is not a CallTrack pairing code"** (JSON.parse fails / missing `u`/`c`).
9. **Re-pair after unpair:** Settings → **Disconnect this phone** → returns to pairing → scan again works (no stale camera/permission state).
10. **Non-GMS device:** repeat steps 3–4. Scanner must open and read the QR via ZXing (no "Google Play Services" error). If it fails here, confirm you did **not** force `mlkit`.

**Pass criteria:** camera opens on tap, QR decodes, pairing completes; cancel/deny are handled gracefully; manual entry unaffected; no crash on any device tier; works on a non-GMS device.

---

**Files an Android dev must touch (all under `/Users/sahilkhanna/Desktop/CRM FABLE`):**
- `package.json` (repo root) — via `npm install` (auto).
- `mobile/android/app/src/main/AndroidManifest.xml` — add CAMERA + uses-feature (manual).
- `mobile/www/app.js` — optional `scanQr()` hardening (manual).
- Auto-regenerated by `cap sync` (do **not** hand-edit): `mobile/android/app/src/main/assets/capacitor.plugins.json`, `mobile/android/capacitor.settings.gradle`, `mobile/android/app/capacitor.build.gradle`, `mobile/android/app/src/main/assets/public/*`.
- No change needed: `MainActivity.kt`, `CallSyncPlugin.kt`, `variables.gradle`, `app/build.gradle`, `capacitor.config.json`.

---

# Near-Real-Time Background Call Sync — Build-Ready Implementation Guide

**Target:** `com.calltrack.mobile` · Capacitor 6.2.1 · minSdk 26 / targetSdk 34 · WorkManager `2.9.1` · Java/Kotlin 17

## (1) Root-cause recap

The only background trigger is a **45-min `PeriodicWorkRequest`** enqueued solely from `CallSyncPlugin.configure()` — which runs only when the WebView boots (i.e. when someone opens the app). There is no `Application` subclass, no `BOOT_COMPLETED` receiver, and no foreground service, so after a reboot or with the app closed, nothing ever schedules or runs a sync. Fix = (Phase 1) re-arm on process start + on boot and drop to the 15-min WorkManager floor; (Phase 2) a foreground `dataSync` service with a `CallLog` `ContentObserver` that fires an **expedited** one-time sync within seconds of any call ending.

---

## (2) EXACT changes

### Phase 1 — Persistent scheduling

#### 1.1 New file — `App.kt`

Create `mobile/android/app/src/main/java/com/calltrack/mobile/App.kt`:

```kotlin
package com.calltrack.mobile

import android.app.Application

/**
 * Process-start entry point. Re-arms the periodic WorkManager schedule every
 * time the OS spins up our process (app open, boot broadcast, JobScheduler
 * wake) so background sync survives reboots and app-swipe-kills even when the
 * WebView never loads. Only re-arms when already paired — never schedules work
 * for an unpaired install.
 *
 * NOTE: We deliberately do NOT implement Configuration.Provider here. Capacitor
 * pulls in androidx.startup, which merges WorkManagerInitializer to initialize
 * WorkManager on-demand. Adding a custom Configuration.Provider here would
 * double-initialize and crash. WorkManager.getInstance(this) is safe.
 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // Re-arm only if the phone is already paired (config present).
        if (SyncEngine.config(this) != null) {
            CallSyncPlugin.schedulePeriodic(this)
            // If the user already opted into the always-on service, restart it.
            if (CallObserverService.isEnabled(this)) {
                CallObserverService.start(this)
            }
        }
    }
}
```

> `CallObserverService.isEnabled` / `.start` are defined in Phase 2. If you apply Phase 1 only, delete the inner `if (CallObserverService...)` block — it is the single line tying the two phases together.

#### 1.2 Lower the periodic interval to the 15-min floor — `CallSyncPlugin.kt`

WorkManager clamps any periodic interval below 15 min up to 15 min, so 45 → 15 is the real floor. In the `companion object`:

```diff
     companion object {
         const val PERIODIC_WORK = "calltrack_periodic_sync"
         fun schedulePeriodic(ctx: Context) {
-            val req = PeriodicWorkRequestBuilder<SyncWorker>(45, TimeUnit.MINUTES)
+            val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                 .setConstraints(Constraints.Builder()
                     .setRequiredNetworkType(NetworkType.CONNECTED).build())
                 .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.MINUTES)
                 .build()
             WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                 PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, req)
         }
     }
```

> `ExistingPeriodicWorkPolicy.UPDATE` (already used) means existing installs adopt the new 15-min cadence on next `schedulePeriodic` call without losing the unique work — correct here.

#### 1.3 New file — `BootReceiver.kt`

Create `mobile/android/app/src/main/java/com/calltrack/mobile/BootReceiver.kt`:

```kotlin
package com.calltrack.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms background sync after a reboot. Most OEMs also deliver
 * QUICKBOOT_POWERON / HTC equivalents — we register for the common set in the
 * manifest. Guarded so we never schedule work for an unpaired phone.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON"
        ) {
            if (SyncEngine.config(context) != null) {
                CallSyncPlugin.schedulePeriodic(context)
                if (CallObserverService.isEnabled(context)) {
                    CallObserverService.start(context)
                }
            }
        }
    }
}
```

> Phase-1-only: drop the inner `CallObserverService` lines.

#### 1.4 Manifest — wire `App`, register `BootReceiver`, add boot permission

Edit `mobile/android/app/src/main/AndroidManifest.xml`.

Add the boot permission next to the existing permission block:

```diff
     <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
     <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
     <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
         android:maxSdkVersion="32" />
+    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

Add `android:name=".App"` to the `<application>` tag:

```diff
     <application
+        android:name=".App"
         android:allowBackup="true"
         android:icon="@mipmap/ic_launcher"
```

Register the receiver — insert inside `<application>`, right after the closing `</activity>` (and before the `<provider>`):

```xml
        <receiver
            android:name=".BootReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.LOCKED_BOOT_COMPLETED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
                <action android:name="com.htc.intent.action.QUICKBOOT_POWERON" />
            </intent-filter>
        </receiver>
```

> The stray duplicate `<uses-permission android:name="android.permission.INTERNET" />` at the bottom (outside `<application>`, under the `<!-- Permissions -->` comment) is harmless — leave it; the manifest merger dedupes it.

#### 1.5 Gate onboarding on the battery-optimization exemption — `mobile/www/app.js`

The setup checklist already renders a battery step from `s.batteryOptimized` and an autostart step. The only gating change needed: **block the "Done" button until battery optimization is disabled**, so users can't skip the single most important OEM survival setting. Reuse the existing `getState().batteryOptimized` and `openBatterySettings`.

Replace the `done` button line in `renderSetup()`:

```diff
-      <button class="btn" id="done">Done — start using CallTrack</button>
+      <button class="btn" id="done" ${s.batteryOptimized ? 'disabled' : ''}>Done — start using CallTrack</button>
+      ${s.batteryOptimized ? '<div class="muted" style="text-align:center;margin-top:8px">Turn off battery restrictions above so calls keep syncing when the app is closed.</div>' : ''}
```

The existing `done.onclick` is unchanged. Because `renderSetup()` re-runs on every `[data-act]` tap (`setTimeout(renderSetup, 600)`), the button auto-enables once the user returns from the battery-settings screen having granted the exemption. `disabled` is plain HTML — no CSS change required.

> Web-layer compat: `app.js`/`native.js` are ES modules already shipping in Capacitor 6 — no API change. Remember to edit `mobile/www/app.js`, **never** the generated `mobile/android/app/src/main/assets/public/app.js`.

---

### Phase 2 — Foreground service + CallLog observer (near-real-time)

#### 2.1 New file — `CallObserverService.kt`

Create `mobile/android/app/src/main/java/com/calltrack/mobile/CallObserverService.kt`:

```kotlin
package com.calltrack.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.CallLog
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Always-on foreground dataSync service. Watches the system CallLog via a
 * ContentObserver; when a call row changes (i.e. a call just ended and was
 * written to the log), it enqueues an EXPEDITED one-time SyncWorker so the
 * just-ended call + its recording upload within seconds — without the WebView
 * ever being open. The user accepts a persistent low-priority notification.
 *
 * Debounced: OEM dialers write the call row, then patch duration/recording a
 * beat later, firing onChange 2-4 times per call. We coalesce into one sync.
 */
class CallObserverService : Service() {

    private lateinit var observer: CallLogObserver
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        startInForeground()
        observer = CallLogObserver(handler)
        // notifyForDescendants=true: some OEMs notify on a child uri, not the
        // base CONTENT_URI.
        contentResolver.registerContentObserver(
            CallLog.Calls.CONTENT_URI, true, observer
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Re-assert foreground in case the system restarted us.
        startInForeground()
        return START_STICKY
    }

    override fun onDestroy() {
        try { contentResolver.unregisterContentObserver(observer) } catch (_: Exception) {}
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startInForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(
                CHANNEL_ID, "Background call sync",
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Keeps your calls syncing to the office CRM"
                setShowBadge(false)
            }
            nm.createNotificationChannel(ch)
        }
        val tapIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
            android.app.PendingIntent.getActivity(
                this, 0, it,
                android.app.PendingIntent.FLAG_IMMUTABLE or
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT
            )
        }
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CallTrack is active")
            .setContentText("Syncing your calls to the office CRM")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(tapIntent)
            .build()

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIF_ID, notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    /** Debounced observer — coalesces the burst of onChange events per call. */
    private inner class CallLogObserver(h: Handler) : ContentObserver(h) {
        private val debounce = Runnable { enqueueExpeditedSync(this@CallObserverService) }
        override fun onChange(selfChange: Boolean) = onChange(selfChange, null)
        override fun onChange(selfChange: Boolean, uri: android.net.Uri?) {
            handler.removeCallbacks(debounce)
            // 4s lets the OEM dialer finish writing duration + flush the
            // recording file before we read & upload.
            handler.postDelayed(debounce, 4_000L)
        }
    }

    companion object {
        const val CHANNEL_ID = "calltrack_fgs"
        const val NOTIF_ID = 4711
        const val EXPEDITED_WORK = "calltrack_expedited_sync"
        private const val PREF_ENABLED = "fgsEnabled"

        fun isEnabled(ctx: Context): Boolean =
            SyncEngine.prefs(ctx).getBoolean(PREF_ENABLED, false)

        fun setEnabled(ctx: Context, enabled: Boolean) {
            SyncEngine.prefs(ctx).edit().putBoolean(PREF_ENABLED, enabled).apply()
        }

        fun start(ctx: Context) {
            setEnabled(ctx, true)
            val i = Intent(ctx, CallObserverService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            setEnabled(ctx, false)
            ctx.stopService(Intent(ctx, CallObserverService::class.java))
        }

        /** Expedited one-time sync — runs within seconds, foreground quota. */
        fun enqueueExpeditedSync(ctx: Context) {
            if (SyncEngine.config(ctx) == null) return
            val req = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                EXPEDITED_WORK, ExistingWorkPolicy.REPLACE, req
            )
        }
    }
}
```

**Capacitor-6 / WorkManager-2.9.1 compat notes (load-bearing):**
- `setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)` is the safe form: on Android 12+ it runs as a real expedited job (seconds); below 12 (this app's minSdk is 26) it transparently falls back to a normal job. It will **not** crash even though `SyncWorker` is a plain `Worker` — but for true expedited execution on API 31+, WorkManager will call `getForegroundInfo()`. Add the override below to `SyncWorker.kt` so an expedited run can promote itself if the OS demands it (no-op on older APIs):

```diff
 package com.calltrack.mobile

 import android.content.Context
+import android.app.Notification
+import android.content.pm.ServiceInfo
+import android.os.Build
+import androidx.core.app.NotificationCompat
 import androidx.work.Worker
+import androidx.work.ForegroundInfo
 import androidx.work.WorkerParameters

 /** Background sync. Best-effort on Indian OEMs — sync-on-app-open is primary. */
 class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
     override fun doWork(): Result {
         val cfg = SyncEngine.config(applicationContext) ?: return Result.success()
         return try {
             val res = SyncEngine.sync(applicationContext)
             val errors = res.getJSONArray("errors")
             if (errors.length() > 0) Result.retry() else Result.success()
         } catch (e: Exception) {
             Result.retry()
         }
     }
+
+    // Required when an expedited request is promoted to a foreground job on
+    // API 31+. Reuses the persistent FGS channel so no extra notification noise.
+    override fun getForegroundInfo(): ForegroundInfo {
+        val notif: Notification = NotificationCompat.Builder(
+            applicationContext, CallObserverService.CHANNEL_ID
+        )
+            .setContentTitle("CallTrack")
+            .setContentText("Syncing a call…")
+            .setSmallIcon(R.mipmap.ic_launcher)
+            .setOngoing(true)
+            .setPriority(NotificationCompat.PRIORITY_MIN)
+            .build()
+        return if (Build.VERSION.SDK_INT >= 29) {
+            ForegroundInfo(
+                CallObserverService.NOTIF_ID + 1, notif,
+                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
+            )
+        } else {
+            ForegroundInfo(CallObserverService.NOTIF_ID + 1, notif)
+        }
+    }
 }
```

> If `CallObserverService.CHANNEL_ID` is created lazily, `getForegroundInfo` referencing it before the service started is fine — `NotificationCompat` tolerates an absent channel on API < 26, and on API ≥ 26 the channel is created the first time the service starts (which always precedes any observer-driven expedited work). For belt-and-suspenders, create the channel in `App.onCreate()` too if you prefer.

#### 2.2 Manifest — `<service>` entry

In `AndroidManifest.xml`, inside `<application>`, after the `<receiver>` you added:

```xml
        <service
            android:name=".CallObserverService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="dataSync" />
```

> `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_DATA_SYNC` permissions are **already declared** in the manifest — no permission change needed for the service. `targetSdk 34` requires the `foregroundServiceType` attribute and the typed `startForeground(...)` call (both done above).

#### 2.3 Start the service — from onboarding + plugin method

Add a plugin method so the web onboarding can start/stop the service explicitly after permissions are granted. In `CallSyncPlugin.kt`, add these two `@PluginMethod`s (e.g. right after `openAutostartSettings`):

```kotlin
    @PluginMethod
    fun startBackgroundService(call: PluginCall) {
        CallObserverService.start(context)
        call.resolve(JSObject().put("started", true))
    }

    @PluginMethod
    fun stopBackgroundService(call: PluginCall) {
        CallObserverService.stop(context)
        call.resolve(JSObject().put("started", false))
    }
```

And surface `serviceEnabled` in `getState()` so the UI can reflect it. In the `getState` `call.resolve(...)` chain, add one line:

```diff
             .put("batteryOptimized", isBatteryOptimized())
+            .put("serviceEnabled", CallObserverService.isEnabled(context))
             .put("androidId", androidId()))
```

#### 2.4 Web wiring — `mobile/www/native.js` + `app.js`

In `mobile/www/native.js`, add to the `mock` object:

```diff
   async openAutostartSettings() {},
+  async startBackgroundService() { return { started: false }; },
+  async stopBackgroundService() { return { started: false }; },
   async configure() {},
```

…and to the exported `Native` object:

```diff
   openAutostartSettings: () => P.openAutostartSettings(),
+  startBackgroundService: () => P.startBackgroundService(),
+  stopBackgroundService: () => P.stopBackgroundService(),
```

In `mobile/www/app.js`, start the service when the user finishes setup. Replace the `done.onclick` in `renderSetup()`:

```diff
-  document.getElementById('done').onclick = () => { route = 'home'; render(); };
+  document.getElementById('done').onclick = async () => {
+    if (isNative) { try { await Native.startBackgroundService(); } catch {} }
+    route = 'home';
+    render();
+  };
```

> The service also auto-restarts on reboot/process-start via `App.kt`/`BootReceiver.kt` because `start()` persisted `fgsEnabled=true` in the existing `calltrack_sync` prefs (via `SyncEngine.prefs`). No new prefs file.

---

## (3) Exact shell commands

Run from the repo root (`/Users/sahilkhanna/Desktop/CRM FABLE`). `cap sync` regenerates `assets/public/*` from `mobile/www` and refreshes the native project:

```bash
# 1. Sync web assets + native config into the Android project
npx cap sync android

# 2. Build the debug APK (from the android project dir)
mobile/android/gradlew -p mobile/android assembleDebug

# 3. (Release) with signing env vars set
CALLTRACK_KEYSTORE=/path/to/calltrack.keystore \
CALLTRACK_KEYSTORE_PASS=*** \
mobile/android/gradlew -p mobile/android assembleRelease

# 4. Install to a connected device
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

> No new Gradle dependency: WorkManager `2.9.1` (already present) provides `OneTimeWorkRequest`, `setExpedited`, `ForegroundInfo`. `androidx.core` (`1.12.0`, already present) provides `NotificationCompat`. **Do not** add a custom `WorkManager` `Configuration.Provider` — Capacitor's merged `androidx.startup` `WorkManagerInitializer` already initializes it on demand; a second initializer throws `IllegalStateException: WorkManager is already initialized`.

---

## (4) Device test checklist

Test on a stock-ish device (Pixel/Android 14) **plus** at least one each: **Xiaomi/Redmi (MIUI/HyperOS)**, **OPPO/realme (ColorOS)**, **vivo (Funtouch/OriginOS)**, **Samsung (One UI)**.

**A. Onboarding gating (Phase 1)**
1. Fresh install → pair via QR. On the setup screen, confirm **"Done"** is disabled while "Battery: no restrictions" is unchecked.
2. Tap "Open" on the battery step → grant the ignore-battery-optimization prompt → return. Within ~600 ms the step shows ✓ and **"Done"** enables. Tap it.
3. Confirm the persistent **"CallTrack is active"** notification appears (low priority, no sound, can't be swiped away).

**B. Reboot survival (Phase 1)**
4. Reboot the phone. **Do not open the app.** Confirm the foreground notification reappears within ~30 s of unlock (proves `BootReceiver` + `App.onCreate` + service restart).
5. `adb shell dumpsys jobscheduler | grep -i calltrack` → confirm a periodic job exists (the 15-min `calltrack_periodic_sync`).

**C. Call-end latency (Phase 2 — the headline)**
6. With the app **fully closed** (swiped from recents), make/receive a real call on the device, then hang up.
7. Watch the office server logs (or `/api/today`). The new call row should POST to `/api/sync/calls` within **~5–10 s** of hang-up (4 s observer debounce + expedited dispatch + upload).
8. If the device's dialer records calls, confirm the recording uploads to `/api/sync/recordings` in the same window (OEM writes the file a beat after the log row — the 4 s debounce covers this; if a recording is consistently late, bump the debounce to 6–8 s).
9. `adb logcat | grep -iE "WM-|calltrack"` during a call → confirm `calltrack_expedited_sync` enqueues and runs.

**D. Doze / idle**
10. Force Doze: `adb shell dumpsys deviceidle force-idle`. Make a call. Expedited work should still fire (expedited jobs get a Doze exemption window); periodic work is deferred to the next maintenance window — expected. Exit with `adb shell dumpsys deviceidle unforce`.

**E. OEM kill behavior**
11. Swipe the app from recents on each OEM. Confirm the notification persists (service survives task removal via `START_STICKY`). On aggressive OEMs it may be killed — verify it returns after the next call or reboot.
12. Toggle airplane mode during a call-end; expected: expedited work fails the network constraint, then the 15-min periodic + backoff retries upload when connectivity returns.

**F. OEM battery/autostart caveats — must verify per device, document for users**
- **MIUI/HyperOS (Xiaomi/Redmi/POCO):** Settings → Apps → CallTrack → **Autostart = ON**, and Battery saver → **No restrictions**. Without Autostart, MIUI kills the FGS within minutes and blocks `BootReceiver`. The app's "Auto-start" setup step (`openAutostartSettings`) deep-links here.
- **ColorOS (OPPO/realme):** App → Battery usage → **Allow background activity** + **Allow auto-launch**. ColorOS aggressively freezes FGS otherwise.
- **vivo (Funtouch/OriginOS):** Settings → Battery → **High background power consumption** allowlist + **Auto-start** allowlist.
- **Samsung (One UI):** Settings → Battery → Background usage limits → **Never sleeping apps → add CallTrack**, and turn **off** "Put unused apps to sleep." Samsung does **not** need autostart (the setup step text already says "Skip on Samsung").
- **Stock Android (Pixel):** Only the battery-optimization exemption (already gated) is required; FGS + expedited work behave per AOSP.

**Acceptance bar:** on a properly-configured device (battery exemption + OEM autostart), a call placed with the app closed and the screen locked surfaces on the server within ~10 s, and the same holds after a reboot with the app never opened.

---

**Files to create:** `App.kt`, `BootReceiver.kt`, `CallObserverService.kt` (all under `mobile/android/app/src/main/java/com/calltrack/mobile/`).
**Files to edit:** `CallSyncPlugin.kt`, `SyncWorker.kt`, `AndroidManifest.xml`, `mobile/www/native.js`, `mobile/www/app.js`.
**Never edit:** `mobile/android/app/src/main/assets/public/*` (regenerated by `npx cap sync`).
**One version-compat risk flagged:** expedited work needs `getForegroundInfo()` on API 31+ (added to `SyncWorker`); do not add a `Configuration.Provider` (double-init with Capacitor's `WorkManagerInitializer`).

---

# Make Call Recordings Discoverable (esp. Pixel 7) — Build-Ready Guide

## 1. Root-cause recap

`SyncEngine.recordingFolders()` only scans a hardcoded OEM-folder allowlist (`RECORDING_DIRS`, SyncEngine.kt:25–35) that has **no Pixel/Google path**, and the one escape hatch — `prefs("safFolder")` read at SyncEngine.kt:127 — is **never populated** because no SAF folder picker exists anywhere in the app; stock Pixel often ships no native call recorder at all, so even a correct path may yield zero files.

**Strategy (locked):** the app does **not** record audio. Nothing below makes a non-system app force-record — Android forbids that for non-default-dialer/non-system apps, and we add no `RECORD_AUDIO` permission and no `MediaRecorder`/`AudioRecord`. We only (a) let the user point us at the folder their *own* dialer/recorder writes to (SAF), (b) add a `MediaStore.Audio` discovery channel as a second way to find those same files, and (c) widen the folder allowlist. The user must still enable recording in their dialer; on a stock Pixel with no recorder, no file is produced and there is nothing to upload — covered by onboarding + a server health alert.

---

## 2. EXACT changes

### 2.1 `AndroidManifest.xml` — add `READ_MEDIA_AUDIO` (API 33+)

File: `mobile/android/app/src/main/AndroidManifest.xml`. Add after the existing `READ_EXTERNAL_STORAGE` block (line 13–14):

```xml
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
        android:maxSdkVersion="32" />
    <!-- API 33+: lets the MediaStore.Audio discovery channel see recorder output
         even when All-Files-Access is denied. We never record audio ourselves. -->
    <uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
```

> Compat note (Capacitor 6 / targetSdk 34): `READ_MEDIA_AUDIO` is the correct granular replacement for `READ_EXTERNAL_STORAGE` on API 33+. It is request-at-runtime (dangerous). We request it through the existing Capacitor permission machinery (2.3). On API ≤ 32 it is simply ignored by the system; the `MANAGE_EXTERNAL_STORAGE` (All-Files) path still covers File scanning there.

---

### 2.2 `SyncEngine.kt` — full rewrite of discovery + upload to DocumentFile + MediaStore

This is a **drop-in replacement for the whole file**. It preserves every public/used symbol (`prefs`, `config`, `saveConfig`, `clearConfig`, `lastSync`, `sync`, `recordingFolders`, `sha256`), the `pairedAt`/`lastCallTs` prefs, and the exact `name:length` ledger semantics — now computed from `DocumentFile.getName()` + `.length()` (SAF) and `MediaStore DISPLAY_NAME` + `SIZE` (MediaStore), so an item already uploaded by one channel is not re-uploaded by the other.

```kotlin
package com.calltrack.mobile

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.CallLog
import android.provider.MediaStore
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * All call-capture sync logic. Reads the call log and discovers recordings the
 * PHONE'S OWN dialer/recorder produced, then posts to the office server.
 *
 * The app never records audio itself. Recordings are discovered three ways:
 *   1. A user-picked SAF tree (prefs "safFolder") — most reliable on Pixel.
 *   2. MediaStore.Audio query (API 33+ READ_MEDIA_AUDIO) — second channel.
 *   3. A hardcoded OEM-folder allowlist via All-Files-Access (legacy).
 * No cloud — every byte goes only to the paired office server.
 */
object SyncEngine {
    private const val PREFS = "calltrack_sync"

    // OEM call-recording folders, probed in order via All-Files-Access.
    // First that exists is scanned; the SAF-granted tree (if any) is scanned too.
    private val RECORDING_DIRS = listOf(
        "Recordings/Call",                       // Samsung One UI
        "Call",                                  // older Samsung
        "MIUI/sound_recorder/call_rec",          // Xiaomi/Redmi/POCO
        "Recorder/call",                         // HyperOS
        "Music/Recordings/Call Recordings",      // realme / OPPO ColorOS
        "Record/Call",                           // vivo
        "Sounds/CallRecordings",                 // OnePlus
        "PhoneRecord",                           // generic
        "CallRecordings",
        // Pixel / Google Phone app + AOSP / generic defense-in-depth:
        "Recordings",                            // Pixel "Recorder"/Phone recordings root
        "Recordings/Call Recordings",            // Pixel Phone call-recording subfolder
        "Android/data/com.google.android.dialer/files/CallRecordings",
        "Music/Recordings",
        "Download/CallRecordings"
    )
    private val AUDIO_EXT = setOf("m4a", "mp3", "amr", "wav", "ogg", "aac", "3gp", "opus")

    // Substrings (lowercased) a path/name must contain for the MediaStore channel
    // to treat a file as a CALL recording. Keeps personal music/voice memos out.
    private val CALL_HINTS = listOf("call", "rec/call", "callrec", "call_rec", "call recording", "phonerecord")

    data class Config(val serverUrl: String, val token: String)

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun config(ctx: Context): Config? {
        val p = prefs(ctx)
        val url = p.getString("serverUrl", null) ?: return null
        val token = p.getString("token", null) ?: return null
        return Config(url.trimEnd('/'), token)
    }

    fun saveConfig(ctx: Context, serverUrl: String, token: String) {
        prefs(ctx).edit()
            .putString("serverUrl", serverUrl)
            .putString("token", token)
            .putLong("pairedAt", maxOf(prefs(ctx).getLong("pairedAt", 0L), System.currentTimeMillis()))
            .apply()
    }

    fun clearConfig(ctx: Context) = prefs(ctx).edit().clear().apply()

    fun lastSync(ctx: Context) = prefs(ctx).getLong("lastSyncMs", 0L)

    /** Returns {calls, recordings, errors[]}. Safe to call repeatedly. */
    fun sync(ctx: Context): JSONObject {
        val cfg = config(ctx) ?: return result(0, 0, listOf("Not paired"))
        val errors = mutableListOf<String>()
        var callCount = 0
        var recCount = 0

        val pairedAt = prefs(ctx).getLong("pairedAt", 0L)
        val sinceCalls = maxOf(prefs(ctx).getLong("lastCallTs", 0L), pairedAt)

        try {
            val calls = readCallLog(ctx, sinceCalls)
            if (calls.length() > 0) {
                postJson(cfg, "/api/sync/calls", JSONObject().put("calls", calls))
                callCount = calls.length()
                var maxTs = sinceCalls
                for (i in 0 until calls.length()) maxTs = maxOf(maxTs, calls.getJSONObject(i).getLong("call_log_ts"))
                prefs(ctx).edit().putLong("lastCallTs", maxTs).apply()
            }
        } catch (e: Exception) { errors.add("Calls: ${e.message}") }

        try {
            recCount = uploadRecordings(ctx, cfg, pairedAt)
        } catch (e: Exception) { errors.add("Recordings: ${e.message}") }

        prefs(ctx).edit().putLong("lastSyncMs", System.currentTimeMillis()).apply()
        return result(callCount, recCount, errors)
    }

    private fun readCallLog(ctx: Context, sinceMs: Long): JSONArray {
        val arr = JSONArray()
        val cols = arrayOf(
            CallLog.Calls.NUMBER, CallLog.Calls.TYPE,
            CallLog.Calls.DURATION, CallLog.Calls.DATE
        )
        ctx.contentResolver.query(
            CallLog.Calls.CONTENT_URI, cols,
            "${CallLog.Calls.DATE} > ?", arrayOf(sinceMs.toString()),
            "${CallLog.Calls.DATE} ASC"
        )?.use { c ->
            val ni = c.getColumnIndex(CallLog.Calls.NUMBER)
            val ti = c.getColumnIndex(CallLog.Calls.TYPE)
            val di = c.getColumnIndex(CallLog.Calls.DURATION)
            val dt = c.getColumnIndex(CallLog.Calls.DATE)
            while (c.moveToNext()) {
                val number = c.getString(ni) ?: continue
                val direction = when (c.getInt(ti)) {
                    CallLog.Calls.INCOMING_TYPE -> "incoming"
                    CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                    else -> "missed"
                }
                arr.put(JSONObject()
                    .put("phone", number)
                    .put("direction", direction)
                    .put("duration_seconds", c.getInt(di))
                    .put("call_log_ts", c.getLong(dt)))
            }
        }
        return arr
    }

    // ---- Discovery channel A: a user-picked SAF tree ----
    // Returns the DocumentFile tree root the user granted (or null).
    fun safTree(ctx: Context): DocumentFile? {
        val uriStr = prefs(ctx).getString("safFolder", null) ?: return null
        val uri = Uri.parse(uriStr)
        return try { DocumentFile.fromTreeUri(ctx, uri) } catch (_: Exception) { null }
    }

    // ---- Discovery channel C: legacy OEM folders via All-Files-Access ----
    fun recordingFolders(ctx: Context): List<File> {
        val ext = android.os.Environment.getExternalStorageDirectory()
        return RECORDING_DIRS.map { File(ext, it) }.filter { it.isDirectory }
    }

    /**
     * A discovered recording, abstracted over its source so dedupe + upload
     * are identical for File, SAF DocumentFile and MediaStore rows.
     * ledgerKey preserves the original "name:length" semantics.
     */
    private data class Rec(
        val name: String,
        val length: Long,
        val lastModified: Long,
        val open: () -> InputStream?
    ) {
        val ledgerKey get() = "$name:$length"
    }

    private fun uploadRecordings(ctx: Context, cfg: Config, pairedAt: Long): Int {
        val ledger = prefs(ctx).getStringSet("uploaded", emptySet())!!.toMutableSet()
        var count = 0

        val recs = mutableListOf<Rec>()
        // Channel A — SAF tree (recursive).
        safTree(ctx)?.let { collectFromSaf(ctx, it, recs) }
        // Channel C — legacy File folders.
        for (dir in recordingFolders(ctx)) collectFromFiles(dir, recs)
        // Channel B — MediaStore.Audio (API 33+ READ_MEDIA_AUDIO or All-Files).
        collectFromMediaStore(ctx, pairedAt, recs)

        // Dedupe across channels on the ledger key (name:length), upload new ones.
        val seenThisRun = HashSet<String>()
        for (r in recs) {
            if (r.lastModified < pairedAt) continue
            val key = r.ledgerKey
            if (!seenThisRun.add(key)) continue        // same file via 2 channels
            if (ledger.contains(key)) continue
            try {
                val stream = r.open() ?: continue
                uploadOne(cfg, r, stream)
                ledger.add(key)
                count++
            } catch (_: Exception) { /* retry next run */ }
        }
        prefs(ctx).edit().putStringSet("uploaded", ledger).apply()
        return count
    }

    private fun collectFromFiles(dir: File, out: MutableList<Rec>) {
        val files = dir.listFiles() ?: return
        for (f in files) {
            if (!f.isFile) continue
            if (f.extension.lowercase() !in AUDIO_EXT) continue
            out.add(Rec(f.name, f.length(), f.lastModified()) { f.inputStream() })
        }
    }

    private fun collectFromSaf(ctx: Context, dir: DocumentFile, out: MutableList<Rec>) {
        val children = try { dir.listFiles() } catch (_: Exception) { return }
        for (df in children) {
            if (df.isDirectory) { collectFromSaf(ctx, df, out); continue } // recurse one folder deep is enough, but full recursion is safe
            val name = df.name ?: continue
            val ext = name.substringAfterLast('.', "").lowercase()
            if (ext !in AUDIO_EXT) continue
            out.add(Rec(name, df.length(), df.lastModified()) {
                try { ctx.contentResolver.openInputStream(df.uri) } catch (_: Exception) { null }
            })
        }
    }

    private fun collectFromMediaStore(ctx: Context, pairedAt: Long, out: MutableList<Rec>) {
        val collection = if (Build.VERSION.SDK_INT >= 29)
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        else
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI

        val projection = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATE_MODIFIED,   // seconds
            MediaStore.Audio.Media.RELATIVE_PATH    // API 29+
        )
        // pairedAt cutoff (DATE_MODIFIED is in SECONDS).
        val sinceSec = (pairedAt / 1000L)
        val selection = "${MediaStore.Audio.Media.DATE_MODIFIED} >= ?"
        val args = arrayOf(sinceSec.toString())

        try {
            ctx.contentResolver.query(collection, projection, selection, args,
                "${MediaStore.Audio.Media.DATE_MODIFIED} ASC")?.use { c ->
                val idI = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val nameI = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                val sizeI = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
                val modI = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)
                val pathI = c.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH)
                while (c.moveToNext()) {
                    val name = c.getString(nameI) ?: continue
                    val ext = name.substringAfterLast('.', "").lowercase()
                    if (ext !in AUDIO_EXT) continue
                    val relPath = if (pathI >= 0) (c.getString(pathI) ?: "") else ""
                    // Tight filter: name OR folder must look like a CALL recording.
                    val hay = "$relPath/$name".lowercase()
                    if (CALL_HINTS.none { hay.contains(it) }) continue
                    val size = c.getLong(sizeI)
                    val modMs = c.getLong(modI) * 1000L
                    val id = c.getLong(idI)
                    val itemUri = Uri.withAppendedPath(collection, id.toString())
                    out.add(Rec(name, size, modMs) {
                        try { ctx.contentResolver.openInputStream(itemUri) } catch (_: Exception) { null }
                    })
                }
            }
        } catch (_: SecurityException) { /* READ_MEDIA_AUDIO not granted yet */ }
        catch (_: Exception) { /* ignore — other channels still run */ }
    }

    private fun durationOf(stream: InputStream?): Int? {
        // MediaMetadataRetriever needs a path/FD/uri, not a generic stream; for
        // the duration metadata we re-open via a temp not needed — callers that
        // can supply a path use durationOfPath. For stream sources we skip.
        return null
    }

    // ---- HTTP (no third-party libs; plain HttpURLConnection) ----
    private fun postJson(cfg: Config, path: String, body: JSONObject): String {
        val conn = (URL(cfg.serverUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Authorization", "Bearer ${cfg.token}")
            setRequestProperty("Content-Type", "application/json")
            doOutput = true
            connectTimeout = 10000
            readTimeout = 30000
        }
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = conn.responseCode
        val resp = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.readText() ?: ""
        conn.disconnect()
        if (code !in 200..299) throw RuntimeException("HTTP $code: $resp")
        return resp
    }

    private fun uploadOne(cfg: Config, rec: Rec, stream: InputStream) {
        val boundary = "----calltrack${System.nanoTime()}"
        val conn = (URL(cfg.serverUrl + "/api/sync/recordings").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Authorization", "Bearer ${cfg.token}")
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            doOutput = true
            connectTimeout = 10000
            readTimeout = 60000
        }
        conn.outputStream.use { out ->
            fun field(name: String, value: String) {
                out.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray())
            }
            field("filename", rec.name)
            field("last_modified_ms", rec.lastModified.toString())
            // duration is computed server-side now (stream sources have no path);
            // server can probe with ffprobe. If you must send it, see note below.
            out.write(("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"${rec.name}\"\r\n" +
                "Content-Type: application/octet-stream\r\n\r\n").toByteArray())
            stream.use { it.copyTo(out) }
            out.write("\r\n--$boundary--\r\n".toByteArray())
        }
        val code = conn.responseCode
        conn.disconnect()
        if (code !in 200..299) throw RuntimeException("upload HTTP $code")
    }

    private fun result(calls: Int, recs: Int, errors: List<String>) = JSONObject()
        .put("calls", calls).put("recordings", recs)
        .put("errors", JSONArray(errors))

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
```

**Notes on this rewrite (read before applying):**

- **`duration_seconds` field is dropped from the multipart body.** The original `durationOf(File)` used `MediaMetadataRetriever.setDataSource(absolutePath)`, which does not work for SAF/MediaStore content streams. Three honest options — pick one:
  1. **(Recommended, smallest change)** Compute duration server-side from the uploaded file (ffprobe) — the multipart still carries `filename` + `last_modified_ms`. The server already owns the bytes.
  2. Keep duration for **File** sources only: in `collectFromFiles`, capture the `File`, and in `uploadOne` send duration when the source is a `File`. Requires adding an optional `path: String?` to `Rec`.
  3. Use `MediaMetadataRetriever.setDataSource(ctx, uri)` (the `(Context, Uri)` overload) for SAF/MediaStore — but that consumes the stream, so you must re-open for upload. Workable but doubles I/O.
  
  If your server endpoint **requires** `duration_seconds`, implement option 2 by adding a `durationOfPath(path)` helper (identical body to the old `durationOf`) and a `path` field on `Rec` for File sources. Flag this to the server owner: confirm `/api/sync/recordings` tolerates a missing `duration_seconds` field before shipping option 1.

- `androidx.documentfile` is **not** a transitive dep of capacitor-android — you must add it (2.4).
- SAF recursion: `collectFromSaf` recurses fully. `DocumentFile.listFiles()` over SAF is slow for huge trees; in practice a call-recordings folder is flat, so this is fine. If the user accidentally picks `Internal storage` root, the pairedAt cutoff + `name:length` ledger still prevent re-uploads, but warn them in onboarding to pick the **recordings** folder specifically.

---

### 2.3 `CallSyncPlugin.kt` — SAF picker `@PluginMethod` + activity result + READ_MEDIA_AUDIO request + expose SAF state

Add the imports, a `READ_MEDIA_AUDIO` permission alias, the picker method with its `@ActivityCallback`, a media-audio permission request, and surface `safFolderPicked` in `getState`.

**(a) Imports** — add to the import block at the top:

```kotlin
import com.getcapacitor.annotation.ActivityCallback
import androidx.activity.result.ActivityResult
```

**(b) Add the `media` permission alias** to the `@CapacitorPlugin` annotation (Capacitor only requests aliases it knows about). Replace the `permissions = [ ... ]` block:

```kotlin
@CapacitorPlugin(
    name = "CallSync",
    permissions = [
        Permission(alias = "calllog", strings = [Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE]),
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
        Permission(alias = "mediaaudio", strings = [Manifest.permission.READ_MEDIA_AUDIO])
    ]
)
```

> Compat note: `Manifest.permission.READ_MEDIA_AUDIO` is an API-33 constant; the project compiles against `compileSdk 34` so it resolves fine. At runtime on API ≤ 32 the system auto-grants it (it maps to nothing), so requesting it is harmless. Guard the *request* on SDK ≥ 33 anyway (below).

**(c) New picker method + activity callback.** Insert after `openAutostartSettings` (after line 105), before `configure`:

```kotlin
    // ---- SAF: let the user point us at their dialer's recordings folder ----
    // Fires the system folder picker, takes a persistable read grant, and stores
    // the tree Uri into prefs "safFolder" (read by SyncEngine.safTree()).
    @PluginMethod
    fun pickRecordingsFolder(call: PluginCall) {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
                     Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            // Hint the picker toward the recordings area (best-effort; ignorable).
            if (Build.VERSION.SDK_INT >= 26) {
                try {
                    val initial = Uri.parse(
                        "content://com.android.externalstorage.documents/document/primary%3ARecordings")
                    putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI, initial)
                } catch (_: Exception) {}
            }
        }
        startActivityForResult(call, i, "folderPickedResult")
    }

    @ActivityCallback
    fun folderPickedResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != android.app.Activity.RESULT_OK) {
            call.resolve(JSObject().put("picked", false)); return
        }
        val treeUri: Uri? = result.data?.data
        if (treeUri == null) { call.resolve(JSObject().put("picked", false)); return }
        // Persist the grant so background WorkManager runs can still read it.
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
        try {
            context.contentResolver.takePersistableUriPermission(treeUri, flags)
        } catch (e: Exception) {
            call.resolve(JSObject().put("picked", false).put("error", e.message)); return
        }
        SyncEngine.prefs(context).edit().putString("safFolder", treeUri.toString()).apply()
        call.resolve(JSObject().put("picked", true).put("uri", treeUri.toString()))
    }

    // ---- API 33+ runtime grant for the MediaStore.Audio discovery channel ----
    @PluginMethod
    fun requestMediaAudio(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 33 || hasPerm(Manifest.permission.READ_MEDIA_AUDIO)) {
            call.resolve(JSObject().put("granted", true)); return
        }
        requestPermissionForAliases(arrayOf("mediaaudio"), call, "mediaAudioCallback")
    }

    @com.getcapacitor.annotation.PermissionCallback
    fun mediaAudioCallback(call: PluginCall) {
        val granted = Build.VERSION.SDK_INT < 33 || hasPerm(Manifest.permission.READ_MEDIA_AUDIO)
        call.resolve(JSObject().put("granted", granted))
    }
```

> Capacitor 6 API check: `startActivityForResult(PluginCall, Intent, String)` and the `@ActivityCallback fun(PluginCall?, ActivityResult)` signature are the supported Capacitor 6 activity-result pattern (the bridge wraps `ActivityResultContracts.StartActivityForResult`). `@ActivityCallback`/`@PermissionCallback`/`requestPermissionForAliases` all exist in `@capacitor/android` 6.2.1. No version risk.

**(d) Surface SAF + media-audio state in `getState`.** Edit the `perms` object and the resolved payload (lines 34–45):

```kotlin
        val perms = JSObject()
            .put("callLog", hasPerm(Manifest.permission.READ_CALL_LOG))
            .put("storage", hasAllFilesAccess())
            .put("mediaAudio", if (Build.VERSION.SDK_INT >= 33) hasPerm(Manifest.permission.READ_MEDIA_AUDIO) else true)
            .put("notifications", if (Build.VERSION.SDK_INT >= 33) hasPerm(Manifest.permission.POST_NOTIFICATIONS) else true)
        val ledger = SyncEngine.prefs(ctx).getStringSet("uploaded", emptySet())!!.size
        call.resolve(JSObject()
            .put("permissions", perms)
            .put("lastSyncMs", SyncEngine.lastSync(ctx))
            .put("pendingUploads", 0)
            .put("uploadedCount", ledger)
            .put("safFolderPicked", SyncEngine.prefs(ctx).getString("safFolder", null) != null)
            .put("batteryOptimized", isBatteryOptimized())
            .put("androidId", androidId()))
```

---

### 2.4 `mobile/android/app/build.gradle` — add DocumentFile dependency

File: `mobile/android/app/build.gradle`. Add inside `dependencies { ... }` (after line 61, next to the `work-runtime-ktx` line):

```gradle
    implementation "androidx.work:work-runtime-ktx:2.9.1"
    implementation "androidx.documentfile:documentfile:1.0.1"
```

> Compat note: `documentfile:1.0.1` is the current stable, compiles against any AndroidX baseline this project uses (`core 1.12.0`). No version conflict.

---

### 2.5 `mobile/www/native.js` — bridge the 3 new methods + mocks

File: `mobile/www/native.js`. Add to the `mock` object (so browser dev stays clickable):

```js
  async openAutostartSettings() {},
  async pickRecordingsFolder() { return { picked: false }; },
  async requestMediaAudio() { return { granted: false }; },
  async configure() {},
```

Add to the exported `Native` object (after `openAutostartSettings`):

```js
  openAutostartSettings: () => P.openAutostartSettings(),
  pickRecordingsFolder: () => P.pickRecordingsFolder(),
  requestMediaAudio: () => P.requestMediaAudio(),
  configure: (cfg) => P.configure(cfg),
```

---

### 2.6 `mobile/www/app.js` — onboarding: "Turn ON recording in dialer" + "Pick recordings folder"

File: `mobile/www/app.js`, `renderSetup()` (lines 135–168). Add two steps after the existing "Recordings access" step, and wire two new actions. The deep-link to the dialer's recording settings mirrors the existing `openAutostartSettings` pattern (best-effort `ACTION_VIEW`/dialer intent) — but since there is **no native method for it yet**, we drive it from JS with a plain settings-app fallback and a clear instruction. (If you want a true native deep-link, add an `openDialerRecordingSettings` `@PluginMethod` that tries the Google Dialer call-recording activity; instructions below the diff.)

Replace the `<div class="card"> ... </div>` step list (lines 146–152) with:

```js
      <div class="card">
        <h2>Finish setup — ${cfg.userName}</h2>
        ${step(s.permissions.callLog, 'Call log access', 'So calls attach to leads automatically', 'perms', 'Allow')}
        ${step(s.permissions.storage, 'Recordings access (all files)', 'Lets us read your dialer\u2019s recordings folder', 'files', 'Allow')}
        ${step(s.permissions.mediaAudio, 'Audio access', 'Second way to find recordings (Android 13+)', 'mediaaudio', 'Allow')}
        ${step(false, 'Turn ON call recording in your dialer', 'CallTrack never records \u2014 your Phone app does. Enable it once.', 'dialerrec', 'Open')}
        ${step(s.safFolderPicked, 'Pick your recordings folder', 'Tap, then choose the folder your Phone app saves recordings to', 'safpick', 'Choose')}
        ${step(!s.batteryOptimized, 'Battery: no restrictions', 'So syncing keeps working in the background', 'battery', 'Open')}
        ${step(false, 'Auto-start (Xiaomi/Oppo/Vivo)', 'Skip on Samsung. Lets the app restart itself', 'autostart', 'Open')}
      </div>
```

In the `data-act` click handler (lines 156–165) add the three new branches:

```js
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
```

**Optional true native dialer deep-link** (replaces the `dialerrec` `openAutostartSettings()` placeholder). Add this `@PluginMethod` to `CallSyncPlugin.kt` and a `Native.openDialerRecordingSettings()` bridge mirroring 2.5; there is no documented action for the call-recording toggle, so this opens the Google Phone app's settings as the best target, with a generic dialer-open fallback:

```kotlin
    @PluginMethod
    fun openDialerRecordingSettings(call: PluginCall) {
        val targets = listOf(
            // Google Phone app settings (Pixel + many OEMs ship it).
            "com.google.android.dialer" to "com.android.dialer.settings.DialerSettingsActivity",
            "com.android.dialer"        to "com.android.dialer.settings.DialerSettingsActivity"
        )
        for ((pkg, cls) in targets) {
            try {
                context.startActivity(Intent().setClassName(pkg, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                call.resolve(); return
            } catch (_: Exception) {}
        }
        // Fallback: just launch the default dialer so the user can open its menu.
        try {
            context.startActivity(Intent(Intent.ACTION_DIAL).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {}
        call.resolve()
    }
```

> Reality flag for the team: Android exposes **no** stable intent to jump straight to the "Call recording" switch on most OEMs (and Google's auto-record is region-locked). The honest UX is "open the dialer settings + tell the user what to tap," which is what the above does. Do not promise a one-tap toggle.

---

### 2.7 Server-side health alert (note for backend owner — not in this repo's mobile dir)

Add a check on the office server: for each paired device, if `now - pairedAt > 24h` **and** the device has uploaded **zero** rows to `/api/sync/recordings` since `pairedAt` (while it *has* posted calls to `/api/sync/calls`), surface a dashboard banner / admin alert: *"<device> is syncing calls but no recordings since pairing — recording may be OFF in the phone's dialer, or the recordings folder isn't linked."* This is the only reliable way to catch stock-Pixel-with-no-recorder, because the client genuinely has nothing to upload. Key it off the existing `pairedAt` semantics already sent (calls carry `call_log_ts`; recordings carry `last_modified_ms`).

---

## 3. Exact shell commands

Run from repo root `/Users/sahilkhanna/Desktop/CRM FABLE`:

```bash
# 1. (No npm deps change for the web side; native dep is added in build.gradle.)
# 2. Copy web assets (mobile/www -> android assets/public) and sync native plugins/config.
npx cap sync android

# 3. Build a debug APK to sideload for testing.
cd mobile/android && ./gradlew assembleDebug
# Output: mobile/android/app/build/outputs/apk/debug/app-debug.apk

# 4. Install on a connected device.
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 5. (Release, when ready — keystore env vars must be set as per build.gradle)
CALLTRACK_KEYSTORE=/path/to/calltrack.keystore CALLTRACK_KEYSTORE_PASS=*** ./gradlew assembleRelease
```

> `npx cap sync android` regenerates `mobile/android/app/src/main/assets/public/*` and `capacitor.plugins.json`. Since `CallSync` is a **local** plugin registered in `MainActivity` (not an npm Capacitor package), it does not appear in `capacitor.plugins.json` and needs no entry there — no action required. Verify after sync that `AndroidManifest.xml`, `build.gradle`, and the `.kt` files are unchanged by the sync (they are not generated). Edit only `mobile/www`, never `assets/public`.

---

## 4. Device test checklist

Test on at least: **Pixel 7 (Android 14, stock Google Phone)** — primary; **Samsung (One UI)**; **Xiaomi/Redmi (MIUI/HyperOS)**; one **OnePlus or vivo/realme**. For each device, first confirm a recording file is even produced (Strategy A depends on it).

**A. Does a file even get produced? (do this FIRST on Pixel 7)**
1. Open the **Phone app → Settings → Call recording**. If absent (common on stock Pixel outside supported regions), note it — there is nothing to discover; the server "no recordings since pairing" alert is the expected outcome. If present, turn it ON.
2. Place a real 20-second call (both directions). End it.
3. Using a file manager, confirm a new audio file exists and note its **exact folder** (e.g. Pixel often `Recordings/` or `Recordings/Call Recordings/`) and **filename + size**.

**B. SAF picker + persistable permission**
4. In CallTrack setup, tap **"Pick your recordings folder" → Choose**. Confirm the system folder picker opens (initial location hint near Recordings is best-effort).
5. Select the folder from step 3 → **Use this folder / Allow**. Confirm the setup step flips to ✓ (`safFolderPicked = true`).
6. Verify the grant **persists**: force-stop the app, reopen — the step is still ✓. (Confirms `takePersistableUriPermission` worked; reboot the phone and re-check for full confidence.)

**C. MediaStore channel (Android 13+)**
7. Tap **"Audio access" → Allow**, grant `READ_MEDIA_AUDIO`. Step flips to ✓. (On Android ≤ 12 this step shows ✓ automatically.)
8. Without picking a SAF folder (clear it / fresh install), confirm a call recording in a `…/Call…` path is still discovered via MediaStore alone — tap **"Sync my calls now"**.

**D. Upload + dedupe**
9. Tap **Sync my calls now**. Toast should read `Synced N calls, 1 recordings` after step-A's call.
10. On the office server / review screen, confirm the recording appears against the right call, plays back, and `filename`/`last_modified_ms` match the device file.
11. Tap **Sync now again** → recordings count is **0** (ledger `name:length` dedupe holds; the same file found by both SAF and MediaStore is uploaded **once**).
12. Confirm **pre-pairing** recordings (made before pairing, or older `lastModified`) are **not** uploaded.

**E. Personal-audio safety**
13. Put a music/voice-memo file (no "call" in name or path) into a non-call folder dated after pairing. Sync. Confirm it is **NOT** uploaded by the MediaStore channel (rejected by `CALL_HINTS`). If you pointed SAF at a broad folder containing it, confirm you only see call files in the chosen folder (warn users to pick the specific recordings folder).

**F. Background**
14. Pair, link folder, then leave app backgrounded ~45 min (or trigger WorkManager via `adb shell cmd jobscheduler run -f com.calltrack.mobile <jobId>` / Android Studio Background Task Inspector). Confirm new recordings upload without opening the WebView, proving the **persistable** SAF grant + MediaStore work from `SyncWorker`.

**G. OEM matrix**
15. Repeat A–D on Samsung/Xiaomi/OnePlus. Confirm the legacy `RECORDING_DIRS` File channel still works there (it should find files without needing SAF), and that adding the new Pixel/Google paths caused no regression.

---

## Files referenced (all absolute)
- `/Users/sahilkhanna/Desktop/CRM FABLE/mobile/android/app/src/main/java/com/calltrack/mobile/SyncEngine.kt` (full rewrite — 2.2)
- `/Users/sahilkhanna/Desktop/CRM FABLE/mobile/android/app/src/main/java/com/calltrack/mobile/CallSyncPlugin.kt` (2.3)
- `/Users/sahilkhanna/Desktop/CRM FABLE/mobile/android/app/src/main/AndroidManifest.xml` (2.1)
- `/Users/sahilkhanna/Desktop/CRM FABLE/mobile/android/app/build.gradle` (2.4)
- `/Users/sahilkhanna/Desktop/CRM FABLE/mobile/www/native.js` (2.5)
- `/Users/sahilkhanna/Desktop/CRM FABLE/mobile/www/app.js` (`renderSetup`, lines 135–168 — 2.6)
- Unchanged but relevant: `SyncWorker.kt` (calls `SyncEngine.sync`, no edit needed), `MainActivity.kt` (plugin already registered), `file_paths.xml` (no change — SAF/MediaStore don't use FileProvider).

**Capacitor 6 compat summary:** all new APIs (`startActivityForResult`/`@ActivityCallback`, `requestPermissionForAliases`/`@PermissionCallback`, `Permission` alias for `READ_MEDIA_AUDIO`) are present in `@capacitor/android` ^6.2.1. New AndroidX dep `documentfile:1.0.1` is compatible. No version risk identified. The only **open decision** the team must make before shipping is the `duration_seconds` handling (2.2 note) — confirm the server's `/api/sync/recordings` contract.

---

## Consolidated device test matrix

Run each section's detailed checklist, but at minimum verify on **(a) a Pixel 7 (stock Android)** and **(b) one team OEM phone (Xiaomi/Samsung/realme/vivo)** — behavior differs sharply between them:

| Check | Pixel 7 | OEM phone |
|---|---|---|
| QR scan: camera permission prompt appears, pairing QR scans (§A) | ☐ | ☐ |
| Recording **plays inside the app** after rebuild (playback fix) | ☐ | ☐ |
| Background sync fires after reboot (BootReceiver) (§B) | ☐ | ☐ |
| New call appears in CRM within seconds, app closed (foreground service) (§B) | ☐ | ☐ |
| Survives OEM battery-killer / Doze after battery-opt exemption (§B) | ☐ | ☐ |
| A call recording is actually **produced** by the dialer (§C) | ☐ | ☐ |
| SAF folder-picker grants persistable access; recordings upload (§C) | ☐ | ☐ |
| MediaStore channel finds recordings on API 33+ (§C) | ☐ | ☐ |

> On a stock Pixel with **no** built-in call recorder, §C cannot surface a recording that was never created — that's the OEM-recorder reality, not a bug. Use a phone whose dialer records, or have the user enable recording in their dialer.

*Authored by a multi-agent code investigation against the live repo; build, compile-check, and device-test before release.*
