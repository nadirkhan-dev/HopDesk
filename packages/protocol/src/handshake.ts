import {
  Spake2, passwordScalar, secretScalar, deriveSessionRoot, deviceIdFromPublicKey, sign, verify,
  sha256, encodeFields, concat, utf8, toBase64, fromBase64, bigIntToBytes, bytesToBigInt,
  type DeviceIdentity, type Spake2Result,
} from '@hopdesk/crypto';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION, type AuthKind, type ChallengeMessage, type ConfirmMessage, type ErrorMessage,
  type HandshakeErrorCode, type HelloMessage,
} from './messages.js';
import { AttemptLimiter, type Attempt } from './limiter.js';
import { NonceCache } from './replay.js';
import type { GrantStore } from './grants.js';

/**
 * The HopDesk authentication handshake (three messages).
 *
 *   viewer → host   hello      { viewer key, nonce, SPAKE2 share pA, auth kind }
 *   host → viewer   challenge  { host key, nonce, pB, confirmation cB, host signature }
 *   viewer → host   confirm    { confirmation cA, viewer signature }
 *
 * SPAKE2 (RFC 9382) proves both sides know the access code without revealing
 * it or allowing offline guessing. Its associated data is a hash binding every
 * other field of the exchange — both device keys, both nonces, names, protocol
 * version and auth method — so tampering with any of them breaks confirmation.
 * Each side also signs that binding with its Ed25519 device key, tying the
 * session to device identities that can be pinned and, later, enrolled in an
 * account. The session key is derived from the SPAKE2 secret and the complete
 * handshake, and nothing is sent under it until both confirmations verified.
 */

export type LocalErrorCode = 'identity-mismatch' | 'timeout' | 'closed' | 'rejected';

export class HandshakeError extends Error {
  constructor(readonly code: HandshakeErrorCode | LocalErrorCode, message?: string, readonly retryAfterMs?: number) {
    super(message ?? code);
    this.name = 'HandshakeError';
  }
}

const HOST_SIG = 'hopdesk/handshake/host/v1';
const VIEWER_SIG = 'hopdesk/handshake/viewer/v1';

function binding(hello: HelloMessage, hostKey: string, hostName: string, hostNonce: string): Uint8Array {
  return sha256(encodeFields(
    'hopdesk/handshake/binding/v1', String(hello.v), hello.hostId, hello.viewerId,
    fromBase64(hello.viewerKey), fromBase64(hostKey), hello.viewerName, hostName,
    fromBase64(hello.nonce), fromBase64(hostNonce), String(hello.time), hello.auth, hello.grantId ?? '',
  ));
}

function sessionRoot(result: Spake2Result, bind: Uint8Array, pA: Uint8Array, pB: Uint8Array, cA: Uint8Array, cB: Uint8Array) {
  return deriveSessionRoot(result.Ke, sha256(encodeFields(bind, pA, pB, cA, cB)));
}

/** The scalar a host stores for unattended access: never the password itself. */
export async function unattendedVerifier(password: string, hostId: string): Promise<Uint8Array> {
  return bigIntToBytes(await passwordScalar(password, hostId), 32);
}

/* ------------------------------------------------------------------ host */

export interface AuthenticatedViewer {
  viewerId: string;
  viewerKey: Uint8Array;
  viewerName: string;
  auth: AuthKind;
  grantId?: string;
  root: Uint8Array;
}

export interface HostAuthOptions {
  identity: DeviceIdentity;
  hostName: string;
  /** The current access code, or null when access by code is switched off. */
  accessCode: () => string | null;
  /** Called when repeated failures force a new access code. */
  rotateAccessCode: () => void;
  grants: GrantStore;
  /** Stored verifier when unattended access is enabled; null otherwise. */
  unattended?: () => Uint8Array | null;
  now?: () => number;
  limiter?: AttemptLimiter;
  unattendedLimiter?: AttemptLimiter;
  nonces?: NonceCache;
}

export type HelloOutcome =
  | { kind: 'challenge'; reply: ChallengeMessage; pending: PendingHostHandshake }
  | { kind: 'error'; reply: ErrorMessage };

export interface PendingHostHandshake {
  confirm(message: ConfirmMessage): AuthenticatedViewer;
  /** The viewer went away or timed out: the spent guess still counts. */
  abandon(): void;
}

