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
  /**
   * Where it answered last time, so a saved computer can still be reached on a
   * network where discovery is blocked. A hint, never a credential: the
   * handshake authenticates whoever answers there.
   */
  lastAddress?: string;
  lastPort?: number;
  /** It told us it will let this computer in without asking. */
  paired?: boolean;
}

/**
 * A name that is really an address, which tells nobody which computer it is.
 *
 * It happens: a host whose system name is unset, or a connection made by
 * address before the other end said what it was called. Showing "192.168.1.21"
 * in a list of computers is worse than showing the Device ID, because an
 * address belongs to whoever has it this week.
 */
export function looksLikeAddress(name: string): boolean {
  const text = name.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(text)) return true;        // 192.168.1.21, with or without a port
  if (/^\[[0-9a-f:]+\](:\d+)?$/i.test(text)) return true;               // [::1]:47631
  return /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}$/i.test(text);              // a bare IPv6 address
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
          ...(typeof device.lastAddress === 'string' ? { lastAddress: device.lastAddress.slice(0, 255) } : {}),
          ...(Number.isInteger(device.lastPort) ? { lastPort: device.lastPort } : {}),
          ...(device.paired === true ? { paired: true } : {}),
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
  remember(deviceId: string, key: Uint8Array, name: string, where?: { address?: string; port?: number; paired?: boolean }): void {
    const existing = this.devices.get(deviceId);
    const address = where?.address ?? existing?.lastAddress;
    const port = where?.port ?? existing?.lastPort;
    this.devices.set(deviceId, {
      deviceId,
      key: existing?.key ?? toBase64(key),
      /* Refreshed every time, so a computer that was saved under an address -
         or renamed since - is called what it calls itself now. */
      name: looksLikeAddress(name) ? deviceId : (name.trim().slice(0, 64) || deviceId),
      lastConnected: Date.now(),
      ...(address ? { lastAddress: address } : {}),
      ...(port ? { lastPort: port } : {}),
      /* Pairing is remembered until this computer is *told* otherwise, and
         a connection that simply did not grant it is not being told.
         `paired ?? existing` read the other way round: a session where the
         host asked again - the access code used on a computer already paired,
         or a connection over an account, where trust is not offered because
         the account is the vouching - reported `paired: false` and erased a
         pairing that was still good. The effect was the complaint this fixes:
         one click became "type the code again", for no reason the person
         could see. Only `setPaired(id, false)` takes it away now, and the only
         thing that calls it is the host saying it no longer knows this
         computer. */
      ...(where?.paired || existing?.paired ? { paired: true } : {}),
    });
    void this.persist();
  }

  /**
   * Records that a host will not ask again, or that it no longer knows this
   * computer.
   *
   * The second is the one that matters: a host forgets a trusted computer when
   * the person revokes it, and after ninety days unused. Once it has, a
   * `paired` connection is refused with `not-paired`, and this computer has to
   * stop offering one click and ask for a code again - which is the honest
   * answer, not a failure.
   */
  setPaired(deviceId: string, paired: boolean): void {
    const device = this.devices.get(deviceId);
    if (!device || Boolean(device.paired) === paired) return;
    if (paired) device.paired = true; else delete device.paired;
    void this.persist();
  }

  /**
   * Replaces the pinned key for a computer, after the person was shown both
   * fingerprints and said to accept the new one.
   *
   * `remember` deliberately never overwrites a key - that is what makes the
   * pin a pin. This is the one way past it, and it exists because the
   * alternative was a dead end: a key that changed for an innocent reason left
   * no way to continue except forgetting the computer entirely, which throws
   * away the very record that would have caught a real substitution.
   */
  acceptNewKey(deviceId: string, key: Uint8Array): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    // A key that does not hash to this Device ID is not that computer's key.
    if (deviceIdFromPublicKey(key) !== deviceId) return false;
    device.key = toBase64(key);
    device.lastConnected = Date.now();
    void this.persist();
    return true;
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
