import { EventEmitter } from 'node:events';
import { sign, toBase64, utf8, type SecureStorage } from '@hopdesk/crypto';
import { RelayClient, type RelaySessionIntro, type RelayState } from '@hopdesk/transport';
import type { MessageLink } from '@hopdesk/protocol';
import type { LocalIdentity } from './identity.js';

/**
 * Signing in to a HopDesk server, so this computer appears in "My computers"
 * and can be reached from anywhere rather than only on this network.
 *
 * What is stored here, and where:
 *
 * * the server address and the email — ordinary settings;
 * * the refresh token and this computer's device token — in the same protected
 *   storage as the device key, never in settings and never logged.
 *
 * The device token is what lets a computer stay reachable while nobody is
 * logged in at the keyboard. It is bound to this device, and removing the
 * device on the server makes it useless immediately.
 */

export interface AccountComputer {
  deviceId: string;
  name: string;
  /** 'macos', 'linux', 'windows' - what the computer said when it enrolled. */
  os: string | null;
  /**
   * Whether a computer already on this account has vouched for this one.
   * A computer that has not been cannot reach anything: email and password add
   * a computer, they do not make it one of yours.
   */
  approved: boolean;
  publicKey: string;
  online: boolean;
  lastSeen: number | null;
  /** True for the computer this app is running on. */
  self: boolean;
}

export interface AccountState {
  signedIn: boolean;
  serverUrl?: string;
  email?: string;
  deviceName?: string;
  relay: RelayState;
  /** Why the account is not usable right now, in words for the UI. */
  detail?: string;
  computers: AccountComputer[];
}

export interface AccountDependencies {
  identity: LocalIdentity;
  /** The name this computer is listed under. */
  deviceName: string;
  storage: SecureStorage;
  log: { info(m: string): void; warn(m: string): void };
  /** Where a session relayed by the server is handed to the Host. */
  onIncoming: (intro: RelaySessionIntro, link: MessageLink) => void;
  /** Persisted, non-secret part: the server address and the email. */
  readSettings: () => { serverUrl?: string; email?: string };
  writeSettings: (patch: { serverUrl?: string | null; email?: string | null }) => Promise<void>;
  fetch?: typeof fetch;
}

const REFRESH_SECRET = 'account-refresh-token';
const DEVICE_SECRET = 'account-device-token';
/** The label a device signs to prove it holds its key while enrolling. */
const ENROL_LABEL = 'hopdesk/enrol/v1';

/**
 * What kind of computer this is, in the words the interface uses for an icon.
 * Node's own names for the other platforms are already what is wanted.
 */
function osName(): string {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
}
/** How often the list is fetched again behind the live updates. */
const POLL_MS = 120_000;

