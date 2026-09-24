import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deviceIdFromPublicKey, fromBase64, verify } from '@hopdesk/crypto';
import { str, obj, optional, parseJson, SchemaError } from '@hopdesk/protocol';
import type { ServerConfig } from './config.js';
import type { Store } from './store.js';
import { hashPassword, verifyPassword, WeakPasswordError } from './passwords.js';
import { hashToken, issueRefresh, revokeRefresh, rotateRefresh, signAccessToken, verifyAccessToken } from './tokens.js';
import { turnCredentials } from './turn.js';
import type { Presence } from './presence.js';

/**
 * The account API. Small on purpose: create an account, sign in, keep a session
 * alive, enrol a computer, list them, remove one, and ask for relay
 * credentials. Everything else a HopDesk session needs happens between the two
 * computers, not here.
 */

const MAX_BODY = 16 * 1024;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const credentials = obj({
  email: str({ min: 3, max: 254, pattern: emailPattern }),
  password: str({ min: 1, max: 512 }),
});
const registration = obj({
  email: str({ min: 3, max: 254, pattern: emailPattern }),
  password: str({ min: 1, max: 512 }),
  /** Required unless the server was deployed with open registration. */
  token: optional(str({ min: 1, max: 256 })),
});
const refreshBody = obj({ refreshToken: str({ min: 8, max: 512 }) });
const enrolBody = obj({
  deviceId: str({ max: 12, pattern: /^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/ }),
  publicKey: str({ min: 43, max: 64 }),
  name: str({ min: 1, max: 64 }),
  /* What kind of computer, for the icon in the list. Optional: a device
     enrolled by an older version of HopDesk simply has none. */
  os: optional(str({ max: 16, pattern: /^[a-z]+$/ })),
  nonce: str({ min: 20, max: 64 }),
  signature: str({ min: 80, max: 128 }),
});

export interface ApiDependencies {
  config: ServerConfig;
  store: Store;
  presence: Presence;
  now?: () => number;
  log: (message: string) => void;
}

/** Proof that whoever asks holds a device's private key, valid for a few minutes. */
interface EnrolChallenge { accountId: string; expiresAt: number }

export class Api {
  private readonly challenges = new Map<string, EnrolChallenge>();
  private readonly now: () => number;

  constructor(private readonly deps: ApiDependencies) {
    this.now = deps.now ?? Date.now;
  }

  /** Resolves the caller from an Authorization header, for HTTP and WebSocket alike. */
  authenticate(header: string | undefined): Caller | null {
    const token = /^Bearer (.+)$/.exec(header ?? '')?.[1];
    if (!token) return null;
    return this.authenticateToken(token);
  }

