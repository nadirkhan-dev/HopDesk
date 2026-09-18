import { EventEmitter } from 'node:events';
import {
  connectToHost, HandshakeError, type EndReason, type MessageLink, type ViewerSession,
} from '@hopdesk/protocol';
import { connectLan, findHosts, negotiateAsViewer, DEFAULT_LAN_PORT } from '@hopdesk/transport';
import { normalizeAccessCode, normalizeDeviceId } from '@hopdesk/crypto';
import type { LocalIdentity } from './identity.js';
import type { RtcPeerHandle } from './rtc-bridge.js';

/**
 * This computer as a Viewer: connecting to another HopDesk computer with its
 * Device ID and access code, and nothing else — no address, no port, no
 * protocol choice.
 *
 * The Device ID is looked up on the local network by mDNS. An address can be
 * given instead for networks where multicast is blocked. Either way the
 * handshake verifies that whoever answered really holds the key behind that
 * Device ID, so a wrong or hostile answer cannot pass.
 */

export type ViewerState = 'looking' | 'connecting' | 'waiting-for-consent' | 'connected' | 'reconnecting' | 'ended';

export interface ViewerStatus {
  state: ViewerState;
  deviceId: string;
  hostName?: string;
  sessionId?: string;
  /** How the session is carried: on this network, directly, or via the relay. */
  connection?: string;
  /** Present when the session ended or failed. */
  error?: { code: string; message: string };
  /** Whether a reconnect can be attempted without asking the host again. */
  resumable: boolean;
}

export interface ViewerDependencies {
  identity: LocalIdentity;
  viewerName: string;
  log: { info(m: string): void; warn(m: string): void };
  /** Creates the peer connection for this session in the window showing it. */
  createPeer: (sessionId: string, iceServers: unknown[]) => Promise<{ peer: RtcPeerHandle; close: () => void }>;
  /** How that session ended up connected, once it is. */
  connectionKind?: (sessionId: string) => string | undefined;
  /** Relay and STUN servers, for a session that cannot go direct. */
  iceServers?: () => Promise<unknown[]>;
  /** Known host keys, so a changed identity is noticed rather than trusted. */
  pinnedKey: (deviceId: string) => Uint8Array | undefined;
  rememberKey: (deviceId: string, key: Uint8Array, name: string) => void;
}

export interface ConnectRequest {
  deviceId: string;
  code: string;
  /** Optional address, for networks where discovery does not work. */
  address?: string;
  port?: number;
}

export class ViewerRole extends EventEmitter {
  private session: ViewerSession | null = null;
  private peer: { peer: RtcPeerHandle; close: () => void } | null = null;
  private status: ViewerStatus = { state: 'ended', deviceId: '', resumable: false };
  private grant: { id: string; secret: Uint8Array; expiresAt: number } | null = null;
  private lastRequest: ConnectRequest | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  /** Set when the other side ended the session on purpose: do not come back. */
  private endedByPeer: EndReason | null = null;

  constructor(private readonly deps: ViewerDependencies) { super(); }

  current(): ViewerStatus { return { ...this.status }; }

  private setStatus(patch: Partial<ViewerStatus>) {
    this.status = { ...this.status, ...patch };
    this.deps.log.info(`viewer state -> ${this.status.state}${this.status.error ? ` (${this.status.error.code})` : ''}`);
    this.emit('status', this.current());
  }

  /**
   * Connects to a computer on the same HopDesk account, over a link the server
   * has relayed. There is no code to type: the account says these two computers
   * belong together, and the device keys prove which is which.
   */
  async connectAccount(link: MessageLink, target: { deviceId: string; name?: string; publicKey?: Uint8Array }): Promise<ViewerStatus> {
    this.stopped = false;
    this.attempt = 0;
    this.lastRequest = null;
    this.grant = null;
    this.setStatus({
      state: 'waiting-for-consent', deviceId: target.deviceId, resumable: false,
      error: undefined, hostName: target.name, sessionId: undefined,
    });

    /* The key the account gave us is what the host's signature must match; a
       key pinned from an earlier session wins, so a server that changes its
       answer is caught rather than trusted. */
    const pinned = this.deps.pinnedKey(target.deviceId) ?? target.publicKey;
    let session: ViewerSession;
    try {
      session = await connectToHost(link, {
        identity: this.deps.identity.identity,
        viewerName: this.deps.viewerName,
        hostId: target.deviceId,
        credential: { kind: 'account' },
        ...(pinned ? { expectedHostKey: pinned } : {}),
      });
    } catch (err) {
      const code = err instanceof HandshakeError ? err.code : 'error';
      this.setStatus({ state: 'ended', error: { code, message: (err as Error).message } });
      throw err;
    }
    await this.startSession(session, target.deviceId);
    return this.current();
  }

  async connect(request: ConnectRequest): Promise<ViewerStatus> {
    const deviceId = normalizeDeviceId(request.deviceId);
    if (!deviceId) throw new Error('That is not a HopDesk Device ID. It looks like HD-7K3M-Q9TX.');
    const code = normalizeAccessCode(request.code);
    if (!code) throw new Error('An access code is six digits, like 739 421.');

    this.stopped = false;
    this.attempt = 0;
    this.lastRequest = { ...request, deviceId, code };
    this.grant = null;
    await this.attemptConnect({ deviceId, code });
    return this.current();
  }

