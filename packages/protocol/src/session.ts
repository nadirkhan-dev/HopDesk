import { randomBytes } from 'node:crypto';
import { SealedChannel, fromBase64, toBase64, utf8 } from '@hopdesk/crypto';
import {
  controlMessage, signalingMessage, type AuthKind, type ControlMessage, type RejectReason, type SignalingMessage,
} from './messages.js';
import { SchemaError, parseJson, type Check } from './schema.js';
import {
  HandshakeError, HostAuthenticator, ViewerHandshake,
  type AuthenticatedHost, type AuthenticatedViewer, type ViewerHandshakeOptions,
} from './handshake.js';
import type { GrantStore } from './grants.js';

/**
 * Running the handshake and the encrypted control channel over any
 * message-oriented link: a LAN socket, a signaling-server relay, or a WebRTC
 * data channel. The link only ever carries the handshake and sealed frames.
 */

export interface MessageLink {
  send(message: SignalingMessage): void;
  /** Replaces the previous handler. Messages are untrusted, unvalidated values. */
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(error?: Error): void;
  readonly closed: boolean;
}

/** Buffers link messages so a flow can await them one at a time. */
class Inbox {
  private readonly queue: SignalingMessage[] = [];
  private waiter: { resolve: (m: SignalingMessage) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(private readonly link: MessageLink) {
    link.onMessage(raw => {
      let message: SignalingMessage;
      try {
        message = signalingMessage(raw, '');
      } catch (err) {
        this.fail(new HandshakeError('protocol', (err as Error).message));
        link.close(this.failure!);
        return;
      }
      if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(message); }
      else this.queue.push(message);
    });
    link.onClose(err => this.fail(err instanceof HandshakeError ? err : new HandshakeError('closed', 'The connection closed')));
  }

  private fail(error: Error) {
    this.failure ??= error;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(this.failure); }
  }

  next(timeoutMs: number): Promise<SignalingMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new HandshakeError('timeout', 'The other device did not answer in time'));
      }, timeoutMs);
      this.waiter = {
        resolve: m => { clearTimeout(timer); resolve(m); },
        reject: e => { clearTimeout(timer); reject(e); },
      };
    });
  }

  /** Hands any queued messages to a new consumer. */
  drain(): SignalingMessage[] { return this.queue.splice(0); }
}

/**
 * The sealed control channel. Any frame that fails authentication, arrives
 * out of order or does not match the schema closes the link: a session that
 * has seen tampering is not trustworthy for anything that follows.
 */
export class SecureControl {
  private readonly channel: SealedChannel;
  private handler: (message: ControlMessage) => void = noop;
  private closeHandlers: ((error?: Error) => void)[] = [];
  private readonly pending: ControlMessage[] = [];

  constructor(private readonly link: MessageLink, root: Uint8Array, role: 'host' | 'viewer', backlog: SignalingMessage[] = []) {
    this.channel = new SealedChannel(root, 'control', role);
    link.onMessage(raw => this.receive(raw));
    link.onClose(err => { for (const h of this.closeHandlers) h(err); });
    for (const m of backlog) this.receive(m);
  }

  private receive(raw: unknown) {
    try {
      const message = signalingMessage(raw, '');
      if (message.type === 'error') {
        this.link.close(new HandshakeError(message.code, undefined, message.retryAfterMs));
        return;
      }
      if (message.type !== 'sealed') throw new SchemaError('type', 'only sealed frames are allowed after the handshake');
      const plain = new TextDecoder('utf-8', { fatal: true }).decode(this.channel.open(fromBase64(message.data)));
      const control = parseJson(controlMessage, plain, 128 * 1024);
      if (this.handler === noop) this.pending.push(control);
      else this.handler(control);
    } catch (err) {
      this.link.close(new HandshakeError('protocol', `Rejected a control message: ${(err as Error).message}`));
    }
  }

  send(message: ControlMessage) {
    if (this.link.closed) return;
    this.link.send({ type: 'sealed', data: toBase64(this.channel.seal(utf8(JSON.stringify(message)))) });
  }

  onMessage(handler: (message: ControlMessage) => void) {
    this.handler = handler;
    for (const m of this.pending.splice(0)) handler(m);
  }

