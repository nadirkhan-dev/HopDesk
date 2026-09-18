import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fromBase64, toBase64, deviceIdFromPublicKey } from '@hopdesk/crypto';

/**
 * HopDesk computers this one has connected to before, and the identity key each
 * of them proved it holds.
 *
 * The point is to notice a change. A Device ID is short enough that someone
 * could, with effort, make a key whose ID matches; pinning the key that was
 * seen the first time turns that into a visible warning rather than a silent
 * substitution. The stored key is public, so this file holds no secrets.
 */

export interface KnownDevice {
  deviceId: string;
  /** Ed25519 public key, base64. */
  key: string;
  name: string;
  lastConnected: number;
}

export class KnownDevices {
  private devices = new Map<string, KnownDevice>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  private get file() { return path.join(this.dataDir, 'devices.json'); }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { devices?: unknown };
      const list = Array.isArray(raw.devices) ? raw.devices : [];
      for (const entry of list) {
        const device = entry as Partial<KnownDevice>;
        if (typeof device.deviceId !== 'string' || typeof device.key !== 'string') continue;
        // A stored key that does not hash to its Device ID is not usable.
        try {
          if (deviceIdFromPublicKey(fromBase64(device.key)) !== device.deviceId) continue;
        } catch { continue; }
        this.devices.set(device.deviceId, {
          deviceId: device.deviceId,
          key: device.key,
          name: typeof device.name === 'string' ? device.name.slice(0, 64) : device.deviceId,
          lastConnected: typeof device.lastConnected === 'number' ? device.lastConnected : 0,
        });
      }
    } catch {
      // A corrupt file costs pinning, not function: it is rebuilt as devices connect.
      this.devices.clear();
    }
  }

  list(): KnownDevice[] {
    return [...this.devices.values()].sort((a, b) => b.lastConnected - a.lastConnected);
  }

  keyFor(deviceId: string): Uint8Array | undefined {
    const device = this.devices.get(deviceId);
    return device ? fromBase64(device.key) : undefined;
  }

  /** Records a successful connection. The key is only stored the first time. */
  remember(deviceId: string, key: Uint8Array, name: string): void {
    const existing = this.devices.get(deviceId);
    this.devices.set(deviceId, {
      deviceId,
      key: existing?.key ?? toBase64(key),
      name: name.slice(0, 64) || deviceId,
      lastConnected: Date.now(),
    });
    void this.persist();
  }

  forget(deviceId: string): void {
    if (this.devices.delete(deviceId)) void this.persist();
  }

  private persist(): Promise<void> {
    const next = this.writing.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, devices: this.list() }, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    });
    this.writing = next.catch(() => {});
    return next;
  }

  flush(): Promise<void> { return this.writing; }
}
