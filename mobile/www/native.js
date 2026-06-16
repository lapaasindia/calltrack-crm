// Bridge to the native CallSync Capacitor plugin. In a browser (dev preview)
// the plugin is absent, so every method falls back to a harmless mock — the
// UI stays fully clickable for development.
const Cap = window.Capacitor;
const Plugin = Cap?.Plugins?.CallSync;
export const isNative = !!Plugin;

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
};
