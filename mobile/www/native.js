// Bridge to the native CallSync Capacitor plugin. In a browser (dev preview)
// the plugin is absent, so every method falls back to a harmless mock — the
// UI stays fully clickable for development.
const Cap = window.Capacitor;
const Plugin = Cap?.Plugins?.CallSync;
export const isNative = !!Plugin;

// @capacitor/local-notifications — optional. Absent in the browser preview and
// in any build where the plugin hasn't been `npm i`'d + `cap sync`'d yet (see
// docs/WHATSAPP-MOBILE.md). Every call below no-ops gracefully without it, the
// same way the CallSync mock keeps the UI clickable in dev.
const LocalNotifications = Cap?.Plugins?.LocalNotifications;

const mock = {
  async getState() {
    return {
      permissions: { callLog: false, mediaAudio: false, notifications: false },
      paired: false, token: null, serverUrl: null,
      lastSyncMs: 0, lastSuccessMs: 0, lastError: null, pendingUploads: 0,
      safFolderPicked: false, recordingsFolder: null,
      batteryOptimized: true, serviceEnabled: false,
      androidId: 'browser-mock', deviceModel: 'Browser preview', manufacturer: 'browser',
      defaultDialer: null, oemDialer: false, hasAutostartScreen: false,
      appVersion: 'dev', versionCode: 0, tokenStorage: 'none', disconnectedReason: null,
    };
  },
  async requestAppPermissions() { return { granted: false }; },
  async openBatterySettings() { return { opened: false }; },
  async openAutostartSettings() { return { opened: false, oem: false }; },
  async openDialerSettings() { return { opened: false }; },
  async startBackgroundService() { return { started: false }; },
  async stopBackgroundService() { return { started: false }; },
  async pickRecordingsFolder() { return { picked: false }; },
  async requestMediaAudio() { return { granted: false }; },
  async configure() { return { ok: true }; },
  async syncNow() { return { calls: 0, recordings: 0, errors: ['Not on a real device'] }; },
  async checkForUpdate() { return { updateAvailable: false, error: 'Not on a real device' }; },
  async installUpdate() { return { opened: false }; },
  async clearConfig() { return { ok: true }; },
};

const P = Plugin || mock;

export const Native = {
  isNative,
  getState: () => P.getState(),
  requestPermissions: () => (P.requestAppPermissions || P.requestPermissions).call(P),
  openBatterySettings: () => P.openBatterySettings(),
  openAutostartSettings: () => P.openAutostartSettings(),
  openDialerSettings: () => P.openDialerSettings(),
  startBackgroundService: () => P.startBackgroundService(),
  stopBackgroundService: () => P.stopBackgroundService(),
  pickRecordingsFolder: () => P.pickRecordingsFolder(),
  requestMediaAudio: () => P.requestMediaAudio(),
  // Hand the native side the server URL + bearer token so its WorkManager
  // jobs can sync in the background without the WebView being open. The token
  // is kept natively (Keystore-backed) — JS only ever holds it in memory.
  configure: (cfg) => P.configure(cfg),
  syncNow: () => P.syncNow(),
  checkForUpdate: () => P.checkForUpdate(),
  installUpdate: (url) => P.installUpdate({ url }),
  clearConfig: () => P.clearConfig(),
  // Fires when the Android activity resumes (back from a system dialog /
  // settings screen / the SAF picker). Translucent system screens never
  // trigger visibilitychange, so this is what refreshes the setup checklist.
  onResume(cb) {
    if (!Plugin) return null;
    try { return Plugin.addListener('appResumed', cb); } catch { return null; }
  },

  // ---- Local notifications (optional; for WhatsApp inbound alerts) ----
  // True only when the plugin is actually present on this build.
  hasNotifications: !!LocalNotifications,

  // Ask once on boot. Returns true if we may post notifications. On Android 13+
  // this surfaces the POST_NOTIFICATIONS runtime prompt. Never throws.
  async requestNotificationPermission() {
    if (!LocalNotifications) return false;
    try {
      const r = await LocalNotifications.requestPermissions();
      return r?.display === 'granted';
    } catch { return false; }
  },

  // Schedule (immediately fire) a single local notification. `id` should be a
  // stable 32-bit int so repeats replace rather than stack. No-ops — and never
  // throws — when the plugin or permission is absent, mirroring how the other
  // optional native calls degrade in the browser preview.
  async notify({ id, title, body }) {
    if (!LocalNotifications) return false;
    try {
      await LocalNotifications.schedule({
        notifications: [{
          id: ((id | 0) || (Date.now() % 2147483647)),
          title: title || 'CallTrack',
          body: body || '',
          smallIcon: 'ic_stat_calltrack',
        }],
      });
      return true;
    } catch { return false; }
  },
};