export class AccountError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class AccountClient extends EventEmitter {
  private relay: RelayClient | null = null;
  private relayState: RelayState = 'offline';
  private accessToken: string | null = null;
  private accessExpiresAt = 0;
  private deviceToken: string | null = null;
  private computers: AccountComputer[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private accountId: string | null = null;
  private detail: string | undefined;
  private readonly fetch: typeof fetch;

  constructor(private readonly deps: AccountDependencies) {
    super();
    this.fetch = deps.fetch ?? fetch;
  }

  state(): AccountState {
    const settings = this.deps.readSettings();
    return {
      signedIn: this.deviceToken !== null,
      ...(settings.serverUrl ? { serverUrl: settings.serverUrl } : {}),
      ...(settings.email ? { email: settings.email } : {}),
      deviceName: this.deps.deviceName,
      relay: this.relayState,
      ...(this.detail ? { detail: this.detail } : {}),
      computers: this.computers,
    };
  }

  /** Whether a viewer may connect because it is a computer on this account. */
  authorises(viewerId: string, viewerKey: Uint8Array): boolean {
    const known = this.computers.find(c => c.deviceId === viewerId);
    if (!known || known.self) return false;
    /* A computer nobody on this account has vouched for is not one of ours,
       whatever the server says about it. The relay refuses it a socket too;
       this is the half that does not depend on the server behaving. */
    if (!known.approved) return false;
    // The key must be the one the account holds for that Device ID.
    return known.publicKey === toBase64(viewerKey);
  }

  /* -------------------------------------------------------------- sign in */

  async signIn(serverUrl: string, email: string, password: string): Promise<AccountState> {
    const base = normalizeServerUrl(serverUrl);
    const session = await this.request<{ accessToken: string; refreshToken: string; expiresIn: number; account: { id: string; email: string } }>(
      base, 'POST', '/api/login', { body: { email, password } });

    this.accessToken = session.accessToken;
    this.accessExpiresAt = Date.now() + session.expiresIn - 30_000;
    this.accountId = session.account.id;
    await this.deps.storage.set(REFRESH_SECRET, utf8(session.refreshToken));
    await this.deps.writeSettings({ serverUrl: base, email: session.account.email });

    await this.enrol(base);
    await this.refreshComputers();
    /* Signing in worked even when the relay will not have this computer yet.
       A computer waiting to be approved from another one on the account is
       refused a socket, and that is not a failure to sign in - it is the
       state it is meant to be in, and being told so is the whole point.
       The relay keeps trying by itself and connects the moment it is let in. */
    await this.connectRelay().catch((err: unknown) => {
      this.detail = (err as Error).message;
      this.deps.log.info(`signed in; the relay is not available yet: ${this.detail}`);
    });
    this.emitChange();
    return this.state();
  }

  /**
   * Creates an account on a server, then signs in. Most servers require the
   * registration token their owner set when deploying.
   */
  async register(serverUrl: string, email: string, password: string, token?: string): Promise<AccountState> {
    const base = normalizeServerUrl(serverUrl);
    await this.request(base, 'POST', '/api/register', {
      body: { email, password, ...(token ? { token } : {}) },
      anonymous: true,
    });
    return this.signIn(base, email, password);
  }

  /** Restores a session saved earlier, at startup. */
  async restore(): Promise<void> {
    const settings = this.deps.readSettings();
    if (!settings.serverUrl) return;
    const stored = await this.deps.storage.get(DEVICE_SECRET);
    if (!stored) return;
    this.deviceToken = new TextDecoder().decode(stored);
    try {
      await this.refreshComputers();
      await this.connectRelay();
    } catch (err) {
      // Being unable to reach the server is not a reason to fail to start.
      this.detail = `Could not reach the HopDesk server: ${(err as Error).message}`;
      this.deps.log.warn(this.detail);
    }
    this.emitChange();
  }

  async signOut({ keepDevice = false } = {}): Promise<AccountState> {
    const settings = this.deps.readSettings();
    const base = settings.serverUrl;
    /* Signing out removes this computer from the account by default: leaving it
       enrolled would keep it reachable by anyone who still has the account. */
    if (base && !keepDevice) {
      try {
        await this.request(base, 'DELETE', `/api/devices/${encodeURIComponent(this.deps.identity.deviceId)}`, {});
      } catch (err) {
        this.deps.log.warn(`could not remove this computer from the account: ${(err as Error).message}`);
      }
    }
    const refresh = await this.deps.storage.get(REFRESH_SECRET);
    if (base && refresh) {
      try {
        await this.request(base, 'POST', '/api/logout', { body: { refreshToken: new TextDecoder().decode(refresh) }, anonymous: true });
      } catch { /* the token expires on its own */ }
    }
    this.relay?.close();
    this.relay = null;
    this.relayState = 'offline';
    this.accessToken = null;
    this.deviceToken = null;
    this.computers = [];
    this.detail = undefined;
    await this.deps.storage.delete(REFRESH_SECRET);
    await this.deps.storage.delete(DEVICE_SECRET);
    await this.deps.writeSettings({ email: null });
    this.emitChange();
    return this.state();
  }

  /** Enrols this computer, proving it holds the private key behind its Device ID. */
  private async enrol(base: string) {
    if (!this.accountId) throw new AccountError('signed-out', 'Sign in before enrolling this computer');
    const challenge = await this.request<{ nonce: string }>(base, 'POST', '/api/devices/challenge', {});
    const signature = toBase64(sign(this.deps.identity.identity, ENROL_LABEL, utf8(`${challenge.nonce}\0${this.accountId}`)));
    const enrolled = await this.request<{ deviceToken: string }>(base, 'POST', '/api/devices', {
      body: {
        deviceId: this.deps.identity.deviceId,
        publicKey: toBase64(this.deps.identity.identity.publicKey),
        name: this.deps.deviceName,
        os: osName(),
        nonce: challenge.nonce,
        signature,
      },
    });
    this.deviceToken = enrolled.deviceToken;
    await this.deps.storage.set(DEVICE_SECRET, utf8(enrolled.deviceToken));
    this.deps.log.info(`this computer is enrolled as ${this.deps.identity.deviceId}`);
  }

  private async storedRefresh(): Promise<string> {
    const stored = await this.deps.storage.get(REFRESH_SECRET);
    if (!stored) throw new AccountError('signed-out', 'Sign in to this HopDesk server again');
    return new TextDecoder().decode(stored);
  }

  /* ------------------------------------------------------------ computers */

  async refreshComputers(): Promise<AccountComputer[]> {
    const settings = this.deps.readSettings();
    if (!settings.serverUrl) return [];
    const { devices } = await this.request<{ devices: AccountComputer[] }>(settings.serverUrl, 'GET', '/api/devices', {});
    this.computers = devices.map(d => ({ ...d, self: d.deviceId === this.deps.identity.deviceId }));
    this.detail = undefined;
    this.emitChange();
    return this.computers;
  }

  /**
   * Vouches for another computer on this account, which lets it connect.
   *
   * Only a computer that is itself approved may do this, and the server checks
   * that rather than taking our word for it - a sign-in alone is refused,
   * which is what makes the whole arrangement worth anything.
   */
  async approveComputer(deviceId: string): Promise<void> {
    const settings = this.deps.readSettings();
    if (!settings.serverUrl) throw new AccountError('signed-out', 'Not signed in');
    await this.request(settings.serverUrl, 'POST', `/api/devices/${encodeURIComponent(deviceId)}/approve`, {});
    this.deps.log.info(`approved ${deviceId}; it can now connect through this account`);
    await this.refreshComputers();
  }

  /** Removes another computer from the account. */
  async removeComputer(deviceId: string): Promise<void> {
    const settings = this.deps.readSettings();
    if (!settings.serverUrl) throw new AccountError('signed-out', 'Not signed in');
    await this.request(settings.serverUrl, 'DELETE', `/api/devices/${encodeURIComponent(deviceId)}`, {});
    await this.refreshComputers();
  }

  /** ICE servers for a session, from the server's relay configuration. */
  async iceServers(): Promise<unknown[]> {
    const settings = this.deps.readSettings();
    if (!settings.serverUrl || !this.deviceToken) return [];
    try {
      const answer = await this.request<{ iceServers: unknown[] }>(settings.serverUrl, 'GET', '/api/turn', {});
      return Array.isArray(answer.iceServers) ? answer.iceServers : [];
    } catch (err) {
      this.deps.log.warn(`could not get relay credentials: ${(err as Error).message}`);
      return [];
    }
  }

  /* ---------------------------------------------------------------- relay */

  /**
   * Asks for the list again now and then, as a floor under the live updates.
   *
   * The server says who came and went, which is what makes the list live; this
   * is for what a push cannot cover - a message missed while this computer was
   * asleep, a device enrolled or removed elsewhere, a server restarted. Slow
   * on purpose: it is a safety net, not the mechanism.
   */
  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.deviceToken) return;
      void this.refreshComputers().catch(() => { /* the next one will do */ });
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  private async connectRelay(): Promise<void> {
    const settings = this.deps.readSettings();
    if (!settings.serverUrl || !this.deviceToken) return;
    this.relay?.close();
    const url = `${settings.serverUrl.replace(/^http/, 'ws')}/ws`;
    const relay = new RelayClient({
      url,
      token: this.deviceToken,
      onIncoming: (intro, link) => this.deps.onIncoming(intro, link),
      /* The server says who came and went as it happens, so the list follows
         without asking for it again. */
      onPresence: change => this.applyPresence(change),
      onState: (state, detail) => {
        this.relayState = state;
        this.detail = state === 'offline' && detail ? detail : undefined;
        if (state === 'online') void this.refreshComputers().catch(() => {});
        this.emitChange();
      },
      log: message => this.deps.log.info(message),
    });
    this.relay = relay;
    this.startPolling();
    await relay.connect();
  }

