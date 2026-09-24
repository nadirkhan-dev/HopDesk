import {
  app, BrowserWindow, ipcMain, shell, Menu, clipboard, screen, desktopCapturer,
  session as electronSession,
  systemPreferences,
  type IpcMainInvokeEvent, type IpcMainEvent,
} from 'electron';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ConnectionManager, CredentialStore, SettingsStore, Session, ExternalEngine,
  rdpAvailable, spiceAvailable, probeRdpCertificate, decideRdpCertificate, normalizeFingerprint,
  detectFreeRdpCapabilities, listFreeRdpMonitors, browseLan,
  type Backend, type Connection, type FriendlyError, type RdpCertificate, type SessionStats,
} from '@hopdesk/core';
import { createLogger } from './logger.js';
import { isTrustedFrom, isTrustedSender } from './ipc-guard.js';
import { loadIdentity, identityStorage, type LocalIdentity } from './identity.js';
import { KnownDevices } from './devices.js';
import { RtcBridge, type RtcPeerHandle } from './rtc-bridge.js';
import { AccountClient } from './account.js';
import { HostRole } from './host.js';
import { KeyAccepted, ViewerRole } from './viewer.js';
import { openInputController, linuxBackend, type InputController } from '@hopdesk/platform';
import {
  clearStaleMacPermissions, createPermissionManager, openPermissionSettings, resetMacPermissions,
  type PermissionReport,
} from './permissions.js';
import { fingerprint, TrustedDevices } from './trusted.js';
import { PortalToken } from './portal-token.js';
import {
  capturedTheWrongScreen, screenChoices, sharedDisplay, sourceForDisplay,
} from './screens.js';
import { BackgroundMode, openAtLogin, setOpenAtLogin } from './background.js';
import { viewerNotices } from './permission-report.js';
import {
  MAX_CLIPBOARD_CHARS, type ConsentDecision, type ConsentRequest,
} from '@hopdesk/protocol';
import { fromBase64 } from '@hopdesk/crypto';

/**
 * Main process.
 *
 * Holds everything privileged: the filesystem, the credential store, sockets
 * and child processes. The renderer gets a narrow, explicit IPC surface and
 * nothing else — `nodeIntegration` is off, `contextIsolation` and `sandbox`
 * on, so a cross-site script in the UI cannot reach any of it.
 *
 * The path of a connection is: renderer → preload bridge → the IPC handlers
 * below → ConnectionManager/CredentialStore → Session (VNC, in-process) or
 * ExternalEngine (RDP/SPICE, FreeRDP or Virt Viewer).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(__dirname, '../renderer/index.html');
const UI_URL = pathToFileURL(UI_FILE).href;
/* The hidden window that captures this screen and holds the host's peer
   connection. It has no interface; see renderer/host-rtc.js. */
const HOST_FILE = path.join(__dirname, '../renderer/host-rtc.html');
const HOST_URL = pathToFileURL(HOST_FILE).href;

// Every renderer is sandboxed, including any created later by mistake.
app.enableSandbox();

/* Chromium's display backend is chosen before this script runs, so it cannot be
   set here: see apps/desktop/scripts/launch-args.mjs, which every launcher
   (dev, packaged, tests) uses to pass --ozone-platform. */

// XDG paths, so the app behaves like a native Linux application rather than
// scattering dotfiles in $HOME.
const dataDir = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'hopdesk')
  : path.join(app.getPath('home'), '.local', 'share', 'hopdesk');

const log = createLogger(dataDir);
log.info(`session type: ${process.env.XDG_SESSION_TYPE ?? 'unknown'}, DISPLAY=${process.env.DISPLAY ?? 'none'}`);

/* HOPDESK_CREDENTIAL_BACKEND=file forces the encrypted vault, for machines whose
   keyring misbehaves and for tests that must not touch the user's keyring. */
const forcedBackend = ((): Backend | undefined => {
  const v = process.env.HOPDESK_CREDENTIAL_BACKEND;
  return v === 'file' || v === 'keyring' ? v : undefined;
})();

let window: BrowserWindow | null = null;
let hostWindow: BrowserWindow | null = null;
const credentials = new CredentialStore(dataDir, forcedBackend);
const connections = new ConnectionManager(dataDir, credentials);
const settings = new SettingsStore(dataDir);
const knownDevices = new KnownDevices(dataDir);
/** The computers this one lets in without asking; public keys only. */
const trustedDevices = new TrustedDevices(dataDir);
/** The Wayland desktop's "again without asking" token, if it ever gave one. */
const portalToken = new PortalToken(dataDir);

/** Set once the device identity has been loaded, at startup. */
let localIdentity: LocalIdentity | null = null;
let host: HostRole | null = null;
let viewer: ViewerRole | null = null;
let account: AccountClient | null = null;

/** Certificates trusted "for this session only", by connection id. Never persisted. */
const sessionTrust = new Map<string, string>();

interface ActiveSession {
  connection: Connection;
  session: Session | null;
  engine: ExternalEngine | null;
  /** The history entry, open until the session ends. */
  historyId: string;
  warnings: string[];
  /** Fingerprint FreeRDP was told to accept, to diagnose a later TLS failure. */
  pinnedFingerprint: string | null;
}
let active: ActiveSession | null = null;

let background: BackgroundMode | null = null;

/** Brings the window back, creating it again if it was closed. */
function showWindow() {
  if (!window || window.isDestroyed()) { createWindow(); return; }
  if (!window.isVisible()) window.show();
  window.focus();
}

function createWindow() {
  // Never larger than the screen it opens on.
  const work = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    width: Math.min(1180, work.width), height: Math.min(780, work.height),
    minWidth: Math.min(760, work.width), minHeight: Math.min(520, work.height),
    title: 'HopDesk',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only needs `require('electron')`, which sandboxed preloads provide.
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.loadFile(UI_FILE);
  /* Closing the window does not stop this computer being reachable: it hides,
     and the menu bar item stays. Quitting from there ends every session. */
  window.on('close', event => {
    if (!background?.shouldHideOnClose()) return;
    event.preventDefault();
    window?.hide();
  });
  window.on('closed', () => { window = null; });
  Menu.setApplicationMenu(applicationMenu());
}

/**
 * The menu bar.
 *
 * Linux and Windows have none: everything is in the window. macOS is not
 * optional, though - an app with no application menu has no Quit item and no
 * ⌘Q, which left force quit as the only way to stop HopDesk. ⌘C and ⌘V are
 * here for the same reason: without an Edit menu macOS does not deliver them,
 * and a Device ID that cannot be pasted is not much use.
 */
function applicationMenu(): Menu | null {
  if (process.platform !== 'darwin') return null;
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        /* Not `role: 'quit'`: quitting has to be announced first, so closing
           the window stops hiding it and every session is ended properly. */
        {
          label: `Quit ${app.name}`, accelerator: 'Command+Q',
          click: () => { background?.beginQuit(); app.quit(); },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }, { role: 'togglefullscreen' }] },
  ]);
}

/* ------------------------------------------------- this computer as a host */

/**
 * The hidden window that captures this screen. Created when the first viewer is
 * authorised and closed when the last session ends, so nothing is capturing
 * while nobody is connected.
 */
async function ensureHostWindow(): Promise<BrowserWindow> {
  if (hostWindow && !hostWindow.isDestroyed()) return hostWindow;
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // A hidden window would otherwise be throttled, which would stall capture.
      backgroundThrottling: false,
    },
  });
  hostWindow = win;
  win.on('closed', () => { if (hostWindow === win) hostWindow = null; });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The screen sharing window did not start')), 15_000);
    ipcMain.once('host:ready', event => {
      if (event.sender !== win.webContents) return;
      clearTimeout(timer);
      resolve();
    });
  });
  await win.loadFile(HOST_FILE);
  await ready;
  return win;
}

/**
 * The screen being shared. On a computer with one, that is the only one there
 * is; on a laptop with an external monitor it is whichever was chosen, because
 * the windows on the other monitor are not in the picture at all.
 */
