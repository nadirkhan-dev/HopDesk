import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fromBase64, toBase64 } from './bytes.js';
import { generateIdentity, identityFromSecretKey, type DeviceIdentity } from './identity.js';

/**
 * Where long-lived secrets (the device private key, unattended-access
 * verifiers) are kept. Platform code supplies the implementation; this
 * package only depends on the interface.
 */
export interface SecureStorage {
  get(name: string): Promise<Uint8Array | null>;
  set(name: string, value: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
  /**
   * True when values are encrypted by an OS facility (Keychain, DPAPI,
   * Secret Service); false when protection is only file permissions.
   */
  readonly osProtected: boolean;
}

/**
 * Optional OS encryption layered over files — e.g. Electron's safeStorage,
 * which uses Keychain on macOS, DPAPI on Windows and the Secret Service or
 * KWallet on Linux.
 */
export interface Protector {
  encrypt(plain: Uint8Array): Uint8Array | Promise<Uint8Array>;
  decrypt(sealed: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One file per secret in a 0700 directory, each written 0600 and atomically.
 * Without a Protector this is the same protection an SSH private key gets.
 */
export class FileSecureStorage implements SecureStorage {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string, private readonly protector?: Protector) {}

  get osProtected() { return this.protector !== undefined; }

  private file(name: string) {
    if (!NAME.test(name)) throw new Error(`Invalid secret name: ${name}`);
    return path.join(this.dir, `${name}.secret`);
  }

  async get(name: string): Promise<Uint8Array | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const parsed = JSON.parse(raw) as { v: 1; protected: boolean; data: string };
    const data = fromBase64(parsed.data);
    if (parsed.protected) {
      if (!this.protector) throw new Error('This secret was encrypted by the OS keystore, which is not available now');
      return this.protector.decrypt(data);
    }
    return data;
  }

  set(name: string, value: Uint8Array): Promise<void> {
    let target: string;
    try { target = this.file(name); } catch (err) { return Promise.reject(err); }
    const next = this.writing.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
      const data = this.protector ? await this.protector.encrypt(value) : value;
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify({ v: 1, protected: !!this.protector, data: toBase64(data) }), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, target);
    });
    this.writing = next.catch(() => {});
    return next;
  }

  async delete(name: string): Promise<void> {
    try { await unlink(this.file(name)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
}

export const IDENTITY_SECRET_NAME = 'device-identity';

/** Loads this installation's identity, creating and saving one on first run. */
export async function loadOrCreateIdentity(storage: SecureStorage): Promise<DeviceIdentity> {
  const existing = await storage.get(IDENTITY_SECRET_NAME);
  if (existing) return identityFromSecretKey(existing);
  const identity = generateIdentity();
  await storage.set(IDENTITY_SECRET_NAME, identity.secretKey);
  return identity;
}
