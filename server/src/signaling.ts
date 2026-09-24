import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { signalingMessage, obj, str, literal, tagged, parseJson, SchemaError, type Check } from '@hopdesk/protocol';
import type { Store } from './store.js';
import type { Api } from './api.js';
import { Presence, type Connection } from './presence.js';

/**
 * The rendezvous: it introduces two computers on the same account and then
 * carries opaque frames between them.
 *
 * What it can see: which devices are connected, which one asked to reach which,
 * and when. What it cannot see: anything inside a session. The frames it relays
 * are the same handshake and sealed messages the two computers exchange
 * directly on a local network — the keys come from the devices, so this server
 * cannot read a session, join one, or impersonate either side.
 *
 * It is deliberately strict about shape and volume, because it is the one part
 * of HopDesk exposed to the internet.
 */

const MAX_MESSAGE_BYTES = 256 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 120_000;
const MAX_SESSIONS_PER_DEVICE = 4;
/** Frames one connection may send per second before it is disconnected. */
const MAX_FRAMES_PER_SECOND = 400;

const deviceId = str({ max: 12, pattern: /^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/ });

const clientMessage = tagged('type', {
  auth: obj({ type: literal('auth'), token: str({ min: 8, max: 2048 }) }),
  connect: obj({ type: literal('connect'), target: deviceId }),
  frame: obj({ type: literal('frame'), sessionId: str({ min: 8, max: 64 }), payload: signalingMessage as Check<unknown> }),
  close: obj({ type: literal('close'), sessionId: str({ min: 8, max: 64 }) }),
  ping: obj({ type: literal('ping') }),
});

export interface SignalingDependencies {
  store: Store;
  api: Api;
  presence: Presence;
  log: (message: string) => void;
  now?: () => number;
}

export class SignalingServer {
  private readonly wss: WebSocketServer;
  private readonly now: () => number;
  /** Set by close(), so a socket closing during shutdown writes nothing. */
  private stopping = false;

  constructor(private readonly deps: SignalingDependencies) {
    this.now = deps.now ?? Date.now;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  }