function displayShared() {
  return sharedDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id,
    settings.get().remoteAccess.screen);
}

/** Tells the capture window to let go of this screen and take the other one. */
function recapture() {
  if (hostWindow && !hostWindow.isDestroyed()) hostWindow.webContents.send('host:recapture');
}

function closeHostWindowIfIdle() {
  if (!host || host.status().sessions.length) return;
  const win = hostWindow;
  hostWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

/** Renderers of this app that may speak to the main process. */
const ownWindows = () => [
  { contents: window && !window.isDestroyed() ? window.webContents : null, url: UI_URL },
  { contents: hostWindow && !hostWindow.isDestroyed() ? hostWindow.webContents : null, url: HOST_URL },
];

const rtc = new RtcBridge(log, event => isTrustedFrom(event, ownWindows()));

/**
 * Input injection for the Host. X11 through XTest; created on first use and
 * kept, since opening a display connection per keystroke would be absurd.
 * A session where this is unavailable is view-only rather than broken.
 */
let inputController: InputController | null = null;
let inputUnavailable: string | null = null;

/**
 * The controller for a session.
 *
 * If none has been opened yet — the app started with remote access already on,
 * or a Wayland dialog is still to be answered — this starts opening one and
 * returns null for now, so the first input message is dropped rather than the
 * session waiting on a dialog. The next one works.
 */
function hostInput(): InputController | null {
  if (!inputController && !inputUnavailable && !preparingInput) void prepareInput();
  /* On macOS, events posted without Accessibility are dropped by the system
     with no error, so injecting them would count as success while nothing
     moved. Refuse instead, and say why. */
  if (inputController && macAccessibilityOff()) return null;
  return inputController;
}

/** Why this computer cannot take a viewer's mouse and keyboard right now, or null. */
function inputProblem(): string | null {
  if (macAccessibilityOff()) {
    return 'macOS Accessibility is off for HopDesk (System Settings → Privacy & Security → Accessibility)';
  }
  return inputUnavailable ?? (preparingInput ? 'input is still being set up' : null);
}

/* Asked at most once a second: it is checked for every input message. */
let accessibilityChecked = 0;
let accessibilityOff = false;
function macAccessibilityOff(): boolean {
  if (process.platform !== 'darwin') return false;
  const now = Date.now();
  if (now - accessibilityChecked > 1000) {
    accessibilityChecked = now;
    const off = !systemPreferences.isTrustedAccessibilityClient(false);
    if (off !== accessibilityOff) {
      accessibilityOff = off;
      // Turned on or off in System Settings while HopDesk runs: refresh what is shown and sent.
      void refreshPermissions(false).then(() => permissionsChanged());
    }
  }
  return accessibilityOff;
}

let preparingInput: Promise<string | null> | null = null;

/**
 * Opens the way in for the mouse and keyboard.
 *
 * X11 and macOS can do this at any moment. Wayland cannot: the compositor shows
 * its own dialog, so this happens when the user switches remote access on —
 * they are at the keyboard then, which is exactly when a permission dialog
 * makes sense. If they refuse, sharing still works; it is just view-only, and
 * the interface says so rather than pretending the keyboard is broken.
 */
function prepareInput(): Promise<string | null> {
  if (inputController) return Promise.resolve(null);
  preparingInput ??= (async () => {
    try {
      /* On Wayland, the token from the last time someone answered the
         desktop's dialog. With it the compositor allows the session without
         asking; without it, it asks - every session, including the ones
         nobody is sitting at. */
      const restoreToken = portalToken.get();
      inputController = await openInputController({
        ...(restoreToken ? { restoreToken } : {}),
        onRestoreToken: token => {
          portalToken.set(token);
          log.info('the desktop gave HopDesk permission to control it again without asking');
        },
      });
      inputUnavailable = null;
      log.info(`input ready (${process.platform === 'linux' ? linuxBackend() : process.platform}`
        + `${restoreToken ? ', without asking' : ''})`);
      return null;
    } catch (err) {
      inputUnavailable = (err as Error).message;
      /* A token the compositor will not take - revoked, or from a session it
         has forgotten - makes it ask afresh. Keeping it would mean offering
         something refused, forever. */
      if (portalToken.get() && /token|denied|cancel/i.test(inputUnavailable)) {
        portalToken.clear();
        log.warn('the desktop refused the saved permission; it will ask again next time');
      }
      log.warn(`input injection unavailable: ${inputUnavailable}`);
      return inputUnavailable;
    } finally {
      preparingInput = null;
    }
  })();
  return preparingInput;
}

/**
 * What the operating system currently allows. Checked when remote access is
 * switched on and shown in the interface, because on macOS a refused permission
 * makes capture and input fail silently rather than loudly.
 */
const permissions = createPermissionManager();
let permissionReport: PermissionReport | null = null;

/**
 * What this computer can actually share.
 *
 * On a Wayland desktop HopDesk runs through Xwayland, because Electron's
 * Wayland backend crashes when it creates a window (reproduced on Electron 38,
 * 42 and 44 here, while Chrome on the same machine is fine). Through Xwayland,
 * the mouse and keyboard still reach the real desktop — those go through the
 * portal, which is Wayland's own mechanism — but the *picture* is only of X11
 * windows. Sharing a screen that shows almost nothing, without saying so, would
 * be the worst of both.
 */
function waylandLimitation(): string | null {
  if (process.platform !== 'linux') return null;
  const onWayland = process.env.HOPDESK_DESKTOP_SESSION === 'wayland'
    || process.env.XDG_SESSION_TYPE === 'wayland';
  if (!onWayland) return null;
  if (process.env.HOPDESK_OZONE_PLATFORM === 'wayland') return null;    // running natively
  return 'This is a Wayland desktop, and HopDesk is running through Xwayland: someone connecting '
    + 'can control the mouse and keyboard, but will only see windows that use X11. '
    + 'Sharing the whole Wayland desktop needs HOPDESK_OZONE_PLATFORM=wayland, which crashes on '
    + 'this machine (an Electron bug, see docs/ARCHITECTURE.md). Log in to an X11 session to share this screen.';
}

async function refreshPermissions(request = false): Promise<PermissionReport> {
  const before = JSON.stringify(permissionReport?.items.map(i => [i.id, i.state]) ?? null);
  const report = request ? await permissions.request() : await permissions.check();
  permissionReport = report;
  const after = JSON.stringify(report.items.map(i => [i.id, i.state]));
  if (before !== after && report.items.length) {
    log.info(`permissions: ${report.items.map(i => `${i.name} ${i.granted ? 'allowed' : 'not allowed'}`).join(', ')}`);
    if (report.detail) log.warn(`permissions: ${report.detail}`);
  }
  return report;
}

/** Tells the window, and anyone connected, that what this computer can share has changed. */
function permissionsChanged() {
  if (host) send('hostStatus', hostStatusPayload());
  host?.refreshNotices();
}

/** What a viewer should be told about this computer before they wonder why. */
function notices(): string[] {
  const wayland = waylandLimitation()
    ? 'The other computer is on a Wayland desktop, which HopDesk cannot fully capture yet: you may see only some of its windows.'
    : null;
  return viewerNotices(permissionReport, inputProblem(), [wayland]);
}

/**
 * Whether sessions must go through the relay. Off by default: a direct
 * connection is faster and costs the server nothing.
 */
const icePolicy = (): 'all' | 'relay' =>
  (settings.get().account.forceRelay ? 'relay' : 'all');

/** Pending Allow/Reject questions, by id. */
const consentRequests = new Map<string, (decision: ConsentDecision) => void>();

/**
 * Asks the person at this computer. With no window to ask in, the answer is no:
 * a connection must never be allowed by default.
 */
function askConsent(request: ConsentRequest, signal: AbortSignal): Promise<ConsentDecision> {
  if (!window || window.isDestroyed()) return Promise.resolve('reject');
  const id = randomUUID();
  return new Promise<ConsentDecision>(resolve => {
    let done = false;
    const settle = (decision: ConsentDecision) => {
      if (done) return;
      done = true;
      consentRequests.delete(id);
      send('consentWithdrawn', { id });
      resolve(decision);
    };
    consentRequests.set(id, settle);
    signal.addEventListener('abort', () => settle('reject'));
    send('consentRequest', { id, viewerId: request.viewerId, viewerName: request.viewerName, auth: request.auth });
    if (window && !window.isDestroyed()) {
      // The person needs to see the question, wherever the window was.
      window.show();
      window.focus();
    }
  });
}

/**
 * Asks whether a computer's new identity key should be accepted.
 *
 * Both fingerprints go to the window, because the only person who can tell a
 * reinstalled computer from a substituted one is the one who knows whether it
 * was reinstalled. No window, no question: refuse.
 */
const keyChangeRequests = new Map<string, (accepted: boolean) => void>();
function askAboutNewKey(info: {
  deviceId: string; hostName?: string; oldKey: Uint8Array; newKey: Uint8Array;
}): Promise<boolean> {
  if (!window || window.isDestroyed()) return Promise.resolve(false);
  const id = randomUUID();
  log.warn(`identity key changed for ${info.deviceId}: was ${fingerprint(info.oldKey)}, now ${fingerprint(info.newKey)}`);
  return new Promise<boolean>(resolve => {
    let done = false;
    const settle = (accepted: boolean) => {
      if (done) return;
      done = true;
      keyChangeRequests.delete(id);
      log.info(`identity key for ${info.deviceId} ${accepted ? 'accepted by the user' : 'refused'}`);
      resolve(accepted);
    };
    keyChangeRequests.set(id, settle);
    send('keyChangeRequest', {
      id,
      deviceId: info.deviceId,
      hostName: info.hostName,
      oldFingerprint: fingerprint(info.oldKey),
      newFingerprint: fingerprint(info.newKey),
    });
    window?.show();
    window?.focus();
  });
}

const send = (channel: string, payload: unknown) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
};

