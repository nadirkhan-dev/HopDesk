/**
 * What happened to one session's input on the Host: how many messages arrived,
 * how many reached the platform, and how many were dropped and why.
 *
 * Every path that drops input used to do it silently, so "the mouse does
 * nothing" left no trace in the log. This makes each one visible: the first
 * message, the first time each reason occurs, a summary at most every five
 * seconds while the counts change, and a final one when the session ends.
 *
 * Counts and reasons only. Which keys were pressed is never recorded — they can
 * be someone's password.
 */
export class InputStats {
  private readonly received = new Map<string, number>();
  private readonly dropped = new Map<string, number>();
  private injected = 0;
  private lastReport: number;

  constructor(
    private readonly sessionId: string,
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
    private readonly interval = 5000,
  ) {
    // The first summary comes a full interval in, once there is an outcome to
    // report; the first arrival has its own line.
    this.lastReport = now();
  }

  /** A message arrived from the viewer. */
  arrived(type: string) {
    if (this.total(this.received) === 0) this.log(`session ${this.sessionId}: first input arrived from the viewer`);
    // Not a reporting point: the outcome — delivered or dropped — follows.
    this.received.set(type, (this.received.get(type) ?? 0) + 1);
  }

  /** It reached the platform's injector. */
  delivered() {
    this.injected++;
    this.touch();
  }

  /** It did not, and this is why. */
  drop(reason: string) {
    if (!this.dropped.has(reason)) this.log(`session ${this.sessionId}: input dropped: ${reason}`);
    this.bump(this.dropped, reason);
  }

  /** The summary line, logged at the end of a session. */
  finish() {
    this.report('session ended');
  }

  summary() {
    return {
      received: this.total(this.received),
      injected: this.injected,
      dropped: this.total(this.dropped),
    };
  }

  private bump(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);
    this.touch();
  }

  private touch() {
    if (this.now() - this.lastReport >= this.interval) this.report('');
  }

  private report(why: string) {
    const describe = (map: Map<string, number>) =>
      [...map].map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    this.log(`session ${this.sessionId} input${why ? ` (${why})` : ''}: `
      + `received ${this.total(this.received)} [${describe(this.received)}]; `
      + `injected ${this.injected}; dropped ${this.total(this.dropped)} [${describe(this.dropped)}]`);
    this.lastReport = this.now();
  }

  private total(map: Map<string, number>) {
    let n = 0;
    for (const v of map.values()) n += v;
    return n;
  }
}