  /**
   * One computer's arrival or departure, from the server.
   *
   * Applied to what is already known rather than fetching the list again: a
   * whole round trip for one boolean would make a busy account chatty, and the
   * message carries everything that changed. A device nobody has heard of -
   * one enrolled since this list was fetched - is worth the fetch.
   */
  private applyPresence(change: { deviceId: string; online: boolean; lastSeen: number }): void {
    const known = this.computers.find(c => c.deviceId === change.deviceId);
    if (!known) {
      void this.refreshComputers().catch(() => {});
      return;
    }
    if (known.online === change.online && known.lastSeen === change.lastSeen) return;
    known.online = change.online;
    known.lastSeen = change.lastSeen;
    this.emitChange();
  }

  /** Asks the server to introduce this computer to another one. */
  async openSession(deviceId: string) {
    if (!this.relay?.connected) throw new AccountError('offline', 'Not connected to the HopDesk server');
    return this.relay.requestSession(deviceId);
  }

  close() {
    this.relay?.close();
    this.relay = null;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  /* ---------------------------------------------------------------- http */

  private async request<T>(base: string, method: string, path: string, opts: { body?: unknown; anonymous?: boolean }): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (!opts.anonymous) {
      const token = await this.authorization(base);
      if (token) headers.authorization = `Bearer ${token}`;
    }
    let response: Response;
    try {
      response = await this.fetch(`${base}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (err) {
      throw new AccountError('unreachable', `Could not reach ${base}: ${(err as Error).message}`);
    }
    const text = await response.text();
    const parsed = text ? safeJson(text) : null;
    if (!response.ok) {
      const code = (parsed as { error?: string } | null)?.error ?? String(response.status);
      throw new AccountError(code, describe(code, (parsed as { detail?: string } | null)?.detail));
    }
    return parsed as T;
  }

  /** A usable credential: the device token, or an access token refreshed if stale. */
  private async authorization(base: string): Promise<string | null> {
    if (this.deviceToken) return this.deviceToken;
    if (this.accessToken && Date.now() < this.accessExpiresAt) return this.accessToken;
    const refresh = await this.deps.storage.get(REFRESH_SECRET);
    if (!refresh) return null;
    const renewed = await this.request<{ accessToken: string; refreshToken: string; expiresIn: number }>(
      base, 'POST', '/api/token/refresh', { body: { refreshToken: new TextDecoder().decode(refresh) }, anonymous: true });
    this.accessToken = renewed.accessToken;
    this.accessExpiresAt = Date.now() + renewed.expiresIn - 30_000;
    await this.deps.storage.set(REFRESH_SECRET, utf8(renewed.refreshToken));
    return this.accessToken;
  }

  private emitChange() { this.emit('change', this.state()); }
}

function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new AccountError('bad-url', 'That does not look like a server address');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    // Plain HTTP would expose the password and the tokens on the way.
    throw new AccountError('insecure', 'A HopDesk server address must start with https://');
  }
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** Server error codes in words a person can act on. */
function describe(code: string, detail?: string): string {
  switch (code) {
    case 'bad-credentials': return 'That email and password do not match an account on this server.';
    case 'too-many-attempts': return 'Too many sign-in attempts. Wait a few minutes and try again.';
    case 'registration-closed': return 'This server is not accepting new accounts.';
    case 'bad-registration-token': return 'That registration token is not right. Ask whoever runs this server for the current one.';
    case 'email-taken': return 'There is already an account with that email on this server.';
    case 'weak-password': return detail ?? 'Choose a longer password.';
    case 'device-claimed': return 'This computer is already enrolled on another account. Remove it there first.';
    case 'unauthorised': return 'Sign in again: this session has expired.';
    case 'reused': return 'You were signed out for safety, because a saved sign-in was used twice.';
    default: return detail ?? `The server refused the request (${code}).`;
  }
}
