import { timingSafeEqual } from 'node:crypto';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

/** Small byte helpers shared by the crypto modules. */

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function toHex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error('Invalid hex string');
  return new Uint8Array(Buffer.from(clean, 'hex'));
}

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');
}

/** Strict base64 decoding: rejects anything Node would silently skip. */
export function fromBase64(s: string): Uint8Array {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) {
    throw new Error('Invalid base64 string');
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** 8-byte little-endian length prefix, as RFC 9382 defines len(). */
export function u64le(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

export function bytesToBigInt(b: Uint8Array): bigint {
  return b.length ? BigInt(`0x${toHex(b)}`) : 0n;
}

export function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const hex = n.toString(16).padStart(length * 2, '0');
  if (hex.length > length * 2) throw new Error('Integer does not fit');
  return fromHex(hex);
}

/** Constant-time equality for MACs, confirmations and other secrets. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Overwrites key material that is no longer needed. Best effort in JS. */
export function wipe(...buffers: Uint8Array[]) {
  for (const b of buffers) b.fill(0);
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/** Unambiguous encoding of a list of fields: each prefixed with its 8-byte length. */
export function encodeFields(...fields: (Uint8Array | string)[]): Uint8Array {
  return concat(...fields.flatMap(f => {
    const b = typeof f === 'string' ? utf8(f) : f;
    return [u64le(b.length), b];
  }));
}