  authenticateToken(token: string): Caller | null {
    const payload = verifyAccessToken(this.deps.config.tokenSecret, token, this.now());
    if (payload) {
      // An access token is only as good as the account still existing.
      return this.deps.store.accountById(payload.sub)
        ? { kind: 'access', accountId: payload.sub, ...(payload.device ? { deviceId: payload.device } : {}) }
        : null;
    }
    /* Device tokens: long-lived, stored hashed, and revoked by removing the
       device. A computer that must reconnect on its own cannot hold a password —
       and a device token can do less than a sign-in can. */
    const device = this.deps.store.deviceByTokenHash(hashToken(token));
    if (!device) return null;
    return { kind: 'device', accountId: device.accountId, deviceId: device.deviceId };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /api/health') return this.send(res, 200, { ok: true });
      if (route === 'POST /api/register') return await this.register(req, res);
      if (route === 'POST /api/login') return await this.login(req, res);
      if (route === 'POST /api/token/refresh') return await this.refresh(req, res);
      if (route === 'POST /api/logout') return await this.logout(req, res);
      if (route === 'GET /api/devices') return this.listDevices(req, res);
      if (route === 'POST /api/devices/challenge') return this.deviceChallenge(req, res);
      if (route === 'POST /api/devices') return await this.enrolDevice(req, res);
      if (req.method === 'POST' && /^\/api\/devices\/[^/]+\/approve$/.test(url.pathname)) {
        return this.approveDevice(req, res, decodeURIComponent(url.pathname.split('/')[3]!));
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/devices/')) {
        return this.removeDevice(req, res, decodeURIComponent(url.pathname.slice('/api/devices/'.length)));
      }
      if (route === 'GET /api/turn') return this.turn(req, res);
      this.send(res, 404, { error: 'not-found' });
    } catch (err) {
      if (err instanceof SchemaError) return this.send(res, 400, { error: 'invalid-request', detail: err.message });
      if (err instanceof WeakPasswordError) return this.send(res, 400, { error: 'weak-password', detail: err.message });
      if (err instanceof BodyTooLarge) return this.send(res, 413, { error: 'too-large' });
      this.deps.log(`error handling ${route}: ${(err as Error).message}`);
      this.send(res, 500, { error: 'server-error' });
    }
  }

  /* ------------------------------------------------------------- accounts */

  private async register(req: IncomingMessage, res: ServerResponse) {
    const body = parseJson(registration, await readBody(req), MAX_BODY);
    const { store, config } = this.deps;

    if (config.registration === 'closed') {
      return this.send(res, 403, { error: 'registration-closed' });
    }
    if (config.registration === 'token') {
      /* Attempts are throttled by address as well as by token, so the secret
         cannot be found by trying, and compared in constant time so it cannot
         be found by timing either. */
      const limit = store.throttle(`register:${clientAddress(req, config.trustProxy)}`, this.now(), 10, 15 * 60_000);
      if (limit.locked) {
        return this.send(res, 429, { error: 'too-many-attempts', retryAfterMs: limit.retryAfterMs });
      }
      const given = typeof body.token === 'string' ? body.token : '';
      if (!config.registrationToken || !sameSecret(given, config.registrationToken)) {
        this.deps.log('a registration was refused: wrong or missing token');
        return this.send(res, 403, { error: 'bad-registration-token' });
      }
    }
    if (store.accountByEmail(body.email)) {
      // Deliberately the same shape as success would take to a stranger.
      return this.send(res, 409, { error: 'email-taken' });
    }
    const account = store.createAccount(body.email, await hashPassword(body.password), this.now());
    this.deps.log(`account created: ${account.id}`);
    return this.send(res, 201, { account: { id: account.id, email: account.email } });
  }

  private async login(req: IncomingMessage, res: ServerResponse) {
    const body = parseJson(credentials, await readBody(req), MAX_BODY);
    const { store } = this.deps;
    const key = `login:${body.email.toLowerCase()}`;
    const limit = store.throttle(key, this.now(), 10, 15 * 60_000);
    if (limit.locked) {
      return this.send(res, 429, { error: 'too-many-attempts', retryAfterMs: limit.retryAfterMs });
    }
    const account = store.accountByEmail(body.email);
    /* The password is checked even when there is no such account, so the answer
       takes the same time either way and does not reveal which emails exist. */
    const stored = account?.passwordHash ?? await placeholderHash();
    const ok = await verifyPassword(body.password, stored);
    if (!account || !ok) return this.send(res, 401, { error: 'bad-credentials' });

    store.clearThrottle(key);
    return this.send(res, 200, this.session(account.id, account.email));
  }

  private async refresh(req: IncomingMessage, res: ServerResponse) {
    const body = parseJson(refreshBody, await readBody(req), MAX_BODY);
    const outcome = rotateRefresh(this.deps.store, body.refreshToken, this.deps.config.refreshTokenTtlMs, this.now());
    if (!outcome.ok) {
      if (outcome.reason === 'reused') {
        this.deps.log('a refresh token was replayed; its family has been revoked');
      }
      return this.send(res, 401, { error: outcome.reason });
    }
    const account = this.deps.store.accountById(outcome.accountId);
    if (!account) return this.send(res, 401, { error: 'invalid' });
    return this.send(res, 200, {
      account: { id: account.id, email: account.email },
      accessToken: this.accessToken(account.id),
      expiresIn: this.deps.config.accessTokenTtlMs,
      refreshToken: outcome.next.token,
    });
  }

  private async logout(req: IncomingMessage, res: ServerResponse) {
    const body = parseJson(refreshBody, await readBody(req), MAX_BODY);
    revokeRefresh(this.deps.store, body.refreshToken);
    return this.send(res, 200, { ok: true });
  }

  private session(accountId: string, email: string) {
    const refresh = issueRefresh(this.deps.store, accountId, this.deps.config.refreshTokenTtlMs, this.now());
    return {
      account: { id: accountId, email },
      accessToken: this.accessToken(accountId),
      expiresIn: this.deps.config.accessTokenTtlMs,
      refreshToken: refresh.token,
    };
  }

  private accessToken(accountId: string, deviceId?: string) {
    return signAccessToken(this.deps.config.tokenSecret, {
      sub: accountId,
      ...(deviceId ? { device: deviceId } : {}),
      exp: this.now() + this.deps.config.accessTokenTtlMs,
    });
  }

  /* -------------------------------------------------------------- devices */

  private listDevices(req: IncomingMessage, res: ServerResponse) {
    const caller = this.authenticate(req.headers.authorization);
    if (!caller) return this.send(res, 401, { error: 'unauthorised' });
    const devices = this.deps.store.devicesOfAccount(caller.accountId).map(d => ({
      deviceId: d.deviceId,
      name: d.name,
      os: d.os,
      // The public key is what the other side's signature is checked against.
      publicKey: d.publicKey,
      /* Listed whether approved or not: a computer waiting to be let in is
         exactly what the others need to be shown, with its fingerprint. */
      approved: d.approved,
      online: this.deps.presence.isOnline(d.deviceId),
      lastSeen: d.lastSeen,
      self: d.deviceId === caller.deviceId,
    }));
    return this.send(res, 200, { devices });
  }

  private deviceChallenge(req: IncomingMessage, res: ServerResponse) {
    const caller = this.authenticate(req.headers.authorization);
    if (!caller) return this.send(res, 401, { error: 'unauthorised' });
    if (caller.kind === 'device') return this.send(res, 403, { error: 'needs-sign-in' });
    this.pruneChallenges();
    const nonce = randomBytes(24).toString('base64');
    this.challenges.set(nonce, { accountId: caller.accountId, expiresAt: this.now() + 5 * 60_000 });
    return this.send(res, 200, { nonce, expiresInMs: 5 * 60_000 });
  }

  /**
   * One computer vouching for another.
   *
   * Only an approved *device* may do it, never a bare sign-in: the whole point
   * is that email and password are not enough to add a computer that can
   * reach the others, so a password alone must not be enough to approve one
   * either. That is what closes the hole where a server - or anyone who
   * learned the password - quietly adds a machine of its own.
   */
  private approveDevice(req: IncomingMessage, res: ServerResponse, deviceId: string) {
    const caller = this.authenticate(req.headers.authorization);
    if (!caller) return this.send(res, 401, { error: 'unauthorised' });
    if (!caller.deviceId) return this.send(res, 403, { error: 'needs-approved-device' });
    const approver = this.deps.store.deviceById(caller.deviceId);
    if (!approver?.approved) return this.send(res, 403, { error: 'needs-approved-device' });

    const device = this.deps.store.deviceById(deviceId);
    if (!device || device.accountId !== caller.accountId) return this.send(res, 404, { error: 'not-found' });
    if (device.deviceId === caller.deviceId) return this.send(res, 400, { error: 'same-device' });

    this.deps.store.approveDevice(deviceId);
    this.deps.log(`device ${deviceId} approved by ${caller.deviceId}`);
    return this.send(res, 200, { ok: true });
  }

  private async enrolDevice(req: IncomingMessage, res: ServerResponse) {
    const caller = this.authenticate(req.headers.authorization);
    if (!caller) return this.send(res, 401, { error: 'unauthorised' });
    // Adding a computer to an account is a decision by the person signing in.
    if (caller.kind === 'device') return this.send(res, 403, { error: 'needs-sign-in' });
    const body = parseJson(enrolBody, await readBody(req), MAX_BODY);

    const challenge = this.challenges.get(body.nonce);
    this.challenges.delete(body.nonce);
    if (!challenge || challenge.expiresAt <= this.now() || challenge.accountId !== caller.accountId) {
      return this.send(res, 400, { error: 'bad-challenge' });
    }

    /* Whether this computer is one of yours, or merely one somebody signed in
       from. The first computer on an account has nobody to ask, so it vouches
       for itself; every one after it waits for one that is already approved.
       A computer re-enrolling keeps the answer it already had - reinstalling
       HopDesk is not a new machine, and rotating its own key must not silently
       re-approve it either. */
    const already = this.deps.store.devicesOfAccount(caller.accountId);
    const existingDevice = already.find(d => d.deviceId === body.deviceId);
    const approved = existingDevice
      ? existingDevice.approved
      : !already.some(d => d.approved);

    let publicKey: Uint8Array;
    try {
      publicKey = fromBase64(body.publicKey);
    } catch {
      return this.send(res, 400, { error: 'bad-key' });
    }
    /* The Device ID must be the one this key produces, and the signature proves
       the computer enrolling really holds the matching private key — otherwise
       anyone could enrol someone else's Device ID and be offered its sessions. */
    if (publicKey.length !== 32 || deviceIdFromPublicKey(publicKey) !== body.deviceId) {
      return this.send(res, 400, { error: 'key-mismatch' });
    }
    let signature: Uint8Array;
    try {
      signature = fromBase64(body.signature);
    } catch {
      return this.send(res, 400, { error: 'bad-signature' });
    }
    if (!verify(publicKey, ENROL_LABEL, new TextEncoder().encode(`${body.nonce}\0${caller.accountId}`), signature)) {
      return this.send(res, 400, { error: 'bad-signature' });
    }

    const existing = this.deps.store.deviceById(body.deviceId);
    if (existing && existing.accountId !== caller.accountId) {
      // Enrolled elsewhere: it must be removed there first.
      return this.send(res, 409, { error: 'device-claimed' });
    }

    const deviceToken = randomBytes(32).toString('base64url');
    this.deps.store.saveDevice({
      deviceId: body.deviceId,
      accountId: caller.accountId,
      name: body.name,
      publicKey: body.publicKey,
      os: body.os ?? existing?.os ?? null,
      approved,
      tokenHash: hashToken(deviceToken),
      createdAt: existing?.createdAt ?? this.now(),
    });
    this.deps.log(`device ${body.deviceId} enrolled for account ${caller.accountId}`
      + `${approved ? '' : ', waiting to be approved from an approved computer'}`);
    return this.send(res, 201, {
      deviceToken,
      device: { deviceId: body.deviceId, name: body.name, approved },
    });
  }

  private removeDevice(req: IncomingMessage, res: ServerResponse, deviceId: string) {
    const caller = this.authenticate(req.headers.authorization);
    if (!caller) return this.send(res, 401, { error: 'unauthorised' });
    /* A computer's own token may remove that computer — that is what signing out
       there does — but removing *other* computers takes a real sign-in, so a
       stolen device token cannot lock the owner out of their own machines. */
    if (caller.kind === 'device' && caller.deviceId !== deviceId) {
      return this.send(res, 403, { error: 'needs-sign-in' });
    }
    const device = this.deps.store.deviceById(deviceId);
    if (!device || device.accountId !== caller.accountId) return this.send(res, 404, { error: 'not-found' });
    this.deps.store.removeDevice(deviceId);
    // Its token is gone, so its connection must go with it.
    this.deps.presence.disconnect(deviceId, 'removed');
    this.deps.log(`device ${deviceId} removed from account ${caller.accountId}`);
    return this.send(res, 200, { ok: true });
  }

  /* ----------------------------------------------------------------- turn */

  private turn(req: IncomingMessage, res: ServerResponse) {
    const caller = this.authenticate(req.headers.authorization);
    if (!caller) return this.send(res, 401, { error: 'unauthorised' });
    const { turn } = this.deps.config;
    if (!turn) return this.send(res, 200, { iceServers: [], relay: false });
    const { iceServers, expiresAt } = turnCredentials(turn, caller.deviceId ?? caller.accountId, this.now());
    return this.send(res, 200, { iceServers, expiresAt, relay: true });
  }

  /* ---------------------------------------------------------------- utils */

  private pruneChallenges() {
    const now = this.now();
    for (const [nonce, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(nonce);
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      // Nothing here belongs in a cache or a frame.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(text);
  }
}

/** Who is making a request, and with which kind of credential. */
export interface Caller {
  kind: 'access' | 'device';
  accountId: string;
  deviceId?: string;
}

/** The label a device signs during enrolment; see `enrolDevice`. */
export const ENROL_LABEL = 'hopdesk/enrol/v1';

export class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new BodyTooLarge()); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A fixed hash to compare against when no account matched, so timing matches. */
let placeholder: string | null = null;
async function placeholderHash(): Promise<string> {
  placeholder ??= await hashPassword(randomBytes(24).toString('base64'));
  return placeholder;
}

/** The caller's address, honouring a reverse proxy only when told to. */
function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Exported for tests: a constant-time string compare. */
export function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
