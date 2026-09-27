// CommonJS, and named .cjs deliberately. Electron loads preload scripts as
// CommonJS and does not honour package.json "type": "module" for them, so the
// previous ESM `import` here threw a SyntaxError before contextBridge ever ran.
// window.electronAPI was therefore never defined in the packaged app, and both
// consumers fail soft -- apiConfig uses `?.` and the update banner does
// `if (!a) return` -- so nothing surfaced the breakage while the update banner
// silently never appeared. Keep this file CJS.
const { contextBridge, ipcRenderer } = require('electron');

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

  // Sign-in comes back from the provider as a deep link on the weatherts://
  // protocol, which only the main process can receive. The renderer holds the
  // PKCE verifier, so the URL has to be handed to it to be worth anything.
  onAuthCallback: (cb) => ipcRenderer.on('auth:callback', (_e, url) => cb(url)),

  getVersion: () => ipcRenderer.invoke('app:version'),
  getBackendPort: () => ipcRenderer.invoke('backend:port'),

  // Keep drawing at full pace while hidden, for the length of an animation export.
  keepRendering: (on) => ipcRenderer.send('render:keep', !!on),
});
