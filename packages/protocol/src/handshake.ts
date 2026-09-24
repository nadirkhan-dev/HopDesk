import {
  Spake2, passwordScalar, secretScalar, deriveSessionRoot, deviceIdFromPublicKey, sign, verify,
  sha256, encodeFields, concat, equalBytes, utf8, toBase64, fromBase64,
  generateEphemeral, deriveExchange, ExchangeError,
  type DeviceIdentity, type EphemeralKeyPair, type Spake2Result,
} from '@hopdesk/crypto';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION, type AuthKind, type ChallengeMessage, type ConfirmMessage, type ErrorMessage,
  type HandshakeErrorCode, type HelloMessage,
} from './messages.js';
import { AttemptLimiter, PeerThrottle, type Attempt } from './limiter.js';
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
  /**
   * @param presentedKey For an identity mismatch: the key the other computer
   *   actually presented, base64. Carried so the person can be shown both
   *   fingerprints and decide, rather than meeting a refusal with nothing to
   *   compare. It proves nothing on its own - it is what is in question.
   */
  constructor(
    readonly code: HandshakeErrorCode | LocalErrorCode,
    message?: string,
    readonly retryAfterMs?: number,
    readonly presentedKey?: string,
  ) {
    super(message ?? code);
    this.name = 'HandshakeError';
  }
}

const HOST_SIG = 'hopdesk/handshake/host/v1';
const VIEWER_SIG = 'hopdesk/handshake/viewer/v1';

function binding(hello: HelloMessage, hostKey: string, hostName: string, hostNonce: string, hostDh = ''): Uint8Array {
  return sha256(encodeFields(
    'hopdesk/handshake/binding/v1', String(hello.v), hello.hostId, hello.viewerId,
    fromBase64(hello.viewerKey), fromBase64(hostKey), hello.viewerName, hostName,
    fromBase64(hello.nonce), fromBase64(hostNonce), String(hello.time), hello.auth, hello.grantId ?? '',
    // Empty for the SPAKE2 kinds; the ephemeral keys for an account exchange.
    hello.dh ? fromBase64(hello.dh) : new Uint8Array(), hostDh ? fromBase64(hostDh) : new Uint8Array(),
  ));
}

function sessionRoot(result: Spake2Result, bind: Uint8Array, pA: Uint8Array, pB: Uint8Array, cA: Uint8Array, cB: Uint8Array) {
  return deriveSessionRoot(result.Ke, sha256(encodeFields(bind, pA, pB, cA, cB)));
}

/**
 * What each side signs. The message is public — it contains no key material —
 * and the label keeps a host signature from ever passing as a viewer's.
 */
