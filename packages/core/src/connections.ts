import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CredentialStore } from './credentials.js';

/**
 * Saved connections.
 *
 * Deliberately a plain JSON file rather than SQLite: this is tens of records,
 * a user may reasonably want to read or hand-edit it, and adding a native
 * database dependency to a Linux desktop app means a compile step and an ABI
 * that breaks between distributions.
 *
 * **No password ever appears in this file.** Secrets live in the CredentialStore
 * (system keyring, or an encrypted vault) and are looked up by connection id at
 * connect time. The file is written 0600 regardless, because hostnames and
 * usernames are still worth protecting.
 */

export type Protocol = 'vnc' | 'rdp' | 'spice';

/** What the remote computer runs, as the user described it. Drives defaults and hints only. */
export type RemoteOs = 'windows' | 'macos' | 'linux' | 'other';

export interface Connection {
  id: string;
  name: string;
  protocol: Protocol;
  /** Optional; inferred for older files (RDP → Windows). */
  os?: RemoteOs;
  host: string;
  port: number;
  username?: string;
  /** RDP only; ignored elsewhere. */
  domain?: string;
  favorite: boolean;
  /** Per-connection overrides of the global settings. */
  options: ConnectionOptions;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
  /** Rolling count, used to sort "frequent" without a separate stats table. */
  connectCount: number;
}

export interface ConnectionOptions {
  /** fit scales to the window, fill crops, none is 1:1 with scrollbars. */
  /**
   * fit: whole remote screen in the window, aspect ratio kept.
   * none: 1:1 pixels (or `zoom` percent) with scrollbars.
   * fill: ask the remote computer to change its resolution to the window
   * (VNC servers with ExtendedDesktopSize, RDP dynamic resolution); falls back
   * to fit where unsupported. Never stretches the image.
   */
  scaling: 'fit' | 'fill' | 'none';
  /** Percent, used with scaling "none". */
  zoom?: number;
  fullscreenOnConnect: boolean;
  viewOnly: boolean;
  shareClipboard: boolean;
  /** RDP and SPICE only. */
  enableAudio: boolean;
  /** RDP only: a local folder exposed to the remote session. */
  redirectFolder?: string;
  /** RDP only. Higher means better quality, more bandwidth. */
  colorDepth?: 16 | 24 | 32;
  /** RDP multi-monitor. */
  multiMonitor: boolean;
  /**
   * RDP: which local monitors to use when multiMonitor is on — all of them, or
   * the listed FreeRDP monitor ids.
   */
  monitors?: number[];
  /** RDP: "auto" follows the window size; otherwise "WIDTHxHEIGHT". */
  resolution?: string;
  /** Reconnect automatically when the network drops. */
  autoReconnect: boolean;
  /**
   * RDP only: SHA-256 fingerprint of a certificate the user explicitly chose to
   * trust. Not secret — it identifies the server, it does not authenticate us.
   */
  trustedCertificate?: string;
}

export const DEFAULT_OPTIONS: ConnectionOptions = {
  scaling: 'fit',
  fullscreenOnConnect: false,
  viewOnly: false,
  shareClipboard: true,
  enableAudio: false,          // off by default: surprising and bandwidth-hungry
  colorDepth: 32,
  multiMonitor: false,
  autoReconnect: true,
};

export const DEFAULT_PORTS: Record<Protocol, number> = {
  vnc: 5900,
  rdp: 3389,
  spice: 5900,
};

export interface HistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  host: string;
  protocol: Protocol;
  startedAt: string;
  endedAt?: string;
  outcome: 'connected' | 'failed' | 'cancelled';
  /** When the session was established, if it was. */
  connectedAt?: string;
  /**
   * Session length for connected sessions (connectedAt → endedAt), attempt
   * length otherwise.
   */
  durationMs?: number;
  /** How a connected session ended. */
  endReason?: 'user' | 'remote' | 'error';
  error?: string;
  /** Machine-readable failure category (see errors.ts). */
  errorCategory?: string;
}

interface StoreFile {
  version: 1;
  connections: Connection[];
  history: HistoryEntry[];
}

const MAX_HISTORY = 200;

export class ConnectionManager {
  private data: StoreFile = { version: 1, connections: [], history: [] };
  private loaded = false;