  /** Waits for one control message, validated by `check`-style predicate. */
  expect<T extends ControlMessage['type']>(type: T, timeoutMs: number): Promise<Extract<ControlMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.handler = noop; reject(new HandshakeError('timeout', `No ${type} received in time`)); }, timeoutMs);
      this.onClose(err => { clearTimeout(timer); reject(err instanceof HandshakeError ? err : new HandshakeError('closed', 'The connection closed')); });
      this.onMessage(message => {
        clearTimeout(timer);
        this.handler = noop;
        if (message.type === type) resolve(message as Extract<ControlMessage, { type: T }>);
        else {
          reject(new HandshakeError('protocol', `Expected ${type}, received ${message.type}`));
          this.link.close();
        }
      });
    });
  }

  onClose(handler: (error?: Error) => void) {
    if (this.link.closed) { handler(); return; }
    this.closeHandlers.push(handler);
  }

  close(error?: Error) { this.link.close(error); }
  get closed() { return this.link.closed; }
}

const noop = () => {};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ host */

export interface ConsentRequest {
  viewerId: string;
  viewerName: string;
  auth: AuthKind;
}

/**
 * What the person at the host answered. `allow-and-trust` also means "and let
 * this computer connect again without asking": the caller stores the viewer's
 * public key, and later connections arrive as `paired`.
 */
export type ConsentDecision = 'allow' | 'allow-and-trust' | 'reject';

export interface AcceptOptions {
  /**
   * Asks the person at this computer. Consulted for an access code and for a
   * computer on the same account: both are someone deciding to connect now.
   * A grant resumes an already-approved session, and a paired device is one
   * explicit opt-in that stands in for the answer.
   */
  authorize: (request: ConsentRequest, signal: AbortSignal) => Promise<ConsentDecision>;
  /**
   * Which kinds of connection need that prompt. The default asks for `code` and
   * `account`. `paired` never does — being on the trusted list *is* the answer,
   * given once — and `grant` resumes a session already allowed.
   */
  needsConsent?: (auth: AuthKind) => boolean;
  /** Called when the answer was 'allow-and-trust', with the viewer to remember. */
  onTrust?: (viewer: { viewerId: string; viewerKey: Uint8Array; viewerName: string }) => void;
  grants: GrantStore;
  handshakeTimeoutMs?: number;
  consentTimeoutMs?: number;
  grantTtlMs?: number;
}

export interface HostSession {
  control: SecureControl;
  viewer: Omit<AuthenticatedViewer, 'root'>;
  root: Uint8Array;
  sessionId: string;
  grantId: string;
}

