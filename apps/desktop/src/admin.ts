/**
 * Administering installations from inside HopDesk, instead of from a terminal.
 *
 * The token is the whole of an administrator's authority over the service: it
 * can disable any installation the service knows about. So it lives here, in
 * the main process, encrypted by the same OS keystore that holds the identity
 * key - and it is never given back. The window asks for things to be done and
 * is told what happened; it is never told the credential that did them. That
 * way a mistake in the renderer, or anything that manages to run there, has
 * nothing to steal.
 *
 * A 401 is treated as the answer it is: the token is not good, so it is thrown
 * away rather than kept to fail again. Being told "not valid" once is better
 * than every page being mysteriously empty.
 */
import type { SecureStorage } from '@hopdesk/crypto';

const TOKEN_SECRET = 'admin-token';
const TIMEOUT_MS = 15_000;

/** What the window is allowed to know about an installation. */
export interface AdminInstallation {
  installationId: string;
  os: string | null;
  appVersion: string | null;
  registeredAt: number | null;
  lastSeen: number | null;
  status: string;
  blockedAt: number | null;
  blockedReason: string | null;
  blockedBy: string | null;
}

export interface AdminEvent {
  at: number;
  actor: string;
  action: string;
  subject: string;
  reason: string | null;
}

export interface AdminStatus {
  /** Whether a token is held. Never the token. */
  signedIn: boolean;
  /** The service being administered, so a person can see which one it is. */
  service: string | null;
  /**
   * Whether it will still be held after a restart.
   *
   * False on a computer with no OS keystore, where it is kept for this run
   * only - see `signIn`.
   */
  remembered: boolean;
}

export type AdminResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: 'no-token' | 'token-not-valid' | 'no-service' | 'unreachable' | 'refused'; detail?: string };

export interface AdminOptions {
  storage: SecureStorage;
  /** The service this build was made for, when it was made for one. */
  defaultService: string | null;
  /** Where the person pointed it, for a build with none compiled in. */
  savedService: () => string | null;
  rememberService: (url: string | null) => void;
  log: { info(m: string): void; warn(m: string): void };
  fetch?: typeof globalThis.fetch;
}

export class AdminClient {
  private token: string | null = null;
  private loaded = false;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly opts: AdminOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  /** The address being administered: the build's, or the one chosen here. */
  get service(): string | null {
    return this.opts.defaultService ?? this.opts.savedService();
  }

  async status(): Promise<AdminStatus> {
    await this.load();
    return {
      signedIn: this.token !== null,
      service: this.service,
      remembered: this.token !== null && this.opts.storage.osProtected,
    };
  }

  /**
   * Checks a token by using it, and keeps it only if it worked.
   *
   * Storing first and verifying later would leave a useless credential behind
   * after a typo, and the person being told it was accepted.
   */
  async signIn(token: string, service?: string | null): Promise<AdminResult<{ service?: string; remembered?: boolean }>> {
    const url = normalise(service ?? this.service);
    if (!url) return { ok: false, error: 'no-service' };
    if (!/^hda_[A-Za-z0-9_-]{16,}$/.test(token.trim())) {
      return { ok: false, error: 'token-not-valid', detail: 'That is not an administrator token.' };
    }

    const answer = await this.call<{ installations: unknown }>('GET', '/api/admin/installations', url, token.trim());
    if (!answer.ok) return answer;

    this.token = token.trim();
    this.loaded = true;
    /* Written down only where the operating system will encrypt it. Without a
       keystore - no Keychain, no Secret Service, no KWallet - the file store
       keeps secrets in a 0600 file and nothing more, which is the right
       trade for a device key that is useless to anyone else and the wrong one
       for a credential that can disable every installation on the service. So
       on such a computer it is held for this run and asked for again next
       time, which is a smaller cost than leaving it readable. */
    if (this.opts.storage.osProtected) {
      await this.opts.storage.set(TOKEN_SECRET, new TextEncoder().encode(this.token));
    } else {
      this.opts.log.warn('no OS keystore here, so the administrator token is kept for this run only');
    }
    if (!this.opts.defaultService) this.opts.rememberService(url);
    this.opts.log.info(`signed in to administer ${url}`);
    return { ok: true, service: url, remembered: this.opts.storage.osProtected };
  }