  constructor(
    private readonly dataDir: string,
    private readonly credentials?: CredentialStore,
  ) {}

  private get file() { return path.join(this.dataDir, 'connections.json'); }

  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as StoreFile;
        this.data = {
          version: 1,
          connections: (raw.connections ?? []).map(normalise),
          history: raw.history ?? [],
        };
      } catch (err) {
        /* A corrupt file must not lose everything silently. Move it aside so
           the user can recover it by hand and start clean rather than crash on
           every launch. */
        const backup = `${this.file}.corrupt-${Date.now()}`;
        await rename(this.file, backup).catch(() => {});
        throw new Error(
          `Your connections file could not be read and was moved to ${backup}. ` +
          `Starting with an empty list. (${(err as Error).message})`);
      }
    }
    this.loaded = true;
  }

  private assertLoaded() {
    if (!this.loaded) throw new Error('ConnectionManager.load() was not called');
  }

  private writing: Promise<void> = Promise.resolve();

  /**
   * Writes are queued: two overlapping writes of the same temporary file could
   * otherwise rename a half-written file into place. Each write captures the
   * data as it is when it runs, so the last one queued always wins.
   */
  private persist(): Promise<void> {
    const next = this.writing.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      /* Write to a temporary file and rename. rename() is atomic on POSIX, so a
         crash mid-write cannot leave a truncated connections file — which would
         otherwise lose every saved host. */
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    // A failed write must not block every later one.
    this.writing = next.catch(() => {});
    return next;
  }

  /** Resolves once every queued write has reached the disk. */
  flush(): Promise<void> { return this.writing; }

  /* --------------------------------------------------------------- CRUD */

  list(): Connection[] {
    this.assertLoaded();
    // Favourites first, then most recently used, then alphabetical. This is the
    // order people actually look for things in.
    return [...this.data.connections].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      const at = a.lastConnectedAt ?? '';
      const bt = b.lastConnectedAt ?? '';
      if (at !== bt) return bt.localeCompare(at);
      return a.name.localeCompare(b.name);
    });
  }

  get(id: string): Connection | undefined {
    this.assertLoaded();
    return this.data.connections.find(c => c.id === id);
  }

  async add(input: {
    name: string; protocol: Protocol; os?: RemoteOs; host: string; port?: number;
    username?: string; domain?: string; password?: string;
    options?: Partial<ConnectionOptions>; favorite?: boolean;
  }): Promise<Connection> {
    this.assertLoaded();

    if (!PROTOCOLS.includes(input.protocol)) throw new Error('Choose how to connect: RDP or VNC');
    if (input.os !== undefined && !OSES.includes(input.os)) throw new Error('Choose the kind of computer');
    const host = cleanHost(input.host);
    const name = input.name.trim() || host;

    const port = input.port ?? DEFAULT_PORTS[input.protocol];
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Port must be between 1 and 65535');
    }

    const now = new Date().toISOString();
    const connection: Connection = {
      id: randomUUID(),
      name, protocol: input.protocol, host, port,
      os: input.os ?? (input.protocol === 'rdp' ? 'windows' : undefined),
      username: input.username?.trim() || undefined,
      domain: input.domain?.trim() || undefined,
      favorite: input.favorite ?? false,
      options: { ...DEFAULT_OPTIONS, ...input.options },
      createdAt: now, updatedAt: now,
      connectCount: 0,
    };

    this.data.connections.push(connection);
    await this.persist();

    // Stored separately, and only after the connection itself is safely on
    // disk — an orphaned secret is easier to live with than a saved password
    // pointing at a connection that failed to save.
    if (input.password && this.credentials) {
      await this.credentials.set(connection.id, input.password);
    }
    return connection;
  }

  async update(
    id: string,
    patch: Partial<Omit<Connection, 'id' | 'createdAt' | 'options'>> & { password?: string; options?: Partial<ConnectionOptions> },
  ): Promise<Connection> {
    this.assertLoaded();
    const existing = this.get(id);
    if (!existing) throw new Error('That connection no longer exists');

    if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) {
      throw new Error('Port must be between 1 and 65535');
    }
    if (patch.host !== undefined) patch = { ...patch, host: cleanHost(patch.host) };
    if (patch.protocol !== undefined && !PROTOCOLS.includes(patch.protocol)) throw new Error('Choose how to connect: RDP or VNC');
    if (patch.os !== undefined && !OSES.includes(patch.os)) throw new Error('Choose the kind of computer');

    const { password, ...fields } = patch;
    // A different address is a different machine: trust given to the old
    // one's certificate must not carry over to whatever answers there now.
    const moved = (fields.host !== undefined && fields.host.trim() !== existing.host)
      || (fields.port !== undefined && fields.port !== existing.port);
    const previousOptions = existing.options;
    Object.assign(existing, fields, { updatedAt: new Date().toISOString() });
    if (fields.host !== undefined) existing.host = fields.host.trim();
    existing.options = { ...previousOptions, ...(fields.options ?? {}) };
    if (moved && fields.options?.trustedCertificate === undefined) delete existing.options.trustedCertificate;
    // An empty value (null from the UI's "Forget") removes the trust entirely.
    if (!existing.options.trustedCertificate) delete existing.options.trustedCertificate;

    await this.persist();

    if (password !== undefined && this.credentials) {
      // An empty string means "forget the saved password", which is different
      // from leaving it untouched.
      if (password === '') await this.credentials.delete(id);
      else await this.credentials.set(id, password);
    }
    return existing;
  }

  async remove(id: string): Promise<void> {
    this.assertLoaded();
    const before = this.data.connections.length;
    this.data.connections = this.data.connections.filter(c => c.id !== id);
    if (this.data.connections.length === before) throw new Error('That connection no longer exists');

    // A deleted computer's sessions go with it: history belongs to a connection.
    this.data.history = this.data.history.filter(h => h.connectionId !== id);
    await this.persist();
    // Always attempt this: leaving a secret in the keyring for a deleted
    // connection is exactly the kind of residue that accumulates unnoticed.
    await this.credentials?.delete(id).catch(() => {});
  }

  async toggleFavorite(id: string): Promise<boolean> {
    const c = this.get(id);
    if (!c) throw new Error('That connection no longer exists');
    c.favorite = !c.favorite;
    c.updatedAt = new Date().toISOString();
    await this.persist();
    return c.favorite;
  }

  /**
   * Copies a connection under a new name. The saved password is copied too
   * when it can be read; `passwordCopied` says whether it was, so the UI can
   * say "enter the password" instead of failing later.
   */
  async duplicate(id: string): Promise<{ connection: Connection; passwordCopied: boolean }> {
    this.assertLoaded();
    const source = this.get(id);
    if (!source) throw new Error('That connection no longer exists');
    const now = new Date().toISOString();
    const copy: Connection = {
      ...structuredClone(source),
      id: randomUUID(),
      name: uniqueName(`${source.name} (copy)`, this.data.connections.map(c => c.name)),
      favorite: false,
      createdAt: now, updatedAt: now,
      lastConnectedAt: undefined,
      connectCount: 0,
    };
    this.data.connections.push(copy);
    await this.persist();

    let passwordCopied = false;
    if (this.credentials) {
      const secret = await this.credentials.get(id).catch(() => null);
      if (secret) {
        await this.credentials.set(copy.id, secret);
        passwordCopied = true;
      }
    }
    return { connection: copy, passwordCopied };
  }

  /** Password for a connection, or null if none was saved. */
  async passwordFor(id: string): Promise<string | null> {
    if (!this.credentials) return null;
    return this.credentials.get(id).catch(() => null);
  }

  /* ------------------------------------------------------------ history */

  async recordStart(connectionId: string): Promise<string> {
    this.assertLoaded();
    const c = this.get(connectionId);
    if (!c) throw new Error('That connection no longer exists');

    const entry: HistoryEntry = {
      id: randomUUID(),
      connectionId, connectionName: c.name, host: c.host, protocol: c.protocol,
      startedAt: new Date().toISOString(),
      outcome: 'cancelled',        // overwritten on connect or failure
    };
    this.data.history.unshift(entry);
    this.data.history = this.data.history.slice(0, MAX_HISTORY);
    await this.persist();
    return entry.id;
  }

  async recordEnd(historyId: string, outcome: HistoryEntry['outcome'], error?: string, errorCategory?: string) {
    this.assertLoaded();
    const entry = this.data.history.find(h => h.id === historyId);
    if (!entry) return;

    entry.endedAt = new Date().toISOString();
    entry.durationMs = Date.parse(entry.endedAt) - Date.parse(entry.startedAt);
    entry.outcome = outcome;
    // Truncated: a stack trace in the history list helps nobody.
    entry.error = error?.slice(0, 300);
    if (errorCategory) entry.errorCategory = errorCategory;

    if (outcome === 'connected') this.countConnected(entry);
    await this.persist();
  }

  /** The attempt succeeded; the entry stays open until `recordSessionEnd`. */
  async recordConnected(historyId: string) {
    this.assertLoaded();
    const entry = this.data.history.find(h => h.id === historyId);
    if (!entry || entry.connectedAt) return;
    entry.outcome = 'connected';
    entry.connectedAt = new Date().toISOString();
    this.countConnected(entry);
    await this.persist();
  }

  /**
   * A session ended. For a connected session the duration is how long it was
   * connected; an attempt that never connected is recorded as failed or
   * cancelled with its own duration.
   */
  async recordSessionEnd(historyId: string, end: { reason: 'user' | 'remote' | 'error'; error?: string; errorCategory?: string }) {
    this.assertLoaded();
    const entry = this.data.history.find(h => h.id === historyId);
    if (!entry || entry.endedAt) return;

    if (!entry.connectedAt) {
      await this.recordEnd(historyId, end.reason === 'user' ? 'cancelled' : 'failed', end.error, end.errorCategory);
      return;
    }
    entry.endedAt = new Date().toISOString();
    entry.durationMs = Date.parse(entry.endedAt) - Date.parse(entry.connectedAt);
    entry.endReason = end.reason;
    entry.error = end.error?.slice(0, 300);
    if (end.errorCategory) entry.errorCategory = end.errorCategory;
    await this.persist();
  }

  private countConnected(entry: HistoryEntry) {
    const c = this.get(entry.connectionId);
    if (c) {
      c.lastConnectedAt = entry.startedAt;
      c.connectCount++;
    }
  }

  /** Most recent first; only one connection's sessions when an id is given. */
  history(limit = 50, connectionId?: string): HistoryEntry[] {
    this.assertLoaded();
    const rows = connectionId
      ? this.data.history.filter(h => h.connectionId === connectionId)
      : this.data.history;
    return rows.slice(0, limit);
  }

  async clearHistory() {
    this.data.history = [];
    await this.persist();
  }
}