export async function acceptViewer(link: MessageLink, auth: HostAuthenticator, opts: AcceptOptions): Promise<HostSession> {
  const handshakeTimeout = opts.handshakeTimeoutMs ?? 15_000;
  const inbox = new Inbox(link);
  let viewer: AuthenticatedViewer;
  try {
    const hello = await inbox.next(handshakeTimeout);
    if (hello.type !== 'hello') throw new HandshakeError('protocol', `Expected hello, received ${hello.type}`);
    const outcome = await auth.onHello(hello);
    if (outcome.kind === 'error') {
      link.send(outcome.reply);
      throw new HandshakeError(outcome.reply.code, undefined, outcome.reply.retryAfterMs);
    }
    link.send(outcome.reply);
    let confirm: SignalingMessage;
    try {
      confirm = await inbox.next(handshakeTimeout);
    } catch (err) {
      outcome.pending.abandon();
      throw err;
    }
    if (confirm.type !== 'confirm') {
      outcome.pending.abandon();
      throw new HandshakeError('protocol', `Expected confirm, received ${confirm.type}`);
    }
    try {
      viewer = outcome.pending.confirm(confirm);
    } catch (err) {
      if (err instanceof HandshakeError && err.code === 'bad-auth') link.send({ type: 'error', code: 'bad-auth' });
      throw err;
    }
  } catch (err) {
    link.close(err as Error);
    throw err;
  }

  const control = new SecureControl(link, viewer.root, 'host', inbox.drain());
  const reject = (reason: RejectReason) => {
    control.send({ type: 'auth-result', allowed: false, reason });
    control.close();
    return new HandshakeError('rejected', `Connection not allowed: ${reason}`);
  };

  // Already trusted when it arrived this way; possibly trusted by the answer below.
  let trusted = viewer.auth === 'paired';
  const needsConsent = opts.needsConsent ?? (auth => auth === 'code' || auth === 'account');
  if (needsConsent(viewer.auth)) {
    const abort = new AbortController();
    control.onClose(() => abort.abort());
    const decision = await withTimeout(
      opts.authorize({ viewerId: viewer.viewerId, viewerName: viewer.viewerName, auth: viewer.auth }, abort.signal)
        .catch((): ConsentDecision => 'reject'),
      opts.consentTimeoutMs ?? 60_000,
    );
    if (decision === 'timeout') abort.abort();
    if (control.closed) throw new HandshakeError('closed', 'The viewer left before the request was answered');
    if (decision !== 'allow' && decision !== 'allow-and-trust') {
      throw reject(decision === 'timeout' ? 'timeout' : 'user-rejected');
    }
    if (decision === 'allow-and-trust') {
      opts.onTrust?.({ viewerId: viewer.viewerId, viewerKey: viewer.viewerKey, viewerName: viewer.viewerName });
      trusted = true;
    }
  }

  const grantTtl = opts.grantTtlMs ?? 10 * 60_000;
  let grantId: string;
  let grantMessage: { id: string; secret: string; expiresAt: number } | undefined;
  if (viewer.auth === 'grant' && viewer.grantId) {
    grantId = viewer.grantId;
    opts.grants.extend(grantId, grantTtl);
  } else {
    const grant = opts.grants.issue(viewer.viewerKey, grantTtl);
    grantId = grant.id;
    grantMessage = { id: grant.id, secret: toBase64(grant.secret), expiresAt: grant.expiresAt };
  }
  const sessionId = toBase64(randomBytes(16));
  control.send({
    type: 'auth-result', allowed: true, sessionId,
    ...(grantMessage ? { grant: grantMessage } : {}),
    ...(trusted ? { trusted: true } : {}),
  });

  const { root, ...publicViewer } = viewer;
  return { control, viewer: publicViewer, root, sessionId, grantId };
}

/* ---------------------------------------------------------------- viewer */

export interface ViewerSession {
  control: SecureControl;
  host: Omit<AuthenticatedHost, 'root'>;
  root: Uint8Array;
  sessionId: string;
  /** Present for connections that may resume: use it to reconnect silently. */
  grant?: { id: string; secret: Uint8Array; expiresAt: number };
  /** The host will let this computer in again with no code and no prompt. */
  trusted: boolean;
}

export interface ConnectOptions extends ViewerHandshakeOptions {
  handshakeTimeoutMs?: number;
  /** How long to wait for the person at the host to answer. */
  consentTimeoutMs?: number;
}

export async function connectToHost(link: MessageLink, opts: ConnectOptions): Promise<ViewerSession> {
  const inbox = new Inbox(link);
  let host: AuthenticatedHost;
  try {
    const handshake = await ViewerHandshake.create(opts);
    link.send(handshake.hello);
    const reply = await inbox.next(opts.handshakeTimeoutMs ?? 15_000);
    if (reply.type === 'error') throw new HandshakeError(reply.code, undefined, reply.retryAfterMs);
    if (reply.type !== 'challenge') throw new HandshakeError('protocol', `Expected challenge, received ${reply.type}`);
    const { confirm, host: authenticated } = handshake.onChallenge(reply);
    link.send(confirm);
    host = authenticated;
  } catch (err) {
    link.close(err as Error);
    throw err;
  }

  const control = new SecureControl(link, host.root, 'viewer', inbox.drain());
  // The host may still reply with a plain `error` (bad-auth); SecureControl treats that as fatal and closes.
  const result = await control.expect('auth-result', (opts.consentTimeoutMs ?? 60_000) + 5_000);
  if (!result.allowed) {
    control.close();
    throw new HandshakeError('rejected', `The connection was not allowed: ${result.reason ?? 'not-allowed'}`);
  }
  const { root, ...publicHost } = host;
  const session: ViewerSession = { control, host: publicHost, root, sessionId: result.sessionId ?? '', trusted: result.trusted === true };
  if (result.grant) session.grant = { id: result.grant.id, secret: fromBase64(result.grant.secret), expiresAt: result.grant.expiresAt };
  return session;
}

export type { Check };
