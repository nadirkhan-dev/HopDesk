import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Storage: SQLite through Node's own `node:sqlite`, so a self-hosted server
 * needs no database to run and no native module to compile. One file in the
 * data directory, written with foreign keys and WAL on.
 *
 * Nothing here holds anything that could be replayed as a password: account
 * passwords are scrypt hashes, and refresh and device tokens are stored only as
 * SHA-256 of the value handed out.
 */

export interface Account {
  id: string; email: string; passwordHash: string; createdAt: number;
  /** When an administrator disabled this account, and why. */
  blockedAt: number | null; blockedReason: string | null; blockedBy: string | null;
}

/**
 * An installation of HopDesk, as distinct from a device on an account.
 *
 * A computer used only on its own network has no account and never needed one;
 * the server has no record of it and no way to refuse it anything. An
 * installation record is that missing relationship: the computer registers
 * itself, proves it holds its own key, and asks periodically whether it is
 * still allowed to run. It is what makes blocking reach a computer that never
 * signs in to anything.
 */
export interface Installation {
  installationId: string;
  publicKey: string;
  os: string | null;
  appVersion: string | null;
  tokenHash: string;
  createdAt: number;
  lastSeen: number | null;
  blockedAt: number | null; blockedReason: string | null; blockedBy: string | null;
}

/** An administrator of this server, who may disable accounts and devices. */
export interface Admin { id: string; email: string; tokenHash: string; createdAt: number; lastUsed: number | null }

