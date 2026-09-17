/**
 * Guessing protection for the six-digit access code.
 *
 * SPAKE2 gives an attacker one guess per handshake, and a guess is "spent" as
 * soon as the host sends its challenge — the attacker can check the host's
 * confirmation MAC against its guess even if it never replies. So an
 * abandoned handshake counts exactly like a failed one; only a verified
 * confirmation clears it.
 *
 * Policy: at most `maxPending` code handshakes at a time; after `freeFailures`
 * consecutive failures an exponentially growing lockout applies; after
 * `rotateAfter` failures against one code the code is replaced, which bounds
 * any attacker's total success probability to rotateAfter / 10^6 per code.
 */

export interface LimiterPolicy {
  maxPending: number;
  freeFailures: number;
  baseLockoutMs: number;
  maxLockoutMs: number;
  rotateAfter: number;
}

export const DEFAULT_LIMITER_POLICY: LimiterPolicy = {
  maxPending: 3,
  freeFailures: 3,
  baseLockoutMs: 2000,
  maxLockoutMs: 5 * 60_000,
  rotateAfter: 10,
};

export type AttemptDecision = { ok: true; attempt: Attempt } | { ok: false; retryAfterMs: number; reason: 'locked' | 'busy' };

export interface Attempt {
  succeed(): void;
  fail(): void;
}

export class AttemptLimiter {
  private pending = 0;
  private consecutive = 0;
  private sinceRotation = 0;
  private lockedUntil = 0;

  constructor(
    private readonly onRotate: () => void,
    private readonly policy: LimiterPolicy = DEFAULT_LIMITER_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  begin(): AttemptDecision {
    const t = this.now();
    if (t < this.lockedUntil) return { ok: false, retryAfterMs: this.lockedUntil - t, reason: 'locked' };
    if (this.pending >= this.policy.maxPending) return { ok: false, retryAfterMs: 1000, reason: 'busy' };
    this.pending++;
    let settled = false;
    const settle = (success: boolean) => {
      if (settled) return;
      settled = true;
      this.pending--;
      if (success) { this.consecutive = 0; return; }
      this.consecutive++;
      this.sinceRotation++;
      if (this.sinceRotation >= this.policy.rotateAfter) {
        this.sinceRotation = 0;
        this.onRotate();
      }
      if (this.consecutive >= this.policy.freeFailures) {
        const exp = this.consecutive - this.policy.freeFailures;
        const delay = Math.min(this.policy.maxLockoutMs, this.policy.baseLockoutMs * 2 ** Math.min(exp, 20));
        this.lockedUntil = Math.max(this.lockedUntil, this.now() + delay);
      }
    };
    return { ok: true, attempt: { succeed: () => settle(true), fail: () => settle(false) } };
  }

  /** Called when the user regenerates the code by hand. */
  resetForNewCode() { this.sinceRotation = 0; }

  get failuresSinceRotation() { return this.sinceRotation; }
}