/* Nothing the UI loads may open windows, navigate away, embed webviews or ask
   for camera, microphone, notifications or any other permission. */
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', e => e.preventDefault());
  contents.on('will-redirect', e => e.preventDefault());
  contents.on('will-attach-webview', e => e.preventDefault());
});

/** Creates the Host and Viewer roles once the device identity is known. */
function createRoles(identity: LocalIdentity) {
  const hostRole = new HostRole({
    identity,
    hostName: hostname(),
    log,
    settings: () => settings.get().remoteAccess,
    consent: askConsent,
    createPeer: async (sessionId, iceServers) => {
      const win = await ensureHostWindow();
      const peer = rtc.attach(sessionId, win.webContents, iceServers, icePolicy());
      return { peer, close: () => closeHostWindowIfIdle() };
    },
    trusted: () => trustedDevices,
    input: hostInput,
    inputProblem,
    notices,
    // Only a signed-in computer can authorise an account connection.
    accountAuthorised: (viewerId, viewerKey) => account?.authorises(viewerId, viewerKey) ?? false,
    iceServers: () => account?.iceServers() ?? Promise.resolve([]),
    clipboard: {
      read: () => clipboard.readText(),
      write: text => clipboard.writeText(text),
    },
    /**
     * Where the shared screen is, in the coordinates input is injected in.
     *
     * The viewer sends a fraction of the screen it can see, which is one
     * display. On a computer with two, that display may not start at 0,0 —
     * spreading those fractions across the whole desktop put the pointer on
     * the *other* monitor, which is what happened here with a laptop screen
     * to the right of an external one.
     *
     * X11 injects in pixels across the whole X screen; macOS injects in points
     * in the same global space Electron reports bounds in.
     */
    displayBounds: () => {
      const display = displayShared();
      const perPixel = process.platform === 'darwin' ? 1 : display.scaleFactor;
      return {
        x: Math.round(display.bounds.x * perPixel),
        y: Math.round(display.bounds.y * perPixel),
        width: Math.round(display.size.width * perPixel),
        height: Math.round(display.size.height * perPixel),
      };
    },
    shareClipboard: () => settings.get().defaults.shareClipboard !== false,
  });
  // The whole status, permissions included: a partial one would blank them in the window.
  hostRole.on('change', () => {
    send('hostStatus', hostStatusPayload());
    background?.refresh();
  });
  hostRole.on('clipboard', (sessionId: string, message: unknown) => {
    rtc.post(sessionId, 'host:send', { sessionId, label: 'clipboard', message });
  });
  hostRole.on('notice', (sessionId: string, message: unknown) => {
    rtc.post(sessionId, 'host:send', { sessionId, label: 'display', message });
  });

  const viewerRole = new ViewerRole({
    identity,
    viewerName: hostname(),
    log,
    createPeer: async (sessionId, iceServers) => {
      if (!window || window.isDestroyed()) throw new Error('The HopDesk window is closed');
      const peer: RtcPeerHandle = rtc.attach(sessionId, window.webContents, iceServers, icePolicy());
      return { peer, close: () => {} };
    },
    iceServers: () => account?.iceServers() ?? Promise.resolve([]),
    connectionKind: sessionId => rtc.connectionKind(sessionId),
    pinnedKey: deviceId => knownDevices.keyFor(deviceId),
    keyChanged: info => askAboutNewKey(info),
    acceptNewKey: (deviceId, key) => knownDevices.acceptNewKey(deviceId, key),
    rememberKey: (deviceId, key, name, where) => knownDevices.remember(deviceId, key, name || deviceId, where),
    lastAddress: deviceId => {
      const device = knownDevices.list().find(d => d.deviceId === deviceId);
      return device?.lastAddress ? { address: device.lastAddress, ...(device.lastPort ? { port: device.lastPort } : {}) } : undefined;
    },
  });
  viewerRole.on('status', (status: unknown) => send('deviceSession', status));

  /* Signing in to a HopDesk server: it makes this computer reachable from
     anywhere and lists the account's other computers. A session the server
     relays goes through exactly the same Host path as one from this network. */
  const accountClient = new AccountClient({
    identity,
    deviceName: hostname(),
    storage: identityStorage(dataDir),
    log,
    onIncoming: (intro, link) => {
      if (!settings.get().remoteAccess.enabled) {
        // Not accepting connections: refuse rather than silently ignoring.
        link.close(new Error('remote access is off on this computer'));
        return;
      }
      /* The account's device list is checked against the key the caller signs
         with, so it has to be current: a computer that enrolled after this one
         last looked would otherwise be refused on its first connection. */
      void accountClient.refreshComputers()
        .catch(err => log.warn(`could not refresh the computer list: ${(err as Error).message}`))
        .then(() => hostRole.acceptLink(link,
          `${intro.peer.name} (${intro.peer.deviceId}) via the HopDesk server`,
          `relay:${intro.peer.deviceId}`));
    },
    readSettings: () => settings.get().account,
    writeSettings: async patch => { await settings.update({ account: patch }); },
  });
  accountClient.on('change', state => send('accountState', state));

  return { hostRole, viewerRole, accountClient };
}

