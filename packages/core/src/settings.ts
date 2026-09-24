import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_OPTIONS, type ConnectionOptions } from './connections.js';

/**
 * App-wide settings: the defaults new computers start with.
 *
 * Kept out of connections.json so a hand-edited or corrupt settings file never
 * takes saved computers with it, and written the same atomic way. Only
 * options that make sense as a default are accepted; per-computer values such
 * as a trusted certificate or a shared folder never live here.
 */

/**
 * Letting other computers connect to this one. Off until the user turns it on.
 * Which computers may connect without anyone answering a prompt is not kept
 * here but in the trusted list (apps/desktop/src/trusted.ts), because that is a
 * list of public keys rather than a setting.
 */
export interface RemoteAccessSettings {
  enabled: boolean;
  /** TCP port the Host listens on for direct connections on the local network. */
  port: number;
  /** Announce this computer on the local network so it can be found by name. */
  announce: boolean;
  /**
   * Which screen is shared, as Electron's display id, on a computer with more
   * than one. Null shares the main screen — and is also what a screen that has
   * since been unplugged falls back to.
   */
  screen: number | null;
}

/** The HopDesk server this computer is signed in to, if any. Not secret. */
export interface AccountSettings {
  serverUrl?: string;
  email?: string;
  /**
   * Always carry sessions through the server's relay instead of connecting the
   * two computers directly. Slower and uses the server's bandwidth, but the two
   * computers never learn each other's addresses.
   */
  forceRelay?: boolean;
}

/** How each computer was last connected to, keyed by Device ID. */
export type ConnectChoices = Record<string, 'trusted' | 'ask' | 'code'>;

export interface AppSettings {
  version: 1;
  account: AccountSettings;
  /**
   * The way in last used for each computer.
   *
   * Kept here rather than in the window's own storage, which belongs to
   * Chromium's profile and does not survive what a person would call the same
   * installation. Someone who has to ask permission for one computer and never
   * for another should not re-pick which is which.
   */
  connectChoices: ConnectChoices;
  defaults: Pick<ConnectionOptions,
    'scaling' | 'fullscreenOnConnect' | 'viewOnly' | 'shareClipboard' | 'enableAudio' | 'autoReconnect'>;
  remoteAccess: RemoteAccessSettings;
}

/** The Host's default port for direct connections on a local network. */
export const DEFAULT_HOST_PORT = 47631;

export const DEFAULT_REMOTE_ACCESS: RemoteAccessSettings = {
  enabled: false,
  port: DEFAULT_HOST_PORT,
  announce: true,
  screen: null,
};

const DEFAULT_KEYS = ['scaling', 'fullscreenOnConnect', 'viewOnly', 'shareClipboard', 'enableAudio', 'autoReconnect'] as const;

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  account: {},
  connectChoices: {},
  remoteAccess: structuredClone(DEFAULT_REMOTE_ACCESS),
  defaults: {
    scaling: DEFAULT_OPTIONS.scaling,
    fullscreenOnConnect: DEFAULT_OPTIONS.fullscreenOnConnect,
    viewOnly: DEFAULT_OPTIONS.viewOnly,
    shareClipboard: DEFAULT_OPTIONS.shareClipboard,
    enableAudio: DEFAULT_OPTIONS.enableAudio,
    autoReconnect: DEFAULT_OPTIONS.autoReconnect,
  },
};

export class SettingsStore {
  private data: AppSettings = structuredClone(DEFAULT_SETTINGS);

  constructor(private readonly dataDir: string) {}

  private get file() { return path.join(this.dataDir, 'settings.json'); }

