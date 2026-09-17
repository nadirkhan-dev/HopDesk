import { EventEmitter } from 'node:events';
import { RfbClient, type Rect, type RemoteScreen, type ServerInfo } from './protocols/rfb.js';
import type { Connection } from './connections.js';
import { classifyVncError, type FriendlyError } from './errors.js';

/**
 * Session lifecycle and reconnect.
 *
 * One state machine for every protocol, so the UI shows the same status text
 * whether the transport is VNC, RDP or SPICE:
 *
 *   idle → connecting → connected → reconnecting → connected
 *                   ↘ failed        ↘ failed
 *                                    → disconnected (deliberate)
 *
 * The distinction that matters is **deliberate disconnect versus network
 * drop**. Reconnecting after a user pressed Disconnect is maddening, so the
 * flag is set before teardown and checked before any retry.
 */

export type SessionState =
  | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export interface SessionStats {
  state: SessionState;
  /** Round-trip milliseconds, or null before the first measurement. */
  latencyMs: number | null;
  attempt: number;
  connectedAt: string | null;
  bytesReceived: number;
  framesReceived: number;
  lastError: string | null;
  /** The last failure, classified for display; null while healthy. */
  error: FriendlyError | null;
}

export interface ReconnectPolicy {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Attempts allowed before the first successful connection. A session that
   * was working and dropped deserves patient retries; a first attempt at a
   * wrong address should say so quickly. Defaults to maxAttempts.
   */
  initialAttempts?: number;
}

export const DEFAULT_RECONNECT: ReconnectPolicy = {
  enabled: true,
  maxAttempts: 8,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

/**
 * Exponential backoff with jitter.
 *
 * Jitter matters more than it looks: without it, every client that dropped
 * when a server restarted retries in lockstep and knocks it over again. ±25%
 * is enough to spread the thundering herd.
 */
export function backoffDelay(attempt: number, policy: ReconnectPolicy): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const jitter = exponential * 0.25 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(exponential + jitter));
}

/**
 * Socket errors as sentences a user can act on. Node reports these as
 * "connect ECONNREFUSED 10.0.0.5:5900", which says what happened but not what
 * to do about it.
 */