app.whenReady().then(async () => {
  /* The UI may not use the camera, microphone, notifications or anything else.
     The one exception is the hidden capture window, which exists to share this
     screen — and only while the user has turned remote access on. */
  /* Chromium asks for screen sharing as 'media' with a video media type, and in
     some paths as 'display-capture'. Both are allowed for the hidden capture
     window and for nothing else — and never for audio, which HopDesk does not
     capture. */
  const allowCapture = (contents: Electron.WebContents | null, permission: string, mediaType?: string) =>
    (permission === 'display-capture' || permission === 'media')
    && mediaType !== 'audio'
    && contents !== null
    && hostWindow !== null && !hostWindow.isDestroyed() && contents === hostWindow.webContents
    && settings.get().remoteAccess.enabled;
  /* A session shown full screen, with every key going to the other computer,
     needs three permissions of its own — and only for HopDesk's own window.
     Chromium leaves a denied requestFullscreen() promise pending forever, so
     refusing these looked exactly like a button that does nothing. */
  const SESSION_PERMISSIONS = ['fullscreen', 'keyboardLock', 'pointerLock'];
  const allowForUi = (contents: Electron.WebContents | null, permission: string) =>
    SESSION_PERMISSIONS.includes(permission)
    && contents !== null
    && window !== null && !window.isDestroyed() && contents === window.webContents;

  electronSession.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] } | undefined)?.mediaTypes;
    callback(allowForUi(wc, permission)
      || allowCapture(wc, permission, mediaTypes?.includes('audio') ? 'audio' : undefined));
  });
  electronSession.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) =>
    allowForUi(wc, permission)
    || allowCapture(wc, permission, (details as { mediaType?: string } | undefined)?.mediaType));

  /* getDisplayMedia asks the application which screen to share: the Host shares
     the primary display. Answering it here means no picker appears on a machine
     that is being connected to, which is the point of a trusted device — the
     consent prompt was answered once, when it was paired. */
  electronSession.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const fromHostWindow = hostWindow !== null && !hostWindow.isDestroyed()
      && request.frame?.url === HOST_URL;
    log.info(`display media request from ${request.frame?.url ?? 'unknown'} (expected ${HOST_URL})`);
    if (!fromHostWindow || !settings.get().remoteAccess.enabled) {
      callback({});
      return;
    }
    /* The callback may be called once. Refusing with {} throws when video was
       requested, and that throw used to reach the catch below, which called it
       a second time — an unhandled rejection, and a viewer told only "Invalid
       capture constraints". */
    let answered = false;
    const answer = (streams: Parameters<typeof callback>[0]) => {
      if (answered) return;
      answered = true;
      try { callback(streams); } catch { /* a refusal: getDisplayMedia rejects in the capture window */ }
    };
    void desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false }).then(sources => {
      const display = displayShared();
      const chosen = sourceForDisplay(sources, screen.getAllDisplays(), display);
      log.info(`screen sources: ${sources.map(s => `${s.name}/${s.display_id}`).join(', ') || 'none'}`);
      log.info(`sharing ${chosen?.name ?? 'nothing'} (${display.size.width}x${display.size.height} at `
        + `${display.bounds.x},${display.bounds.y})`);
      if (!chosen) log.error('no screen to share: the system reported no screens HopDesk can capture');
      answer(chosen ? { video: chosen } : {});
    }).catch(err => {
      log.error(`screen capture unavailable: ${(err as Error).message}`);
      answer({});
    });
  }, { useSystemPicker: false });

  try {
    await connections.load();
  } catch (err) {
    // A corrupt file is recoverable; report it rather than refusing to start.
    log.error(`connections: ${(err as Error).message}`);
  }
  await settings.load();
  await knownDevices.load();
  await trustedDevices.load();

  try {
    localIdentity = await loadIdentity(dataDir);
    const roles = createRoles(localIdentity);
    host = roles.hostRole;
    viewer = roles.viewerRole;
    account = roles.accountClient;
    log.info(`device id ${localIdentity.deviceId}; identity key ${localIdentity.protectionDetail}`);
  } catch (err) {
    // Without an identity this computer cannot be a HopDesk host or viewer, but
    // VNC and RDP still work, so the app starts and says what is missing.
    log.error(`device identity unavailable: ${(err as Error).message}`);
  }

  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
    else showWindow();
  });

  /* The menu bar item, and staying alive without a window. macOS only: on
     Linux the app is started when it is wanted, and a tray icon there would be
     a second way to lose track of what is running. */
  /* A tray icon wherever the desktop has one: it is how a computer that is
     reachable says so, and how it is quit for real. */
  if (process.platform === 'darwin' || process.platform === 'linux') {
    background = new BackgroundMode({
      show: showWindow,
      status: () => (host ? host.status() : hostUnavailable()),
      setRemoteAccess: async enabled => {
        if (!host) return;
        await settings.update({ remoteAccess: { enabled } });
        if (enabled) await host.start(); else await host.stop();
        send('hostStatus', hostStatusPayload());
        background?.refresh();
      },
      endSession: id => { host?.endSession(id, 'user-disconnected'); },
      quit: () => app.quit(),
      log: line => log.info(line),
      /* Waking from sleep: the network may have changed underneath a listener
         that still thinks it is bound. Starting an already-started host is a
         no-op, so this only repairs the case where it stopped. */
      onWake: () => {
        if (!host || !settings.get().remoteAccess.enabled) return;
        void host.start().catch(err => log.warn(`could not resume remote access after waking: ${(err as Error).message}`));
      },
    });
    background.start();
  }

  /* On a Mac, what the system allows is shown from the start — not only after
     remote access is switched on — and checked again whenever HopDesk comes
     back to the front, which is what happens after a trip to System Settings. */
  if (process.platform === 'darwin') {
    const report = await refreshPermissions(false);
    /* A permission that reads as missing may be one an earlier build was given:
       macOS ties it to a signature, and an ad hoc signed build gets a new one
       each release. Clearing it is what makes macOS ask again. */
    if (await clearStaleMacPermissions(dataDir, app.getVersion(), report.items.some(i => !i.granted))) {
      log.info('cleared permissions granted to an earlier build, so macOS asks again for this one');
      await refreshPermissions(false);
    }
    permissionsChanged();
    app.on('browser-window-focus', () => { void refreshPermissions(false).then(permissionsChanged); });
  }

  if (host && settings.get().remoteAccess.enabled) {
    try {
      await host.start();
      /* Remote access was already on when the app started. Open the way in for
         the mouse and keyboard now — except on Wayland, where doing so shows
         the compositor's dialog, and putting that in front of someone who has
         just logged in would be rude. There it waits for a session. */
      if (process.platform !== 'linux' || linuxBackend() !== 'wayland') await prepareInput();
    } catch (err) {
      log.error(`remote access could not start: ${(err as Error).message}`);
    }
  }

  // Reconnect to the HopDesk server, if this computer was signed in.
  if (account) await account.restore();
});

/* Leaving a session running with no window is a way to lose control of a
   remote machine without noticing. Every way out ends it: closing the window,
   quitting, and being terminated (logout, `kill`, Ctrl+C in a terminal). */
let shutdownDone: Promise<void> | null = null;
let shutdownFinished = false;
function shutdown(): Promise<void> {
  shutdownDone ??= (async () => {
    stopActive();
    // A session where someone is watching this screen must not outlive the app.
    viewer?.disconnect();
    account?.close();
    await host?.stop();
    // Closing the controller also hands back the Wayland portal session.
    background?.stop();
    inputController?.close();
    inputController = null;
    credentials.lock();
    await knownDevices.flush();
    // Let the session's end reach the history file before the process exits.
    await Promise.race([connections.flush(), new Promise(r => setTimeout(r, 2000))]);
    shutdownFinished = true;
  })();
  return shutdownDone;
}

app.on('window-all-closed', () => {
  // On a Mac the app lives on in the menu bar; everywhere else this is the end.
  if (background?.shouldHideOnClose()) return;
  void shutdown().then(() => app.quit());
});
// Quitting is held back until the shutdown has finished, however it started
// (menu, window close, or Electron's own handling of SIGTERM).
app.on('before-quit', e => {
  /* However quitting started, from here on the window closing must not be
     turned into hiding, or the app would be left half shut down. */
  background?.beginQuit();
  if (shutdownFinished) return;
  e.preventDefault();
  void shutdown().then(() => app.quit());
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void shutdown().then(() => app.quit());
  });
}

/* ------------------------------------------------------------ IPC plumbing */

