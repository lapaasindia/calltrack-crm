# WhatsApp on the Android app (Phase 6B) — native build checklist

The WebView side (a **Chats** tab + an unread poll that fires a local
notification) is already written in `mobile/www/app.js` / `style.css`, routed
through a thin notification bridge in `mobile/www/native.js`
(`Native.requestNotificationPermission()` + `Native.notify()`). It is
**feature-gated**: the tab and the poll only appear when the server's
`whatsapp_enabled` setting is on (the WebView reads `/api/whatsapp/unread`,
which returns `{ enabled:false }` until the owner connects WhatsApp in Settings).

De-dupe: `Native.notify()` is keyed on the WhatsApp `wa_message` id (the `latest.id`
from `/api/whatsapp/unread`), so the same inbound never raises two notifications,
and the `wa_since` watermark in `@capacitor/preferences` stops old messages from
re-notifying after a reopen.

**Most of the wiring is already committed in the repo.** Only the steps that need
the Android toolchain (Android Studio + SDK) remain — there is no Android SDK/device
in the dev/build sandbox, so the APK itself must be built on your Mac with Android
Studio installed.

## Already done (in the repo)
- ✅ `@capacitor/local-notifications@^6.1.3` is in `package.json` (matches Capacitor 6).
- ✅ `POST_NOTIFICATIONS` is in `mobile/android/app/src/main/AndroidManifest.xml`.
- ✅ Status-bar icon `ic_stat_calltrack` at
  `mobile/android/app/src/main/res/drawable/ic_stat_calltrack.xml` (white silhouette;
  swap for white PNGs in `drawable-*dpi/` if a specific OEM renders the vector poorly).
- ✅ `capacitor.config.json` sets the notification `smallIcon` + `iconColor`.
- ✅ WebView **Chats** tab + 30s `/api/whatsapp/unread` poll + `Native.notify()` bridge
  (`mobile/www/app.js` / `native.js`), feature-gated on the server's `whatsapp_enabled`.

## Remaining: sync + build (run at the REPO ROOT — not `mobile/`)
The Capacitor project is rooted at the repo root (`capacitor.config.json` lives here),
so use plain `npx cap …` — **not** `--prefix mobile`:
```bash
npm install            # installs @capacitor/local-notifications (already in package.json)
npx cap sync android   # wires the plugin's native module into mobile/android
```
The WebView guards for the plugin's absence, so nothing breaks before this — but no
notification fires until the plugin is synced into the native project.

## 3. Background polling (app closed) — foreground service
The LAN deployment has **no FCM / internet push**. While the WebView is open it
polls `/api/whatsapp/unread` every 30s. To notify when the app is closed, extend
the existing call-capture **foreground service** (the `CallObserverService` in
`docs/ANDROID-FIXES.md`) to also:
- GET `<serverUrl>/api/whatsapp/unread?since=<lastSeenSentAt>` with the device
  bearer token, on the same WorkManager / service cadence used for call sync;
- persist the newest `latest.sent_at` it has notified about (mirror the
  `wa_since` watermark the WebView keeps in Preferences) so a message is never
  notified twice;
- fire a `LocalNotifications`-style native notification per new inbound.

Keep the cadence modest (30–60s) to protect battery on Indian OEMs.

## 4. Build + device test (on a Mac with Android Studio)
```bash
npm install
npx cap sync android
# then EITHER open mobile/android in Android Studio → Run on a device, OR:
cd mobile/android && ./gradlew assembleDebug   # → app/build/outputs/apk/debug/app-debug.apk
```
(There is no `mobile/www` build step — those are static files served straight into
the WebView.) Bump the version in `mobile/android/app/build.gradle` if you're cutting
a release APK, per the project's release ritual.
Then on the device:
1. Pair the phone to the LAN server as usual.
2. In the **web** Settings (owner), connect WhatsApp and scan the QR with the
   **dedicated business number**.
3. Send a message to that number from another phone → confirm it appears in the
   app's **Chats** tab and (with the app backgrounded) fires a notification.

## Hard limits (document for the team)
- The phone **must be on the office WiFi** (same LAN as the server) for chats and
  notifications to sync — there is no cloud relay.
- WhatsApp here is the **unofficial Web protocol (Baileys)**. Use a dedicated
  business number; a personal number risks a ban.

## Verify gates note
The server + web verify gates (`npm test`, `npm --prefix client run build`, the
boot smoke) **do not** cover `mobile/www` or the Android native build — those are
validated on a device per the steps above.
