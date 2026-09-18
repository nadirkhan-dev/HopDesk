import { EventEmitter } from 'node:events';
import {
  HostAuthenticator, GrantStore, acceptViewer, inputMessage, clipboardMessage, HandshakeError,
  type ConsentDecision, type ConsentRequest, type EndReason, type HostSession, type MessageLink,
} from '@hopdesk/protocol';
import { LanListener, HopdeskAnnouncer, negotiateAsHost } from '@hopdesk/transport';
import { generateAccessCode, fromBase64, bytesToBigInt } from '@hopdesk/crypto';
import type { InputController } from '@hopdesk/platform';
import { InputStats } from './input-stats.js';
import { keysymFor } from './keysym.js';
import type { RemoteAccessSettings } from '@hopdesk/core';
import type { LocalIdentity } from './identity.js';
import type { RtcPeerHandle } from './rtc-bridge.js';

/**
 * This computer as a Host: letting another HopDesk computer see and control it.
 *
 * Nothing here runs until the user turns remote access on. When it does: a TCP
 * listener for computers on the same network, an mDNS announcement so a Device
 * ID is enough to find it, and for each connection the handshake from
 * @hopdesk/protocol, an Allow/Reject prompt for the person sitting here, and
 * then a WebRTC connection carrying the screen one way and input the other.
 *
 * The access code lives in memory only. It is new every time the app starts,
 * can be replaced by hand, and is replaced automatically after repeated wrong
 * guesses.
 */

export interface HostSessionInfo {
  id: string;
  viewerId: string;
  viewerName: string;
  since: number;
  /** 'authenticating' → 'connecting' (media) → 'connected'. */
  state: 'connecting' | 'connected';
}

export interface HostStatus {
  enabled: boolean;
  listening: boolean;
  deviceId: string;
  name: string;
  /** Null when remote access is off; never logged. */
  accessCode: string | null;
  port: number;
  announcing: boolean;
  unattended: boolean;
  keyProtection: string;
  detail?: string;
  sessions: HostSessionInfo[];
}

export interface HostDependencies {
  identity: LocalIdentity;
  hostName: string;
  log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  settings: () => RemoteAccessSettings;
  /** Asks the person at this computer. Must not resolve 'allow' by itself. */
  consent: (request: ConsentRequest, signal: AbortSignal) => Promise<ConsentDecision>;
  /** Creates the hidden renderer that captures the screen and holds the peer connection. */
  createPeer: (sessionId: string, iceServers: unknown[]) => Promise<{ peer: RtcPeerHandle; close: () => void }>;
  /** The platform's input injector, or null when input cannot be injected. */
  input: () => InputController | null;
  /** Why input cannot be injected right now, for the log; null when it can. */
  inputProblem?: () => string | null;
  /** What a viewer should be told about the limits of this computer, in plain words. */
  notices?: () => string[];
  /**
   * Whether a device may connect because it is on the same HopDesk account.
   * Absent when this computer is not signed in, which refuses account
   * connections rather than guessing.
   */
  accountAuthorised?: (viewerId: string, viewerKey: Uint8Array) => boolean;
  /** Relay and STUN servers for sessions that cannot go direct. */
  iceServers?: () => Promise<unknown[]>;
  clipboard: { read(): Promise<string>; write(text: string): Promise<void> };
  /** Size of the display being shared, for turning normalised pointer positions into pixels. */
  displaySize: () => { width: number; height: number };
  shareClipboard: () => boolean;
}

interface RunningSession {
  session: HostSession;
  peer: { peer: RtcPeerHandle; close: () => void } | null;
  info: HostSessionInfo;
  clipboardSeq: number;
  input: InputStats;
  /** The notices last sent to this viewer, so they go again only when they change. */
  noticesSent: string | null;
}

export class HostRole extends EventEmitter {
  private listener: LanListener | null = null;
  private announcer: HopdeskAnnouncer | null = null;
  private authenticator: HostAuthenticator | null = null;
  private readonly grants = new GrantStore();
  private readonly sessions = new Map<string, RunningSession>();
  private code: string | null = null;
  private announcing = false;
  private detail: string | undefined;
  private clipboardTimer: NodeJS.Timeout | null = null;
  private lastClipboard = '';

