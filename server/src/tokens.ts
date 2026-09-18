import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Store } from './store.js';

/**
 * Two kinds of credential, with different lifetimes and different failure
 * modes.
 *
 * **Access tokens** are short-lived and signed, so a request can be checked
 * without a database lookup. They cannot be revoked individually, which is why
 * they expire in minutes.
 *
 * **Refresh tokens** are long-lived, stored only as a hash, and rotate on every
 * use: the old one is marked used, and a second attempt to use it means the
 * token was copied, so the whole family is revoked and the person has to sign in
 * again. That converts a stolen refresh token from silent, permanent access into
 * a visible sign-out.
 *
 * **Device tokens** (in `devices.ts`) are for a computer that must reconnect on
 * its own, and are revoked by removing the device.
 */

export interface AccessTokenPayload {
  sub: string;              // account id
  device?: string;          // device id, when the token belongs to a device
  exp: number;              // ms since epoch
}

const b64url = (b: Buffer) => b.toString('base64url');

export function signAccessToken(secret: Buffer, payload: AccessTokenPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyAccessToken(secret: Buffer, token: string, now = Date.now()): AccessTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest();
  let given: Buffer;
  try { given = Buffer.from(mac, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: AccessTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessTokenPayload;
  } catch {
    return null;
  }
  if (typeof payload?.sub !== 'string' || typeof payload?.exp !== 'number') return null;
  if (payload.exp <= now) return null;
  return payload;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('base64');

export interface IssuedRefresh { token: string; expiresAt: number }

/** A new refresh token, either starting a family or continuing one. */
export function issueRefresh(store: Store, accountId: string, ttlMs: number, now = Date.now(), family: string = randomUUID()): IssuedRefresh {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const expiresAt = now + ttlMs;
  store.saveRefresh({ id, family, accountId, hash: hashToken(secret), expiresAt });
  // The id travels with the secret so the record can be found without a scan.
  return { token: `${id}.${secret}`, expiresAt };
}

export type RefreshOutcome =
  | { ok: true; accountId: string; next: IssuedRefresh }
  | { ok: false; reason: 'invalid' | 'expired' | 'reused' };

export function rotateRefresh(store: Store, token: string, ttlMs: number, now = Date.now()): RefreshOutcome {
  const [id, secret] = token.split('.');
  if (!id || !secret) return { ok: false, reason: 'invalid' };
  const record = store.refreshById(id);
  if (!record) return { ok: false, reason: 'invalid' };

  const given = Buffer.from(hashToken(secret), 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };
  if (record.revoked) return { ok: false, reason: 'reused' };
  if (record.usedAt !== null) {
    /* Someone is using a token that was already exchanged: either it was
       copied, or a client replayed it. Either way the family is no longer
       trustworthy. */
    store.revokeFamily(record.family);
    return { ok: false, reason: 'reused' };
  }
  if (record.expiresAt <= now) return { ok: false, reason: 'expired' };

  store.markRefreshUsed(id, now);
  return { ok: true, accountId: record.accountId, next: issueRefresh(store, record.accountId, ttlMs, now, record.family) };
}

export function revokeRefresh(store: Store, token: string): boolean {
  const [id] = token.split('.');
  if (!id) return false;
  const record = store.refreshById(id);
  if (!record) return false;
  store.revokeFamily(record.family);
  return true;
}
