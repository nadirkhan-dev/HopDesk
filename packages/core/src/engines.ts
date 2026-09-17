import type { ChildProcess } from 'node:child_process';
import { spawnClean } from './spawn.js';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import type { Connection } from './connections.js';
import { classifyRdpError, type FriendlyError } from './errors.js';
import {
  BASELINE_RDP_CAPABILITIES, buildRdpLaunch, detectFreeRdpCapabilities, explainRdpError, rdpErrorIn,
  type FreeRdpCapabilities,
} from './rdp.js';

/**
 * RDP and SPICE, driven through their reference implementations.
 *
 * VNC is implemented natively in this codebase because RFB is small and we want
 * the pixels in-process. RDP is the opposite case: it is decades of codecs
 * (RemoteFX, NSCodec, H.264), NLA and CredSSP, TLS, smartcard redirection and
 * security fixes. FreeRDP is maintained, audited and packaged everywhere.
 * Reimplementing it would be slower, less compatible and less safe — so this
 * launches `xfreerdp` and manages its lifecycle instead.
 *
 * The visible trade-off: an external window rather than an embedded surface.
 *
 * **Passwords are never passed on the command line.** Process arguments are
 * world-readable in /proc, so `/p:secret` would expose the password to every
 * user on the machine. FreeRDP reads it from stdin via `/from-stdin:force`.
 * The exact command line is planned in rdp.ts.
 */

export type EngineState = 'starting' | 'running' | 'exited' | 'failed';

export interface EngineEvent {
  state: EngineState;
  code?: number | null;
  message?: string;
  /** The FreeRDP error name behind a failure, e.g. ERRCONNECT_LOGON_FAILURE. */
  errorCode?: string;
  /** The failure, classified for display. */
  error?: FriendlyError;
}

export interface ExternalEngineOptions {
  /** SHA-256 fingerprint of the one certificate to accept for this session. */
  trustedFingerprint?: string | null;
  /** Skips detection; tests use it to pin a FreeRDP build. */
  capabilities?: FreeRdpCapabilities;
  /** How long FreeRDP must survive without an error to count as connected. */
  settleMs?: number;
  /** How long a process that reported a fatal error may linger before it is killed. */
  hangKillMs?: number;
  /** Overrides the binary search, for tests. */
  binary?: string;
  /** The server was reachable just before launch; sharpens failure messages. */
  reachable?: boolean;
  /** Initial RDP window size when the resolution follows the window. */
  windowSize?: { width: number; height: number };
}

/** Binaries we know how to drive, in preference order. */
const RDP_BINARIES = ['xfreerdp3', 'xfreerdp', 'freerdp3'];
const SPICE_BINARIES = ['remote-viewer', 'spicy'];

