import { randomBytes } from 'node:crypto';
import { equalBytes, toBase64 } from '@hopdesk/crypto';

/**
 * Reconnect grants: after the person at the host allows a viewer, the host
 * hands that viewer a random 256-bit secret over the encrypted channel. A
 * dropped connection can then resume without a new consent prompt, but only
 * for the same viewer key, only until the grant expires, and never after the
 * host revokes it. Grants live in memory and die with the host process.
 */

export interface Grant {
  id: string;            // base64, 16 bytes
  secret: Uint8Array;    // 32 bytes
  viewerKey: Uint8Array;
  expiresAt: number;
}

export class GrantStore {
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(viewerKey: Uint8Array, ttlMs: number): Grant {
    this.prune();
    const grant: Grant = {
      id: toBase64(randomBytes(16)),
      secret: new Uint8Array(randomBytes(32)),
      viewerKey: viewerKey.slice(),
      expiresAt: this.now() + ttlMs,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /** The grant, if it exists, has not expired and belongs to this viewer key. */
  find(id: string, viewerKey: Uint8Array): Grant | null {
    const grant = this.grants.get(id);
    if (!grant) return null;
    if (grant.expiresAt <= this.now()) { this.revoke(id); return null; }
    return equalBytes(grant.viewerKey, viewerKey) ? grant : null;
  }

  /** Extends a live grant, e.g. while its session is still connected. */
  extend(id: string, ttlMs: number) {
    const grant = this.grants.get(id);
    if (grant) grant.expiresAt = Math.max(grant.expiresAt, this.now() + ttlMs);
  }

  revoke(id: string) {
    const grant = this.grants.get(id);
    if (!grant) return;
    grant.secret.fill(0);
    this.grants.delete(id);
  }

  revokeViewer(viewerKey: Uint8Array) {
    for (const g of [...this.grants.values()]) if (equalBytes(g.viewerKey, viewerKey)) this.revoke(g.id);
  }

  revokeAll() {
    for (const id of [...this.grants.keys()]) this.revoke(id);
  }

  get size() { this.prune(); return this.grants.size; }

  private prune() {
    const t = this.now();
    for (const g of [...this.grants.values()]) if (g.expiresAt <= t) this.revoke(g.id);
  }
}