/** Only the app's own window, showing the bundled UI, may call in. */
function fromOurWindow(e: IpcMainInvokeEvent | IpcMainEvent) {
  const contents = window && !window.isDestroyed() ? window.webContents : null;
  return isTrustedSender(e, contents, UI_URL);
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromOurWindow(e)) {
      log.warn(`refused IPC "${channel}" from an untrusted sender`);
      throw new Error('Unauthorised caller');
    }
    return fn(...(args as A));
  });
}

/** Thrown to tell the UI to ask for the vault passphrase and try again. */
const VAULT_LOCKED = 'VAULT_LOCKED: Unlock saved passwords to continue';

async function assertCanStoreSecrets() {
  if (await credentials.needsUnlock()) throw new Error(VAULT_LOCKED);
}

/* -------------------------------------------------------------- connections */

handle('list', () => connections.list());

handle('add', async (input: Parameters<ConnectionManager['add']>[0]) => {
  if (input?.password) await assertCanStoreSecrets();
  // New computers start from the user's defaults; anything chosen explicitly wins.
  return connections.add({ ...input, options: { ...settings.get().defaults, ...(input?.options ?? {}) } });
});

handle('update', async (id: string, patch: Parameters<ConnectionManager['update']>[1]) => {
  if (patch?.password !== undefined) await assertCanStoreSecrets();
  return connections.update(id, patch);
});

handle('duplicate', (id: string) => connections.duplicate(id));

handle('remove', async (id: string) => {
  if (active?.connection.id === id) stopActive();
  sessionTrust.delete(id);
  return connections.remove(id);
});

handle('toggleFavorite', (id: string) => connections.toggleFavorite(id));
handle('history', (id?: string) => connections.history(50, typeof id === 'string' ? id : undefined));

handle('discover', () => browseLan({ timeoutMs: 2500 }));

handle('listMonitors', async () => {
  const binary = await rdpAvailable();
  if (!binary) return [];
  return listFreeRdpMonitors(binary, await detectFreeRdpCapabilities(binary));
});

/* -------------------------------------------------------------- credentials */

async function vaultStatus() {
  const backend = await credentials.backend();
  return { backend, locked: await credentials.needsUnlock(), exists: credentials.vaultExists };
}

handle('vaultStatus', () => vaultStatus());

handle('unlockVault', async (passphrase: string) => {
  if (typeof passphrase !== 'string') throw new Error('Enter the passphrase');
  await credentials.unlock(passphrase);
  log.info('credential vault unlocked');
  return vaultStatus();
});

handle('lockVault', async () => {
  credentials.lock();
  log.info('credential vault locked');
  return vaultStatus();
});

/* ---------------------------------------------------------------- sessions */

interface ConnectRequest {
  username?: string;
  password?: string;
  /** Save the password given in this request for next time. */
  savePassword?: boolean;
}

type ConnectResult =
  | { status: 'started'; warnings: string[] }
  | { status: 'failed'; error: FriendlyError }
  | { status: 'needs-credentials'; fields: Array<'username' | 'password'>; vaultLocked: boolean }
  | { status: 'needs-unlock'; vaultExists: boolean }
  | { status: 'certificate'; reason: 'untrusted' | 'changed'; certificate: RdpCertificate; previousFingerprint?: string };

handle('connect', async (id: string, request: ConnectRequest = {}): Promise<ConnectResult> => {
  let connection = connections.get(id);
  if (!connection) throw new Error('That connection no longer exists');

  // Never run two sessions at once; the previous one is torn down first.
  stopActive();

  if (request.username?.trim() && request.username.trim() !== connection.username) {
    connection = await connections.update(id, { username: request.username.trim() });
  }

  // Where the password comes from: typed now, or saved.
  let password: string | null = null;
  const vaultLocked = await credentials.needsUnlock();
  if (request.password) {
    password = request.password;
    if (request.savePassword) {
      if (vaultLocked) return { status: 'needs-unlock', vaultExists: credentials.vaultExists };
      await connections.update(id, { password });
    }
  } else if (!vaultLocked) {
    password = await connections.passwordFor(id);
  }

  if (connection.protocol === 'rdp') {
    // NLA needs both before connecting, and FreeRDP must not prompt for either.
    const fields: Array<'username' | 'password'> = [];
    if (!connection.username) fields.push('username');
    if (!password) fields.push('password');
    if (fields.length) return { status: 'needs-credentials', fields, vaultLocked: vaultLocked && credentials.vaultExists };
    return startRdp(connection, password);
  }

  if (connection.protocol === 'vnc') {
    // Many VNC servers need no password, so connect first; the server says if
    // one is required, and the UI asks then.
    return startVnc(connection, password);
  }

  return startExternal(connection, password, null);
});

handle('trustCertificate', async (id: string, fingerprint: string, remember: boolean) => {
  const connection = connections.get(id);
  if (!connection) throw new Error('That connection no longer exists');
  const fp = normalizeFingerprint(fingerprint);
  if (remember) {
    await connections.update(id, { options: { trustedCertificate: fp } });
    sessionTrust.delete(id);
  } else {
    sessionTrust.set(id, fp);
  }
  log.info(`certificate ${fp} trusted for ${connection.host}:${connection.port}${remember ? ' permanently' : ' for this session'}`);
  return { ok: true };
});

handle('disconnect', () => {
  stopActive();
  return { ok: true };
});

/** Ends the active session because the user asked (or the app is closing). */
function stopActive() {
  const current = active;
  if (!current) return;
  active = null;
  current.session?.stop();
  current.engine?.stop();
  void connections.recordSessionEnd(current.historyId, { reason: 'user' });
  // The session's own events are ignored once it is no longer active, so the
  // UI is told here.
  publish(current, { state: 'disconnected' });
  log.info(`disconnected from ${current.connection.host}:${current.connection.port}`);
}

/** The stats shape the renderer receives for every state change. */
function publish(a: ActiveSession, stats: Partial<SessionStats> & { state: string }, extra: Record<string, unknown> = {}) {
  const info = a.session?.serverInfo;
  send('session', {
    connectionId: a.connection.id,
    protocol: a.connection.protocol,
    external: a.connection.protocol !== 'vnc',
    warnings: a.warnings,
    latencyMs: null, attempt: 0, bytesReceived: 0, framesReceived: 0, connectedAt: null, lastError: null, error: null,
    width: info?.width, height: info?.height,
    canResize: a.session?.canResize ?? false,
    unicodeClipboard: a.session?.unicodeClipboard ?? false,
    ...stats,
    ...extra,
  });
}

async function startVnc(connection: Connection, password: string | null): Promise<ConnectResult> {
  const session = new Session(connection, password, {
    enabled: connection.options.autoReconnect,
    maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 30_000,
    // A first attempt that fails twice is reported, not retried for minutes.
    initialAttempts: 2,
  });
  const a: ActiveSession = {
    connection, session, engine: null, warnings: [], pinnedFingerprint: null,
    historyId: await connections.recordStart(connection.id),
  };
  active = a;
  log.info(`connecting to ${connection.host}:${connection.port} (vnc)`);

  // Paint-paced: the next update is requested once the renderer has drawn this one.
  session.setFlowControl(true);

  session.on('state', (state, stats) => {
    if (active !== a) return;
    const category = stats.error?.category;
    const needsPassword = state === 'failed' && (category === 'auth-required' || category === 'auth-failed');
    publish(a, stats, needsPassword ? { credentialsRequired: ['password'] } : {});

    if (state === 'connected') {
      log.info(`connected to ${connection.host}:${connection.port}`);
      void connections.recordConnected(a.historyId);
    }
    if (state === 'failed') {
      log.error(`session failed: ${stats.error?.category ?? ''} ${stats.lastError}`);
      void connections.recordSessionEnd(a.historyId, {
        reason: 'error', error: stats.error?.title ?? stats.lastError ?? undefined, errorCategory: category,
      });
      active = null;
    }
  });

  session.on('resize', size => {
    if (active === a) publish(a, session.current, size);
  });
  session.on('screens', () => {
    if (active === a) publish(a, session.current);
  });
  session.on('resizeRejected', status => {
    if (active === a) send('notice', { connectionId: connection.id, kind: 'resize-rejected', status });
  });

  session.on('update', update => {
    if (active !== a) return;
    const s = session.current;
    send('frame', {
      connectionId: connection.id,
      width: update.width, height: update.height,
      stats: { latencyMs: s.latencyMs, framesReceived: s.framesReceived, bytesReceived: s.bytesReceived },
      rects: update.rects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height, data: r.data, src: r.src })),
    });
  });

  session.on('clipboard', text => {
    // Asynchronous since Electron 44; a failed write only loses this one clipboard update.
    if (active === a && connection.options.shareClipboard) void clipboard.writeText(text).catch(() => {});
  });

  await session.start();
  return { status: 'started', warnings: [] };
}

