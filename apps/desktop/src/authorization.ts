import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  deviceIdFromPublicKey, fromBase64, sign, toBase64, utf8, verify, type DeviceIdentity,
} from '@hopdesk/crypto';
import { VERDICT_LABEL, verdictBytes, verdictFrom, type InstallationVerdict } from '@hopdesk/protocol';
import type { SecureStorage } from '@hopdesk/crypto';

/**
 * Whether this installation of HopDesk is still allowed to run.
 *
 * The honest shape of this, so nobody reading it is misled:
 *
 * **What it does.** An installation registers itself with the authorization
 * service built into the build, gets a credential it can be stripped of, and
 * asks periodically whether it may still host. Blocked, it stops accepting
 * connections - including connections on the local network, which no server
 * can see, and which are therefore the only reason this client-side check
 * exists at all.
 *
 * **What makes it worth anything.** Every answer is signed by the service, and
 * the public half is built into the application. Pointing the check at another
 * server, a proxy or a hosts-file entry gets an answer that does not verify,
 * which counts as no answer - so a blocked installation cannot talk itself
 * into being allowed.
 *
 * **What it cannot do.** It cannot bind someone who edits this file and
 * rebuilds: HopDesk's source is public, and a few deleted lines defeat it. It
 * cannot reach a version of HopDesk released before it existed. And a computer
 * kept offline is unreachable until its grace window runs out. These are
 * properties of running software on a computer somebody else owns, not gaps to
 * be closed later.
 */

const FILE = 'authorization.json';
const TOKEN_SECRET = 'installation-token';
const REGISTER_LABEL = 'hopdesk/installation/register/v1';

/** How often an installation asks, while nothing is wrong. */
export const CHECK_INTERVAL_MS = 6 * 3600_000;

/**
 * The longest an answer stands, whatever the service said.
 *
 * The grace window is the service's to set, and this is the ceiling on it: a
 * misconfigured server cannot hand out an answer that never expires.
 */
const MAX_GRACE_MS = 30 * 24 * 3600_000;

/** How far ahead of this computer's clock an answer may be dated. */
const CLOCK_SLACK_MS = 24 * 3600_000;

export type AuthorizationState = 'active' | 'blocked' | 'unverified' | 'disabled';

export interface AuthorizationStatus {
  /**
   * `disabled` means this build has no authorization service to ask, which is
   * the case for a build made from source without one configured. It is not a
   * failure and not a block: there is nothing to check against.
   */
  state: AuthorizationState;
  /** Why it was blocked, when the service said so. */
  reason?: string;
  /** When the service last answered. */
  checkedAt?: number;
  /** How long this answer stands without another. */
  validUntil?: number;
  /** What to show a person, in their words. */
  detail?: string;
}

/** A verdict as the service states it, before any of it is believed. */
type Verdict = InstallationVerdict & { signature: string };

export interface AuthorizationOptions {
  dataDir: string;
  identity: DeviceIdentity;
  installationId: string;
  storage: SecureStorage;
  /** The service this build asks. Absent in a build with none configured. */
  serviceUrl: string | null;
  /** The key its answers must be signed with. Absent disables the check. */
  servicePublicKey: Uint8Array | null;
  appVersion: string;
  os: string;
  log: { info(m: string): void; warn(m: string): void };
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class Authorization {
  private token: string | null = null;
  private cached: Verdict | null = null;
  private readonly now: () => number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly opts: AuthorizationOptions) {
    this.now = opts.now ?? Date.now;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.cached = this.readCache();
  }

  private get file() { return path.join(this.opts.dataDir, FILE); }

  /** Whether this build has a service to ask at all. */
  get configured(): boolean {
    return Boolean(this.opts.serviceUrl && this.opts.servicePublicKey);
  }

  /**
   * What is known right now, without asking anybody.
   *
   * The cache is a *signed statement*, not a flag: editing the file to say
   * "active" produces something that does not verify, which is treated as
   * never having asked. That is the difference between a check and a
   * suggestion.
   */
  status(): AuthorizationStatus {
    if (!this.configured) {
      return { state: 'disabled', detail: 'This build has no authorization service configured.' };
    }
    const verdict = this.cached;
    if (!verdict) {
      return {
        state: 'unverified',
        detail: 'HopDesk has not been able to check whether this installation is authorized.',
      };
    }
    if (verdict.status === 'blocked') {
      return {
        state: 'blocked',
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        checkedAt: verdict.checkedAt,
        detail: 'This HopDesk installation has been disabled.',
      };
    }
    /* A verdict dated in the future would otherwise outlive any sane grace
       window, and one with an absurd validity would never expire. Neither can
       be forged - both are signed - but a server with a wrong clock or a
       mistaken grace setting should not be able to mint a permanent licence
       by accident. */
    const ceiling = Math.min(verdict.validUntil, verdict.checkedAt + MAX_GRACE_MS);
    if (ceiling <= this.now() || verdict.checkedAt > this.now() + CLOCK_SLACK_MS) {
      return {
        state: 'unverified',
        checkedAt: verdict.checkedAt,
        validUntil: ceiling,
        detail: 'HopDesk could not reach the authorization service, and the last answer has expired.',
      };
    }
      return { state: 'active', checkedAt: verdict.checkedAt, validUntil: ceiling };
  }

