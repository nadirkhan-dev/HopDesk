/**
 * Rejects a handshake whose nonce was already seen, or whose timestamp is too
 * far from the host's clock to be checked against the cache.
 *
 * Replaying a hello can never authenticate (the host answers with a fresh
 * ephemeral key), but without this a recorded hello could be replayed to
 * spam consent prompts or burn through the guess budget.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    /** Accepted distance between the peer's clock and ours. */
    readonly windowMs = 10 * 60_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 'ok', 'replay' or 'clock-skew'. Records the nonce on 'ok'. */
  check(nonce: string, time: number): 'ok' | 'replay' | 'clock-skew' {
    const t = this.now();
    if (Math.abs(t - time) > this.windowMs) return 'clock-skew';
    this.prune(t);
    if (this.seen.has(nonce)) return 'replay';
    if (this.seen.size >= this.maxEntries) {
      // Evict the oldest; entries are inserted in time order.
      const first = this.seen.keys().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    this.seen.set(nonce, t);
    return 'ok';
  }

  private prune(t: number) {
    // A nonce older than twice the window can no longer pass the clock check.
    for (const [nonce, at] of this.seen) {
      if (t - at <= 2 * this.windowMs) break;
      this.seen.delete(nonce);
    }
  }
}