  async load(): Promise<AppSettings> {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AppSettings>;
        this.data = {
          version: 1,
          defaults: sanitize({ ...DEFAULT_SETTINGS.defaults, ...(raw.defaults ?? {}) }),
          remoteAccess: sanitizeRemoteAccess(raw.remoteAccess),
          account: sanitizeAccount(raw.account),
          connectChoices: sanitizeChoices(raw.connectChoices),
        };
      } catch {
        // Settings are cheap to lose; the defaults are a working configuration.
        this.data = structuredClone(DEFAULT_SETTINGS);
      }
    }
    return this.get();
  }

  get(): AppSettings { return structuredClone(this.data); }

  async update(patch: {
    defaults?: Partial<AppSettings['defaults']>;
    remoteAccess?: Partial<RemoteAccessSettings>;
    /** Merged, not replaced: one computer's choice never clears another's. */
    connectChoices?: ConnectChoices;
    /** null clears a field, e.g. on sign-out. */
    account?: { serverUrl?: string | null; email?: string | null; forceRelay?: boolean | null };
  }): Promise<AppSettings> {
    this.data.defaults = sanitize({ ...this.data.defaults, ...(patch?.defaults ?? {}) });
    if (patch?.remoteAccess) {
      this.data.remoteAccess = sanitizeRemoteAccess({ ...this.data.remoteAccess, ...patch.remoteAccess });
    }
    if (patch?.connectChoices) {
      this.data.connectChoices = sanitizeChoices({ ...this.data.connectChoices, ...patch.connectChoices });
    }
    if (patch?.account) {
      const next: Record<string, unknown> = { ...this.data.account };
      for (const key of ['serverUrl', 'email', 'forceRelay'] as const) {
        const value = patch.account[key];
        if (value === null) delete next[key];
        else if (value !== undefined) next[key] = value;
      }
      this.data.account = sanitizeAccount(next);
    }
    await mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    return this.get();
  }
}

/** Keeps known keys with values of the right type; anything else falls back to the default. */
function sanitize(input: Record<string, unknown>): AppSettings['defaults'] {
  const out = structuredClone(DEFAULT_SETTINGS.defaults) as Record<string, unknown>;
  for (const key of DEFAULT_KEYS) {
    const value = input[key];
    if (key === 'scaling') {
      if (value === 'fit' || value === 'fill' || value === 'none') out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out as AppSettings['defaults'];
}

/**
 * Remote access is security-sensitive, so a malformed or hand-edited file must
 * never leave it more permissive than the defaults: anything unrecognised
 * falls back to off.
 */
function sanitizeRemoteAccess(input: unknown): RemoteAccessSettings {
  const out = structuredClone(DEFAULT_REMOTE_ACCESS);
  if (typeof input !== 'object' || input === null) return out;
  const raw = input as Record<string, unknown>;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.announce === 'boolean') out.announce = raw.announce;
  if (Number.isInteger(raw.port) && (raw.port as number) >= 1024 && (raw.port as number) <= 65535) {
    out.port = raw.port as number;
  }
  // Electron's display ids are large but whole; anything else means "the main screen".
  if (Number.isFinite(raw.screen) && Number.isInteger(raw.screen)) out.screen = raw.screen as number;
  /* There was once an "unattended access" password here, stored as the SPAKE2
     scalar. That scalar *was* the credential: anyone who could read this file
     could connect. Trusted device keys replaced it (apps/desktop/src/trusted.ts),
     and any leftover fields are dropped on load rather than honoured. */
  return out;
}

/**
 * Device IDs mapped to one of the three ways in, and nothing else. A
 * hand-edited or stale file cannot introduce a fourth, and cannot grow without
 * bound: a list this long is already far more computers than anyone has.
 */
function sanitizeChoices(input: unknown): ConnectChoices {
  const out: ConnectChoices = {};
  if (typeof input !== 'object' || input === null) return out;
  let kept = 0;
  for (const [deviceId, method] of Object.entries(input as Record<string, unknown>)) {
    if (kept >= 500) break;
    if (!/^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(deviceId)) continue;
    if (method !== 'trusted' && method !== 'ask' && method !== 'code') continue;
    out[deviceId] = method;
    kept++;
  }
  return out;
}

/** The server address and email only, and only in forms that make sense. */
function sanitizeAccount(input: unknown): AccountSettings {
  const out: AccountSettings = {};
  if (typeof input !== 'object' || input === null) return out;
  const raw = input as Record<string, unknown>;
  if (typeof raw.serverUrl === 'string' && /^https?:\/\/[^\s]+$/.test(raw.serverUrl)) out.serverUrl = raw.serverUrl.slice(0, 200);
  if (typeof raw.email === 'string' && raw.email.length <= 254) out.email = raw.email;
  if (typeof raw.forceRelay === 'boolean') out.forceRelay = raw.forceRelay;
  return out;
}
