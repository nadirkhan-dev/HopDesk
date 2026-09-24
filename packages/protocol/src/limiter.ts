/**
 * Guessing protection for the six-digit access code.
 *
 * SPAKE2 gives an attacker one guess per handshake, and a guess is "spent" as
 * soon as the host sends its challenge — the attacker can check the host's
 * confirmation MAC against its guess even if it never replies. So an
 * abandoned handshake counts exactly like a failed one; only a verified
 * confirmation clears it.
 *
 * **Lockouts are per peer.** They used to be one counter for the whole host,
 * which protected the code and handed out a denial of service with it: three
 * failures from anyone who could reach the port locked the code path for
 * everybody, and doubling up to five minutes made it cheap to keep locked. A
 * peer is an address and the Device ID it claims to be, so failures follow
 * whoever is making them and a second computer can still connect while an
 * attacker is serving its own lockout.
 *
 * **The caps are global**, because a peer is not a scarce resource: each code
 * attempt costs the host 32 MiB of scrypt, so the number in flight at once is
 * limited across all peers, not per peer. And rotation stays global, because
 * the code is: after `rotateAfter` failures against one code — from one peer
 * or a thousand — it is replaced, which is what bounds any attacker's total
 * success probability to rotateAfter / 10^6 per code, however the attempts are
 * spread around.
 */

export interface LimiterPolicy {
  /** Code handshakes in flight at once, across every peer. */
  maxPending: number;
  /** Code handshakes in flight at once from one peer. */
  maxPendingPerPeer: number;
  /** Consecutive failures a peer gets before its lockout begins. */
  freeFailures: number;
  baseLockoutMs: number;
  maxLockoutMs: number;
  /** Failures against one code, from anyone, before the code is replaced. */
  rotateAfter: number;
  /** How long a quiet peer's record is kept. */
  peerTtlMs: number;
  /** Peers remembered at once; the least recently seen is dropped first. */
  maxPeers: number;
}

export const DEFAULT_LIMITER_POLICY: LimiterPolicy = {
  maxPending: 3,
  maxPendingPerPeer: 2,
  freeFailures: 3,
  baseLockoutMs: 2000,
  maxLockoutMs: 5 * 60_000,
  rotateAfter: 10,
  peerTtlMs: 60 * 60_000,
  maxPeers: 1024,
};

export type AttemptDecision = { ok: true; attempt: Attempt } | { ok: false; retryAfterMs: number; reason: 'locked' | 'busy' };

export interface Attempt {
  succeed(): void;
  fail(): void;
}

interface PeerRecord {
  pending: number;
  consecutive: number;
  lockedUntil: number;
  seen: number;
}

export class AttemptLimiter {
  private readonly peers = new Map<string, PeerRecord>();
  private pending = 0;
  private sinceRotation = 0;

