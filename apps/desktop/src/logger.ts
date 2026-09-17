import { appendFile, mkdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * File logging.
 *
 * A remote desktop client fails in ways users cannot describe — "it just
 * disconnected" — so a log they can attach to a bug report is worth more than
 * any amount of in-app diagnostics.
 *
 * Rotated at 2 MB so it cannot fill a small root partition.
 */

const MAX_BYTES = 2 * 1024 * 1024;

export function createLogger(dir: string) {
  const file = path.join(dir, 'hopdesk.log');
  let queue: Promise<void> = Promise.resolve();

  const write = (level: string, message: string) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`;
    // Serialised through a promise chain: concurrent appends from several
    // events would otherwise interleave and corrupt lines.
    queue = queue.then(async () => {
      try {
        await mkdir(dir, { recursive: true });
        const size = await stat(file).then(s => s.size).catch(() => 0);
        if (size > MAX_BYTES) await rename(file, `${file}.1`).catch(() => {});
        await appendFile(file, line, { mode: 0o600 });
      } catch {
        // Logging must never take the app down.
      }
    });
  };

  return {
    path: file,
    info: (m: string) => write('INFO', m),
    warn: (m: string) => write('WARN', m),
    error: (m: string) => write('ERROR', m),
    debug: (m: string) => { if (process.env.HOPDESK_DEBUG) write('DEBUG', m); },
  };
}
