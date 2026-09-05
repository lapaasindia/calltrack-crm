// Minimal bridge for the setup window only. The main window (remote content)
// has NO preload and no IPC on purpose.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calltrack', {
  choose: (choice) => ipcRenderer.invoke('setup:choose', {
    mode: choice && choice.mode,
    serverUrl: choice && typeof choice.serverUrl === 'string' ? choice.serverUrl.slice(0, 200) : undefined,
    openAtLogin: !!(choice && choice.openAtLogin),
  }),
  restore: () => ipcRenderer.invoke('setup:restore'),
});
