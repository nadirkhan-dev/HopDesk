import type { MessageLink, SignalingMessage } from '@hopdesk/protocol';

/**
 * The client side of a HopDesk server's rendezvous.
 *
 * One WebSocket carries every session this computer is part of. The server
 * introduces two devices on the same account and then forwards frames between
 * them; those frames are the same handshake and sealed messages that travel
 * directly on a local network, so a session over the relay is exactly as
 * private as one that never left the building.
 *
 * The socket reconnects on its own, because a computer that is meant to be
 * reachable has to come back after a network hiccup without anyone logging in.
 */

export interface RelayPeer {
  deviceId: string;
  name: string;
  /** The key the server has registered for that device, base64. A hint for
   *  pinning; the handshake still verifies a signature against it. */
  publicKey: string;
}

export interface RelaySessionIntro {
  sessionId: string;
  role: 'host' | 'viewer';
  peer: RelayPeer;
}

export type RelayState = 'offline' | 'connecting' | 'online';

/** Another device on this account came or went. */
export interface PresenceChange {
  deviceId: string;
  online: boolean;
  /** When the server last saw it, epoch milliseconds. */
  lastSeen: number;
}

/**
 * How often this computer says it is still here.
 *
 * The server closes a socket that has said nothing for two minutes. Nothing
 * used to be sent between sessions, so an idle host was closed, reconnected
 * with a backoff of up to thirty seconds, and read as offline on every other
 * screen in the meantime - while being perfectly reachable the whole time.
 */
const HEARTBEAT_MS = 30_000;

export interface RelayClientOptions {
  /** e.g. wss://hopdesk.example.com/ws */
  url: string;
  /** This device's token, from enrolment. */
  token: string;
  /** A session another computer started with this one. */
  onIncoming: (intro: RelaySessionIntro, link: MessageLink) => void;
  onState?: (state: RelayState, detail?: string) => void;
  /** Another device on this account connected or disconnected. */
  onPresence?: (change: PresenceChange) => void;
  log?: (message: string) => void;
  /** Injectable for tests; defaults to the global WebSocket. */
  createSocket?: (url: string) => WebSocket;
  reconnect?: boolean;
}

export class RelayError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

interface SessionEntry {
  link: RelayLink;
  intro: RelaySessionIntro;
}

