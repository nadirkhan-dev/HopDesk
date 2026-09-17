import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, utf8 } from './bytes.js';

/**
 * Device identity: a long-lived Ed25519 key pair per installation.
 *
 * The Device ID people read aloud ("HD-7K3M-Q9TX") is derived from the public
 * key. It is a lookup handle, not a credential: 40 bits is plenty to address
 * a device but far too short to authenticate one, so the protocol always
 * verifies the full public key and pins it after the first connection.
 */

export interface DeviceIdentity {
  publicKey: Uint8Array;   // 32 bytes
  secretKey: Uint8Array;   // 32-byte seed
}

export function generateIdentity(): DeviceIdentity {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

export function identityFromSecretKey(secretKey: Uint8Array): DeviceIdentity {
  if (secretKey.length !== 32) throw new Error('An Ed25519 secret key is 32 bytes');
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/** Signs with a domain label so a signature can never be replayed in another context. */
export function sign(identity: DeviceIdentity, label: string, message: Uint8Array): Uint8Array {
  return ed25519.sign(concat(utf8(label), new Uint8Array([0]), message), identity.secretKey);
}

export function verify(publicKey: Uint8Array, label: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    // Strict RFC 8032 verification (not ZIP-215): malleable encodings are refused.
    return ed25519.verify(signature, concat(utf8(label), new Uint8Array([0]), message), publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** Crockford base32 without I, L, O, U: nothing that reads as another character. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** HD-XXXX-XXXX from the first 40 bits of a domain-separated hash of the public key. */
export function deviceIdFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('An Ed25519 public key is 32 bytes');
  const h = sha256(concat(utf8('hopdesk/device-id/v1\0'), publicKey));
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(h[i]!);
  let chars = '';
  for (let i = 7; i >= 0; i--) chars += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `HD-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * Accepts what a person might type or paste — lower case, missing prefix,
 * spaces, and the classic look-alikes O/0 and I/L/1 — and returns the
 * canonical form, or null if it cannot be a Device ID.
 */
export function normalizeDeviceId(input: string): string | null {
  let s = String(input).toUpperCase().replace(/[\s\-_.]/g, '');
  // Only a 10-character input carries the prefix; "HD" is also valid ID content.
  if (s.length === 10 && s.startsWith('HD')) s = s.slice(2);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 8 || [...s].some(c => !ALPHABET.includes(c))) return null;
  return `HD-${s.slice(0, 4)}-${s.slice(4)}`;
}