export class HostAuthenticator {
  readonly deviceId: string;
  readonly limiter: AttemptLimiter;
  private readonly unattendedLimiter: AttemptLimiter;
  private readonly nonces: NonceCache;
  private readonly now: () => number;

  constructor(private readonly opts: HostAuthOptions) {
    this.deviceId = deviceIdFromPublicKey(opts.identity.publicKey);
    this.now = opts.now ?? Date.now;
    this.limiter = opts.limiter ?? new AttemptLimiter(() => opts.rotateAccessCode(), undefined, this.now);
    this.unattendedLimiter = opts.unattendedLimiter ?? new AttemptLimiter(() => {}, undefined, this.now);
    this.nonces = opts.nonces ?? new NonceCache(undefined, undefined, this.now);
  }

  async onHello(hello: HelloMessage): Promise<HelloOutcome> {
    const error = (code: HandshakeErrorCode, retryAfterMs?: number): HelloOutcome =>
      ({ kind: 'error', reply: retryAfterMs === undefined ? { type: 'error', code } : { type: 'error', code, retryAfterMs } });

    if (hello.v !== PROTOCOL_VERSION) return error('unsupported-version');
    if (hello.hostId !== this.deviceId) return error('unknown-device');
    const viewerKey = fromBase64(hello.viewerKey);
    if (deviceIdFromPublicKey(viewerKey) !== hello.viewerId) return error('protocol');
    if ((hello.auth === 'grant') !== (hello.grantId !== undefined)) return error('protocol');

    const fresh = this.nonces.check(hello.nonce, hello.time);
    if (fresh !== 'ok') return error(fresh);

    let w: bigint;
    let attempt: Attempt | null = null;
    if (hello.auth === 'grant') {
      const grant = this.opts.grants.find(hello.grantId!, viewerKey);
      if (!grant) return error('grant-invalid');
      w = secretScalar(grant.secret, `${this.deviceId}\0${grant.id}`);
    } else {
      const secret = hello.auth === 'code' ? this.opts.accessCode() : this.opts.unattended?.() ?? null;
      if (secret === null) return error(hello.auth === 'code' ? 'code-disabled' : 'unattended-disabled');
      const decision = (hello.auth === 'code' ? this.limiter : this.unattendedLimiter).begin();
      if (!decision.ok) return error(decision.reason === 'busy' ? 'busy' : 'rate-limited', decision.retryAfterMs);
      attempt = decision.attempt;
      try {
        w = typeof secret === 'string' ? await passwordScalar(secret, this.deviceId) : bytesToBigInt(secret);
      } catch {
        attempt.fail();
        return error('protocol');
      }
    }

    const hostNonce = toBase64(randomBytes(32));
    const hostKey = toBase64(this.opts.identity.publicKey);
    const bind = binding(hello, hostKey, this.opts.hostName, hostNonce);
    const pA = fromBase64(hello.share);
    const spake = new Spake2({ role: 'B', idA: utf8(hello.viewerId), idB: utf8(this.deviceId), w });
    let result: Spake2Result;
    try {
      result = spake.finish(pA, bind);
    } catch {
      attempt?.fail();
      return error('protocol');
    }
    const pB = spake.outbound;
    const cB = result.confirmation;
    const reply: ChallengeMessage = {
      type: 'challenge',
      hostKey,
      hostName: this.opts.hostName,
      nonce: hostNonce,
      share: toBase64(pB),
      confirm: toBase64(cB),
      signature: toBase64(sign(this.opts.identity, HOST_SIG, concat(bind, pA, pB, cB))),
    };

    let done = false;
    const pending: PendingHostHandshake = {
      confirm: (message) => {
        if (done) throw new HandshakeError('protocol', 'Handshake already completed');
        done = true;
        const cA = fromBase64(message.confirm);
        if (!result.verifyPeer(cA)) {
          attempt?.fail();
          throw new HandshakeError('bad-auth', 'The viewer did not prove knowledge of the access secret');
        }
        if (!verify(viewerKey, VIEWER_SIG, concat(bind, pA, pB, cA), fromBase64(message.signature))) {
          attempt?.fail();
          throw new HandshakeError('protocol', 'The viewer signature is not valid');
        }
        attempt?.succeed();
        const viewer: AuthenticatedViewer = {
          viewerId: hello.viewerId,
          viewerKey,
          viewerName: hello.viewerName,
          auth: hello.auth,
          root: sessionRoot(result, bind, pA, pB, cA, cB),
        };
        if (hello.grantId) viewer.grantId = hello.grantId;
        return viewer;
      },
      abandon: () => {
        if (done) return;
        done = true;
        attempt?.fail();
      },
    };
    return { kind: 'challenge', reply, pending };
  }
}

