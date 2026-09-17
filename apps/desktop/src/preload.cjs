const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the UI and anything privileged.
 *
 * Each method is listed explicitly. Exposing `ipcRenderer` itself would let any
 * script in the renderer invoke every channel, which defeats the point of
 * context isolation.
 *
 * CommonJS on purpose: this runs in Electron's sandboxed preload environment,
 * which cannot load ES modules.
 */
contextBridge.exposeInMainWorld('hopdesk', {
  isElectron: true,

  list: () => ipcRenderer.invoke('list'),
  add: input => ipcRenderer.invoke('add', input),
  update: (id, patch) => ipcRenderer.invoke('update', id, patch),
  remove: id => ipcRenderer.invoke('remove', id),
  toggleFavorite: id => ipcRenderer.invoke('toggleFavorite', id),
  duplicate: id => ipcRenderer.invoke('duplicate', id),
  discover: () => ipcRenderer.invoke('discover'),
  listMonitors: () => ipcRenderer.invoke('listMonitors'),
  history: id => ipcRenderer.invoke('history', id),

  vaultStatus: () => ipcRenderer.invoke('vaultStatus'),
  unlockVault: passphrase => ipcRenderer.invoke('unlockVault', passphrase),
  lockVault: () => ipcRenderer.invoke('lockVault'),

  connect: (id, request) => ipcRenderer.invoke('connect', id, request),
  trustCertificate: (id, fingerprint, remember) => ipcRenderer.invoke('trustCertificate', id, fingerprint, remember),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  // Fire-and-forget: a mouse move must not wait for a reply.
  input: msg => ipcRenderer.send('input', msg),
  frameRendered: () => ipcRenderer.send('frameRendered'),

  getSettings: () => ipcRenderer.invoke('getSettings'),
  updateSettings: patch => ipcRenderer.invoke('updateSettings', patch),
  openLogFolder: () => ipcRenderer.invoke('openLogFolder'),

  onSession: handler => {
    // The handler receives only the payload; the IPC event object is not
    // forwarded, since it exposes the sender and its frames.
    ipcRenderer.on('session', (_event, payload) => handler(payload));
  },
  onFrame: handler => {
    ipcRenderer.on('frame', (_event, payload) => handler(payload));
  },
  onNotice: handler => {
    ipcRenderer.on('notice', (_event, payload) => handler(payload));
  },
});