/** One thing an administrator did, kept so a block can be accounted for. */
export interface AdminEvent {
  id: string; at: number; actor: string; action: string; subject: string; reason: string | null;
}
export interface Device {
  deviceId: string;
  accountId: string;
  name: string;
  publicKey: string;
  /**
   * What kind of computer it is - 'macos', 'linux', 'windows' - so a list of
   * them can be read at a glance. The device says so when it enrols; it is a
   * label, never anything to decide on.
   */
  os: string | null;
  /**
   * Whether an already-approved computer on this account has vouched for this
   * one. Email and password are enough to *add* a computer; they are not
   * enough to make it one of yours. Until this is true the device can sign in
   * and see that it is waiting, and nothing else.
   */
  approved: boolean;
  /**
   * When an administrator disabled this installation, and why.
   *
   * Not the same as removing it: a removed device can enrol again, while a
   * blocked one is refused with its record intact, which is what makes the
   * decision auditable and reversible.
   */
  blockedAt: number | null; blockedReason: string | null; blockedBy: string | null;
  createdAt: number;
  lastSeen: number | null;
}
export interface RefreshRecord {
  id: string;
  family: string;
  accountId: string;
  expiresAt: number;
  usedAt: number | null;
  revoked: boolean;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dataDir: string, filename = 'hopdesk.db') {
    if (filename !== ':memory:') mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename === ':memory:' ? ':memory:' : path.join(dataDir, filename));
    this.db.exec('pragma journal_mode = wal');
    this.db.exec('pragma foreign_keys = on');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      create table if not exists accounts (
        id text primary key,
        email text not null unique collate nocase,
        password_hash text not null,
        created_at integer not null
      );
      create table if not exists refresh_tokens (
        id text primary key,
        family text not null,
        account_id text not null references accounts(id) on delete cascade,
        hash text not null,
        expires_at integer not null,
        used_at integer,
        revoked integer not null default 0
      );
      create index if not exists refresh_family on refresh_tokens(family);
      create table if not exists devices (
        device_id text primary key,
        account_id text not null references accounts(id) on delete cascade,
        name text not null,
        public_key text not null,
        token_hash text not null,
        created_at integer not null,
        last_seen integer,
        os text,
        approved integer not null default 0
      );
      create index if not exists devices_account on devices(account_id);
      create table if not exists throttle (
        key text primary key,
        count integer not null,
        until integer not null
      );
    `);

    /* A column added after a server has been running: "create table if not
       exists" leaves the existing table exactly as it is, so the column has to
       be added separately. Checked rather than caught, because a failed ALTER
       and a column that is already there are the same error text. */
    this.addColumn('devices', 'os', 'text');
    /* Devices that existed before approval did are approved: they were added
       when adding was all it took, and locking their owner out of their own
       computers would be a fine way to introduce a security feature. */
    this.addColumn('devices', 'approved', 'integer not null default 1');
    /* Disabling an installation, as distinct from removing it: a removed
       device can enrol again, a blocked one is refused with its record
       intact. Columns rather than a table so every lookup that already finds
       a device finds its status with it, and nothing can read one without the
       other. */
    this.addColumn('devices', 'blocked_at', 'integer');
    this.addColumn('devices', 'blocked_reason', 'text');
    this.addColumn('devices', 'blocked_by', 'text');
    this.addColumn('accounts', 'blocked_at', 'integer');
    this.addColumn('accounts', 'blocked_reason', 'text');
    this.addColumn('accounts', 'blocked_by', 'text');
    this.db.exec(`
      create table if not exists installations (
        installation_id text primary key,
        public_key text not null,
        os text,
        app_version text,
        token_hash text not null unique,
        created_at integer not null,
        last_seen integer,
        blocked_at integer,
        blocked_reason text,
        blocked_by text
      );
      create table if not exists admins (
        id text primary key,
        email text not null unique collate nocase,
        token_hash text not null unique,
        created_at integer not null,
        last_used integer
      );
      create table if not exists admin_events (
        id text primary key,
        at integer not null,
        actor text not null,
        action text not null,
        subject text not null,
        reason text
      );
      create index if not exists admin_events_subject on admin_events(subject);
      create index if not exists admin_events_at on admin_events(at);
    `);
  }

  /** Adds a column if the table does not have it yet. */
  private addColumn(table: string, column: string, type: string) {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as { name?: unknown }[];
    if (columns.some(c => String(c.name) === column)) return;
    this.db.exec(`alter table ${table} add column ${column} ${type}`);
  }

  close() { this.db.close(); }

  /* ------------------------------------------------------------- accounts */

  createAccount(email: string, passwordHash: string, now: number): Account {
    const account: Account = {
      id: randomUUID(), email, passwordHash, createdAt: now,
      blockedAt: null, blockedReason: null, blockedBy: null,
    };
    this.db.prepare('insert into accounts (id, email, password_hash, created_at) values (?, ?, ?, ?)')
      .run(account.id, account.email, account.passwordHash, account.createdAt);
    return account;
  }

  accountByEmail(email: string): Account | null {
    const row = this.db.prepare('select * from accounts where email = ?').get(email) as Record<string, unknown> | undefined;
    return row ? this.toAccount(row) : null;
  }

  accountById(id: string): Account | null {
    const row = this.db.prepare('select * from accounts where id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toAccount(row) : null;
  }

  countAccounts(): number {
    const row = this.db.prepare('select count(*) as n from accounts').get() as { n: number };
    return Number(row.n);
  }

  private toAccount(row: Record<string, unknown>): Account {
    return {
      id: String(row.id), email: String(row.email),
      passwordHash: String(row.password_hash), createdAt: Number(row.created_at),
      blockedAt: row.blocked_at === null || row.blocked_at === undefined ? null : Number(row.blocked_at),
      blockedReason: row.blocked_reason === null || row.blocked_reason === undefined ? null : String(row.blocked_reason),
      blockedBy: row.blocked_by === null || row.blocked_by === undefined ? null : String(row.blocked_by),
    };
  }

  /* ------------------------------------------------------- refresh tokens */

  saveRefresh(record: { id: string; family: string; accountId: string; hash: string; expiresAt: number }) {
    this.db.prepare('insert into refresh_tokens (id, family, account_id, hash, expires_at) values (?, ?, ?, ?, ?)')
      .run(record.id, record.family, record.accountId, record.hash, record.expiresAt);
  }

  refreshById(id: string): (RefreshRecord & { hash: string }) | null {
    const row = this.db.prepare('select * from refresh_tokens where id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), family: String(row.family), accountId: String(row.account_id),
      hash: String(row.hash), expiresAt: Number(row.expires_at),
      usedAt: row.used_at === null ? null : Number(row.used_at),
      revoked: Number(row.revoked) === 1,
    };
  }

  markRefreshUsed(id: string, now: number) {
    this.db.prepare('update refresh_tokens set used_at = ? where id = ?').run(now, id);
  }

  /** Revokes every token in a rotation family: used when one is replayed. */
  revokeFamily(family: string) {
    this.db.prepare('update refresh_tokens set revoked = 1 where family = ?').run(family);
  }

  revokeAccountTokens(accountId: string) {
    this.db.prepare('update refresh_tokens set revoked = 1 where account_id = ?').run(accountId);
  }

  pruneRefresh(now: number) {
    this.db.prepare('delete from refresh_tokens where expires_at < ?').run(now);
  }

  /* -------------------------------------------------------------- devices */

  saveDevice(device: Omit<Device, 'lastSeen'> & { tokenHash: string }) {
    this.db.prepare(`
      insert into devices (device_id, account_id, name, public_key, token_hash, created_at, os, approved)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(device_id) do update set
        account_id = excluded.account_id, name = excluded.name,
        public_key = excluded.public_key, token_hash = excluded.token_hash,
        os = excluded.os, approved = excluded.approved
    `).run(device.deviceId, device.accountId, device.name, device.publicKey, device.tokenHash,
      device.createdAt, device.os, device.approved ? 1 : 0);
  }

  deviceById(deviceId: string): (Device & { tokenHash: string }) | null {
    const row = this.db.prepare('select * from devices where device_id = ?').get(deviceId) as Record<string, unknown> | undefined;
    return row ? this.toDevice(row) : null;
  }

  deviceByTokenHash(hash: string): (Device & { tokenHash: string }) | null {
    const row = this.db.prepare('select * from devices where token_hash = ?').get(hash) as Record<string, unknown> | undefined;
    return row ? this.toDevice(row) : null;
  }

  devicesOfAccount(accountId: string): (Device & { tokenHash: string })[] {
    const rows = this.db.prepare('select * from devices where account_id = ? order by created_at').all(accountId) as Record<string, unknown>[];
    return rows.map(row => this.toDevice(row));
  }

  /** One computer vouching for another. */
  approveDevice(deviceId: string) {
    this.db.prepare('update devices set approved = 1 where device_id = ?').run(deviceId);
  }

  removeDevice(deviceId: string) {
    this.db.prepare('delete from devices where device_id = ?').run(deviceId);
  }

  touchDevice(deviceId: string, now: number) {
    this.db.prepare('update devices set last_seen = ? where device_id = ?').run(now, deviceId);
  }

  /* ------------------------------------------------------- installations */

  /**
   * Records an installation, or updates the one that is already there.
   *
   * A block survives re-registration, which is the point of keeping a record
   * rather than removing it: reinstalling HopDesk over a blocked installation
   * leaves it blocked, as long as it keeps its identity key.
   */
  saveInstallation(installation: Omit<Installation, 'lastSeen' | 'blockedAt' | 'blockedReason' | 'blockedBy'>): void {
    this.db.prepare(`
      insert into installations (installation_id, public_key, os, app_version, token_hash, created_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(installation_id) do update set
        public_key = excluded.public_key, os = excluded.os,
        app_version = excluded.app_version, token_hash = excluded.token_hash
    `).run(installation.installationId, installation.publicKey, installation.os,
      installation.appVersion, installation.tokenHash, installation.createdAt);
  }

  installationById(installationId: string): Installation | null {
    return this.toInstallation(this.db.prepare('select * from installations where installation_id = ?')
      .get(installationId) as Record<string, unknown> | undefined);
  }

  installationByTokenHash(hash: string): Installation | null {
    return this.toInstallation(this.db.prepare('select * from installations where token_hash = ?')
      .get(hash) as Record<string, unknown> | undefined);
  }

  allInstallations(): Installation[] {
    const rows = this.db.prepare('select * from installations order by created_at desc').all() as Record<string, unknown>[];
    return rows.map(row => this.toInstallation(row)!).filter(Boolean);
  }

  touchInstallation(installationId: string, at: number, appVersion: string | null): void {
    this.db.prepare('update installations set last_seen = ?, app_version = coalesce(?, app_version) where installation_id = ?')
      .run(at, appVersion, installationId);
  }

  blockInstallation(installationId: string, at: number, reason: string | null, by: string): void {
    this.db.prepare('update installations set blocked_at = ?, blocked_reason = ?, blocked_by = ? where installation_id = ?')
      .run(at, reason, by, installationId);
  }

  unblockInstallation(installationId: string): void {
    this.db.prepare('update installations set blocked_at = null, blocked_reason = null, blocked_by = null where installation_id = ?')
      .run(installationId);
  }

  private toInstallation(row: Record<string, unknown> | undefined): Installation | null {
    if (!row) return null;
    return {
      installationId: String(row.installation_id),
      publicKey: String(row.public_key),
      os: row.os === null || row.os === undefined ? null : String(row.os),
      appVersion: row.app_version === null || row.app_version === undefined ? null : String(row.app_version),
      tokenHash: String(row.token_hash),
      createdAt: Number(row.created_at),
      lastSeen: row.last_seen === null || row.last_seen === undefined ? null : Number(row.last_seen),
      blockedAt: row.blocked_at === null || row.blocked_at === undefined ? null : Number(row.blocked_at),
      blockedReason: row.blocked_reason === null || row.blocked_reason === undefined ? null : String(row.blocked_reason),
      blockedBy: row.blocked_by === null || row.blocked_by === undefined ? null : String(row.blocked_by),
    };
  }

  /* ----------------------------------------------------- administrators */

  createAdmin(email: string, tokenHash: string, now: number): Admin {
    const admin: Admin = { id: randomUUID(), email, tokenHash, createdAt: now, lastUsed: null };
    this.db.prepare('insert into admins (id, email, token_hash, created_at) values (?, ?, ?, ?)')
      .run(admin.id, admin.email, admin.tokenHash, admin.createdAt);
    return admin;
  }

  adminByTokenHash(hash: string): Admin | null {
    const row = this.db.prepare('select * from admins where token_hash = ?').get(hash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), email: String(row.email), tokenHash: String(row.token_hash),
      createdAt: Number(row.created_at), lastUsed: row.last_used === null ? null : Number(row.last_used),
    };
  }

  get adminCount(): number {
    return Number((this.db.prepare('select count(*) as n from admins').get() as { n: number }).n);
  }

  touchAdmin(id: string, now: number) {
    this.db.prepare('update admins set last_used = ? where id = ?').run(now, id);
  }

  /* ------------------------------------------------------------ blocking */

  /** Disables an installation. Its record stays, which is what makes it reversible. */
  blockDevice(deviceId: string, at: number, reason: string | null, by: string) {
    this.db.prepare('update devices set blocked_at = ?, blocked_reason = ?, blocked_by = ? where device_id = ?')
      .run(at, reason, by, deviceId);
  }

  unblockDevice(deviceId: string) {
    this.db.prepare('update devices set blocked_at = null, blocked_reason = null, blocked_by = null where device_id = ?')
      .run(deviceId);
  }

  /** Disables an account, and with it every installation signed in to it. */
  blockAccount(accountId: string, at: number, reason: string | null, by: string) {
    this.db.prepare('update accounts set blocked_at = ?, blocked_reason = ?, blocked_by = ? where id = ?')
      .run(at, reason, by, accountId);
  }

  unblockAccount(accountId: string) {
    this.db.prepare('update accounts set blocked_at = null, blocked_reason = null, blocked_by = null where id = ?')
      .run(accountId);
  }

  /** Every installation on the server, newest first, for an administrator. */
  allDevices(): (Device & { tokenHash: string })[] {
    const rows = this.db.prepare('select * from devices order by created_at desc').all() as Record<string, unknown>[];
    return rows.map(row => this.toDevice(row));
  }

  /**
   * Something that was done to one computer, kept so it can be accounted for.
   *
   * The same table as administrative actions, because they answer one
   * question between them: everything that has happened to this computer, in
   * order. The actor says which kind of hand it was - `account:…`,
   * `device:…`, an administrator's address, or `cli`.
   */
  recordEvent(actor: string, action: string, subject: string, detail: string | null, at: number): void {
    this.recordAdminEvent(actor, action, subject, detail, at);
  }

  /**
   * Forgets events older than this, so the table does not grow for ever.
   *
   * Two years: long enough that a block can still be accounted for a year
   * later, short enough that the server is not keeping a record of who
   * connected what to what indefinitely.
   */
  pruneEvents(before: number): number {
    const result = this.db.prepare('delete from admin_events where at < ?').run(before);
    return Number(result.changes ?? 0);
  }

  recordAdminEvent(actor: string, action: string, subject: string, reason: string | null, at: number): void {
    this.db.prepare('insert into admin_events (id, at, actor, action, subject, reason) values (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), at, actor, action, subject, reason);
  }

  adminEventsFor(subject: string): AdminEvent[] {
    const rows = this.db.prepare('select * from admin_events where subject = ? order by at desc').all(subject) as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.id), at: Number(row.at), actor: String(row.actor),
      action: String(row.action), subject: String(row.subject),
      reason: row.reason === null ? null : String(row.reason),
    }));
  }

  private toDevice(row: Record<string, unknown>): Device & { tokenHash: string } {
    return {
      deviceId: String(row.device_id), accountId: String(row.account_id), name: String(row.name),
      publicKey: String(row.public_key), tokenHash: String(row.token_hash),
      os: row.os === null || row.os === undefined ? null : String(row.os),
      approved: Number(row.approved ?? 0) === 1,
      blockedAt: row.blocked_at === null || row.blocked_at === undefined ? null : Number(row.blocked_at),
      blockedReason: row.blocked_reason === null || row.blocked_reason === undefined ? null : String(row.blocked_reason),
      blockedBy: row.blocked_by === null || row.blocked_by === undefined ? null : String(row.blocked_by),
      createdAt: Number(row.created_at),
      lastSeen: row.last_seen === null ? null : Number(row.last_seen),
    };
  }

  /* ------------------------------------------------------------ throttle */

  /**
   * Counts an attempt against a key (an email, an address) and says whether it
   * is now locked out. Sign-in guessing has to be slowed down somewhere, and
   * doing it in the database means it survives a restart.
   */
  throttle(key: string, now: number, limit: number, windowMs: number): { locked: boolean; retryAfterMs: number } {
    const row = this.db.prepare('select count, until from throttle where key = ?').get(key) as { count: number; until: number } | undefined;
    if (row && Number(row.until) > now && Number(row.count) >= limit) {
      return { locked: true, retryAfterMs: Number(row.until) - now };
    }
    const count = row && Number(row.until) > now ? Number(row.count) + 1 : 1;
    this.db.prepare('insert into throttle (key, count, until) values (?, ?, ?) on conflict(key) do update set count = excluded.count, until = excluded.until')
      .run(key, count, now + windowMs);
    return { locked: false, retryAfterMs: 0 };
  }

  clearThrottle(key: string) {
    this.db.prepare('delete from throttle where key = ?').run(key);
  }
}