  private async attemptConnect({ deviceId, code }: { deviceId: string; code: string }) {
    this.setStatus({ state: 'looking', deviceId, resumable: false, error: undefined, hostName: undefined, sessionId: undefined });

    const target = await this.locate(deviceId, this.lastRequest?.address, this.lastRequest?.port);
    this.setStatus({ state: 'connecting' });

    const link = await connectLan(target.address, target.port);
    const pinned = this.deps.pinnedKey(deviceId);
    let session: ViewerSession;
    try {
      this.setStatus({ state: 'waiting-for-consent' });
      session = await connectToHost(link, {
        identity: this.deps.identity.identity,
        viewerName: this.deps.viewerName,
        hostId: deviceId,
        credential: this.grant
          ? { kind: 'grant', id: this.grant.id, secret: this.grant.secret }
          : { kind: 'code', code },
        ...(pinned ? { expectedHostKey: pinned } : {}),
      });
    } catch (err) {
      const code2 = err instanceof HandshakeError ? err.code : 'error';
      this.setStatus({ state: 'ended', error: { code: code2, message: (err as Error).message } });
      throw err;
    }

    await this.startSession(session, deviceId);
  }

  /** Everything after a successful handshake, however the link was made. */
  private async startSession(session: ViewerSession, deviceId: string) {
    this.session = session;
    this.deps.rememberKey(deviceId, session.host.hostKey, session.host.hostName);
    if (session.grant) this.grant = session.grant;
    this.setStatus({ state: 'connecting', hostName: session.host.hostName, sessionId: session.sessionId, resumable: !!this.grant });

    session.control.onClose(() => this.onClosed());

    const iceServers = this.deps.iceServers ? await this.deps.iceServers().catch(() => []) : [];
    const peer = await this.deps.createPeer(session.sessionId, iceServers);
    this.peer = peer;
    try {
      await negotiateAsViewer(session.control, peer.peer);
    } catch (err) {
      this.setStatus({ state: 'ended', error: { code: 'media', message: (err as Error).message } });
      this.teardown();
      throw err;
    }
    /* From here on the control channel carries the session itself. A `bye` is
       the other side ending it deliberately, which must never be answered with
       a silent reconnect — only an unexpected drop is. */
    session.control.onMessage(message => {
      if (message.type === 'ping') session.control.send({ type: 'pong', t: message.t });
      else if (message.type === 'bye') this.endedByPeer = message.reason;
    });

    this.attempt = 0;
    this.setStatus({ state: 'connected', connection: this.deps.connectionKind?.(session.sessionId) ?? 'direct' });
    this.deps.log.info(`viewer session ${session.sessionId} connected to ${deviceId}`);
  }

  /** Where to reach a Device ID: an address if given, otherwise mDNS. */
  private async locate(deviceId: string, address?: string, port?: number): Promise<{ address: string; port: number }> {
    if (address) return { address, port: port ?? DEFAULT_LAN_PORT };
    const hosts = await findHosts({ deviceId, timeoutMs: 3000 });
    const match = hosts.find(h => h.deviceId === deviceId);
    if (!match) {
      throw Object.assign(
        new Error(`No computer with the Device ID ${deviceId} answered on this network.`),
        { code: 'not-found' },
      );
    }
    return { address: match.address, port: match.port };
  }

  /** The control connection dropped. Resume silently if a grant allows it. */
  private onClosed() {
    if (this.stopped || !this.session) return;
    const request = this.lastRequest;
    const deliberate = this.endedByPeer;
    this.endedByPeer = null;
    this.teardown();
    if (deliberate) {
      // The host disconnected, stopped sharing, or revoked access.
      this.grant = null;
      this.setStatus({ state: 'ended', resumable: false, error: { code: deliberate, message: endMessage(deliberate) } });
      return;
    }
    if (!request || !this.grant || this.grant.expiresAt <= Date.now() || this.attempt >= 5) {
      this.setStatus({ state: 'ended', resumable: false });
      return;
    }
    this.attempt++;
    const delay = Math.min(8000, 500 * 2 ** (this.attempt - 1));
    this.setStatus({ state: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => {
      void this.attemptConnect({ deviceId: request.deviceId, code: request.code }).catch(err => {
        this.deps.log.warn(`reconnect failed: ${(err as Error).message}`);
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private teardown() {
    this.peer?.peer.dispose();
    this.peer?.close();
    this.peer = null;
    this.session = null;
  }

  /** Sends a control message, e.g. the viewer's window size. */
  send(message: Parameters<NonNullable<ViewerSession['control']>['send']>[0]) {
    this.session?.control.send(message);
  }

  disconnect(reason: EndReason = 'user-disconnected') {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const session = this.session;
    this.teardown();
    if (session) {
      try { session.control.send({ type: 'bye', reason }); } catch { /* already gone */ }
      session.control.close();
    }
    this.grant = null;
    this.endedByPeer = null;
    this.setStatus({ state: 'ended', resumable: false });
  }
}

function endMessage(reason: EndReason): string {
  switch (reason) {
    case 'user-disconnected': return 'The person at the other computer ended the session.';
    case 'host-stopped': return 'The other computer stopped sharing its screen.';
    case 'revoked': return 'Access to that computer was withdrawn.';
    case 'idle': return 'The session ended after being idle.';
    default: return 'The session ended because of an error.';
  }
}
