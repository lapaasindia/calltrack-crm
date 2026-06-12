// Minimal bridge for the setup window only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calltrack', {
  choose: (choice) => ipcRenderer.invoke('setup:choose', choice),
  restore: () => ipcRenderer.invoke('setup:restore'),
});