  constructor(private readonly deps: HostDependencies) { super(); }

  get deviceId() { return this.deps.identity.deviceId; }

  status(): HostStatus {
    const settings = this.deps.settings();
    return {
      enabled: settings.enabled,
      listening: this.listener !== null,
      deviceId: this.deviceId,
      name: this.deps.hostName,
      accessCode: this.listener ? this.code : null,
      port: settings.port,
      announcing: this.announcing,
      unattended: settings.unattended,
      keyProtection: this.deps.identity.protectionDetail,
      ...(this.detail ? { detail: this.detail } : {}),
      sessions: [...this.sessions.values()].map(s => ({ ...s.info })),
    };
  }

  /** Starts listening. Safe to call when already started. */
  async start(): Promise<void> {
    if (this.listener) return;
    const settings = this.deps.settings();
    this.detail = undefined;
    this.code ??= generateAccessCode();

    this.authenticator = new HostAuthenticator({
      identity: this.deps.identity.identity,
      hostName: this.deps.hostName,
      grants: this.grants,
      accessCode: () => this.code,
      rotateAccessCode: () => {
        this.code = generateAccessCode();
        this.deps.log.warn('access code replaced after repeated failed attempts');
        this.emit('change');
      },
      unattended: () => {
        const s = this.deps.settings();
        if (!s.unattended || !s.unattendedVerifier) return null;
        try { return fromBase64(s.unattendedVerifier); } catch { return null; }
      },
      accountAuthorised: (viewerId, viewerKey) => this.deps.accountAuthorised?.(viewerId, viewerKey) ?? false,
    });

    const listener = new LanListener((link, remote) => {
      void this.acceptLink(link, `${remote.address}`);
    });
    try {
      await listener.listen({ port: settings.port });
    } catch (err) {
      this.detail = `Could not listen on port ${settings.port}: ${(err as Error).message}`;
      this.deps.log.error(this.detail);
      this.emit('change');
      throw err;
    }
    this.listener = listener;
    this.deps.log.info(`host listening on port ${settings.port} as ${this.deviceId}`);

    if (settings.announce) {
      this.announcer = new HopdeskAnnouncer({ deviceId: this.deviceId, name: this.deps.hostName, port: settings.port });
      const result = await this.announcer.start();
      this.announcing = result.announcing;
      if (!result.announcing) {
        // Not fatal: the computer can still be reached by address.
        this.detail = result.detail;
        this.deps.log.warn(result.detail ?? 'network discovery unavailable');
      }
    }
    this.emit('change');
  }