  async signOut(): Promise<void> {
    this.token = null;
    this.loaded = true;
    try {
      await this.opts.storage.delete(TOKEN_SECRET);
    } catch { /* nothing to delete is the state we wanted */ }
    this.opts.log.info('administrator token removed from this computer');
  }

  async list(): Promise<AdminResult<{ installations: AdminInstallation[] }>> {
    const answer = await this.authorised<{ installations: AdminInstallation[] }>('GET', '/api/admin/installations');
    if (!answer.ok) return answer;
    return { ok: true, installations: Array.isArray(answer.installations) ? answer.installations : [] };
  }

  async block(installationId: string, reason: string): Promise<AdminResult<{ status: string }>> {
    const answer = await this.authorised<{ status: string }>(
      'POST', `/api/admin/installations/${encodeURIComponent(installationId)}/block`,
      { reason: reason.slice(0, 200) },
    );
    if (!answer.ok) return answer;
    this.opts.log.info(`blocked ${installationId}`);
    return { ok: true, status: String(answer.status ?? 'blocked') };
  }

  async unblock(installationId: string): Promise<AdminResult<{ status: string }>> {
    const answer = await this.authorised<{ status: string }>(
      'POST', `/api/admin/installations/${encodeURIComponent(installationId)}/unblock`,
    );
    if (!answer.ok) return answer;
    this.opts.log.info(`unblocked ${installationId}`);
    return { ok: true, status: String(answer.status ?? 'active') };
  }

  async history(installationId: string): Promise<AdminResult<{ events: AdminEvent[] }>> {
    const answer = await this.authorised<{ events: AdminEvent[] }>(
      'GET', `/api/admin/installations/${encodeURIComponent(installationId)}/history`,
    );
    if (!answer.ok) return answer;
    return { ok: true, events: Array.isArray(answer.events) ? answer.events : [] };
  }

  /* ------------------------------------------------------------ inside */

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.opts.storage.osProtected) { this.token = null; return; }
    try {
      const stored = await this.opts.storage.get(TOKEN_SECRET);
      this.token = stored ? new TextDecoder().decode(stored) : null;
    } catch (err) {
      /* An unreadable keystore is not an invalid token: say so, and let the
         person sign in again rather than silently appearing signed out
         forever. */
      this.opts.log.warn(`could not read the administrator token: ${(err as Error).message}`);
      this.token = null;
    }
  }

  private async authorised<T>(method: string, route: string, body?: unknown): Promise<AdminResult<T>> {
    await this.load();
    const url = this.service;
    if (!url) return { ok: false, error: 'no-service' };
    if (!this.token) return { ok: false, error: 'no-token' };
    return this.call<T>(method, route, url, this.token, body);
  }

  private async call<T>(method: string, route: string, service: string, token: string, body?: unknown):
  Promise<AdminResult<T>> {
    let response: Response;
    try {
      response = await this.fetch(`${service}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      /* Never the exception's message to the window: a fetch failure can quote
         the request, and the request carries the token. */
      this.opts.log.warn(`administration request failed: ${(err as Error).name}`);
      return { ok: false, error: 'unreachable' };
    }

    if (response.status === 401) {
      /* The token is not good. Keeping it would mean every page quietly
         failing; throwing it away means being asked for a working one. */
      if (this.token) {
        this.token = null;
        try { await this.opts.storage.delete(TOKEN_SECRET); } catch { /* already gone */ }
        this.opts.log.warn('the administrator token was refused; it has been removed');
      }
      return { ok: false, error: 'token-not-valid' };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: 'refused',
        detail: response.status === 429 ? 'Too many attempts. Wait a few minutes.' : `The service answered ${response.status}.`,
      };
    }
    try {
      return { ok: true, ...(await response.json() as T) };
    } catch {
      return { ok: false, error: 'refused', detail: 'The service answered with something unreadable.' };
    }
  }
}

/** https only, and no credentials in the address. */
function normalise(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate.trim());
    const loopback = /^(127\.0\.0\.1|\[::1\]|localhost)$/.test(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (url.username || url.password) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