  constructor(
    private readonly onRotate: () => void,
    private readonly policy: LimiterPolicy = DEFAULT_LIMITER_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Starts an attempt on behalf of one peer.
   *
   * `peer` should identify whoever is trying — an address, and the Device ID
   * claimed, since both can be forged but not freely: an address has to
   * receive replies, and a Device ID has to be signed for later in the
   * handshake. Callers with nothing to go on can pass a constant, which gives
   * the old single-counter behaviour.
   */
  begin(peer = 'unknown'): AttemptDecision {
    const t = this.now();
    this.prune(t);
    const record = this.record(peer, t);

    if (t < record.lockedUntil) return { ok: false, retryAfterMs: record.lockedUntil - t, reason: 'locked' };
    /* Both caps say "busy", which is the truth and says nothing about whether
       this peer in particular is in trouble. */
    if (this.pending >= this.policy.maxPending) return { ok: false, retryAfterMs: 1000, reason: 'busy' };
    if (record.pending >= this.policy.maxPendingPerPeer) return { ok: false, retryAfterMs: 1000, reason: 'busy' };

    this.pending++;
    record.pending++;
    let settled = false;
    const settle = (success: boolean) => {
      if (settled) return;
      settled = true;
      this.pending--;
      record.pending--;
      record.seen = this.now();
      if (success) { record.consecutive = 0; return; }
      record.consecutive++;
      this.sinceRotation++;
      if (this.sinceRotation >= this.policy.rotateAfter) {
        this.sinceRotation = 0;
        this.onRotate();
      }
      if (record.consecutive >= this.policy.freeFailures) {
        const exp = record.consecutive - this.policy.freeFailures;
        const delay = Math.min(this.policy.maxLockoutMs, this.policy.baseLockoutMs * 2 ** Math.min(exp, 20));
        record.lockedUntil = Math.max(record.lockedUntil, this.now() + delay);
      }
    };
    return { ok: true, attempt: { succeed: () => settle(true), fail: () => settle(false) } };
  }

  /** Called when the user regenerates the code by hand. */
  resetForNewCode() { this.sinceRotation = 0; }

  get failuresSinceRotation() { return this.sinceRotation; }
  /** How many peers are being tracked, for tests and diagnostics. */
  get trackedPeers() { return this.peers.size; }

  private record(peer: string, t: number): PeerRecord {
    const existing = this.peers.get(peer);
    if (existing) { existing.seen = t; return existing; }
    /* Full: drop the peer nobody has heard from in longest. An attacker can
       churn through keys to evict others' records, which costs those peers
       their lockout - not their protection, because rotation is global and
       bounds the whole code regardless. */
    if (this.peers.size >= this.policy.maxPeers) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, value] of this.peers) {
        if (value.pending > 0) continue;              // in flight: not ours to drop
        if (value.seen < oldest) { oldest = value.seen; oldestKey = key; }
      }
      if (oldestKey !== null) this.peers.delete(oldestKey);
    }
    const fresh: PeerRecord = { pending: 0, consecutive: 0, lockedUntil: 0, seen: t };
    this.peers.set(peer, fresh);
    return fresh;
  }

  /** Forgets peers that are quiet, out of their lockout, and not mid-handshake. */
  private prune(t: number) {
    for (const [key, record] of this.peers) {
      if (record.pending > 0 || t < record.lockedUntil) continue;
      if (t - record.seen > this.policy.peerTtlMs) this.peers.delete(key);
    }
  }
}

/**
 * A light brake on connections that need no access code — a trusted device, a
 * computer on the same account, a session resuming with its grant.
 *
 * Guessing is not the threat there: those are proved with a signature over the
 * handshake, and no number of tries helps without the key. What is left is
 * churn — a peer reconnecting in a loop, or making the host do signature work
 * as fast as it can accept sockets — so this counts attempts per peer in a
 * window and says "busy" beyond it. Deliberately loose: a person reconnecting
 * after a dropped session, or a host restarting, must never meet it.
 */
export interface ThrottlePolicy {
  /** Attempts allowed from one peer per window. */
  perWindow: number;
  windowMs: number;
  maxPeers: number;
}

export const DEFAULT_THROTTLE_POLICY: ThrottlePolicy = {
  perWindow: 15,
  windowMs: 10_000,
  maxPeers: 1024,
};

export class PeerThrottle {
  private readonly windows = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly policy: ThrottlePolicy = DEFAULT_THROTTLE_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when this attempt is allowed; false when the peer should wait. */
  allow(peer = 'unknown'): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    for (const [key, window] of this.windows) if (window.until <= t) this.windows.delete(key);
    if (this.windows.size >= this.policy.maxPeers && !this.windows.has(peer)) {
      // Under that much churn, one shared answer is better than unbounded memory.
      return { ok: false, retryAfterMs: this.policy.windowMs };
    }
    const window = this.windows.get(peer) ?? { count: 0, until: t + this.policy.windowMs };
    if (window.until <= t) { window.count = 0; window.until = t + this.policy.windowMs; }
    window.count++;
    this.windows.set(peer, window);
    return window.count > this.policy.perWindow
      ? { ok: false, retryAfterMs: window.until - t }
      : { ok: true };
  }
}