/** Fills in anything a hand-edited or older file is missing. */
function normalise(c: Connection): Connection {
  return {
    ...c,
    port: c.port || DEFAULT_PORTS[c.protocol] || 5900,
    favorite: Boolean(c.favorite),
    connectCount: c.connectCount ?? 0,
    os: c.os ?? (c.protocol === 'rdp' ? 'windows' : undefined),
    options: { ...DEFAULT_OPTIONS, ...(c.options ?? {}) },
  };
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = base.replace(/\)$/, ` ${i})`);
    if (!taken.includes(candidate)) return candidate;
  }
}

const PROTOCOLS: Protocol[] = ['vnc', 'rdp', 'spice'];
const OSES: RemoteOs[] = ['windows', 'macos', 'linux', 'other'];

/**
 * A host as people paste it: "vnc://pc.local:5900/", " 10.0.0.5 ". Only the
 * name or address is kept; a port in the text is not silently used, because
 * the port field is where the user sees and sets it.
 */
export function cleanHost(raw: string): string {
  let host = String(raw ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  // user@host is a mistake here: the username has its own field.
  if (host.includes('@')) throw new Error('Enter only the computer address here; the username has its own field');
  // Strip a trailing :port, but leave IPv6 literals alone.
  if (/^\[.*\](:\d+)?$/.test(host)) host = host.replace(/^\[(.*)\](:\d+)?$/, '$1');
  else if ((host.match(/:/g) ?? []).length === 1) host = host.replace(/:\d*$/, '');
  if (!host) throw new Error('Enter a hostname or IP address');
  if (/\s/.test(host) || host.length > 253) throw new Error('That does not look like a computer name or IP address');
  return host;
}