  async stop(reason: EndReason = 'host-stopped'): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.endSession(id, reason);
    this.grants.revokeAll();
    const listener = this.listener;
    this.listener = null;
    this.authenticator = null;
    await listener?.close();
    const announcer = this.announcer;
    this.announcer = null;
    this.announcing = false;
    await announcer?.stop();
    this.stopClipboardWatch();
    this.emit('change');
  }

  /** A new code, at the user's request. Existing sessions are unaffected. */
  regenerateCode(): string | null {
    if (!this.listener) return null;
    this.code = generateAccessCode();
    this.authenticator?.limiter.resetForNewCode();
    this.emit('change');
    return this.code;
  }

  endSession(id: string, reason: EndReason = 'host-stopped') {
    const running = this.sessions.get(id);
    if (!running) return;
    this.sessions.delete(id);
    running.input.finish();
    /* Ending a session here is a decision by the person at this computer, so the
       viewer's resume grant goes with it: reconnecting must ask again. */
    this.grants.revokeViewer(running.session.viewer.viewerKey);
    try { running.session.control.send({ type: 'bye', reason }); } catch { /* already gone */ }
    running.peer?.peer.dispose();
    running.peer?.close();
    running.session.control.close();
    this.deps.input()?.releaseAll();
    if (!this.sessions.size) this.stopClipboardWatch();
    this.emit('change');
  }

  /* --------------------------------------------------------- one session */

  /**
   * Takes a connection through the handshake, consent and media setup. Used for
   * both a direct socket on the local network and a session the HopDesk server
   * has relayed, because from here on they are the same thing.
   */
  async acceptLink(link: MessageLink, origin: string) {
    const auth = this.authenticator;
    if (!auth) { link.close(); return; }

    let session: HostSession;
    try {
      session = await acceptViewer(link, auth, {
        grants: this.grants,
        authorize: (request, signal) => this.deps.consent(request, signal),
        /* Unattended access is what stands in for someone answering, so it
           covers connections from this account's own computers too. */
        needsConsent: kind => kind === 'code' || (kind === 'account' && !this.deps.settings().unattended),
      });
    } catch (err) {
      const code = err instanceof HandshakeError ? err.code : 'error';
      // Never log the access code or any key material — only why it failed.
      this.deps.log.info(`connection from ${origin} refused: ${code}`);
      return;
    }

    const info: HostSessionInfo = {
      id: session.sessionId,
      viewerId: session.viewer.viewerId,
      viewerName: session.viewer.viewerName,
      since: Date.now(),
      state: 'connecting',
    };
    const running: RunningSession = {
      session, peer: null, info, clipboardSeq: 0,
      input: new InputStats(session.sessionId, line => this.deps.log.info(line)),
      noticesSent: null,
    };
    this.sessions.set(session.sessionId, running);
    this.emit('change');
    this.deps.log.info(`session ${session.sessionId} authorised for ${info.viewerId} (${session.viewer.auth})`);

    session.control.onClose(() => {
      if (this.sessions.has(session.sessionId)) {
        this.sessions.delete(session.sessionId);
        running.input.finish();
        running.peer?.peer.dispose();
        running.peer?.close();
        this.deps.input()?.releaseAll();
        if (!this.sessions.size) this.stopClipboardWatch();
        this.emit('change');
        this.deps.log.info(`session ${session.sessionId} ended`);
      }
    });

    try {
      const iceServers = this.deps.iceServers ? await this.deps.iceServers().catch(() => []) : [];
      const peer = await this.deps.createPeer(session.sessionId, iceServers);
      running.peer = peer;
      await negotiateAsHost(session.control, peer.peer);
      info.state = 'connected';
      /* The session proper: a `bye` from the viewer ends it, and pings are
         answered so either side can tell a live connection from a dead one. */
      session.control.onMessage(message => {
        if (message.type === 'ping') session.control.send({ type: 'pong', t: message.t });
        else if (message.type === 'bye') this.endSession(session.sessionId, 'user-disconnected');
      });
      this.startClipboardWatch();
      this.emit('change');
      this.deps.log.info(`session ${session.sessionId} media connected`);
      this.sendNotices(running, true);
    } catch (err) {
      this.deps.log.warn(`session ${session.sessionId} could not start the screen connection: ${(err as Error).message}`);
      this.endSession(session.sessionId, 'error');
    }
  }

  /* ----------------------------------------------------- input from a viewer */

  /**
   * A message from a viewer's input channel, forwarded by the renderer holding
   * the data channel. Validated here, in the main process, against the
   * protocol schema before anything touches the platform.
   */
  handleInput(sessionId: string, raw: unknown) {
    const running = this.sessions.get(sessionId);
    if (!running) {
      this.noteStrayInput(sessionId);
      return;
    }
    const stats = running.input;
    const type = typeof (raw as { type?: unknown })?.type === 'string' ? String((raw as { type: string }).type).slice(0, 20) : 'unknown';
    stats.arrived(type);

    let message;
    try {
      message = inputMessage(raw, '');
    } catch (err) {
      stats.drop(`invalid message (${(err as Error).message.slice(0, 80)})`);
      return;
    }
    const input = this.deps.input();
    if (!input) {
      stats.drop(`no input controller: ${this.deps.inputProblem?.() ?? 'unavailable'}`);
      // The viewer is told, not left wondering why its mouse does nothing.
      this.sendNotices(running);
      return;
    }
    try {
      const { width, height } = this.deps.displaySize();
      switch (message.type) {
        case 'pointer': {
          input.movePointer(message.x * (width - 1), message.y * (height - 1));
          const buttons = message.buttons;
          for (const button of [1, 2, 3] as const) {
            const bit = button === 1 ? 1 : button === 2 ? 4 : 2;      // DOM buttons: 1 left, 2 right, 4 middle
            input.button(button, (buttons & bit) !== 0);
          }
          break;
        }
        case 'wheel':
          input.wheel(message.dx, message.dy);
          break;
        case 'key': {
          const keysym = keysymForMessage(message);
          if (keysym === null) { stats.drop('a key with no keysym on this computer'); return; }
          input.key(keysym, message.down);
          break;
        }
        case 'release-all':
          input.releaseAll();
          break;
      }
      stats.delivered();
    } catch (err) {
      // Thrown inside an IPC listener, this would reach stderr and never the log.
      stats.drop(`injection failed: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  /** Sends every session its notices again, if they changed — say, a permission was just granted. */
  refreshNotices() {
    for (const running of this.sessions.values()) this.sendNotices(running);
  }

  /**
   * What the viewer should know about this computer's limits: that it cannot be
   * controlled, or that its screen cannot be recorded, and what to do about it.
   * Sent on the display channel, which viewers that do not know the message
   * simply ignore. `always` sends an empty list too, so a viewer knows all is well.
   */
  private sendNotices(running: RunningSession, always = false) {
    if (running.info.state !== 'connected') return;
    const notices = this.deps.notices?.() ?? [];
    const key = JSON.stringify(notices);
    if (key === running.noticesSent && !always) return;
    if (key !== running.noticesSent && notices.length) {
      this.deps.log.info(`session ${running.info.id}: telling the viewer: ${notices.join(' | ')}`);
    } else if (key !== running.noticesSent && running.noticesSent) {
      this.deps.log.info(`session ${running.info.id}: telling the viewer the earlier problem is resolved`);
    }
    running.noticesSent = key;
    this.emit('notice', running.info.id, { type: 'host-notice', notices });
  }

  private readonly strayInput = new Set<string>();

  /** Input for a session that is not running: said once per session id. */
  private noteStrayInput(sessionId: string) {
    if (this.strayInput.has(sessionId) || this.strayInput.size > 100) return;
    this.strayInput.add(sessionId);
    this.deps.log.warn(`input dropped: session ${sessionId} is not running on this host`);
  }

  /** Clipboard text a viewer copied, to put on this computer's clipboard. */
  handleClipboard(sessionId: string, raw: unknown) {
    if (!this.sessions.has(sessionId) || !this.deps.shareClipboard()) return;
    let message;
    try {
      message = clipboardMessage(raw, '');
    } catch {
      this.deps.log.warn(`session ${sessionId} sent an invalid clipboard message`);
      return;
    }
    // The length only: clipboard contents are the user's data and are never logged.
    this.deps.log.info(`session ${sessionId} clipboard received (${message.text.length} characters)`);
    this.lastClipboard = message.text;
    void this.deps.clipboard.write(message.text).catch(() => {});
  }

  /**
   * This computer's clipboard, sent to viewers when it changes. Polled, because
   * no desktop platform offers a reliable change notification, and only while a
   * session is connected.
   */
  private startClipboardWatch() {
    if (this.clipboardTimer || !this.deps.shareClipboard()) return;
    this.clipboardTimer = setInterval(() => {
      void this.deps.clipboard.read().then(text => {
        if (text === this.lastClipboard || !this.sessions.size) return;
        this.lastClipboard = text;
        for (const running of this.sessions.values()) {
          if (running.info.state !== 'connected') continue;
          running.clipboardSeq++;
          this.emit('clipboard', running.info.id, { type: 'clipboard', seq: running.clipboardSeq, text });
        }
      }).catch(() => {});
    }, 1000);
    this.clipboardTimer.unref?.();
  }

  private stopClipboardWatch() {
    if (!this.clipboardTimer) return;
    clearInterval(this.clipboardTimer);
    this.clipboardTimer = null;
  }
}

/** Unattended access stores the scalar; this checks it is a usable one. */
export function unattendedVerifierLooksValid(base64: string): boolean {
  try {
    const scalar = bytesToBigInt(fromBase64(base64));
    return scalar > 0n;
  } catch {
    return false;
  }
}

/**
 * A viewer's key message mapped to an X11 keysym — the same table the viewer
 * side uses, so what the user pressed is what the host replays.
 */
function keysymForMessage(message: { code: string; key?: string }): number | null {
  return keysymFor({ code: message.code, key: message.key ?? '' });
}
