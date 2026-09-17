import { scrypt as scryptCb } from 'node:crypto';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, utf8 } from './bytes.js';
import { bytesToScalar } from './spake2.js';

/**
 * Turning a shared secret into the SPAKE2 password scalar w.
 *
 * Low-entropy secrets typed by a person (access codes, unattended-access
 * passwords) go through scrypt, the memory-hard function RFC 9382 asks for.
 * SPAKE2 already confines an attacker to one online guess per exchange; the
 * MHF only matters if a host's stored verifier ever leaks, and costs the host
 * a few tens of milliseconds per attempt, which also slows guessing.
 *
 * High-entropy secrets the software generated itself (reconnect grants) are
 * already uniformly random, so HKDF is enough.
 */

/** scrypt cost. 2^15 · 8 · 128 bytes = 32 MiB; maxmem allows twice that. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 2 * 128 * 8 * 2 ** 15 };

function scrypt(password: Uint8Array, salt: Uint8Array, length: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, length, SCRYPT, (err, key) => err ? reject(err) : resolve(new Uint8Array(key)));
  });
}

/**
 * w for a human-entered secret. `context` binds the result to one host (its
 * device ID), so the same code on two hosts yields unrelated scalars.
 */
export async function passwordScalar(password: string, context: string): Promise<bigint> {
  // NFKC so a password typed on different keyboards/IMEs derives the same w.
  const pw = utf8(password.normalize('NFKC'));
  const salt = sha256(concat(utf8('hopdesk/spake2-w/password/v1\0'), utf8(context)));
  return bytesToScalar(await scrypt(pw, salt, 48));
}

/** w for a random secret of at least 32 bytes that HopDesk generated. */
export function secretScalar(secret: Uint8Array, context: string): bigint {
  if (secret.length < 32) throw new Error('A generated secret must be at least 32 bytes');
  return bytesToScalar(hkdf(sha256, secret, utf8(context), utf8('hopdesk/spake2-w/secret/v1'), 48));
}