export class RelayClient {
  private socket: WebSocket | null = null;
  private state: RelayState = 'offline';
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly pendingConnects = new Map<string, { resolve: (v: { intro: RelaySessionIntro; link: MessageLink }) => void; reject: (e: Error) => void }>();
  private closing = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: RelayClientOptions) {}

  get connected() { return this.state === 'online'; }
  get deviceSessions() { return [...this.sessions.values()].map(s => s.intro); }

  /** Connects and authenticates. Resolves when the server has accepted us. */
  connect(): Promise<void> {
    this.closing = false;
    return new Promise<void>((resolve, reject) => {
      this.open(resolve, reject);
    });
  }

  private open(resolve?: () => void, reject?: (e: Error) => void) {
    this.setState('connecting');
    const create = this.opts.createSocket ?? ((url: string) => new WebSocket(url));
    let socket: WebSocket;
    try {
      socket = create(this.opts.url);
    } catch (err) {
      this.fail(new RelayError('unreachable', (err as Error).message), reject);
      return;
    }
    this.socket = socket;

    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: this.opts.token }));
    socket.onmessage = event => this.receive(String(event.data), resolve);
    socket.onerror = () => { /* reported through onclose */ };
    socket.onclose = event => {
      const wasOnline = this.state === 'online';
      this.socket = null;
      this.stopHeartbeat();
      for (const [id] of this.sessions) this.endSession(id, 'the connection to the server was lost');
      for (const [, pending] of this.pendingConnects) pending.reject(new RelayError('offline', 'The connection to the server was lost'));
      this.pendingConnects.clear();

      /* 4001 and 4003 mean this device's credentials are no longer good —
         reconnecting would only repeat the refusal. */
      const permanent = event.code === 4001 || event.code === 4003;
      this.setState('offline', permanent ? (event.reason || 'this computer is no longer enrolled') : event.reason);
      if (permanent) {
        this.fail(new RelayError('unauthorised', event.reason || 'This computer is no longer enrolled'), reject);
        return;
      }
      if (!wasOnline && reject) {
        this.fail(new RelayError('unreachable', event.reason || 'The server did not accept the connection'), reject);
        return;
      }
      this.scheduleRetry();
    };
  }

  private fail(error: RelayError, reject?: (e: Error) => void) {
    this.opts.log?.(`relay: ${error.message}`);
    if (reject) reject(error);
    else if (this.opts.reconnect !== false && error.code !== 'unauthorised') this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.closing || this.opts.reconnect === false || this.retryTimer) return;
    this.attempt++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closing) this.open();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Says "still here" often enough that the server never closes this socket. */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState !== 1) return;
      try { this.socket.send(JSON.stringify({ type: 'ping' })); } catch { /* the close handler deals with it */ }
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private setState(state: RelayState, detail?: string) {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state, detail);
  }

  private receive(raw: string, resolve?: () => void) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case 'ready':
        this.attempt = 0;
        this.setState('online');
        this.startHeartbeat();
        this.opts.log?.(`relay: connected as ${String(message.deviceId)}`);
        resolve?.();
        return;

      case 'pong':
        return;                                   // proof the socket is alive

      case 'presence': {
        if (typeof message.deviceId !== 'string' || typeof message.online !== 'boolean') return;
        this.opts.onPresence?.({
          deviceId: message.deviceId,
          online: message.online,
          lastSeen: typeof message.lastSeen === 'number' ? message.lastSeen : Date.now(),
        });
        return;
      }

      case 'session': {
        const intro = this.toIntro(message);
        if (!intro) return;
        const link = new RelayLink(intro.sessionId, this);
        this.sessions.set(intro.sessionId, { link, intro });
        if (intro.role === 'viewer') {
          const pending = this.pendingConnects.get(intro.peer.deviceId);
          this.pendingConnects.delete(intro.peer.deviceId);
          pending?.resolve({ intro, link });
        } else {
          this.opts.onIncoming(intro, link);
        }
        return;
      }

      case 'connect-failed': {
        const target = String(message.target ?? '');
        const pending = this.pendingConnects.get(target);
        this.pendingConnects.delete(target);
        pending?.reject(new RelayError(String(message.reason ?? 'failed'), reasonText(String(message.reason ?? ''))));
        return;
      }

      case 'frame': {
        const entry = this.sessions.get(String(message.sessionId));
        entry?.link.deliver(message.payload);
        return;
      }

      case 'session-ended':
        this.endSession(String(message.sessionId), reasonText(String(message.reason ?? '')));
        return;

      default:
        return;
    }
  }

  private toIntro(message: Record<string, unknown>): RelaySessionIntro | null {
    const peer = message.peer as Record<string, unknown> | undefined;
    if (typeof message.sessionId !== 'string' || typeof peer?.deviceId !== 'string') return null;
    if (message.role !== 'host' && message.role !== 'viewer') return null;
    return {
      sessionId: message.sessionId,
      role: message.role,
      peer: {
        deviceId: peer.deviceId,
        name: typeof peer.name === 'string' ? peer.name : peer.deviceId,
        publicKey: typeof peer.publicKey === 'string' ? peer.publicKey : '',
      },
    };
  }

  /** Asks the server to introduce this computer to another on the account. */
  requestSession(target: string, timeoutMs = 15_000): Promise<{ intro: RelaySessionIntro; link: MessageLink }> {
    if (this.state !== 'online' || !this.socket) {
      return Promise.reject(new RelayError('offline', 'Not connected to the HopDesk server'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConnects.delete(target);
        reject(new RelayError('timeout', 'The server did not answer in time'));
      }, timeoutMs);
      this.pendingConnects.set(target, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.socket!.send(JSON.stringify({ type: 'connect', target }));
    });
  }

  /** Called by a session's link. */
  sendFrame(sessionId: string, payload: SignalingMessage) {
    if (this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify({ type: 'frame', sessionId, payload }));
    }
  }

  closeSession(sessionId: string) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type: 'close', sessionId }));
    this.endSession(sessionId, 'closed');
  }

  private endSession(sessionId: string, reason: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    entry.link.remoteClosed(reason);
  }

  close() {
    this.closing = true;
    this.stopHeartbeat();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    for (const [id] of this.sessions) this.endSession(id, 'closed');
    this.socket?.close();
    this.socket = null;
    this.setState('offline');
  }
}

/** One session's MessageLink, carried inside the relay's WebSocket. */
class RelayLink implements MessageLink {
  private handler: (message: unknown) => void = () => {};
  private readonly closeHandlers: ((error?: Error) => void)[] = [];
  private backlog: unknown[] = [];
  private hasHandler = false;
  closed = false;

  constructor(private readonly sessionId: string, private readonly client: RelayClient) {}

  send(message: SignalingMessage) {
    if (!this.closed) this.client.sendFrame(this.sessionId, message);
  }

  onMessage(handler: (message: unknown) => void) {
    this.handler = handler;
    this.hasHandler = true;
    for (const message of this.backlog.splice(0)) handler(message);
  }

  onClose(handler: (error?: Error) => void) {
    if (this.closed) handler();
    else this.closeHandlers.push(handler);
  }

  deliver(payload: unknown) {
    if (this.closed) return;
    if (this.hasHandler) this.handler(payload);
    else this.backlog.push(payload);
  }

  /** The server or the peer ended it. */
  remoteClosed(reason: string) {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(reason);
    for (const handler of this.closeHandlers.splice(0)) handler(error);
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers.splice(0)) handler(error);
    this.client.closeSession(this.sessionId);
  }
}

function reasonText(reason: string): string {
  switch (reason) {
    case 'offline': return 'That computer is not connected to the HopDesk server right now.';
    case 'not-found': return 'That computer is not on this account.';
    case 'same-device': return 'That is this computer.';
    case 'busy': return 'That computer already has as many sessions as it allows.';
    case 'peer-disconnected': return 'The other computer disconnected.';
    case 'unknown-session': return 'That session is no longer open.';
    default: return reason || 'The session ended.';
  }
}
