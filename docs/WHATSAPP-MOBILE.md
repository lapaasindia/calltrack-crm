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

What is **NOT** done here (no Android SDK / device in this environment) and must
be run on a machine with the Android toolchain:

## 1. Add the local-notifications plugin
```bash
npm --prefix mobile i @capacitor/local-notifications
npx --prefix mobile cap sync android
```
The WebView calls `window.Capacitor.Plugins.LocalNotifications` directly and
guards for its absence, so the JS already ships safely without the plugin — but
no notification fires until the plugin is installed + synced.

Pin a **Capacitor 6-compatible** release (`@capacitor/local-notifications@6`)
so it matches the rest of the `@capacitor/*` packages in `mobile/`; a v7 plugin
will fail `cap sync` against a Capacitor 6 project.

## 2. Android manifest
`@capacitor/local-notifications` needs, on Android 13+:
```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```
The WebView requests the runtime permission on boot via
`Native.requestNotificationPermission()` (which calls
`LocalNotifications.requestPermissions()`), but the manifest entry must exist.

## 2a. Small-icon drawable
`capacitor.config.json` sets the notification `smallIcon` to `ic_stat_calltrack`
(`iconColor` `#1f7a4d`). Android status-bar icons must be a **white-on-transparent**
silhouette. Add a drawable named `ic_stat_calltrack` at
`mobile/android/app/src/main/res/drawable*/ic_stat_calltrack.png` (or a vector).
If the drawable is missing the plugin falls back to the app icon, which renders as
a grey square on some OEMs — so add it before the device test.

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

## 4. Build + device test
```bash
npm --prefix mobile run build        # if the WebView has a build step
npx --prefix mobile cap sync android
# open mobile/android in Android Studio → Run on a device, or:
cd mobile/android && ./gradlew assembleDebug
```
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
