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
      permissions: { callLog: false, storage: false, notifications: false },
      lastSyncMs: 0, pendingUploads: 0, batteryOptimized: true, androidId: 'browser-mock',
    };
  },
  async requestAppPermissions() { return { granted: false }; },
  async openAllFilesAccess() {},
  async openBatterySettings() {},
  async openAutostartSettings() {},
  async startBackgroundService() { return { started: false }; },
  async stopBackgroundService() { return { started: false }; },
  async pickRecordingsFolder() { return { picked: false }; },
  async requestMediaAudio() { return { granted: false }; },
  async configure() {},
  async syncNow() { return { calls: 0, recordings: 0, errors: ['Not on a real device'] }; },
  async checkForUpdate() { return { updateAvailable: false }; },
  async installUpdate() {},
  async clearConfig() {},
};

const P = Plugin || mock;

export const Native = {
  isNative,
  getState: () => P.getState(),
  requestPermissions: () => (P.requestAppPermissions || P.requestPermissions).call(P),
  openAllFilesAccess: () => P.openAllFilesAccess(),
  openBatterySettings: () => P.openBatterySettings(),
  openAutostartSettings: () => P.openAutostartSettings(),
  startBackgroundService: () => P.startBackgroundService(),
  stopBackgroundService: () => P.stopBackgroundService(),
  pickRecordingsFolder: () => P.pickRecordingsFolder(),
  requestMediaAudio: () => P.requestMediaAudio(),
  // Hand the native side the server URL + bearer token so its WorkManager
  // jobs can sync in the background without the WebView being open.
  configure: (cfg) => P.configure(cfg),
  syncNow: () => P.syncNow(),
  checkForUpdate: () => P.checkForUpdate(),
  installUpdate: (url) => P.installUpdate({ url }),
  clearConfig: () => P.clearConfig(),

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