async function firstAvailable(candidates: string[]): Promise<string | null> {
  for (const name of candidates) {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir) continue;
      try {
        await access(`${dir}/${name}`, constants.X_OK);
        return name;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

export async function rdpAvailable() { return firstAvailable(RDP_BINARIES); }
export async function spiceAvailable() { return firstAvailable(SPICE_BINARIES); }

/**
 * Human-readable explanation of FreeRDP's exit codes.
 *
 * Without this the user sees "process exited with 131", which tells them
 * nothing. These are the codes people actually hit.
 */
export function explainRdpExit(code: number | null): string {
  switch (code) {
    case 0: return 'The session ended normally.';
    case 1: return 'The session ended.';
    case 12:
    case 0x10008: return 'Could not reach the computer. Check the address and that Remote Desktop is enabled.';
    case 0x20009:
    case 131: return 'The username or password was not accepted.';
    case 0x2000c: return 'The account is not allowed to sign in remotely. Add it to the Remote Desktop Users group.';
    case 0x10000: return 'The connection was refused. Port 3389 may be closed or blocked by a firewall.';
    case 0x00020008: return 'The server\u2019s security certificate was rejected.';
    default:
      return code === null
        ? 'The remote desktop process stopped unexpectedly.'
        : `The remote desktop process exited with code ${code}.`;
  }
}

export declare interface ExternalEngine {
  on(e: 'state', l: (event: EngineEvent) => void): this;
  /** A line of FreeRDP output, with the password redacted. */
  on(e: 'log', l: (line: string) => void): this;
  /** An option that could not be honoured by the installed FreeRDP. */
  on(e: 'warning', l: (message: string) => void): this;
}

export class ExternalEngine extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopping = false;
  private lastLines: string[] = [];
  private fatalError: string | null = null;
  private capabilities: FreeRdpCapabilities | null;

  constructor(
    private readonly connection: Connection,
    private readonly password: string | null,
    private readonly options: ExternalEngineOptions = {},
  ) {
    super();
    this.capabilities = options.capabilities ?? null;
  }

  get pid() { return this.child?.pid ?? null; }
  get running() { return this.child !== null && this.child.exitCode === null; }

  /** Recent stderr, for the diagnostics panel when something goes wrong. */
  get recentLog() { return [...this.lastLines]; }

  async start(opts: { parentWindowId?: string } = {}): Promise<void> {
    const isRdp = this.connection.protocol === 'rdp';
    const binary = this.options.binary ?? (isRdp ? await rdpAvailable() : await spiceAvailable());

    if (!binary) {
      const need = isRdp
        ? 'FreeRDP (install the "freerdp2-x11" or "freerdp3-x11" package)'
        : 'Virt Viewer (install the "virt-viewer" package)';
      this.emit('state', {
        state: 'failed',
        message: `${this.connection.protocol.toUpperCase()} support needs ${need}.`,
      });
      throw new Error(`${this.connection.protocol} viewer not found`);
    }

    let args: string[];
    let stdin: string | null = null;
    if (isRdp) {
      this.capabilities ??= await detectFreeRdpCapabilities(binary);
      const plan = buildRdpLaunch(this.connection, this.capabilities, {
        password: this.password,
        trustedFingerprint: this.options.trustedFingerprint,
        parentWindowId: opts.parentWindowId,
        pathExists: existsSync,
        windowSize: this.options.windowSize,
      });
      args = plan.args;
      stdin = plan.stdin;
      for (const w of plan.warnings) this.emit('warning', w);
    } else {
      args = this.spiceArgs();
    }

    this.stopping = false;
    this.fatalError = null;
    this.emit('state', { state: 'starting' });

    // Without HopDesk's own file descriptors: see spawn.ts.
    const child = spawnClean(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Not detached: the session belongs to this app's process group, so it
      // cannot outlive the app and leave the remote machine held.
      detached: false,
    });
    this.child = child;

    /* The password goes over stdin. Never argv: /proc/<pid>/cmdline is
       world-readable on Linux, so a password on the command line is visible to
       every other user and to any process listing. */
    child.stdin?.on('error', () => { /* the process exited before reading */ });
    if (stdin) child.stdin?.write(stdin);
    child.stdin?.end();

    let hangTimer: ReturnType<typeof setTimeout> | null = null;
    const capture = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split('\n')) {
        if (!raw.trim()) continue;
        const line = this.redact(raw);
        // Bounded: a chatty session must not grow memory without limit.
        this.lastLines.push(line);
        if (this.lastLines.length > 200) this.lastLines.shift();
        this.emit('log', line);

        const error = rdpErrorIn(line);
        if (error && !this.fatalError && !this.stopping) {
          this.fatalError = error;
          // FreeRDP 2 sometimes stays alive after a failed connect (seen after a
          // rejected certificate). A dead session must not look alive.
          hangTimer = setTimeout(() => { if (this.child === child) child.kill('SIGTERM'); },
            this.options.hangKillMs ?? 2500);
          hangTimer.unref?.();
        }
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    child.on('error', err => {
      this.emit('state', { state: 'failed', message: err.message });
    });

    child.on('exit', code => {
      if (hangTimer) clearTimeout(hangTimer);
      this.child = null;
      if (this.stopping) { this.emit('state', { state: 'exited', code }); return; }

      if (this.fatalError) {
        this.emit('state', {
          state: 'failed', code, errorCode: this.fatalError,
          message: explainRdpError(this.fatalError, this.connection, { reachable: this.options.reachable }),
          error: classifyRdpError(this.fatalError, this.connection, { reachable: this.options.reachable, exitCode: code }),
        });
        return;
      }
      const clean = code === 0 || code === 1;
      this.emit('state', {
        state: clean ? 'exited' : 'failed',
        code,
        message: isRdp ? explainRdpExit(code) : `The viewer exited with code ${code}.`,
        error: clean ? undefined : classifyRdpError(null, this.connection, { exitCode: code }),
      });
    });

    // FreeRDP reports readiness only by not dying: surviving the grace period
    // without an error is what distinguishes "connected" from "failed quickly".
    const settle = this.options.settleMs ?? (isRdp ? 3000 : 600);
    const deadline = Date.now() + settle;
    while (Date.now() < deadline && this.child === child && !this.fatalError) {
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    if (this.child === child && !this.fatalError) this.emit('state', { state: 'running' });
  }

  /** The password must never reach a log file, even if a tool echoes it. */
  private redact(line: string): string {
    const p = this.password;
    return p && p.length >= 3 ? line.split(p).join('********') : line;
  }

  /** The FreeRDP command line for this connection. Never contains the password. */
  private rdpArgs(parentWindowId?: string): string[] {
    return buildRdpLaunch(this.connection, this.capabilities ?? BASELINE_RDP_CAPABILITIES, {
      password: this.password,
      trustedFingerprint: this.options.trustedFingerprint,
      parentWindowId,
    }).args;
  }

  private spiceArgs(): string[] {
    const c = this.connection;
    // remote-viewer takes a URI. Passwords come from the URI only for
    // spice:// with no other option; prefer a ticket via the connection file
    // in a future revision.
    return [`spice://${c.host}:${c.port}`, '--title', c.name];
  }

  /** Terminates the session. SIGTERM first, SIGKILL if it ignores us. */
  stop(): void {
    this.stopping = true;
    const child = this.child;
    if (!child) return;

    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      // A wedged viewer holding the remote session is worse than a hard kill.
      if (this.child) this.child.kill('SIGKILL');
    }, 3000);
    timer.unref?.();
  }
}
