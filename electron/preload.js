import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  // No hardcoded version here: it drifted to 0.1.0 while the app shipped 0.2.x.
  // getVersion() below asks the main process for app.getVersion(), which is
  // always the real packaged version.

  // Auto-update channels
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, status) => cb(status)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, progress) => cb(progress)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', () => cb()),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (_e, msg) => cb(msg)),

  checkForUpdates: () => ipcRenderer.send('update:check'),
  downloadUpdate: () => ipcRenderer.send('update:download'),
  installUpdate: () => ipcRenderer.send('update:install'),

  // Pull model, so an update found before the banner mounted is not lost.
  getPendingUpdate: () => ipcRenderer.invoke('update:pending'),

  getVersion: () => ipcRenderer.invoke('app:version'),
  getBackendPort: () => ipcRenderer.invoke('backend:port'),
});
