import { promisify } from 'node:util';
import { randomBytes, createCipheriv, createDecipheriv, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runClean, spawnClean } from './spawn.js';

const scryptAsync = promisify(scrypt) as (
  pw: string | Buffer, salt: Buffer, len: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Credential storage.
 *
 * Passwords are never written in plain text and never sit in the connection
 * file. Two backends, in order of preference:
 *
 * **1. The system keyring** (libsecret — GNOME Keyring, KWallet via the
 * Secret Service API). This is the right answer on a desktop: the secret is
 * held by the session keyring, unlocked with the login password, and other
 * applications cannot read another app's items. We shell out to `secret-tool`
 * rather than binding libsecret natively, because a native binding means a
 * compile step and an ABI that breaks across distributions — and this app must
 * install cleanly on Ubuntu, Fedora and Arch alike.
 *
 * **2. An encrypted file**, for headless machines, minimal window managers and
 * anything without a Secret Service. AES-256-GCM with a key derived by scrypt
 * from a master passphrase the user sets. GCM rather than CBC so tampering is
 * detected rather than producing garbage plaintext.
 *
 * The file backend is genuinely less safe — the vault is only as strong as the
 * passphrase, and it is unlocked for the life of the process. The UI says so
 * rather than implying the two are equivalent.
 */

export type Backend = 'keyring' | 'file' | 'none';

const SERVICE = 'hopdesk';
/* N=2^15, r=8 needs 128 * N * r = 32 MiB, which is exactly Node's default
   `maxmem` ceiling — so it throws "memory limit exceeded" without an explicit
   allowance. Doubling it leaves headroom rather than sitting on the boundary. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 2 ** 15 * 8 * 2 };

export interface VaultFile {
  version: 1;
  salt: string;
  /**
   * A known value encrypted with the master key. Lets a wrong passphrase be
   * rejected even while the vault holds no passwords yet; without it, the
   * first secret saved under a mistyped passphrase would lock out every
   * later one. Absent in vaults written before it existed.
   */
  check?: { iv: string; tag: string; data: string };
  entries: Record<string, { iv: string; tag: string, data: string }>;
}

const VAULT_CHECK = 'hopdesk-vault-v1';
/** Shortest master passphrase accepted when a vault is created. */
export const MIN_PASSPHRASE_LENGTH = 8;

export class CredentialStore {
  private masterKey: Buffer | null = null;
  private vault: VaultFile | null = null;

  constructor(
    private readonly dataDir: string,
    /** Forces a backend. Left undefined, the keyring is probed and preferred. */
    private readonly forced?: Backend,
  ) {}

  private get vaultPath() { return path.join(this.dataDir, 'credentials.vault'); }

  /** Probes for a working Secret Service. Cached per instance. */
  private backendCache: Backend | null = null;

  async backend(): Promise<Backend> {
    if (this.forced) return this.forced;
    if (this.backendCache) return this.backendCache;

    // `lookup` on a missing key exits 1 with no output, which still proves the
    // service answered. A missing binary (127) or a dead D-Bus (1 with an
    // error message) means there is no usable keyring.
    const probe = await runClean('secret-tool', ['lookup', 'service', SERVICE, 'probe', 'probe']);
    const works = probe.code === 0 || (probe.code === 1 && !probe.stderr.trim());
    this.backendCache = works ? 'keyring' : 'file';
    return this.backendCache;
  }

  /* ------------------------------------------------------------ keyring */

  private async keyringSet(id: string, secret: string) {
    // The secret goes over stdin, never argv — process arguments are world
    // readable in /proc on Linux, so a password on a command line is a password
    // visible to every user on the machine.
    const child = spawnClean('secret-tool',
      ['store', '--label', `HopDesk: ${id}`, 'service', SERVICE, 'connection', id],
      { stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin?.on('error', () => { /* reported through the exit code */ });
    child.stdin?.end(secret);
    await new Promise<void>((resolve, reject) => {
      child.on('close', code => code === 0 ? resolve() : reject(new Error('The system keyring did not accept the password')));
      child.on('error', reject);
    });
  }

  private async keyringGet(id: string): Promise<string | null> {
    const { stdout, code } = await runClean('secret-tool', ['lookup', 'service', SERVICE, 'connection', id]);
    // Not found (exit 1) is not an error.
    return code === 0 && stdout.length ? stdout : null;
  }

  private async keyringDelete(id: string) {
    // Exits non-zero when already gone, which is fine.
    await runClean('secret-tool', ['clear', 'service', SERVICE, 'connection', id]);
  }

  /* --------------------------------------------------------- file vault */

  /** Must be called before the file backend can be used. */
  async unlock(passphrase: string): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });

    if (existsSync(this.vaultPath)) {
      const raw = JSON.parse(await readFile(this.vaultPath, 'utf8')) as VaultFile;
      this.vault = raw;
      this.masterKey = await scryptAsync(passphrase, Buffer.from(raw.salt, 'hex'), 32, SCRYPT);

      /* Verify before accepting: a wrong passphrase must fail here, not later
         with a confusing decryption error on the first connection attempt. */
      const probe = raw.check ?? Object.values(raw.entries)[0];
      if (probe) {
        try {
          const plain = this.decrypt(probe);
          if (raw.check && plain !== VAULT_CHECK) throw new Error('check mismatch');
        } catch {
          this.masterKey = null;
          this.vault = null;
          throw new Error('That passphrase is not correct');
        }
      }
      /* Every entry is authenticated too (GCM tags are cheap to check), so a
         modified vault is refused at unlock rather than failing later on one
         connection with a baffling error. */
      for (const entry of Object.values(raw.entries)) {
        try { this.decrypt(entry); }
        catch {
          this.masterKey = null;
          this.vault = null;
          throw new Error(raw.check
            ? 'The saved password vault is damaged or was modified'
            : 'That passphrase is not correct');
        }
      }
      if (!raw.check) {
        // Upgrade an older vault now that the passphrase is known to be right.
        raw.check = this.encrypt(VAULT_CHECK);
        await this.persist();
      }
      return;
    }

    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new Error(`Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters`);
    }
    const salt = randomBytes(16);
    this.masterKey = await scryptAsync(passphrase, salt, 32, SCRYPT);
    this.vault = { version: 1, salt: salt.toString('hex'), entries: {} };
    this.vault.check = this.encrypt(VAULT_CHECK);
    await this.persist();
  }

  /** Whether an encrypted vault has been created on this machine. */
  get vaultExists() { return existsSync(this.vaultPath); }

  /**
   * True when secrets cannot be read or written until `unlock()` is called:
   * the file backend is in use and no passphrase has been given yet.
   */
  async needsUnlock(): Promise<boolean> {
    return (await this.backend()) === 'file' && !this.isUnlocked;
  }

  get isUnlocked() { return this.masterKey !== null; }

  /** Drops the key from memory. Called on lock and at shutdown. */
  lock() {
    this.masterKey?.fill(0);
    this.masterKey = null;
    this.vault = null;
  }

  private encrypt(plain: string) {
    const iv = randomBytes(12);                  // 96-bit nonce, GCM standard
    const cipher = createCipheriv('aes-256-gcm', this.masterKey!, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data: data.toString('hex'),
    };
  }

  private decrypt(entry: { iv: string; tag: string; data: string }): string {
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey!, Buffer.from(entry.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'hex'));
    // final() throws if the tag does not verify, which is the tamper check.
    return Buffer.concat([decipher.update(Buffer.from(entry.data, 'hex')), decipher.final()])
      .toString('utf8');
  }

  private writing: Promise<void> = Promise.resolve();

  /**
   * Atomic and serialised: written to a temporary file and renamed, one write
   * at a time. A crash or two overlapping saves must never leave a truncated
   * vault, which would lose every saved password at once.
   */
  private persist(): Promise<void> {
    const next = this.writing.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.vaultPath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.vault, null, 2), { mode: 0o600 });
      // Explicit, because an existing file keeps its old mode on rewrite.
      await chmod(tmp, 0o600);
      await rename(tmp, this.vaultPath);
    });
    this.writing = next.catch(() => {});
    return next;
  }

  /* -------------------------------------------------------------- api */

  async set(connectionId: string, secret: string): Promise<Backend> {
    const backend = await this.backend();
    if (backend === 'keyring') {
      await this.keyringSet(connectionId, secret);
      return 'keyring';
    }
    if (!this.masterKey) throw new Error('The credential vault is locked');
    this.vault!.entries[connectionId] = this.encrypt(secret);
    await this.persist();
    return 'file';
  }

  async get(connectionId: string): Promise<string | null> {
    const backend = await this.backend();
    if (backend === 'keyring') return this.keyringGet(connectionId);
    if (!this.masterKey) throw new Error('The credential vault is locked');
    const entry = this.vault!.entries[connectionId];
    return entry ? this.decrypt(entry) : null;
  }

  async delete(connectionId: string): Promise<void> {
    const backend = await this.backend();
    if (backend === 'keyring') { await this.keyringDelete(connectionId); return; }
    if (!this.masterKey) return;
    delete this.vault!.entries[connectionId];
    await this.persist();
  }

  /** Used when a connection is removed, so no orphaned secret is left behind. */
  async has(connectionId: string): Promise<boolean> {
    return (await this.get(connectionId)) !== null;
  }
}

/** Constant-time comparison, for anywhere a secret is checked locally. */
export function secretsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
