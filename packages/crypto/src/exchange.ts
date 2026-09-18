import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes, utf8 } from './bytes.js';

/**
 * Authenticated key exchange for connections where both sides already know each
 * other's device key — a computer connecting to another computer on the same
 * HopDesk account. There is no code to type, so there is no password to run
 * SPAKE2 over; what authorises the connection is the account, and what proves
 * identity is each device's Ed25519 key.
 *
 * An ephemeral X25519 exchange, signed by the long-term device keys: forward
 * secrecy from the ephemeral keys, authentication from the signatures. The
 * account server learns nothing usable — it never holds a device private key,
 * so it cannot sit in the middle of a session it relays, and a substituted
 * public key fails the signature check against the key the other side expects.
 */

export interface EphemeralKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateEphemeral(): EphemeralKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { secretKey, publicKey };
}

export class ExchangeError extends Error {}

/**
 * The shared secret and confirmation MACs for one exchange.
 *
 * `binding` must cover every field of the handshake — both device keys, both
 * ephemeral keys, nonces, names — so that altering any of them in flight
 * produces different keys and the confirmation fails.
 */
export function deriveExchange(
  ours: EphemeralKeyPair,
  theirPublic: Uint8Array,
  binding: Uint8Array,
): { Ke: Uint8Array; viewerConfirm: Uint8Array; hostConfirm: Uint8Array } {
  if (theirPublic.length !== 32) throw new ExchangeError('An X25519 public key is 32 bytes');
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(ours.secretKey, theirPublic);
  } catch {
    throw new ExchangeError('The peer sent an invalid X25519 public key');
  }
  // All-zero output means a low-order point: the exchange has no secret in it.
  if (shared.every(b => b === 0)) throw new ExchangeError('The X25519 exchange produced no shared secret');

  const keys = hkdf(sha256, shared, binding, utf8('hopdesk/account-exchange/v1'), 64);
  const Ke = keys.slice(0, 16);
  const macKey = keys.slice(32, 64);
  return {
    Ke,
    viewerConfirm: hmac(sha256, macKey, utf8('viewer')),
    hostConfirm: hmac(sha256, macKey, utf8('host')),
  };
}

export const confirmationsMatch = equalBytes;