async function startRdp(connection: Connection, password: string | null): Promise<ConnectResult> {
  const trusted = connection.options.trustedCertificate ?? sessionTrust.get(connection.id) ?? null;
  const probe = await probeRdpCertificate(connection.host, connection.port);
  const decision = decideRdpCertificate(probe, trusted);
  if (decision.action === 'ask') {
    log.warn(`certificate for ${connection.host}:${connection.port} needs a decision (${decision.reason})`);
    return {
      status: 'certificate', reason: decision.reason, certificate: decision.certificate,
      previousFingerprint: decision.previousFingerprint,
    };
  }
  return startExternal(connection, password, decision.action === 'pin' ? decision.fingerprint : null, probe.kind === 'tls');
}

async function startExternal(
  connection: Connection, password: string | null, fingerprint: string | null, reachable = false,
): Promise<ConnectResult> {
  const available = connection.protocol === 'rdp' ? await rdpAvailable() : await spiceAvailable();
  if (!available) {
    const error: FriendlyError = connection.protocol === 'rdp'
      ? {
        category: 'client-missing', title: 'Remote Desktop support is not installed',
        message: 'HopDesk uses FreeRDP to connect to Windows. Install it from your software centre ("FreeRDP"), or with: sudo apt install freerdp2-x11 (or freerdp3-x11 on newer systems).',
        detail: 'xfreerdp3, xfreerdp and freerdp3 were not found on PATH',
      }
      : {
        category: 'client-missing', title: 'SPICE support is not installed',
        message: 'Install "Virt Viewer" from your software centre, or with: sudo apt install virt-viewer.',
        detail: 'remote-viewer and spicy were not found on PATH',
      };
    send('session', {
      connectionId: connection.id, protocol: connection.protocol, external: true, state: 'failed',
      warnings: [], lastError: error.message, error,
    });
    return { status: 'failed', error };
  }

  const work = screen.getPrimaryDisplay().workAreaSize;
  const engine = new ExternalEngine(connection, password, {
    trustedFingerprint: fingerprint,
    reachable,
    // Most of the screen, leaving room for panels; the remote follows later resizes.
    windowSize: { width: Math.round(work.width * 0.85), height: Math.round(work.height * 0.85) },
  });
  const a: ActiveSession = {
    connection, session: null, engine, warnings: [], pinnedFingerprint: fingerprint,
    historyId: await connections.recordStart(connection.id),
  };
  active = a;
  log.info(`connecting to ${connection.host}:${connection.port} (${connection.protocol})${fingerprint ? ' with a pinned certificate' : ''}`);

  engine.on('warning', message => {
    a.warnings.push(message);
    log.warn(`[${connection.protocol}] ${message}`);
  });
  engine.on('log', line => log.debug(`[${connection.protocol}] ${line}`));

  engine.on('state', event => {
    if (active !== a) return;
    const state = event.state === 'running' ? 'connected'
      : event.state === 'starting' ? 'connecting'
        : event.state === 'exited' ? 'disconnected' : 'failed';

    const extra: Record<string, unknown> = { error: event.error ?? null };
    if (event.error?.category === 'auth-failed') extra.credentialsRequired = ['username', 'password'];
    publish(a, { state, lastError: event.message && state === 'failed' ? event.message : null, attempt: 1 }, extra);

    if (state === 'connected') void connections.recordConnected(a.historyId);
    if (state === 'disconnected') {
      // FreeRDP's own window was closed, or the remote side ended the session.
      void connections.recordSessionEnd(a.historyId, { reason: 'remote' });
    }
    if (state === 'failed') {
      log.error(`${connection.protocol} failed: ${event.errorCode ?? event.code ?? ''} ${event.message ?? ''}`);
      void connections.recordSessionEnd(a.historyId, {
        reason: 'error', error: event.error?.title ?? event.message, errorCategory: event.error?.category,
      });
      if (event.errorCode === 'ERRCONNECT_TLS_CONNECT_FAILED') void explainCertificateFailure(a);
    }
    if (state === 'disconnected' || state === 'failed') active = null;
  });

  try {
    await engine.start();
  } catch (err) {
    if (active === a) active = null;
    throw err;
  }
  return { status: 'started', warnings: a.warnings };
}

/** After a TLS failure, finds out whether the certificate changed and offers the decision. */
async function explainCertificateFailure(a: ActiveSession) {
  const c = a.connection;
  const probe = await probeRdpCertificate(c.host, c.port);
  const decision = decideRdpCertificate(probe, a.pinnedFingerprint);
  if (decision.action !== 'ask') return;
  const changed = decision.reason === 'changed';
  const error: FriendlyError = {
    category: changed ? 'certificate-changed' : 'certificate-rejected',
    title: changed ? 'Certificate changed' : 'Certificate not trusted',
    message: changed
      ? 'The remote computer’s certificate has changed since you trusted it.'
      : 'The remote computer’s certificate is not trusted.',
    detail: `ERRCONNECT_TLS_CONNECT_FAILED; presented ${decision.certificate.fingerprint}`,
  };
  send('session', {
    connectionId: c.id, protocol: c.protocol, external: true, state: 'failed', warnings: a.warnings,
    lastError: error.message, error,
    certificatePrompt: { reason: decision.reason, certificate: decision.certificate, previousFingerprint: decision.previousFingerprint },
  });
}

/* ------------------------------------------------------------------- input */

ipcMain.on('input', (e, msg: { type?: string; [k: string]: unknown }) => {
  if (!fromOurWindow(e)) return;
  const current = active;
  const session = current?.session;
  if (!current || !session || !msg || typeof msg !== 'object') return;
  const int = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;

  if (msg.type === 'key' && int(msg.keysym, 0xffffffff) && typeof msg.down === 'boolean') {
    session.sendKey(msg.keysym as number, msg.down);
  } else if (msg.type === 'pointer' && int(msg.x, 0xffff) && int(msg.y, 0xffff) && int(msg.mask, 0xff)) {
    session.sendPointer(msg.x as number, msg.y as number, msg.mask as number);
  } else if (msg.type === 'clipboard-sync') {
    // Read here rather than in the renderer, which has no clipboard access.
    void clipboard.readText().then(text => {
      // The session may have ended or changed while the clipboard was read.
      if (!text || active !== current || current.session !== session) return;
      const result = session.sendClipboard(text);
      if (result && !result.lossless) {
        send('notice', { connectionId: current.connection.id, kind: 'clipboard-lossy' });
      }
    }).catch(() => {});
  } else if (msg.type === 'resize' && int(msg.width, 16384) && int(msg.height, 16384)
    && (msg.width as number) >= 200 && (msg.height as number) >= 150) {
    session.requestDesktopSize(msg.width as number, msg.height as number);
  }
});

ipcMain.on('frameRendered', e => {
  if (fromOurWindow(e)) active?.session?.renderComplete();
});

/* ---------------------------------------------------------------- settings */

