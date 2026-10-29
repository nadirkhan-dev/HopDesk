import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deviceIdFromPublicKey, fromBase64, toBase64, identityFromSecretKey, sign, utf8, verify } from '@hopdesk/crypto';
import {
  str, obj, optional, parseJson, SchemaError, VERDICT_LABEL, verdictBytes, type InstallationVerdict,
} from '@hopdesk/protocol';
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
/* Labels keep one signature from being usable as another: a device proving it
   holds its key when enrolling, an installation proving the same when
   registering, and this server's own statement about an installation are three
   different things and must not be interchangeable. */
const INSTALLATION_LABEL = 'hopdesk/installation/register/v1';
/** Marks a challenge as belonging to an installation rather than an account. */
const INSTALLATION_CHALLENGE = '\0installation';

const registerInstallationBody = obj({
  installationId: str({ max: 12, pattern: /^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/ }),
  publicKey: str({ min: 43, max: 64 }),
  nonce: str({ min: 20, max: 64 }),
  signature: str({ min: 80, max: 128 }),
  os: optional(str({ max: 16, pattern: /^[a-z]+$/ })),
  appVersion: optional(str({ max: 32 })),
});

const verifyInstallationBody = obj({
  token: str({ min: 10, max: 128 }),
  appVersion: optional(str({ max: 32 })),
});

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

  /**
   * Every credential in the system passes through here - the HTTP routes and
   * the relay socket both - which is why a block is applied here and nowhere
   * else. An installation disabled by an administrator loses the account API,
   * the relay, and TURN credentials in one stroke, and it loses them on
   * versions of HopDesk that know nothing about blocking, because it is the
   * server doing the refusing rather than the client agreeing to be refused.
   */
  authenticateToken(token: string): Caller | null {
    const payload = verifyAccessToken(this.deps.config.tokenSecret, token, this.now());
    if (payload) {
      // An access token is only as good as the account still existing.
      const account = this.deps.store.accountById(payload.sub);
      if (!account || account.blockedAt !== null) return null;
      if (payload.device) {
        const device = this.deps.store.deviceById(payload.device);
        if (device && device.blockedAt !== null) return null;
      }
      return { kind: 'access', accountId: payload.sub, ...(payload.device ? { deviceId: payload.device } : {}) };
    }
    /* Device tokens: long-lived, stored hashed, and revoked by removing the
       device. A computer that must reconnect on its own cannot hold a password —
       and a device token can do less than a sign-in can. */
    const device = this.deps.store.deviceByTokenHash(hashToken(token));
    if (!device) return null;
    if (device.blockedAt !== null) return null;
    const owner = this.deps.store.accountById(device.accountId);
    if (!owner || owner.blockedAt !== null) return null;
    return { kind: 'device', accountId: device.accountId, deviceId: device.deviceId };
  }

  /**
   * The id behind a token that has been blocked, for telling the person why.
   *
   * Deliberately separate from authentication: the token is already refused by
   * the time this is asked, and this only turns "unauthorised" into a sentence
   * that says what happened.
   */
  blockedDeviceFor(token: string): string | null {
    const hash = hashToken(token);
    const installation = this.deps.store.installationByTokenHash(hash);
    if (installation?.blockedAt != null) return installation.installationId;
    const device = this.deps.store.deviceByTokenHash(hash);
    if (!device) return null;
    if (device.blockedAt != null) return device.deviceId;
    return this.deps.store.accountById(device.accountId)?.blockedAt != null ? device.deviceId : null;
  }

  /**
   * Whether this computer has been disabled, by any of the three routes.
   *
   * Asked by the relay about a socket it is already holding, so that a block
   * applied while a computer is connected reaches it - including one applied
   * from the command line, which has no way to close a socket in this process.
   * An installation record counts as well as a device record: the same
   * computer is usually both, and a block that only reached one of them would
   * be a block in name only.
   */
  isBlocked(deviceId: string): boolean {
    if (this.deps.store.installationById(deviceId)?.blockedAt != null) return true;
    const device = this.deps.store.deviceById(deviceId);
    if (!device) return false;
    if (device.blockedAt !== null) return true;
    return this.deps.store.accountById(device.accountId)?.blockedAt != null;
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

      /* Authorization: an installation asking whether it may run. Open to any
         installation, account or not - a computer used only on its own network
         has no account and is exactly the case this exists for. */
      if (route === 'POST /api/installations/challenge') return this.installationChallenge(req, res);
      if (route === 'POST /api/installations/register') return await this.registerInstallation(req, res);
      if (route === 'POST /api/installations/verify') return await this.verifyInstallation(req, res);

      /* Administration: disabling an installation, and accounting for it.
         Every one of these needs an administrator token - never a sign-in,
         never a device - and there is no route here that anybody else can
         reach. */
      if (route === 'GET /api/admin/installations') return this.adminList(req, res);
      if (req.method === 'POST' && /^\/api\/admin\/installations\/[^/]+\/(un)?block$/.test(url.pathname)) {
        const parts = url.pathname.split('/');
        return await this.adminSetBlocked(req, res, decodeURIComponent(parts[4]!), parts[5] === 'block');
      }
      if (req.method === 'POST' && /^\/api\/admin\/accounts\/[^/]+\/(un)?block$/.test(url.pathname)) {
        const parts = url.pathname.split('/');
        return await this.adminSetAccountBlocked(req, res, decodeURIComponent(parts[4]!), parts[5] === 'block');
      }
      if (req.method === 'GET' && /^\/api\/admin\/installations\/[^/]+\/history$/.test(url.pathname)) {
        return this.adminHistory(req, res, decodeURIComponent(url.pathname.split('/')[4]!));
      }
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
    this.deps.store.recordEvent(`device:${caller.deviceId}`, 'approved', deviceId, null, this.now());
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
      /* Enrolling again does not clear a block: that is the whole point of
         keeping the record rather than removing the device. */
      blockedAt: existingDevice?.blockedAt ?? null,
      blockedReason: existingDevice?.blockedReason ?? null,
      blockedBy: existingDevice?.blockedBy ?? null,
      tokenHash: hashToken(deviceToken),
      createdAt: existing?.createdAt ?? this.now(),
    });
    this.deps.log(`device ${body.deviceId} enrolled for account ${caller.accountId}`
      + `${approved ? '' : ', waiting to be approved from an approved computer'}`);
    /* Kept, and not only logged: the text log rotates away, and "when did
       this computer join the account, and was anything done to it since" is
       the question an administrator actually has when deciding about a
       block. Nothing here is new information - it is the same enrolment the
       account already records - it is only kept where it can be read back. */
    this.deps.store.recordEvent(`account:${caller.accountId}`,
      approved ? 'enrolled' : 'enrolled-waiting', body.deviceId, body.name, this.now());
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
    this.deps.store.recordEvent(`account:${caller.accountId}`, 'removed', deviceId, null, this.now());
    return this.send(res, 200, { ok: true });
  }

  /* -------------------------------------------------------- authorization */

  /** A nonce for an installation to sign, proving it holds its own key. */
  private installationChallenge(req: IncomingMessage, res: ServerResponse) {
    if (!this.deps.config.authSigningKey) return this.send(res, 501, { error: 'authorization-not-enabled' });
    const limit = this.deps.store.throttle(
      `install:${clientAddress(req, this.deps.config.trustProxy)}`, this.now(), 30, 15 * 60_000);
    if (limit.locked) return this.send(res, 429, { error: 'rate-limited', retryAfterMs: limit.retryAfterMs });

    /* Dropped here as well as on the account route: this one needs no
       sign-in, so it is the one that can be asked repeatedly by anybody. */
    this.pruneChallenges();
    const nonce = toBase64(randomBytes(24));
    this.challenges.set(nonce, { accountId: INSTALLATION_CHALLENGE, expiresAt: this.now() + 5 * 60_000 });
    return this.send(res, 200, { nonce, expiresInMs: 5 * 60_000 });
  }

  /**
   * Registers an installation and gives it a credential it can be stripped of.
   *
   * The signature proves this installation holds the key behind the identity
   * it claims, exactly as device enrolment does - so one installation cannot
   * register as another and inherit its standing, or its block.
   */
  private async registerInstallation(req: IncomingMessage, res: ServerResponse) {
    if (!this.deps.config.authSigningKey) return this.send(res, 501, { error: 'authorization-not-enabled' });
    const limit = this.deps.store.throttle(
      `install:${clientAddress(req, this.deps.config.trustProxy)}`, this.now(), 30, 15 * 60_000);
    if (limit.locked) return this.send(res, 429, { error: 'rate-limited', retryAfterMs: limit.retryAfterMs });

    const body = parseJson(registerInstallationBody, await readBody(req), MAX_BODY);
    const challenge = this.challenges.get(body.nonce);
    this.challenges.delete(body.nonce);
    if (!challenge || challenge.expiresAt <= this.now() || challenge.accountId !== INSTALLATION_CHALLENGE) {
      return this.send(res, 400, { error: 'bad-challenge' });
    }

    let publicKey: Uint8Array;
    try {
      publicKey = fromBase64(body.publicKey);
    } catch {
      return this.send(res, 400, { error: 'bad-key' });
    }
    if (deviceIdFromPublicKey(publicKey) !== body.installationId) {
      return this.send(res, 400, { error: 'key-mismatch' });
    }
    const signed = verify(publicKey, INSTALLATION_LABEL, utf8(`${body.nonce}\0${body.installationId}`),
      fromBase64(body.signature));
    if (!signed) return this.send(res, 401, { error: 'bad-signature' });

    const existing = this.deps.store.installationById(body.installationId);
    const token = `hdi_${toBase64(randomBytes(32))}`;
    this.deps.store.saveInstallation({
      installationId: body.installationId,
      publicKey: body.publicKey,
      os: body.os ?? existing?.os ?? null,
      appVersion: body.appVersion ?? existing?.appVersion ?? null,
      tokenHash: hashToken(token),
      createdAt: existing?.createdAt ?? this.now(),
    });
    this.deps.store.touchInstallation(body.installationId, this.now(), body.appVersion ?? null);
    this.deps.log(`installation ${body.installationId} registered`
      + `${existing?.blockedAt ? ' (still blocked)' : ''}`);
    return this.send(res, 201, {
      token,
      ...this.installationVerdict(body.installationId),
    });
  }

  /** Whether an installation may still run. Signed, so it cannot be forged. */
  private async verifyInstallation(req: IncomingMessage, res: ServerResponse) {
    if (!this.deps.config.authSigningKey) return this.send(res, 501, { error: 'authorization-not-enabled' });
    /* Rate-limited like the rest: this route is open, and each answer costs a
       signature, which is exactly the shape of thing that gets used to make a
       server do arithmetic for nothing. An installation asks twice a day. */
    const limit = this.deps.store.throttle(
      `install:${clientAddress(req, this.deps.config.trustProxy)}`, this.now(), 30, 15 * 60_000);
    if (limit.locked) return this.send(res, 429, { error: 'rate-limited', retryAfterMs: limit.retryAfterMs });
    const body = parseJson(verifyInstallationBody, await readBody(req), MAX_BODY);
    const installation = this.deps.store.installationByTokenHash(hashToken(body.token));
    if (!installation) return this.send(res, 401, { error: 'unknown-installation' });
    this.deps.store.touchInstallation(installation.installationId, this.now(), body.appVersion ?? null);
    return this.send(res, 200, this.installationVerdict(installation.installationId));
  }

  /**
   * The server's answer about one installation, signed.
   *
   * Signed because the client has to be able to tell this server's answer from
   * anything else that might reply - a proxy, a hosts file, a server of the
   * person's own. An unsigned "you are allowed" is worth nothing.
   */
  private installationVerdict(installationId: string) {
    const installation = this.deps.store.installationById(installationId);
    const status: InstallationVerdict['status'] = installation?.blockedAt != null ? 'blocked' : 'active';
    const statement: InstallationVerdict = {
      installationId,
      status,
      reason: installation?.blockedReason ?? null,
      checkedAt: this.now(),
      validUntil: this.now() + this.deps.config.authGraceMs,
    };
    const signer = identityFromSecretKey(this.deps.config.authSigningKey!);
    return {
      ...statement,
      signature: toBase64(sign(signer, VERDICT_LABEL, verdictBytes(statement))),
    };
  }

  /* ---------------------------------------------------------------- admin */

  /**
   * The administrator behind a request, or null.
   *
   * A separate credential from everything else in this server: not an account,
   * not a device, and not something a sign-in can escalate into. Stored
   * hashed, so the database is no use to whoever reads it, and compared in
   * constant time by the hash lookup rather than by string.
   */
  private admin(req: IncomingMessage): { id: string; email: string } | null {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const admin = this.deps.store.adminByTokenHash(hashToken(header.slice(7).trim()));
    if (!admin) return null;
    this.deps.store.touchAdmin(admin.id, this.now());
    return { id: admin.id, email: admin.email };
  }

  /** Refuses the request unless an administrator made it, slowly. */
  private requireAdmin(req: IncomingMessage, res: ServerResponse): { id: string; email: string } | null {
    /* Guessing an administrator token must not be cheap, and the throttle is
       keyed on the caller's address rather than the token so that trying a
       thousand tokens is one thousand attempts, not one each. */
    const where = `admin:${clientAddress(req, this.deps.config.trustProxy)}`;
    const limit = this.deps.store.throttle(where, this.now(), 20, 15 * 60_000);
    if (limit.locked) {
      this.send(res, 429, { error: 'rate-limited', retryAfterMs: limit.retryAfterMs });
      return null;
    }
    const admin = this.admin(req);
    if (!admin) {
      this.deps.log(`refused an administrator request from ${clientAddress(req, this.deps.config.trustProxy)}`);
      this.send(res, 401, { error: 'unauthorised' });
      return null;
    }
    this.deps.store.clearThrottle(where);
    return admin;
  }

  /** Every installation and every account device the server knows. */
  private adminList(req: IncomingMessage, res: ServerResponse) {
    if (!this.requireAdmin(req, res)) return;
    /* Two registries, because they answer different questions: an
       installation is any copy of HopDesk that registered, account or not,
       and a device is one signed in to an account. The same computer is
       usually both, under the same id. */
    const installations = this.deps.store.allInstallations().map(i => ({
      installationId: i.installationId,
      os: i.os,
      appVersion: i.appVersion,
      registeredAt: i.createdAt,
      lastSeen: i.lastSeen,
      status: i.blockedAt !== null ? 'blocked' : 'active',
      blockedAt: i.blockedAt,
      blockedReason: i.blockedReason,
      blockedBy: i.blockedBy,
    }));
    const devices = this.deps.store.allDevices().map(d => {
      const account = this.deps.store.accountById(d.accountId);
      return {
        installationId: d.deviceId,
        name: d.name,
        os: d.os,
        accountId: d.accountId,
        accountEmail: account?.email ?? null,
        registeredAt: d.createdAt,
        lastSeen: d.lastSeen,
        online: this.deps.presence.isOnline(d.deviceId),
        approved: d.approved,
        status: d.blockedAt !== null ? 'blocked' : (account?.blockedAt != null ? 'blocked-by-account' : 'active'),
        blockedAt: d.blockedAt,
        blockedReason: d.blockedReason,
        blockedBy: d.blockedBy,
      };
    });
    return this.send(res, 200, { installations, devices });
  }

  /**
   * Disables or restores one installation.
   *
   * Blocking takes effect at once: the credential stops working everywhere,
   * and the socket it is holding is closed, which ends the sessions being
   * relayed through it. What it cannot reach is a session between two
   * computers on the same network, which never passes through this server.
   */
  private async adminSetBlocked(req: IncomingMessage, res: ServerResponse, deviceId: string, blocked: boolean) {
    const admin = this.requireAdmin(req, res);
    if (!admin) return;
    /* Either registry is enough to act on: a computer that has registered but
       never signed in to an account is exactly the case this exists for. */
    if (!this.deps.store.deviceById(deviceId) && !this.deps.store.installationById(deviceId)) {
      return this.send(res, 404, { error: 'not-found' });
    }
    const reason = await this.reasonFrom(req);

    if (blocked) {
      /* Both registries at once. The same computer is usually an installation
         and an account device under one id, and an administrator blocking
         "that computer" means both - leaving one of them open would be a
         block in name only. */
      this.deps.store.blockDevice(deviceId, this.now(), reason, admin.email);
      this.deps.store.blockInstallation(deviceId, this.now(), reason, admin.email);
      this.deps.store.recordAdminEvent(admin.email, 'block', deviceId, reason, this.now());
      /* Not just future connections: whatever it is doing now, through this
         server, stops. */
      this.deps.presence.disconnect(deviceId, 'disabled');
      this.deps.log(`installation ${deviceId} blocked by ${admin.email}${reason ? `: ${reason}` : ''}`);
    } else {
      this.deps.store.unblockDevice(deviceId);
      this.deps.store.unblockInstallation(deviceId);
      this.deps.store.recordAdminEvent(admin.email, 'unblock', deviceId, reason, this.now());
      this.deps.log(`installation ${deviceId} unblocked by ${admin.email}`);
    }
    return this.send(res, 200, { ok: true, installationId: deviceId, status: blocked ? 'blocked' : 'active' });
  }

  /** The same, for every installation signed in to one account. */
  private async adminSetAccountBlocked(req: IncomingMessage, res: ServerResponse, accountId: string, blocked: boolean) {
    const admin = this.requireAdmin(req, res);
    if (!admin) return;
    const account = this.deps.store.accountById(accountId);
    if (!account) return this.send(res, 404, { error: 'not-found' });
    const reason = await this.reasonFrom(req);
    const devices = this.deps.store.devicesOfAccount(accountId);

    if (blocked) {
      this.deps.store.blockAccount(accountId, this.now(), reason, admin.email);
      this.deps.store.recordAdminEvent(admin.email, 'block-account', accountId, reason, this.now());
      for (const device of devices) this.deps.presence.disconnect(device.deviceId, 'disabled');
      this.deps.log(`account ${account.email} blocked by ${admin.email}${reason ? `: ${reason}` : ''}`);
    } else {
      this.deps.store.unblockAccount(accountId);
      this.deps.store.recordAdminEvent(admin.email, 'unblock-account', accountId, reason, this.now());
    }
    return this.send(res, 200, { ok: true, accountId, status: blocked ? 'blocked' : 'active', installations: devices.length });
  }

  /** What was done to this installation, and why. */
  private adminHistory(req: IncomingMessage, res: ServerResponse, deviceId: string) {
    if (!this.requireAdmin(req, res)) return;
    return this.send(res, 200, { events: this.deps.store.adminEventsFor(deviceId) });
  }

  /** The reason an administrator gave, if they gave one. */
  private async reasonFrom(req: IncomingMessage): Promise<string | null> {
    try {
      const raw = await readBody(req);
      if (!raw) return null;
      const body = JSON.parse(raw) as { reason?: unknown };
      return typeof body.reason === 'string' ? body.reason.slice(0, 200) : null;
    } catch {
      return null;
    }
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
