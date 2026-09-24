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

  /* ---------------------------------------------- this computer as a host */

  hostStatus: () => ipcRenderer.invoke('hostStatus'),
  setRemoteAccess: patch => ipcRenderer.invoke('setRemoteAccess', patch),
  regenerateAccessCode: () => ipcRenderer.invoke('regenerateAccessCode'),
  checkPermissions: () => ipcRenderer.invoke('checkPermissions'),
  askPermission: id => ipcRenderer.invoke('askPermission', id),
  requestPermissions: () => ipcRenderer.invoke('requestPermissions'),
  openPermissionSettings: action => ipcRenderer.invoke('openPermissionSettings', action),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  resetPermissions: () => ipcRenderer.invoke('resetPermissions'),
  endHostSession: (id, reason) => ipcRenderer.invoke('endHostSession', id, reason),
  knownDevices: () => ipcRenderer.invoke('knownDevices'),
  forgetDevice: deviceId => ipcRenderer.invoke('forgetDevice', deviceId),
  connectChoices: () => ipcRenderer.invoke('connectChoices'),
  rememberConnectMethod: (deviceId, method) => ipcRenderer.invoke('rememberConnectMethod', deviceId, method),
  answerConsent: (id, decision) => ipcRenderer.invoke('answerConsent', id, decision),
  answerKeyChange: (id, accepted) => ipcRenderer.invoke('answerKeyChange', id, accepted),
  onKeyChangeRequest: handler => {
    ipcRenderer.on('keyChangeRequest', (_event, payload) => handler(payload));
  },
  trustedList: () => ipcRenderer.invoke('trustedList'),
  loginItem: () => ipcRenderer.invoke('loginItem'),
  setLoginItem: open => ipcRenderer.invoke('setLoginItem', open),
  trustedRemove: deviceId => ipcRenderer.invoke('trustedRemove', deviceId),
  connectSaved: deviceId => ipcRenderer.invoke('connectSaved', deviceId),
  onHostStatus: handler => {
    ipcRenderer.on('hostStatus', (_event, payload) => handler(payload));
  },
  onConsentRequest: handler => {
    ipcRenderer.on('consentRequest', (_event, payload) => handler(payload));
  },
  onConsentWithdrawn: handler => {
    ipcRenderer.on('consentWithdrawn', (_event, payload) => handler(payload));
  },

  /* ------------------------------------- connecting to another computer */

  connectDevice: request => ipcRenderer.invoke('connectDevice', request),
  disconnectDevice: () => ipcRenderer.invoke('disconnectDevice'),
  sendToHost: (label, message) => ipcRenderer.send('viewerSend', { label, message }),
  viewerClipboardRead: () => ipcRenderer.invoke('viewerClipboardRead'),
  viewerClipboardWrite: text => ipcRenderer.invoke('viewerClipboardWrite', text),
  viewerLog: text => ipcRenderer.send('viewer:log', text),
  onDeviceSession: handler => {
    ipcRenderer.on('deviceSession', (_event, payload) => handler(payload));
  },

  /* ------------------------------------------------------ HopDesk account */

  accountState: () => ipcRenderer.invoke('accountState'),
  accountSignIn: request => ipcRenderer.invoke('accountSignIn', request),
  accountSignOut: () => ipcRenderer.invoke('accountSignOut'),
  accountRefresh: () => ipcRenderer.invoke('accountRefresh'),
  accountRemoveComputer: deviceId => ipcRenderer.invoke('accountRemoveComputer', deviceId),
  connectComputer: deviceId => ipcRenderer.invoke('connectComputer', deviceId),
  onAccountState: handler => {
    ipcRenderer.on('accountState', (_event, payload) => handler(payload));
  },

  /* ------------------------------------------ the WebRTC half of a session */

  onRtcCall: handler => {
    ipcRenderer.on('rtc:call', (_event, payload) => handler(payload));
  },
  rtcReply: reply => ipcRenderer.send('rtc:reply', reply),
  rtcEvent: event => ipcRenderer.send('rtc:event', event),

  /* ------------------------------- used only by the hidden capture window */

  hostReady: () => ipcRenderer.send('host:ready'),
  hostInput: (sessionId, message) => ipcRenderer.send('host:input', { sessionId, message }),
  hostClipboard: (sessionId, message) => ipcRenderer.send('host:clipboard', { sessionId, message }),
  hostDisplay: (sessionId, message) => ipcRenderer.send('host:display', { sessionId, message }),
  hostLog: text => ipcRenderer.send('host:log', text),
  hostCaptured: size => ipcRenderer.send('host:captured', size),
  onHostRecapture: handler => {
    ipcRenderer.on('host:recapture', () => handler());
  },
  onHostSend: handler => {
    ipcRenderer.on('host:send', (_event, payload) => handler(payload));
  },
});