handle('getSettings', async () => ({
  credentialBackend: await credentials.backend(),
  vault: await vaultStatus(),
  logPath: log.path,
  rdpAvailable: Boolean(await rdpAvailable()),
  spiceAvailable: Boolean(await spiceAvailable()),
  defaults: settings.get().defaults,
  remoteAccess: (({ enabled, port, announce }) => ({ enabled, port, announce }))(settings.get().remoteAccess),
  account: settings.get().account,
}));

handle('updateSettings', async (patch: Parameters<SettingsStore['update']>[0]) => {
  await settings.update(patch);
  return { ok: true };
});
handle('openLogFolder', () => { void shell.openPath(dataDir); });

/* --------------------------------------------------- this computer as a host */

const hostUnavailable = () => ({
  enabled: false, listening: false, deviceId: '', name: hostname(), accessCode: null,
  port: 0, announcing: false, trusted: [],
  keyProtection: 'unavailable',
  detail: 'This computer has no HopDesk identity, so it cannot accept connections. See the log.',
  sessions: [],
});

function hostStatusPayload() {
  const problem = inputProblem();
  return {
    ...(host ? host.status() : hostUnavailable()),
    ...(waylandLimitation() ? { detail: waylandLimitation() } : {}),
    permissions: permissionReport,
    inputAvailable: problem === null,
    ...(problem ? { inputDetail: problem } : {}),
    /* Only what someone sharing needs to decide: which screens there are and
       which one they are sharing. A computer with one screen gets a list of
       one, and the window leaves the choice out. */
    screens: screenChoices(screen.getAllDisplays(), screen.getPrimaryDisplay().id),
    sharedScreen: displayShared().id,
  };
}

handle('hostStatus', () => hostStatusPayload());

/* Screen Recording only takes effect after HopDesk restarts; this does it. */
handle('relaunch', () => {
  log.info('restarting at the user\'s request, to apply a permission');
  app.relaunch();
  app.quit();
  return { ok: true };
});

handle('checkPermissions', () => refreshPermissions(false));

/**
 * Asks macOS for one permission with its own dialog. macOS shows each prompt
 * once; `prompted: false` with `granted: false` means it decided not to, and
 * the wizard must send the person to System Settings instead.
 */
handle('askPermission', async (id: string) => {
  const which = id === 'accessibility' ? 'accessibility' : 'screen-recording';
  const result = await permissions.ask?.(which) ?? { granted: false, prompted: false };
  log.info(`asked macOS for ${which}: ${result.granted ? 'allowed' : result.prompted ? 'prompt shown' : 'no prompt (already answered once)'}`);
  await refreshPermissions(false);
  permissionsChanged();
  return { ...result, report: permissionReport };
});
handle('requestPermissions', () => refreshPermissions(true));
/* For a switch that is on in System Settings but does nothing: clears the stale
   entry and restarts, so macOS asks again for the build that is running. */
handle('resetPermissions', async () => {
  const result = await resetMacPermissions();
  if (!result.ok) {
    log.warn(`could not reset macOS permissions: ${result.detail}`);
    return result;
  }
  log.info(`reset macOS permissions for ${result.bundleId}; restarting so macOS asks again`);
  app.relaunch();
  app.quit();
  return result;
});
handle('openPermissionSettings', (action: string) => {
  openPermissionSettings(action as PermissionReport['action']);
  return { ok: true };
});

handle('setRemoteAccess', async (patch: {
  enabled?: boolean; announce?: boolean; port?: number; screen?: number | null;
}) => {
  if (!host) throw new Error('This computer has no HopDesk identity yet');
  /* Switching sharing on is the moment to ask the operating system, so the
     answer arrives before someone tries to connect rather than after. On
     Wayland this is also when the compositor asks about remote control. */
  if (patch?.enabled === true) {
    await refreshPermissions(true);
    await prepareInput();
  }
  const update: Parameters<SettingsStore['update']>[0] = { remoteAccess: {} };

  if (typeof patch?.announce === 'boolean') update.remoteAccess!.announce = patch.announce;
  if (Number.isInteger(patch?.port)) update.remoteAccess!.port = patch.port;
  const screenChanged = patch?.screen !== undefined && patch.screen !== settings.get().remoteAccess.screen;
  if (patch?.screen === null || Number.isInteger(patch?.screen)) update.remoteAccess!.screen = patch.screen ?? null;

  if (typeof patch?.enabled === 'boolean') update.remoteAccess!.enabled = patch.enabled;

  const next = await settings.update(update);
  /* Someone watching should see the other screen now, not after reconnecting. */
  if (screenChanged) {
    log.info(`sharing screen ${next.remoteAccess.screen ?? 'main'} from now on`);
    recapture();
  }
  const wanted = next.remoteAccess.enabled;
  const listening = host.status().listening;
  if (wanted && !listening) await host.start();
  else if (!wanted && listening) await host.stop();
  else if (wanted && listening && (patch?.port !== undefined || patch?.announce !== undefined)) {
    // The port or announcement changed: restart the listener on the new one.
    await host.stop();
    await host.start();
  }
  return host.status();
});

handle('regenerateAccessCode', () => {
  if (!host) throw new Error('This computer has no HopDesk identity yet');
  host.regenerateCode();
  return host.status();
});

handle('endHostSession', (id: string, reason?: string) => {
  host?.endSession(String(id), reason === 'revoked' ? 'revoked' : 'user-disconnected');
  closeHostWindowIfIdle();
  return host ? host.status() : hostUnavailable();
});

/** Accept or Refuse from the "this computer's key changed" dialog. */
handle('answerKeyChange', (id: string, accepted: boolean) => {
  const settle = keyChangeRequests.get(String(id));
  if (!settle) return { ok: false };
  settle(accepted === true);
  return { ok: true };
});

handle('answerConsent', (id: string, decision: string) => {
  const settle = consentRequests.get(String(id));
  if (!settle) return { ok: false };
  /* 'allow-and-trust' is Allow plus "let this computer connect again without
     asking": the host remembers the viewer's public key. */
  settle(decision === 'allow' ? 'allow' : decision === 'allow-and-trust' ? 'allow-and-trust' : 'reject');
  return { ok: true };
});

handle('trustedList', () => (host ? host.status().trusted : []));

/* Opening at login is what makes a Mac reachable after a restart without
   anyone opening the app. A user login item: it runs after *this* person logs
   in, so a computer with nobody logged in stays unreachable. */
/* macOS has a login item; Linux gets a systemd user service that does the same
   job. Windows would too, but nothing there can host yet. */
handle('loginItem', () => ({
  supported: process.platform === 'darwin' || process.platform === 'linux',
  openAtLogin: openAtLogin(),
}));
handle('setLoginItem', (open: boolean) => {
  setOpenAtLogin(Boolean(open));
  const now = openAtLogin();
  log.info(`open at login: ${now ? 'on' : 'off'}`);
  return { openAtLogin: now };
});

handle('trustedRemove', (deviceId: string) => {
  if (!host) throw new Error('This computer has no HopDesk identity yet');
  const removed = host.revokeTrust(String(deviceId));
  send('hostStatus', hostStatusPayload());
  return { ok: removed };
});

/* Messages from the hidden capture window: a viewer's input, its clipboard, and
   its window size. Each is validated against the protocol schema in HostRole
   before it reaches the platform. */
function fromHostWindow(e: IpcMainEvent) {
  return isTrustedFrom(e, [{ contents: hostWindow && !hostWindow.isDestroyed() ? hostWindow.webContents : null, url: HOST_URL }]);
}

let untrustedInput = 0;
ipcMain.on('host:input', (e, payload: { sessionId?: unknown; message?: unknown }) => {
  if (!fromHostWindow(e) || typeof payload?.sessionId !== 'string') {
    // Said once: input that never reaches the host must not vanish without a trace.
    if (untrustedInput++ === 0) log.warn(`input ignored: it came from ${e.senderFrame?.url ?? 'an unknown window'}, not the capture window`);
    return;
  }
  host?.handleInput(payload.sessionId, payload.message);
});

