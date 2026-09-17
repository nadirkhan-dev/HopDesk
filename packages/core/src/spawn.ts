import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Starting helper programs without leaking this process's file descriptors.
 *
 * Inside Electron's main process, children started with child_process inherit
 * every descriptor Chromium opened without close-on-exec: IPC sockets, the
 * Local Storage database and its lock, the pipes to whoever started HopDesk.
 * Observed directly — a FreeRDP started this way held dozens of them. That is
 * more access than a remote desktop client needs, and a child that outlives
 * HopDesk keeps those resources alive.
 *
 * So children are started through bash, which closes everything above
 * stdin/stdout/stderr and then `exec`s the program: no extra process remains,
 * the PID is the program's own, and arguments and stdin pass through untouched.
 * bash is used because POSIX sh (dash) cannot close descriptors above 9. Where
 * bash is missing the program is started directly, as before.
 */

const BASH = ['/usr/bin/bash', '/bin/bash'].find(p => existsSync(p)) ?? null;

const CLOSE_INHERITED_FDS =
  'for fd in /proc/$$/fd/*; do n=${fd##*/}; '
  + 'if [ "$n" -gt 2 ] 2>/dev/null; then eval "exec $n>&-" 2>/dev/null; fi; done; '
  + 'exec "$@"';

export function spawnClean(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (!BASH || process.platform !== 'linux') return spawn(command, args, options);
  // $0 names the process in bash's own error messages; the rest become "$@".
  return spawn(BASH, ['-c', CLOSE_INHERITED_FDS, 'hopdesk-launch', command, ...args], options);
}

/** Like execFile: collects output, with a timeout. Never throws. */
export function runClean(command: string, args: string[], timeoutMs = 5000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    let child: ChildProcess;
    try {
      child = spawnClean(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ stdout, stderr, code: null });
      return;
    }
    const limit = 1024 * 1024;
    child.stdout?.on('data', d => { if (stdout.length < limit) stdout += d; });
    child.stderr?.on('data', d => { if (stderr.length < limit) stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    child.on('error', () => { clearTimeout(timer); resolve({ stdout, stderr, code: null }); });
    child.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });
}
