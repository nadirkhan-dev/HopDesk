import {
  app, BrowserWindow, ipcMain, shell, Menu, clipboard, screen, session as electronSession,
  type IpcMainInvokeEvent, type IpcMainEvent,
} from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ConnectionManager, CredentialStore, SettingsStore, Session, ExternalEngine,
  rdpAvailable, spiceAvailable, probeRdpCertificate, decideRdpCertificate, normalizeFingerprint,
  detectFreeRdpCapabilities, listFreeRdpMonitors, browseLan,
  type Backend, type Connection, type FriendlyError, type RdpCertificate, type SessionStats,
} from '@hopdesk/core';
import { createLogger } from './logger.js';
import { isTrustedSender } from './ipc-guard.js';

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

// Every renderer is sandboxed, including any created later by mistake.
app.enableSandbox();

// XDG paths, so the app behaves like a native Linux application rather than
// scattering dotfiles in $HOME.
const dataDir = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'hopdesk')
  : path.join(app.getPath('home'), '.local', 'share', 'hopdesk');

const log = createLogger(dataDir);

/* HOPDESK_CREDENTIAL_BACKEND=file forces the encrypted vault, for machines whose
   keyring misbehaves and for tests that must not touch the user's keyring. */
const forcedBackend = ((): Backend | undefined => {
  const v = process.env.HOPDESK_CREDENTIAL_BACKEND;
  return v === 'file' || v === 'keyring' ? v : undefined;
})();

let window: BrowserWindow | null = null;
const credentials = new CredentialStore(dataDir, forcedBackend);
const connections = new ConnectionManager(dataDir, credentials);
const settings = new SettingsStore(dataDir);

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
  window.on('closed', () => { window = null; });
  Menu.setApplicationMenu(null);
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

app.whenReady().then(async () => {
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);

  try {
    await connections.load();
  } catch (err) {
    // A corrupt file is recoverable; report it rather than refusing to start.
    log.error(`connections: ${(err as Error).message}`);
  }
  await settings.load();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

/* Leaving a session running with no window is a way to lose control of a
   remote machine without noticing. Every way out ends it: closing the window,
   quitting, and being terminated (logout, `kill`, Ctrl+C in a terminal). */
let shutdownDone: Promise<void> | null = null;
let shutdownFinished = false;
function shutdown(): Promise<void> {
  shutdownDone ??= (async () => {
    stopActive();
    credentials.lock();
    // Let the session's end reach the history file before the process exits.
    await Promise.race([connections.flush(), new Promise(r => setTimeout(r, 2000))]);
    shutdownFinished = true;
  })();
  return shutdownDone;
}

app.on('window-all-closed', () => {
  void shutdown().then(() => app.quit());
});
// Quitting is held back until the shutdown has finished, however it started
// (menu, window close, or Electron's own handling of SIGTERM).
app.on('before-quit', e => {
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
}));

handle('updateSettings', async (patch: Parameters<SettingsStore['update']>[0]) => {
  await settings.update(patch);
  return { ok: true };
});
handle('openLogFolder', () => { void shell.openPath(dataDir); });

/* Anything unhandled reaches the log rather than vanishing or killing the app
   with a dialog the user cannot act on. */
process.on('uncaughtException', err => {
  log.error(`uncaught: ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', reason => {
  log.error(`unhandled rejection: ${String(reason)}`);
});