export function explainVncError(message: string, c: { host: string; port: number }): string {
  const where = `${c.host}:${c.port}`;
  if (/ECONNREFUSED/.test(message)) {
    return `Nothing is accepting VNC connections at ${where}. Check that screen sharing is turned on and the port is right.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    return `The computer name "${c.host}" could not be found. Check the address, or use its IP address.`;
  }
  if (/EHOSTUNREACH|ENETUNREACH/.test(message)) {
    return `${c.host} cannot be reached from this network. Check that both computers are on the same network or VPN.`;
  }
  if (/ETIMEDOUT|No response from/.test(message)) {
    return `${where} did not respond. A firewall may be blocking the port, or the computer is asleep.`;
  }
  if (/No supported authentication method.*Apple Remote Desktop/.test(message)) {
    return `${message}. On the Mac, open System Settings → General → Sharing → Screen Sharing → ⓘ and turn on "VNC viewers may control screen with password".`;
  }
  return message;
}

/** Every rectangle of one FramebufferUpdate, in the order they must be applied. */
export interface FramebufferUpdate {
  width: number;
  height: number;
  rects: Rect[];
}

/** How often the update loop substitutes a 1×1 probe to measure round-trip time. */
const LATENCY_INTERVAL_MS = 5000;
/** Longest the loop waits for the UI to report a frame painted before continuing. */
const RENDER_ACK_TIMEOUT_MS = 1000;

export declare interface Session {
  on(e: 'state', l: (state: SessionState, stats: SessionStats) => void): this;
  on(e: 'frame', l: (rect: Rect) => void): this;
  /** A complete update, batched so a UI can paint it in one pass. */
  on(e: 'update', l: (update: FramebufferUpdate) => void): this;
  on(e: 'resize', l: (size: { width: number; height: number }) => void): this;
  on(e: 'clipboard', l: (text: string) => void): this;
  /** The server can resize its desktop to a size this client asks for. */
  on(e: 'screens', l: (screens: RemoteScreen[]) => void): this;
  on(e: 'resizeRejected', l: (status: number) => void): this;
  on(e: 'error', l: (err: Error) => void): this;
}

export class Session extends EventEmitter {
  private client: RfbClient | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set before teardown so a deliberate disconnect never triggers a retry. */
  private stopping = false;

  /* Update loop. Exactly one FramebufferUpdateRequest is in flight at a time:
     the next is sent only when the previous update has been fully received
     (and, with flow control, painted). Servers answer each request once, so
     this never piles up requests faster than the client can consume them. */
  private pendingRects: Rect[] = [];
  private needFullUpdate = true;
  private lastProbeAt = 0;
  private probeSentAt: number | null = null;
  private flowControl = false;
  private awaitingRender = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  private stats: SessionStats = {
    state: 'idle', latencyMs: null, attempt: 0, connectedAt: null,
    bytesReceived: 0, framesReceived: 0, lastError: null, error: null,
  };

  constructor(
    readonly connection: Connection,
    private readonly password: string | null,
    private readonly policy: ReconnectPolicy = DEFAULT_RECONNECT,
  ) { super(); }

  get current(): SessionStats { return { ...this.stats }; }
  get serverInfo(): ServerInfo | null { return this.client?.serverInfo ?? null; }
  /** Whether the connected server can change its resolution on request. */
  get canResize(): boolean { return this.client?.canResize ?? false; }
  /** Whether clipboard text reaches the server as Unicode. */
  get unicodeClipboard(): boolean { return this.client?.unicodeClipboard ?? false; }

  private setState(state: SessionState, error?: string) {
    this.stats.state = state;
    if (error !== undefined) this.stats.lastError = error;
    this.emit('state', state, this.current);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.stats.attempt = 0;
    await this.attempt();
  }

  private async attempt(): Promise<void> {
    if (this.stopping) return;

    this.stats.attempt++;
    this.setState(this.stats.attempt === 1 ? 'connecting' : 'reconnecting');

    let client: RfbClient | null = null;
    try {
      if (this.connection.protocol !== 'vnc') {
        // RDP and SPICE are driven by an external engine; the session wrapper
        // is shared but the transport is not this class's job.
        throw new Error(
          `${this.connection.protocol.toUpperCase()} sessions are launched through their own engine`);
      }

      client = new RfbClient({
        host: this.connection.host,
        port: this.connection.port,
        password: this.password ?? undefined,
        timeoutMs: 12_000,
      });
      this.client = client;
      const current = client;

      client.on('rect', rect => {
        if (rect.data) this.stats.bytesReceived += rect.data.length;
        this.pendingRects.push(rect);
        this.emit('frame', rect);
      });
      client.on('updateEnd', () => this.onUpdateEnd(current));
      client.on('resize', size => {
        // Everything on screen is now stale; ask for all of it again.
        this.needFullUpdate = true;
        this.emit('resize', size);
      });
      client.on('screens', screens => this.emit('screens', screens));
      client.on('resizeRejected', status => this.emit('resizeRejected', status));
      client.on('clipboard', text => {
        if (this.connection.options.shareClipboard) this.emit('clipboard', text);
      });
      client.on('close', () => { if (this.client === current) this.onDropped('The connection closed'); });
      client.on('error', err => { if (this.client === current) this.onDropped(err.message); });

      await client.connect();

      this.stats.attempt = 0;                    // a success resets the budget
      this.stats.connectedAt = new Date().toISOString();
      this.stats.lastError = null;
      this.stats.error = null;
      this.pendingRects = [];
      this.needFullUpdate = true;
      this.probeSentAt = null;
      this.awaitingRender = false;
      this.setState('connected');
      this.requestNext();
    } catch (err) {
      // Already handled: the client's own error or close event got here first,
      // or the user disconnected while the handshake was in progress. Handling
      // it twice would schedule two reconnect timers.
      if (client && this.client !== client) return;
      this.onDropped((err as Error).message);
    }
  }

  /**
   * Holds the next request until `renderComplete()` is called, so a UI that
   * paints slower than the network delivers is never flooded. Without it,
   * updates queue up in IPC and the screen shown drifts seconds behind.
   */
  setFlowControl(enabled: boolean) {
    this.flowControl = enabled;
    if (!enabled) this.renderComplete();
  }

  /** The UI has painted the last update; the loop may continue. */
  renderComplete() {
    if (!this.awaitingRender) return;
    this.awaitingRender = false;
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    this.requestNext();
  }

  private onUpdateEnd(client: RfbClient) {
    if (this.client !== client) return;

    if (this.probeSentAt !== null) {
      this.stats.latencyMs = Date.now() - this.probeSentAt;
      this.probeSentAt = null;
    }

    const info = client.serverInfo;
    const rects = this.pendingRects;
    this.pendingRects = [];
    if (rects.length && info) {
      this.stats.framesReceived++;
      this.emit('update', { width: info.width, height: info.height, rects });
    }

    if (this.flowControl && rects.length) {
      this.awaitingRender = true;
      // A UI that was reloaded or closed must not stall the session forever.
      this.renderTimer = setTimeout(() => this.renderComplete(), RENDER_ACK_TIMEOUT_MS);
      this.renderTimer.unref?.();
      return;
    }
    this.requestNext();
  }

  /**
   * Sends the one request that keeps the screen live.
   *
   * RFB has no ping, so every few seconds the regular incremental request is
   * replaced by a 1×1 non-incremental one: the server must answer it at once,
   * and the round trip is the latency figure. Replacing rather than adding a
   * request keeps exactly one request in flight.
   */
  private requestNext() {
    const client = this.client;
    if (!client || this.stopping) return;

    const now = Date.now();
    if (this.needFullUpdate) {
      this.needFullUpdate = false;
      client.requestUpdate(false);
    } else if (now - this.lastProbeAt >= LATENCY_INTERVAL_MS) {
      this.lastProbeAt = now;
      this.probeSentAt = now;
      client.requestUpdate(false, { x: 0, y: 0, width: 1, height: 1 });
    } else {
      client.requestUpdate(true);
    }
  }

  /**
   * Handles a drop from either a failed connect or a live session ending.
   *
   * Authentication failures are terminal: retrying a wrong password eight times
   * achieves nothing except locking the account on servers that count attempts.
   */
  private onDropped(reason: string) {
    this.stopLoop();
    // Cleared before disconnecting, so the close event this triggers is
    // recognised as stale and does not re-enter here.
    const client = this.client;
    this.client = null;
    client?.disconnect();

    if (this.stopping) { this.setState('disconnected'); return; }

    this.stats.error = classifyVncError(reason, this.connection);
    reason = explainVncError(reason, this.connection);
    const terminal = /password|authentication|refused the connection|Not a VNC server|No supported authentication/i.test(reason);

    const limit = this.stats.connectedAt ? this.policy.maxAttempts : (this.policy.initialAttempts ?? this.policy.maxAttempts);
    if (!this.policy.enabled || terminal || this.stats.attempt >= limit) {
      this.setState('failed', terminal
        ? reason
        : `${reason} (gave up after ${this.stats.attempt} attempt${this.stats.attempt === 1 ? '' : 's'})`);
      return;
    }

    const delay = backoffDelay(this.stats.attempt, this.policy);
    this.setState('reconnecting', reason);
    this.timer = setTimeout(() => { void this.attempt(); }, delay);
  }

  private stopLoop() {
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    this.awaitingRender = false;
    this.probeSentAt = null;
    this.pendingRects = [];
  }

  /** Deliberate disconnect. Suppresses reconnect. */
  stop() {
    const wasActive = this.stats.state !== 'idle' && this.stats.state !== 'disconnected';
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopLoop();
    const client = this.client;
    this.client = null;
    client?.disconnect();
    // A failed session is already over; reporting it again as "disconnected"
    // would hide the reason it failed.
    if (wasActive && this.stats.state !== 'failed') this.setState('disconnected');
  }

  /** Forces a full repaint, for example after the UI lost its framebuffer. */
  requestUpdate(incremental = true) {
    if (!incremental) this.needFullUpdate = true;
    if (!this.awaitingRender && !incremental) this.client?.requestUpdate(false);
  }
  sendKey(keysym: number, down: boolean) {
    if (this.connection.options.viewOnly) return;
    this.client?.sendKey(keysym, down);
  }
  sendPointer(x: number, y: number, mask: number) {
    if (this.connection.options.viewOnly) return;
    this.client?.sendPointer(x, y, mask);
  }
  /**
   * Sends local clipboard text. Returns null when nothing was sent (sharing off,
   * not connected), otherwise whether the text arrived without loss — false
   * when the server only accepts Latin-1 and the text had other characters.
   */
  sendClipboard(text: string): { lossless: boolean } | null {
    if (!this.connection.options.shareClipboard || !this.client) return null;
    return this.client.sendClipboard(text);
  }

  /** Asks the server to match the given size. False if it cannot resize. */
  requestDesktopSize(width: number, height: number): boolean {
    if (this.connection.options.viewOnly) return false;
    return this.client?.requestDesktopSize(width, height) ?? false;
  }

}