function signedBody(bind: Uint8Array, a: Uint8Array, b: Uint8Array, mac: Uint8Array) {
  return concat(bind, a, b, mac);
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
  /**
   * Whether this viewer's device key is one the person at this computer has
   * chosen to trust, for `paired`. Only public keys are ever compared: there is
   * no stored secret for an attacker to read and replay.
   */
  trusts?: (viewerId: string, viewerKey: Uint8Array) => boolean;
  /**
   * Whether a device may connect because it is on the same HopDesk account.
   * Given the Device ID *and* the key it presented, so a relay cannot pass off
   * one device's identifier with another's key.
   */
  accountAuthorised?: (viewerId: string, viewerKey: Uint8Array) => boolean;
  now?: () => number;
  limiter?: AttemptLimiter;
  throttle?: PeerThrottle;
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
  readonly throttle: PeerThrottle;
  private readonly nonces: NonceCache;
  private readonly now: () => number;

  constructor(private readonly opts: HostAuthOptions) {
    this.deviceId = deviceIdFromPublicKey(opts.identity.publicKey);
    this.now = opts.now ?? Date.now;
    this.limiter = opts.limiter ?? new AttemptLimiter(() => opts.rotateAccessCode(), undefined, this.now);
    this.throttle = opts.throttle ?? new PeerThrottle(undefined, this.now);
    this.nonces = opts.nonces ?? new NonceCache(undefined, undefined, this.now);
  }

  /**
   * @param peer Who is asking, for the rate limiter: an address and the Device
   *   ID claimed. Omitted where the transport cannot say, which puts every
   *   such caller in one bucket rather than none.
   */
  async onHello(hello: HelloMessage, peer?: string): Promise<HelloOutcome> {
    const error = (code: HandshakeErrorCode, retryAfterMs?: number): HelloOutcome =>
      ({ kind: 'error', reply: retryAfterMs === undefined ? { type: 'error', code } : { type: 'error', code, retryAfterMs } });

    if (hello.v !== PROTOCOL_VERSION) return error('unsupported-version');
    if (hello.hostId !== this.deviceId) return error('unknown-device');
    const viewerKey = fromBase64(hello.viewerKey);
    if (deviceIdFromPublicKey(viewerKey) !== hello.viewerId) return error('protocol');
    if ((hello.auth === 'grant') !== (hello.grantId !== undefined)) return error('protocol');

    const fresh = this.nonces.check(hello.nonce, hello.time);
    if (fresh !== 'ok') return error(fresh);

    /* Keyed on both, so one machine claiming to be a hundred devices, and a
       hundred machines claiming to be one, are each held apart. */
    const who = `${peer ?? 'unknown'}|${hello.viewerId}`;

    /* Signature-authenticated kinds cannot be guessed at, but they can be
       churned; see PeerThrottle. Checked before any signature work. */
    if (hello.auth !== 'code') {
      const allowed = this.throttle.allow(who);
      if (!allowed.ok) return error('busy', allowed.retryAfterMs);
    }

    /* Two computers on the same account: no secret to type, so an ephemeral
       exchange signed by both device keys. What authorises it is the account —
       checked here, against the devices this computer knows are its own. */
    if (hello.auth === 'account') {
      if (!hello.dh) return error('protocol');
      if (!this.opts.accountAuthorised?.(hello.viewerId, viewerKey)) return error('not-authorised');
      return this.exchangeChallenge(hello, viewerKey);
    }

    /* A device this computer was told to trust, once, by the person sitting at
       it. The proof is the viewer's signature over the binding with the device
       key whose public half is in the trusted list — nothing typed, nothing
       stored that could be replayed if this computer's files were read. */
    if (hello.auth === 'paired') {
      if (!hello.dh) return error('protocol');
      if (!this.opts.trusts?.(hello.viewerId, viewerKey)) return error('not-paired');
      return this.exchangeChallenge(hello, viewerKey);
    }

    if (!hello.share) return error('protocol');
    let w: bigint;
    let attempt: Attempt | null = null;
    if (hello.auth === 'grant') {
      const grant = this.opts.grants.find(hello.grantId!, viewerKey);
      if (!grant) return error('grant-invalid');
      w = secretScalar(grant.secret, `${this.deviceId}\0${grant.id}`);
    } else {
      const secret = this.opts.accessCode();
      if (secret === null) return error('code-disabled');
      const decision = this.limiter.begin(who);
      if (!decision.ok) return error(decision.reason === 'busy' ? 'busy' : 'rate-limited', decision.retryAfterMs);
      attempt = decision.attempt;
      try {
        w = await passwordScalar(secret, this.deviceId);
      } catch {
        attempt.fail();
        return error('protocol');
      }
    }

    const hostNonce = toBase64(randomBytes(32));
    const hostKey = toBase64(this.opts.identity.publicKey);
    const bind = binding(hello, hostKey, this.opts.hostName, hostNonce);
    const pA = fromBase64(hello.share);   // present: checked above
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

  /**
   * The half of `onHello` for the kinds with no typed secret — `paired` and
   * `account`: a signed ephemeral X25519 exchange. Forward secret, and
   * authenticated by both device keys, so whoever carries the messages cannot
   * impersonate either side.
   */
  private exchangeChallenge(hello: HelloMessage, viewerKey: Uint8Array): HelloOutcome {
    const ephemeral = generateEphemeral();
    const hostNonce = toBase64(randomBytes(32));
    const hostKey = toBase64(this.opts.identity.publicKey);
    const hostDh = toBase64(ephemeral.publicKey);
    const bind = binding(hello, hostKey, this.opts.hostName, hostNonce, hostDh);
    const viewerDh = fromBase64(hello.dh!);

    let derived;
    try {
      derived = deriveExchange(ephemeral, viewerDh, bind);
    } catch (err) {
      if (err instanceof ExchangeError) return { kind: 'error', reply: { type: 'error', code: 'protocol' } };
      throw err;
    }

    const reply: ChallengeMessage = {
      type: 'challenge',
      hostKey,
      hostName: this.opts.hostName,
      nonce: hostNonce,
      dh: hostDh,
      confirm: toBase64(derived.hostConfirm),
      signature: toBase64(sign(this.opts.identity, HOST_SIG, signedBody(bind, viewerDh, ephemeral.publicKey, derived.hostConfirm))),
    };

    let done = false;
    const pending: PendingHostHandshake = {
      confirm: message => {
        if (done) throw new HandshakeError('protocol', 'Handshake already completed');
        done = true;
        const confirm = fromBase64(message.confirm);
        if (!equalBytes(confirm, derived.viewerConfirm)) {
          throw new HandshakeError('bad-auth', 'The viewer did not confirm the exchange');
        }
        if (!verify(viewerKey, VIEWER_SIG, signedBody(bind, viewerDh, ephemeral.publicKey, confirm), fromBase64(message.signature))) {
          // Without the device's private key this cannot be produced, which is
          // what stops a relay from impersonating one of the two computers.
          throw new HandshakeError('protocol', 'The viewer signature is not valid');
        }
        return {
          viewerId: hello.viewerId,
          viewerKey,
          viewerName: hello.viewerName,
          auth: hello.auth,
          root: deriveSessionRoot(derived.Ke, sha256(encodeFields(bind, viewerDh, ephemeral.publicKey, confirm, derived.hostConfirm))),
        };
      },
      // Nothing is guessable here, so an abandoned exchange costs nothing.
      abandon: () => { done = true; },
    };
    return { kind: 'challenge', reply, pending };
  }
}

/* ---------------------------------------------------------------- viewer */

export type ViewerCredential =
  | { kind: 'code'; code: string }
  | { kind: 'grant'; id: string; secret: Uint8Array }
  | { kind: 'paired' }
  /** Both computers are on the same HopDesk account; no secret is typed. */
  | { kind: 'account' };

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
    /** One of the two is set, according to the credential. */
    private readonly spake: Spake2 | null,
    private readonly ephemeral: EphemeralKeyPair | null,
    readonly hello: HelloMessage,
  ) {}

  static async create(opts: ViewerHandshakeOptions): Promise<ViewerHandshake> {
    const viewerId = deviceIdFromPublicKey(opts.identity.publicKey);
    const { credential } = opts;
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
    };

    // No secret to type: an ephemeral exchange, signed by this device's key.
    if (credential.kind === 'account' || credential.kind === 'paired') {
      const ephemeral = generateEphemeral();
      hello.dh = toBase64(ephemeral.publicKey);
      return new ViewerHandshake(opts, null, ephemeral, hello);
    }

    const w = credential.kind === 'grant'
      ? secretScalar(credential.secret, `${opts.hostId}\0${credential.id}`)
      : await passwordScalar(credential.code, opts.hostId);
    const spake = new Spake2({ role: 'A', idA: utf8(viewerId), idB: utf8(opts.hostId), w });
    hello.share = toBase64(spake.outbound);
    if (credential.kind === 'grant') hello.grantId = credential.id;
    return new ViewerHandshake(opts, spake, null, hello);
  }

  onChallenge(challenge: ChallengeMessage): { confirm: ConfirmMessage; host: AuthenticatedHost } {
    if (this.finished) throw new HandshakeError('protocol', 'Handshake already completed');
    this.finished = true;

    const hostKey = fromBase64(challenge.hostKey);
    if (deviceIdFromPublicKey(hostKey) !== this.opts.hostId) {
      throw new HandshakeError('identity-mismatch', 'The responding device is not the one with this Device ID');
    }
    if (this.opts.expectedHostKey && toBase64(this.opts.expectedHostKey) !== challenge.hostKey) {
      throw new HandshakeError(
        'identity-mismatch',
        'This device\'s identity key changed since the last connection',
        undefined,
        challenge.hostKey);
    }

    if (this.ephemeral) return this.finishAccount(challenge, hostKey);

    if (!challenge.share) throw new HandshakeError('protocol', 'The host sent no key share');
    const bind = binding(this.hello, challenge.hostKey, challenge.hostName, challenge.nonce);
    const pA = this.spake!.outbound;
    const pB = fromBase64(challenge.share);
    let result: Spake2Result;
    try {
      result = this.spake!.finish(pB, bind);
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

  /** The account exchange: verify the host's signature, then confirm our own. */
  private finishAccount(challenge: ChallengeMessage, hostKey: Uint8Array) {
    if (!challenge.dh) throw new HandshakeError('protocol', 'The host sent no ephemeral key');
    const ephemeral = this.ephemeral!;
    const bind = binding(this.hello, challenge.hostKey, challenge.hostName, challenge.nonce, challenge.dh);
    const hostDh = fromBase64(challenge.dh);

    let derived;
    try {
      derived = deriveExchange(ephemeral, hostDh, bind);
    } catch (err) {
      throw new HandshakeError('protocol', err instanceof ExchangeError ? err.message : 'The exchange failed');
    }
    if (!equalBytes(fromBase64(challenge.confirm), derived.hostConfirm)) {
      throw new HandshakeError('bad-auth', 'The other computer did not confirm the exchange');
    }
    if (!verify(hostKey, HOST_SIG, signedBody(bind, ephemeral.publicKey, hostDh, derived.hostConfirm), fromBase64(challenge.signature))) {
      throw new HandshakeError('identity-mismatch', 'The host signature is not valid');
    }
    return {
      confirm: {
        type: 'confirm' as const,
        confirm: toBase64(derived.viewerConfirm),
        signature: toBase64(sign(this.opts.identity, VIEWER_SIG, signedBody(bind, ephemeral.publicKey, hostDh, derived.viewerConfirm))),
      },
      host: {
        hostId: this.opts.hostId,
        hostKey,
        hostName: challenge.hostName,
        root: deriveSessionRoot(derived.Ke, sha256(encodeFields(bind, ephemeral.publicKey, hostDh, derived.viewerConfirm, derived.hostConfirm))),
      },
    };
  }
}