  /** Called from the HTTP server's upgrade event for /ws. */
  handleUpgrade(req: IncomingMessage, socket: Parameters<WebSocketServer['handleUpgrade']>[1], head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws));
  }

  private accept(ws: WebSocket) {
    let connection: Connection | null = null;
    let frames = 0;
    let windowStart = this.now();
    let lastSeen = this.now();

    const send = (message: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };

    /* An unauthenticated socket is closed quickly: it costs the server memory
       and proves nothing about who opened it. */
    const authTimer = setTimeout(() => {
      if (!connection) ws.close(4000, 'no credentials');
    }, AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    const idleTimer = setInterval(() => {
      if (this.now() - lastSeen > IDLE_TIMEOUT_MS) ws.close(4008, 'idle');
    }, 30_000);
    idleTimer.unref?.();

    ws.on('message', (data, isBinary) => {
      lastSeen = this.now();
      if (isBinary) { ws.close(4002, 'binary frames are not used'); return; }

      // Cheap rate limit: a relay must not be usable as an amplifier.
      if (this.now() - windowStart > 1000) { windowStart = this.now(); frames = 0; }
      if (++frames > MAX_FRAMES_PER_SECOND) { ws.close(4029, 'too many messages'); return; }

      let message;
      try {
        message = parseJson(clientMessage, data.toString('utf8'), MAX_MESSAGE_BYTES);
      } catch (err) {
        send({ type: 'error', error: 'invalid-message', detail: err instanceof SchemaError ? err.message : 'unreadable' });
        ws.close(4002, 'invalid message');
        return;
      }

      if (message.type === 'auth') {
        if (connection) { ws.close(4002, 'already authenticated'); return; }
        const caller = this.deps.api.authenticateToken(message.token);
        if (!caller?.deviceId) {
          // A token that is not tied to a device cannot be a session endpoint.
          ws.close(4001, 'unauthorised');
          return;
        }
        /* A computer that has been added to the account but not yet vouched
           for by one already on it gets no further than this. Refused here
           rather than at the introduction, so it cannot reach another
           computer, cannot be reached, and cannot see who is online. It can
           still sign in over HTTP and be told it is waiting. */
        const device = this.deps.store.deviceById(caller.deviceId);
        if (!device?.approved) {
          /* 4005 and not 4003: "removed from the account" is final, while
             this is a computer that will be let in the moment somebody says
             so, and it has to reconnect by itself when that happens rather
             than waiting to be restarted. */
          this.deps.log(`device ${caller.deviceId} is not approved yet; refusing the relay`);
          ws.close(4005, 'this computer is waiting to be approved from one of your other computers');
          return;
        }
        clearTimeout(authTimer);
        connection = { deviceId: caller.deviceId, accountId: caller.accountId, send, close: (code, reason) => ws.close(code, reason) };
        this.deps.presence.add(connection);
        this.deps.store.touchDevice(caller.deviceId, this.now());
        this.deps.log(`device ${caller.deviceId} connected`);
        send({ type: 'ready', deviceId: caller.deviceId });
        return;
      }

      if (!connection) { ws.close(4001, 'credentials first'); return; }

      switch (message.type) {
        case 'ping':
          send({ type: 'pong' });
          return;

        case 'connect': {
          const target = this.deps.store.deviceById(message.target);
          /* Both devices must be on the same account. This is the only
             authorisation this server performs, and it is also checked again by
             the host itself against the key the caller signs with. */
          if (!target || target.accountId !== connection.accountId) {
            send({ type: 'connect-failed', target: message.target, reason: 'not-found' });
            return;
          }
          if (target.deviceId === connection.deviceId) {
            send({ type: 'connect-failed', target: message.target, reason: 'same-device' });
            return;
          }
          const peer = this.deps.presence.get(message.target);
          if (!peer) {
            send({ type: 'connect-failed', target: message.target, reason: 'offline' });
            return;
          }
          if (this.deps.presence.sessionsOf(connection).length >= MAX_SESSIONS_PER_DEVICE
            || this.deps.presence.sessionsOf(peer).length >= MAX_SESSIONS_PER_DEVICE) {
            send({ type: 'connect-failed', target: message.target, reason: 'busy' });
            return;
          }
          const sessionId = randomUUID();
          this.deps.presence.openSession(sessionId, connection, peer);
          const self = this.deps.store.deviceById(connection.deviceId);
          // Each side is told the other's registered key, so it knows which
          // signature to expect; the signature itself is what proves identity.
          peer.send({
            type: 'session', sessionId, role: 'host',
            peer: { deviceId: connection.deviceId, name: self?.name ?? connection.deviceId, publicKey: self?.publicKey ?? '' },
          });
          send({
            type: 'session', sessionId, role: 'viewer',
            peer: { deviceId: target.deviceId, name: target.name, publicKey: target.publicKey },
          });
          this.deps.log(`session ${sessionId}: ${connection.deviceId} → ${target.deviceId}`);
          return;
        }

        case 'frame': {
          const peer = this.deps.presence.peer(message.sessionId, connection);
          if (!peer) { send({ type: 'session-ended', sessionId: message.sessionId, reason: 'unknown-session' }); return; }
          // Relayed exactly as it arrived; the server does not look inside.
          peer.send({ type: 'frame', sessionId: message.sessionId, payload: message.payload });
          return;
        }

        case 'close':
          if (this.deps.presence.peer(message.sessionId, connection)) {
            this.deps.presence.endSession(message.sessionId, 'closed');
          }
          return;
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(idleTimer);
      if (connection) {
        this.deps.presence.remove(connection);
        /* Stamped on the way out as well as on the way in, so "last seen" is
           when the device was last here rather than when it last arrived -
           which, for a computer that stayed connected for a week, is a very
           different date.

           Not while the server is stopping: shutdown closes these sockets
           after the database, and a write then throws "database is not open"
           from inside an event handler, where nothing can catch it. */
        if (!this.stopping) {
          try { this.deps.store.touchDevice(connection.deviceId, this.now()); } catch { /* going away anyway */ }
        }
        this.deps.log(`device ${connection.deviceId} disconnected`);
      }
    });
    ws.on('error', () => ws.close());
  }

  close() {
    this.stopping = true;
    for (const client of this.wss.clients) client.close(1001, 'server stopping');
    this.wss.close();
  }
}
