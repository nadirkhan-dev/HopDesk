import { safeStorage } from 'electron';
import path from 'node:path';
import {
  FileSecureStorage, loadOrCreateIdentity, deviceIdFromPublicKey, toBase64, fromBase64,
  type DeviceIdentity, type Protector,
} from '@hopdesk/crypto';

/**
 * This installation's device identity.
 *
 * The private key is what proves this computer is the one behind its Device ID,
 * so it is kept where the operating system can protect it: Electron's
 * safeStorage, which is the Keychain on macOS, DPAPI on Windows and the Secret
 * Service or KWallet on Linux. Where that is unavailable — a Linux machine with
 * no keyring — the key falls back to a 0600 file, exactly the protection an SSH
 * private key gets, and the UI is told so rather than implying otherwise.
 */

export interface LocalIdentity {
  identity: DeviceIdentity;
  deviceId: string;
  /** Whether the private key is encrypted by an OS keystore. */
  osProtected: boolean;
  protectionDetail: string;
}

function osProtector(): { protector: Protector; detail: string } | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  // On Linux, "basic_text" means safeStorage found no keyring and is using a
  // hardcoded key — no better than the file itself, so do not claim otherwise.
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform;
  if (backend === 'basic_text') return null;
  return {
    detail: `encrypted by the system keystore (${backend})`,
    protector: {
      // safeStorage works in strings, so the key travels as base64.
      encrypt: (plain: Uint8Array) => new Uint8Array(safeStorage.encryptString(toBase64(plain))),
      decrypt: (sealed: Uint8Array) => fromBase64(safeStorage.decryptString(Buffer.from(sealed))),
    },
  };
}

/**
 * The protected store this computer keeps its secrets in: the device key, and
 * the tokens that let it stay signed in to a HopDesk server.
 */
export function identityStorage(dataDir: string): FileSecureStorage {
  const os = osProtector();
  return new FileSecureStorage(path.join(dataDir, 'secrets'), os?.protector);
}

export async function loadIdentity(dataDir: string): Promise<LocalIdentity> {
  const os = osProtector();
  const storage = identityStorage(dataDir);
  const identity = await loadOrCreateIdentity(storage);
  return {
    identity,
    deviceId: deviceIdFromPublicKey(identity.publicKey),
    osProtected: os !== null,
    protectionDetail: os?.detail ?? 'stored in a file only this user can read (no system keyring available)',
  };
}
