import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fromBase64, toBase64, deviceIdFromPublicKey, equalBytes } from '@hopdesk/crypto';

/**
 * The computers this one has been told to trust: they may connect without an
 * access code and without anyone here answering a prompt.
 *
 * What is stored is a **public** key. There is no shared secret here to read
 * and replay — a trusted computer proves itself by signing the handshake with
 * the private half, which never leaves it. That is the whole reason this
 * replaced the stored unattended password: a verifier on disk *was* the
 * credential, so reading this file would have been enough to get in.
 *
 * Every entry expires (90 days by default), renewed each time it is used, so a
 * pairing nobody uses closes itself.
 */

export const TRUST_TTL_MS = 90 * 24 * 3600 * 1000;

export interface TrustedDevice {
  deviceId: string;
  /** Ed25519 public key, base64. Public: this file holds no secrets. */
  key: string;
  name: string;
  addedAt: number;
  lastUsed: number;
  expiresAt: number;
}

/** Short, readable, and enough to compare two keys by eye. */
export function fingerprint(key: Uint8Array | string): string {
  const bytes = typeof key === 'string' ? fromBase64(key) : key;
  const hex = [...bytes.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.replace(/(.{4})(?=.)/g, '$1 ');
}

export class TrustedDevices {
  private devices = new Map<string, TrustedDevice>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = TRUST_TTL_MS,
  ) {}

  private get file() { return path.join(this.dataDir, 'trusted.json'); }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { devices?: unknown };
      for (const entry of Array.isArray(raw.devices) ? raw.devices : []) {
        const device = entry as Partial<TrustedDevice>;
        if (typeof device.deviceId !== 'string' || typeof device.key !== 'string') continue;
        // A key that does not hash to its Device ID cannot be what it claims.
        try {
          if (deviceIdFromPublicKey(fromBase64(device.key)) !== device.deviceId) continue;
        } catch { continue; }
        const expiresAt = typeof device.expiresAt === 'number' ? device.expiresAt : 0;
        if (expiresAt <= this.now()) continue;                       // expired: not loaded, not kept
        this.devices.set(device.deviceId, {
          deviceId: device.deviceId,
          key: device.key,
          name: typeof device.name === 'string' ? device.name.slice(0, 64) : device.deviceId,
          addedAt: typeof device.addedAt === 'number' ? device.addedAt : this.now(),
          lastUsed: typeof device.lastUsed === 'number' ? device.lastUsed : 0,
          expiresAt,
        });
      }
    } catch {
      // A corrupt file must not stop the app: it means nothing is trusted yet.
    }
  }

  list(): TrustedDevice[] {
    this.prune();
    return [...this.devices.values()].sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /** Remembers a device, or extends one already here. */
  add(viewer: { viewerId: string; viewerKey: Uint8Array; viewerName: string }): TrustedDevice {
    const device: TrustedDevice = {
      deviceId: viewer.viewerId,
      key: toBase64(viewer.viewerKey),
      name: viewer.viewerName.slice(0, 64) || viewer.viewerId,
      addedAt: this.devices.get(viewer.viewerId)?.addedAt ?? this.now(),
      lastUsed: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.devices.set(device.deviceId, device);
    void this.flush();
    return device;
  }

  /**
   * Whether this device may connect without being asked. Both the Device ID and
   * the key must match: an ID alone is a handle anyone could claim.
   */
  trusts(deviceId: string, key: Uint8Array): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    if (device.expiresAt <= this.now()) { this.devices.delete(deviceId); void this.flush(); return false; }
    try {
      return equalBytes(fromBase64(device.key), key);
    } catch {
      return false;
    }
  }

  /** Called after a trusted device connects: using it keeps it alive. */
  renew(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.lastUsed = this.now();
    device.expiresAt = this.now() + this.ttlMs;
    void this.flush();
  }

  /** Stops trusting one device. Returns its key, so live sessions can be ended. */
  remove(deviceId: string): TrustedDevice | null {
    const device = this.devices.get(deviceId) ?? null;
    if (device) {
      this.devices.delete(deviceId);
      void this.flush();
    }
    return device;
  }

  private prune(): void {
    let changed = false;
    for (const [id, device] of this.devices) {
      if (device.expiresAt <= this.now()) { this.devices.delete(id); changed = true; }
    }
    if (changed) void this.flush();
  }

  /** Writes are serialised and atomic: a half-written file would lock you out. */
  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify({ devices: [...this.devices.values()] }, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    }).catch(() => { /* reported by the caller that reads the list */ });
    return this.writing;
  }
}