/* ---------------------------------------------------------------- viewer */

export type ViewerCredential =
  | { kind: 'code'; code: string }
  | { kind: 'grant'; id: string; secret: Uint8Array }
  | { kind: 'unattended'; password: string };

export interface ViewerHandshakeOptions {
  identity: DeviceIdentity;
  viewerName: string;
  hostId: string;
  credential: ViewerCredential;
  /** A key pinned from an earlier session with this Device ID, if any. */
  expectedHostKey?: Uint8Array;
  now?: () => number;
}

export interface AuthenticatedHost {
  hostId: string;
  hostKey: Uint8Array;
  hostName: string;
  root: Uint8Array;
}

export class ViewerHandshake {
  private finished = false;

  private constructor(
    private readonly opts: ViewerHandshakeOptions,
    private readonly spake: Spake2,
    readonly hello: HelloMessage,
  ) {}

  static async create(opts: ViewerHandshakeOptions): Promise<ViewerHandshake> {
    const viewerId = deviceIdFromPublicKey(opts.identity.publicKey);
    const { credential } = opts;
    const w = credential.kind === 'grant'
      ? secretScalar(credential.secret, `${opts.hostId}\0${credential.id}`)
      : await passwordScalar(credential.kind === 'code' ? credential.code : credential.password, opts.hostId);
    const spake = new Spake2({ role: 'A', idA: utf8(viewerId), idB: utf8(opts.hostId), w });
    const hello: HelloMessage = {
      type: 'hello',
      v: PROTOCOL_VERSION,
      hostId: opts.hostId,
      viewerId,
      viewerKey: toBase64(opts.identity.publicKey),
      viewerName: opts.viewerName.slice(0, 64),
      nonce: toBase64(randomBytes(32)),
      time: (opts.now ?? Date.now)(),
      auth: credential.kind,
      share: toBase64(spake.outbound),
    };
    if (credential.kind === 'grant') hello.grantId = credential.id;
    return new ViewerHandshake(opts, spake, hello);
  }

  onChallenge(challenge: ChallengeMessage): { confirm: ConfirmMessage; host: AuthenticatedHost } {
    if (this.finished) throw new HandshakeError('protocol', 'Handshake already completed');
    this.finished = true;

    const hostKey = fromBase64(challenge.hostKey);
    if (deviceIdFromPublicKey(hostKey) !== this.opts.hostId) {
      throw new HandshakeError('identity-mismatch', 'The responding device is not the one with this Device ID');
    }
    if (this.opts.expectedHostKey && toBase64(this.opts.expectedHostKey) !== challenge.hostKey) {
      throw new HandshakeError('identity-mismatch', 'This device\'s identity key changed since the last connection');
    }

    const bind = binding(this.hello, challenge.hostKey, challenge.hostName, challenge.nonce);
    const pA = this.spake.outbound;
    const pB = fromBase64(challenge.share);
    let result: Spake2Result;
    try {
      result = this.spake.finish(pB, bind);
    } catch {
      throw new HandshakeError('protocol', 'The host sent an invalid key share');
    }
    const cB = fromBase64(challenge.confirm);
    if (!result.verifyPeer(cB)) {
      // Wrong code, or someone in the middle who does not know it: indistinguishable by design.
      throw new HandshakeError('bad-auth', 'The access code is not correct');
    }
    if (!verify(hostKey, HOST_SIG, concat(bind, pA, pB, cB), fromBase64(challenge.signature))) {
      throw new HandshakeError('identity-mismatch', 'The host signature is not valid');
    }
    const cA = result.confirmation;
    return {
      confirm: {
        type: 'confirm',
        confirm: toBase64(cA),
        signature: toBase64(sign(this.opts.identity, VIEWER_SIG, concat(bind, pA, pB, cA))),
      },
      host: {
        hostId: this.opts.hostId,
        hostKey,
        hostName: challenge.hostName,
        root: sessionRoot(result, bind, pA, pB, cA, cB),
      },
    };
  }
}
