import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Account passwords: scrypt, with the parameters stored alongside the hash so
 * they can be raised later without locking anyone out. Never reversible, never
 * logged, and never stored in any other form.
 */

const scryptAsync = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** 2^15 · 8 · 128 = 32 MiB per hash: slow for an attacker, fine for a login. */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 2 * 128 * 8 * 2 ** 15 };

export const MIN_PASSWORD_LENGTH = 10;

export class WeakPasswordError extends Error {}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const params = { N: Number(N), r: Number(r), p: Number(p), maxmem: 2 * 128 * Number(r) * Number(N) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;
  let actual: Buffer;
  try {
    actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt!, 'base64'), Buffer.from(expected!, 'base64').length, params);
  } catch {
    return false;
  }
  const want = Buffer.from(expected!, 'base64');
  return actual.length === want.length && timingSafeEqual(actual, want);
}