ipcMain.on('host:clipboard', (e, payload: { sessionId?: unknown; message?: unknown }) => {
  if (!fromHostWindow(e) || typeof payload?.sessionId !== 'string') return;
  host?.handleClipboard(payload.sessionId, payload.message);
});

ipcMain.on('host:display', (e, payload: { sessionId?: unknown; message?: unknown }) => {
  if (!fromHostWindow(e) || typeof payload?.sessionId !== 'string') return;
  // Only logged for now: resizing the host display to fit a viewer comes with
  // the display manager, and a message the host ignores must not break a session.
  log.info(`session ${payload.sessionId} sent a display message`);
});

ipcMain.on('host:log', (e, text: unknown) => {
  if (!fromHostWindow(e) || typeof text !== 'string') return;
  log.info(`capture window: ${text.slice(0, 200)}`);
});

/**
 * What was actually captured, measured in the capture window.
 *
 * Which source is which monitor can only be matched by position on X11, where
 * the ids mean nothing (see screens.ts). If that matching is ever wrong the
 * person sharing sees nothing unusual — a picture arrives, of the wrong
 * monitor — so the sizes are compared and the disagreement written down.
 */
ipcMain.on('host:captured', (e, size: unknown) => {
  if (!fromHostWindow(e) || typeof size !== 'object' || size === null) return;
  const { width, height } = size as { width?: unknown; height?: unknown };
  if (typeof width !== 'number' || typeof height !== 'number') return;
  const display = displayShared();
  log.info(`captured ${width}x${height}`);
  if (capturedTheWrongScreen(display, { width, height })) {
    log.warn(`the picture is ${width}x${height} but the screen being shared is `
      + `${display.size.width}x${display.size.height}: this may be the wrong monitor. `
      + 'Choose the other screen under "This computer".');
  }
});

/* The viewer's side of a session: its channels and what became of its input.
   The renderer sends counts and states only, never what was typed. */
ipcMain.on('viewer:log', (e, text: unknown) => {
  if (!isTrustedFrom(e, [{ contents: window && !window.isDestroyed() ? window.webContents : null, url: UI_URL }])) return;
  if (typeof text !== 'string') return;
  log.info(`viewer: ${text.slice(0, 300)}`);
});

/* ---------------------------------------- connecting to another computer */

handle('connectDevice', async (request: { deviceId?: string; code?: string; address?: string; port?: number }) => {
  if (!viewer) throw new Error('This computer has no HopDesk identity yet');
  return viewer.connect({
    deviceId: String(request?.deviceId ?? ''),
    code: String(request?.code ?? ''),
    ...(request?.address ? { address: String(request.address) } : {}),
    ...(Number.isInteger(request?.port) ? { port: request.port } : {}),
  });
});

handle('disconnectDevice', () => {
  viewer?.disconnect();
  return { ok: true };
});

/* The viewer's own window sends control messages for its session: its size, and
   keep-alives. Input and clipboard go over the data channels, not through here. */
ipcMain.on('viewerSend', (e, payload: { label?: unknown; message?: unknown }) => {
  if (!fromOurWindow(e) || !viewer) return;
  const message = payload?.message;
  if (payload?.label !== 'control' || typeof message !== 'object' || message === null) return;
  try {
    viewer.send(message as Parameters<NonNullable<typeof viewer>['send']>[0]);
  } catch (err) {
    log.warn(`viewer control message refused: ${(err as Error).message}`);
  }
});

/* The viewer's clipboard, which only the main process can reach. Both
   directions are limited to what a clipboard message may carry, and the text
   itself is never logged. */
handle('viewerClipboardRead', async () => {
  if (!viewer || viewer.current().state !== 'connected') return '';
  if (settings.get().defaults.shareClipboard === false) return '';
  const text = await clipboard.readText();
  return text.slice(0, MAX_CLIPBOARD_CHARS);
});

handle('viewerClipboardWrite', async (text: string) => {
  if (!viewer || viewer.current().state !== 'connected') return { ok: false };
  if (settings.get().defaults.shareClipboard === false) return { ok: false };
  if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_CHARS) return { ok: false };
  await clipboard.writeText(text);
  return { ok: true };
});

/* ------------------------------------------------------ HopDesk account */

const accountUnavailable = { signedIn: false, relay: 'offline' as const, computers: [], detail: 'This computer has no HopDesk identity yet.' };

handle('accountState', () => account?.state() ?? accountUnavailable);

handle('accountSignIn', async (request: { serverUrl?: string; email?: string; password?: string; create?: boolean; token?: string }) => {
  if (!account) throw new Error('This computer has no HopDesk identity yet');
  const serverUrl = String(request?.serverUrl ?? '').trim();
  const email = String(request?.email ?? '').trim();
  const password = String(request?.password ?? '');
  if (!serverUrl || !email || !password) throw new Error('Enter the server address, your email and your password');
  return request?.create
    ? account.register(serverUrl, email, password, String(request?.token ?? '').trim() || undefined)
    : account.signIn(serverUrl, email, password);
});

handle('accountSignOut', () => account?.signOut() ?? accountUnavailable);
handle('accountRefresh', async () => {
  if (!account) return accountUnavailable;
  await account.refreshComputers();
  return account.state();
});
handle('accountRemoveComputer', async (deviceId: string) => {
  if (!account) throw new Error('Not signed in');
  await account.removeComputer(String(deviceId));
  return account.state();
});

/**
 * Connects to a computer on the account: the server introduces the two, and
 * from there it is the same session as one made on a local network.
 */
handle('connectComputer', async (deviceId: string) => {
  if (!account || !viewer) throw new Error('Not signed in');
  const target = account.state().computers.find(c => c.deviceId === deviceId);
  if (!target) throw new Error('That computer is not on this account');
  if (target.self) throw new Error('That is this computer');

  const dial = async () => {
    const { intro, link } = await account!.openSession(String(deviceId));
    try {
      return await viewer!.connectAccount(link, {
        deviceId: intro.peer.deviceId,
        name: intro.peer.name,
        ...(intro.peer.publicKey ? { publicKey: fromBase64(intro.peer.publicKey) } : {}),
      });
    } catch (err) {
      link.close(err as Error);
      throw err;
    }
  };

  try {
    return await dial();
  } catch (err) {
    /* The key changed, the person looked at both fingerprints and accepted it.
       The relayed link is spent, so ask the server for another one - once. */
    if (err instanceof KeyAccepted) return dial();
    throw err;
  }
});

handle('knownDevices', () => knownDevices.list().map(d => ({
  deviceId: d.deviceId, name: d.name, lastConnected: d.lastConnected,
  paired: d.paired === true, lastAddress: d.lastAddress,
})));

/* One click on a saved computer: no code, no prompt — it paired with this one. */
handle('connectSaved', async (deviceId: string) => {
  if (!viewer) throw new Error('This computer has no HopDesk identity yet');
  const id = String(deviceId);
  const device = knownDevices.list().find(d => d.deviceId === id);
  if (!device?.paired) {
    throw new Error('That computer has not been paired with this one yet. Connect with its access code once, and tick "Let this computer connect again without asking".');
  }
  return viewer.connectPaired({ deviceId: id });
});
handle('forgetDevice', (deviceId: string) => { knownDevices.forget(String(deviceId)); return { ok: true }; });

/* Which way in each computer was last reached by, so the button offers the
   same one next time. Only ever a Device ID and one of three words. */
handle('connectChoices', () => settings.get().connectChoices);
handle('rememberConnectMethod', async (deviceId: string, method: string) => {
  const which = method === 'trusted' || method === 'ask' || method === 'code' ? method : null;
  if (!which) return { ok: false };
  await settings.update({ connectChoices: { [String(deviceId)]: which } });
  return { ok: true };
});

/* Anything unhandled reaches the log rather than vanishing or killing the app
   with a dialog the user cannot act on. */
process.on('uncaughtException', err => {
  log.error(`uncaught: ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', reason => {
  log.error(`unhandled rejection: ${String(reason)}`);
});
