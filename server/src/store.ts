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

export interface Account { id: string; email: string; passwordHash: string; createdAt: number }
export interface Device {
  deviceId: string;
  accountId: string;
  name: string;
  publicKey: string;
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
        last_seen integer
      );
      create index if not exists devices_account on devices(account_id);
      create table if not exists throttle (
        key text primary key,
        count integer not null,
        until integer not null
      );
    `);
  }

  close() { this.db.close(); }

  /* ------------------------------------------------------------- accounts */

  createAccount(email: string, passwordHash: string, now: number): Account {
    const account: Account = { id: randomUUID(), email, passwordHash, createdAt: now };
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
      insert into devices (device_id, account_id, name, public_key, token_hash, created_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(device_id) do update set
        account_id = excluded.account_id, name = excluded.name,
        public_key = excluded.public_key, token_hash = excluded.token_hash
    `).run(device.deviceId, device.accountId, device.name, device.publicKey, device.tokenHash, device.createdAt);
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

  removeDevice(deviceId: string) {
    this.db.prepare('delete from devices where device_id = ?').run(deviceId);
  }

  touchDevice(deviceId: string, now: number) {
    this.db.prepare('update devices set last_seen = ? where device_id = ?').run(now, deviceId);
  }

  private toDevice(row: Record<string, unknown>): Device & { tokenHash: string } {
    return {
      deviceId: String(row.device_id), accountId: String(row.account_id), name: String(row.name),
      publicKey: String(row.public_key), tokenHash: String(row.token_hash),
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