  /** Whether this installation may accept a connection right now. */
  mayHost(): boolean {
    const state = this.status().state;
    return state === 'active' || state === 'disabled';
  }

  /**
   * Asks the service, registering first if this installation has never asked.
   *
   * Never throws: a service that cannot be reached is an ordinary condition -
   * a laptop on a train - and the answer is the grace window, not a crash.
   */
  async check(): Promise<AuthorizationStatus> {
    if (!this.configured) return this.status();
    try {
      if (!this.token) this.token = await this.loadToken();
      if (!this.token) await this.register();
      else await this.verify();
    } catch (err) {
      this.opts.log.warn(`authorization check failed: ${(err as Error).message}`);
    }
    return this.status();
  }

  private async register(): Promise<void> {
    const challenge = await this.post<{ nonce: string }>('/api/installations/challenge', {});
    const signature = toBase64(sign(this.opts.identity, REGISTER_LABEL,
      utf8(`${challenge.nonce}\0${this.opts.installationId}`)));
    const answer = await this.post<Verdict & { token: string }>('/api/installations/register', {
      installationId: this.opts.installationId,
      publicKey: toBase64(this.opts.identity.publicKey),
      nonce: challenge.nonce,
      signature,
      os: this.opts.os,
      appVersion: this.opts.appVersion,
    });
    this.token = answer.token;
    await this.opts.storage.set(TOKEN_SECRET, utf8(answer.token));
    this.accept(answer);
    this.opts.log.info(`this installation is registered as ${this.opts.installationId} (${answer.status})`);
  }

  private async verify(): Promise<void> {
    const answer = await this.post<Verdict>('/api/installations/verify', {
      token: this.token,
      appVersion: this.opts.appVersion,
    });
    this.accept(answer);
  }

  /**
   * Takes an answer only if this service really gave it.
   *
   * An unsigned or wrongly signed answer is discarded rather than believed,
   * which is what stops a blocked installation from pointing the check at
   * something friendlier.
   */
  private accept(reply: object): void {
    const answer = reply as Record<string, unknown>;
    const key = this.opts.servicePublicKey;
    const signature = typeof answer.signature === 'string' ? answer.signature : null;
    const statement = verdictFrom(answer);
    if (!key || !signature || !statement) return;
    /* Only the named fields are checked, so anything else travelling in the
       same reply - the token, say - cannot change what was verified. */
    if (!verify(key, VERDICT_LABEL, verdictBytes(statement), fromBase64(signature))) {
      this.opts.log.warn('an authorization answer was not signed by the expected service; ignoring it');
      return;
    }
    if (statement.installationId !== this.opts.installationId) {
      this.opts.log.warn('an authorization answer was about a different installation; ignoring it');
      return;
    }
    this.cached = { ...statement, signature };
    try {
      writeFileSync(this.file, JSON.stringify(answer), { mode: 0o600 });
    } catch {
      /* Not fatal: the answer stands for this run, and the next check writes
         it again. */
    }
  }

  private readCache(): Verdict | null {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const key = this.opts.servicePublicKey;
      const signature = typeof raw?.signature === 'string' ? raw.signature : null;
      const statement = verdictFrom(raw ?? {});
      if (!key || !signature || !statement) return null;
      if (!verify(key, VERDICT_LABEL, verdictBytes(statement), fromBase64(signature))) return null;
      return statement.installationId === this.opts.installationId ? { ...statement, signature } : null;
    } catch {
      return null;
    }
  }

  private async loadToken(): Promise<string | null> {
    try {
      const stored = await this.opts.storage.get(TOKEN_SECRET);
      return stored ? new TextDecoder().decode(stored) : null;
    } catch {
      return null;
    }
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    const response = await this.fetch(`${this.opts.serviceUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    return await response.json() as T;
  }
}

/**
 * Whether a build in this state may accept connections.
 *
 * Separate from the class, and pure, because this is the decision that matters
 * and it has to be checked without an `Authorization` to hand. A build that was
 * made with a service to ask must not be allowed to host merely because the
 * check has not been constructed yet, or could not be: "we never asked" is the
 * same answer as "we could not ask", and both of them are no.
 *
 * @param configured Whether this build has a service and a key compiled in.
 * @param status What the check says, or null when there is no check at all.
 */
export function mayHostWith(configured: boolean, status: AuthorizationStatus | null): { ok: true } | { ok: false; detail: string } {
  if (!configured) return { ok: true };
  if (!status) {
    return {
      ok: false,
      detail: 'HopDesk has not been able to check whether this installation is authorized.',
    };
  }
  if (status.state === 'active' || status.state === 'disabled') return { ok: true };
  return { ok: false, detail: status.detail ?? 'this installation is not authorized' };
}

/** This installation's identity, which is the identity key it already has. */
export function installationIdFor(identity: DeviceIdentity): string {
  return deviceIdFromPublicKey(identity.publicKey);
}
