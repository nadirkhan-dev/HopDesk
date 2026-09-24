import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * The Wayland desktop's "you may do this again" token.
 *
 * Controlling a Wayland desktop goes through the portal, and the portal asks
 * the person at the keyboard every time a session starts - which for a
 * computer meant to be reachable is once too often, and for one nobody is
 * sitting at is fatal. Answering that dialog can produce a *restore token*:
 * hand it back next time and the compositor allows the session without asking
 * again, until the person revokes it.
 *
 * HopDesk has asked for that token since the portal code was written and threw
 * it away every time, because nothing kept it. This keeps it.
 *
 * It is a capability, not a secret in the usual sense: anyone holding it can
 * ask this desktop for input again, without the dialog. So it lives in a file
 * only this user can read, beside the device identity, and it is deleted
 * rather than kept when the compositor refuses it.
 */

const FILE = 'wayland-portal.json';

export class PortalToken {
  private cached: string | null | undefined;

  constructor(private readonly dataDir: string) {}

  private get file() { return path.join(this.dataDir, FILE); }

  /** The token from a previous session, or undefined when there is none. */
  get(): string | undefined {
    if (this.cached !== undefined) return this.cached ?? undefined;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { restoreToken?: unknown };
      this.cached = typeof raw.restoreToken === 'string' && raw.restoreToken.length <= 512
        ? raw.restoreToken : null;
    } catch {
      // Never written, unreadable, or nonsense: there is no token, which is not an error.
      this.cached = null;
    }
    return this.cached ?? undefined;
  }

  /** Keeps a token the desktop has just issued. */
  set(token: string): void {
    if (!token || token.length > 512 || token === this.cached) return;
    this.cached = token;
    try {
      writeFileSync(this.file, JSON.stringify({ restoreToken: token }), { mode: 0o600 });
    } catch {
      /* Not fatal: the desktop will ask again next time, which is how it
         behaved before any of this existed. */
    }
  }

  /**
   * Forgets the token.
   *
   * Called when the portal refuses it - a revoked or stale token makes the
   * compositor start a fresh dialog, and keeping it would mean offering it
   * again forever.
   */
  clear(): void {
    this.cached = null;
    try { unlinkSync(this.file); } catch { /* already gone */ }
  }
}
