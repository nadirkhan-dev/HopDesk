import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, checkServerIdentity, type PeerCertificate } from 'node:tls';
import type { Connection } from './connections.js';
import { runClean } from './spawn.js';

/**
 * RDP launch planning: what the installed FreeRDP can do, the exact command
 * line to run it with, and how to treat the server's certificate.
 *
 * Kept free of process management (that is ExternalEngine's job) so every
 * decision here is a pure function that tests can pin against the real help
 * output of real FreeRDP builds.
 *
 * Two facts about FreeRDP shape all of it, both verified against its source
 * (client/common/client.c and cmdline.c, 2.6.1 and 3.x):
 *
 * 1. **Credentials over stdin are fragile unless done exactly one way.** On
 *    server request it prompts for a missing username and a *missing domain*
 *    with buffered stdio, then reads the password with a raw read(). Buffered
 *    reads swallow later lines, so a password written after an empty domain
 *    prompt is lost. The only reliable form is `/from-stdin:force` — password
 *    read once, raw, before connecting — with `/u:` and `/d:` always given so
 *    nothing else is ever prompted for.
 *
 * 2. **With `/from-stdin`, an unverifiable certificate is rejected without
 *    asking.** So trust cannot be granted interactively; it has to be decided
 *    before launch and passed as `/cert:fingerprint:sha256:…`.
 */

/* ------------------------------------------------------- capabilities */

export interface FreeRdpCapabilities {
  version: { major: number; minor: number; patch: number } | null;
  /** RDP 8 graphics pipeline (`/gfx`). */
  gfx: boolean;
  /**
   * H.264 AVC444. Requires the decoder to be compiled in, which the help text
   * does not reveal: FreeRDP 3 lists AVC444 in `/gfx` syntax even when built
   * without H.264, as Ubuntu 24.04's package is.
   */
  avc444: boolean;
  networkAuto: boolean;
  smartSizing: boolean;
  multimon: boolean;
  drive: boolean;
  parentWindow: boolean;
  /** The audio backend to request, or null when none is available. */
  sound: 'pulse' | 'alsa' | null;
  /** `/from-stdin:force`: password read before connecting. */
  fromStdinForce: boolean;
  /** `/cert:fingerprint:<hash>:<hex>`, needed to trust one specific certificate. */
  certFingerprint: boolean;
  plusClipboard: boolean;
  plusFonts: boolean;
  minusThemes: boolean;
  windowDrag: boolean;
  /** How to list monitors: `/monitor-list` (2.x) or `/list:monitor` (3.x). */
  monitorList: string | null;
  /** `/monitors:<ids>` to choose which monitors a multi-monitor session uses. */
  selectMonitors: boolean;
  /** `/dynamic-resolution` (2.x) or `+dynamic-resolution` (3.x): resize the remote desktop with the window. */
  dynamicResolution: string | null;
  autoReconnect: boolean;
  title: boolean;
  wmClass: boolean;
  size: boolean;
}

/** What is assumed when detection fails: a stock FreeRDP 2 without H.264. */
export const BASELINE_RDP_CAPABILITIES: FreeRdpCapabilities = {
  version: null,
  gfx: true, avc444: false, networkAuto: true, smartSizing: true, multimon: true,
  drive: true, parentWindow: true, sound: 'pulse', fromStdinForce: true,
  certFingerprint: true, plusClipboard: true, plusFonts: true, minusThemes: true, windowDrag: true,
  monitorList: '/monitor-list', selectMonitors: true, dynamicResolution: '/dynamic-resolution',
  autoReconnect: true, title: true, wmClass: true, size: true,
};

/** Parses `/version`, `/help` and `/buildconfig` output into capabilities. */
export function parseFreeRdpCapabilities(versionText: string, help: string, buildConfig: string): FreeRdpCapabilities {
  const v = /FreeRDP version (\d+)\.(\d+)\.(\d+)/.exec(versionText);
  const flag = (name: string): boolean | null => {
    const m = new RegExp(`\\b${name}=(ON|OFF|1|0|TRUE|FALSE)\\b`, 'i').exec(buildConfig);
    return m ? /^(ON|1|TRUE)$/i.test(m[1]!) : null;
  };

  const pulse = flag('WITH_PULSE');
  const alsa = flag('WITH_ALSA');
  const hasSound = /\/sound\b/.test(help);
  let sound: FreeRdpCapabilities['sound'] = null;
  if (hasSound) {
    // An unreadable build configuration is not evidence of a missing backend.
    if (pulse !== false) sound = 'pulse';
    else if (alsa !== false) sound = 'alsa';
  }

  return {
    version: v ? { major: Number(v[1]), minor: Number(v[2]), patch: Number(v[3]) } : null,
    gfx: /\/gfx\b/.test(help),
    avc444: /AVC444/.test(help) && flag('WITH_GFX_H264') === true,
    networkAuto: /\/network:\s*\[[^\]]*\bauto\b/.test(help),
    smartSizing: /\/smart-sizing\b/.test(help),
    multimon: /\/multimon\b/.test(help),
    drive: /\/drive:/.test(help),
    parentWindow: /\/parent-window:/.test(help),
    sound,
    fromStdinForce: /\/from-stdin\[:\s*force\]/.test(help),
    certFingerprint: /\/cert:\s*\[[^\]]*fingerprint/.test(help),
    plusClipboard: /\+clipboard\b/.test(help),
    plusFonts: /\+fonts\b/.test(help),
    minusThemes: /-themes\b/.test(help),
    windowDrag: /\+window-drag\b/.test(help),
    monitorList: /\/monitor-list\b/.test(help) ? '/monitor-list'
      // The /list: syntax wraps over several lines and nests brackets.
      : /\/list:[\s\S]{0,400}?\|monitor\|/.test(help) ? '/list:monitor' : null,
    selectMonitors: /\/monitors:/.test(help),
    dynamicResolution: /\+dynamic-resolution\b/.test(help) ? '+dynamic-resolution'
      : /\/dynamic-resolution\b/.test(help) ? '/dynamic-resolution' : null,
    autoReconnect: /\+auto-reconnect\b/.test(help),
    title: /\/t:\s*<title>/.test(help),
    wmClass: /\/wm-class:/.test(help),
    size: /\/size:/.test(help),
  };
}

async function capture(binary: string, arg: string): Promise<string> {
  // FreeRDP exits non-zero after printing help; the output is still valid.
  const { stdout, stderr } = await runClean(binary, [arg], 5000);
  return `${stdout}${stderr}`;
}

const detected = new Map<string, Promise<FreeRdpCapabilities>>();

/** Runs the binary once per process to learn what it supports. */
export function detectFreeRdpCapabilities(binary: string): Promise<FreeRdpCapabilities> {
  let pending = detected.get(binary);
  if (!pending) {
    pending = Promise.all([capture(binary, '/version'), capture(binary, '/help'), capture(binary, '/buildconfig')])
      .then(([version, help, build]) => help.trim()
        ? parseFreeRdpCapabilities(version, help, build)
        : BASELINE_RDP_CAPABILITIES);
    detected.set(binary, pending);
  }
  return pending;
}

/* ------------------------------------------------------ command line */

export interface RdpLaunchOptions {
  password?: string | null;
  /** SHA-256 fingerprint the user has chosen to trust for this server. */
  trustedFingerprint?: string | null;
  parentWindowId?: string;
  /** Used to skip a shared folder that no longer exists. */
  pathExists?: (p: string) => boolean;
  /** Initial window size for "auto" resolution, e.g. most of the local screen. */
  windowSize?: { width: number; height: number };
}

export interface RdpLaunchPlan {
  args: string[];
  /** Written to the process's stdin. Never part of `args`. */
  stdin: string | null;
  /** Options that could not be honoured, in words a user understands. */
  warnings: string[];
}

export function buildRdpLaunch(
  c: Connection, caps: FreeRdpCapabilities, opts: RdpLaunchOptions = {},
): RdpLaunchPlan {
  const o = c.options;
  const warnings: string[] = [];
  const host = isIP(c.host) === 6 ? `[${c.host}]` : c.host;
  const args = [`/v:${host}:${c.port}`];

  if (c.username) {
    args.push(`/u:${c.username}`);
    // Always present, even empty: a missing domain makes FreeRDP prompt for
    // one on stdin, which consumes the password line.
    args.push(`/d:${c.domain ?? ''}`);
  }

  let stdin: string | null = null;
  if (opts.password) {
    if (/[\r\n]/.test(opts.password)) {
      throw new Error('This password contains a line break, which FreeRDP cannot read securely.');
    }
    // The password goes over stdin, never argv: /proc/<pid>/cmdline is
    // readable by every user on the machine.
    args.push(caps.fromStdinForce ? '/from-stdin:force' : '/from-stdin');
    stdin = `${opts.password}\n`;
  } else {
    // Still set, so FreeRDP never falls back to prompting on a terminal.
    args.push('/from-stdin');
  }

  if (opts.trustedFingerprint) {
    if (caps.certFingerprint) {
      args.push(`/cert:fingerprint:sha256:${normalizeFingerprint(opts.trustedFingerprint)}`);
    } else {
      warnings.push('This FreeRDP version cannot trust a specific certificate. Update FreeRDP to connect to servers with self-signed certificates.');
    }
  }
  // No trusted fingerprint: FreeRDP's own verification applies. Certificate
  // checks are never switched off.

  args.push(`/bpp:${o.colorDepth ?? 32}`);

  if (caps.avc444) args.push('/gfx:AVC444');
  else if (caps.gfx) args.push('/gfx');
  if (caps.networkAuto) args.push('/network:auto');
  if (caps.plusFonts) args.push('+fonts');
  if (caps.windowDrag) args.push('+window-drag');
  if (caps.minusThemes) args.push('-themes');

  if (!o.shareClipboard || o.viewOnly) args.push('-clipboard');
  else if (caps.plusClipboard) args.push('+clipboard');

  /* fit: FreeRDP scales the remote image into the window.
     fill: the remote desktop is resized to the window instead.
     FreeRDP refuses both at once ("mutually exclusive options"). */
  const followWindow = o.scaling === 'fill' && !o.multiMonitor && !o.fullscreenOnConnect
    && !/^\d{3,5}x\d{3,5}$/.test(o.resolution ?? '') && caps.dynamicResolution !== null;
  if (o.scaling === 'fit' || (o.scaling === 'fill' && !followWindow)) {
    if (caps.smartSizing) args.push('/smart-sizing');
    else warnings.push('Scaling to the window is not supported by this FreeRDP version.');
  }
  if (caps.title) args.push(`/t:${c.name}`);
  // Groups the session window with HopDesk in docks and task switchers.
  if (caps.wmClass) args.push('/wm-class:HopDesk');

  if (o.fullscreenOnConnect) args.push('/f');
  if (o.multiMonitor) {
    if (caps.multimon) {
      args.push('/multimon');
      if (o.monitors?.length) {
        if (caps.selectMonitors) args.push(`/monitors:${o.monitors.join(',')}`);
        else warnings.push('This FreeRDP version cannot choose monitors; all monitors are used.');
      }
    } else {
      warnings.push('Multiple monitors are not supported by this FreeRDP version.');
    }
  } else {
    const fixed = /^(\d{3,5})x(\d{3,5})$/.exec(o.resolution ?? '');
    if (fixed && caps.size) {
      args.push(`/size:${fixed[1]}x${fixed[2]}`);
    } else if (!o.fullscreenOnConnect) {
      if (opts.windowSize && caps.size) args.push(`/size:${opts.windowSize.width}x${opts.windowSize.height}`);
      // The remote desktop follows the window as it is resized.
      if (followWindow) args.push(caps.dynamicResolution!);
    }
  }

  if (o.autoReconnect && caps.autoReconnect) {
    // FreeRDP reconnects a dropped session itself, keeping the remote session.
    args.push('+auto-reconnect', '/auto-reconnect-max-retries:10');
  }
  if (o.enableAudio) {
    if (caps.sound) args.push(`/sound:sys:${caps.sound}`);
    else warnings.push('Remote audio is unavailable: this FreeRDP was built without PulseAudio or ALSA.');
  }
  if (o.redirectFolder) {
    if (!caps.drive) {
      warnings.push('Folder sharing is not supported by this FreeRDP version.');
    } else if (opts.pathExists && !opts.pathExists(o.redirectFolder)) {
      warnings.push(`The shared folder ${o.redirectFolder} does not exist, so it was not shared.`);
    } else {
      args.push(`/drive:home,${o.redirectFolder}`);
    }
  }
  if (opts.parentWindowId && caps.parentWindow) args.push(`/parent-window:${opts.parentWindowId}`);

  return { args, stdin, warnings };
}

/* ------------------------------------------------------------- errors */

/** The FreeRDP error name in a log line, if it reports one. */
export function rdpErrorIn(line: string): string | null {
  const m = /\b(ERRCONNECT_[A-Z_]+)\b/.exec(line);
  if (!m || m[1] === 'ERRCONNECT_SUCCESS') return null;
  return m[1]!;
}

export function explainRdpError(
  code: string, c: { host: string; port: number },
  /** The server answered a TLS handshake just before FreeRDP was started. */
  context: { reachable?: boolean } = {},
): string {
  const where = `${c.host}:${c.port}`;
  // Some servers (FreeRDP-based ones, some gateways) reject bad credentials
  // during NLA by dropping the connection, which FreeRDP reports as a transport
  // failure. If the server was demonstrably reachable a moment earlier, "check
  // the firewall" would send the user the wrong way.
  if (context.reachable && (code === 'ERRCONNECT_CONNECT_TRANSPORT_FAILED' || code === 'ERRCONNECT_CONNECT_FAILED')) {
    return `${where} closed the connection during sign-in. Check the username and password, and that this account may sign in remotely.`;
  }
  switch (code) {
    case 'ERRCONNECT_LOGON_FAILURE':
    case 'ERRCONNECT_AUTHENTICATION_FAILED':
    case 'ERRCONNECT_WRONG_PASSWORD':
    case 'ERRCONNECT_NO_OR_MISSING_CREDENTIALS':
      return 'The username or password was not accepted. For a Microsoft account, use the account e-mail address and its password, not the PIN.';
    case 'ERRCONNECT_PASSWORD_EXPIRED':
    case 'ERRCONNECT_PASSWORD_CERTAINLY_EXPIRED':
    case 'ERRCONNECT_PASSWORD_MUST_CHANGE':
      return 'The password has expired. Sign in on the computer itself to set a new one.';
    case 'ERRCONNECT_ACCOUNT_DISABLED':
    case 'ERRCONNECT_ACCOUNT_EXPIRED':
      return 'This account is disabled or expired.';
    case 'ERRCONNECT_ACCOUNT_LOCKED_OUT':
      return 'This account is locked after too many failed sign-ins. Wait, or ask an administrator to unlock it.';
    case 'ERRCONNECT_ACCOUNT_RESTRICTION':
    case 'ERRCONNECT_LOGON_TYPE_NOT_GRANTED':
    case 'ERRCONNECT_INSUFFICIENT_PRIVILEGES':
    case 'ERRCONNECT_ACCESS_DENIED':
      return 'This account is not allowed to sign in remotely. Add it to the Remote Desktop Users group on that computer.';
    case 'ERRCONNECT_TLS_CONNECT_FAILED':
      return `The secure connection to ${where} failed. Its certificate was not trusted or has changed.`;
    case 'ERRCONNECT_DNS_ERROR':
    case 'ERRCONNECT_DNS_NAME_NOT_FOUND':
      return `The computer name "${c.host}" could not be found. Check the address, or use its IP address.`;
    case 'ERRCONNECT_CONNECT_TRANSPORT_FAILED':
    case 'ERRCONNECT_CONNECT_FAILED':
      return `Could not reach ${where}. Check the address, that Remote Desktop is turned on, and that a firewall is not blocking the port.`;
    case 'ERRCONNECT_SECURITY_NEGO_CONNECT_FAILED':
      return 'The computer rejected the security settings. It may require Network Level Authentication with a username and password.';
    case 'ERRCONNECT_CONNECT_CANCELLED':
      return 'The connection was cancelled.';
    case 'ERRCONNECT_KDC_UNREACHABLE':
      return 'The domain controller could not be reached to verify the account.';
    default:
      return `The remote desktop connection failed (${code}).`;
  }
}

/* ------------------------------------------------------- certificates */

export interface RdpCertificate {
  /** SHA-256, lower-case colon-separated hex — the form FreeRDP accepts. */
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** Chains to a trusted CA and matches the host name. */
  trusted: boolean;
  trustError: string | null;
}

export type RdpProbeResult =
  | { kind: 'tls'; certificate: RdpCertificate }
  /** The server does not use TLS (legacy RDP security) or refused to negotiate it. */
  | { kind: 'no-tls'; reason: string }
  | { kind: 'unreachable'; reason: string };

export function normalizeFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length !== 64) throw new Error('A SHA-256 certificate fingerprint has 64 hex digits');
  return hex.match(/../g)!.join(':');
}

const describeName = (name: PeerCertificate['subject'] | undefined) =>
  name ? Object.entries(name).map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(', ') : v}`).join(', ') : '';

/**
 * Reads the server's TLS certificate the way an RDP client first meets it: an
 * X.224 connection request asking for TLS or NLA, then a TLS handshake on the
 * same socket. Nothing is authenticated and no credentials are sent.
 */
export function probeRdpCertificate(host: string, port: number, timeoutMs = 6000): Promise<RdpProbeResult> {
  return new Promise(resolve => {
    let done = false;
    let sock: Socket | null = null;
    const finish = (r: RdpProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ kind: 'unreachable', reason: `No response from ${host}:${port}` }), timeoutMs);

    const raw = netConnect({ host, port });
    sock = raw;
    raw.on('error', err => finish({ kind: 'unreachable', reason: err.message }));

    raw.on('connect', () => {
      // TPKT(4) + X.224 CR(7) + RDP_NEG_REQ(8) asking for PROTOCOL_SSL | PROTOCOL_HYBRID.
      raw.write(Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x08, 0x00, 0x03, 0, 0, 0]));
    });

    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt16BE(2);
      if (buf.length < len) return;
      raw.off('data', onData);

      if (buf[0] !== 3 || len < 11 || buf[5] !== 0xd0) {
        finish({ kind: 'no-tls', reason: 'The server did not answer as an RDP server.' });
        return;
      }
      if (len < 19) {
        finish({ kind: 'no-tls', reason: 'The server only offers legacy RDP security, without TLS.' });
        return;
      }
      const type = buf[11];
      const value = buf.readUInt32LE(15);
      if (type === 3) {
        finish({ kind: 'no-tls', reason: `The server refused TLS negotiation (code ${value}).` });
        return;
      }
      if (type !== 2 || value === 0) {
        finish({ kind: 'no-tls', reason: 'The server only offers legacy RDP security, without TLS.' });
        return;
      }

      const options = {
        socket: raw,
        rejectUnauthorized: false,
        servername: isIP(host) ? undefined : host,
        // Only the certificate is read here, so old servers (TLS 1.0, SHA-1
        // certificates) must still be probed; FreeRDP applies its own policy
        // to the actual session.
        minVersion: 'TLSv1' as const,
      };
      let tls;
      try {
        // OpenSSL needs the security level lowered for legacy certificates.
        tls = tlsConnect({ ...options, ciphers: 'DEFAULT:@SECLEVEL=0' });
      } catch {
        // Electron's BoringSSL rejects that syntax (synchronously); its
        // defaults already accept what is needed to read a certificate.
        try {
          tls = tlsConnect(options);
        } catch (err) {
          finish({ kind: 'no-tls', reason: `TLS could not be started: ${(err as Error).message}` });
          return;
        }
      }
      sock = tls;
      tls.on('error', err => finish({ kind: 'no-tls', reason: `TLS handshake failed: ${err.message}` }));
      tls.on('secureConnect', () => {
        const cert = tls.getPeerCertificate();
        if (!cert?.fingerprint256) {
          finish({ kind: 'no-tls', reason: 'The server presented no certificate.' });
          return;
        }
        const identityError = checkServerIdentity(host, cert);
        const trusted = tls.authorized && !identityError;
        finish({
          kind: 'tls',
          certificate: {
            fingerprint: normalizeFingerprint(cert.fingerprint256),
            subject: describeName(cert.subject),
            issuer: describeName(cert.issuer),
            validFrom: cert.valid_from,
            validTo: cert.valid_to,
            trusted,
            trustError: trusted ? null : String(tls.authorizationError ?? identityError?.message ?? 'not trusted'),
          },
        });
      });
    };
    raw.on('data', onData);
  });
}

export type CertificateDecision =
  /** Trust exactly this certificate. */
  | { action: 'pin'; fingerprint: string }
  /** Let FreeRDP verify against the system CA store. */
  | { action: 'verify' }
  /** The user must decide; the connection must not start until they do. */
  | { action: 'ask'; reason: 'untrusted' | 'changed'; certificate: RdpCertificate; previousFingerprint?: string };

export function decideRdpCertificate(probe: RdpProbeResult, trustedFingerprint?: string | null): CertificateDecision {
  const trusted = trustedFingerprint ? normalizeFingerprint(trustedFingerprint) : null;

  if (probe.kind !== 'tls') {
    // Unreachable or not TLS: nothing to decide here. FreeRDP connects (or
    // fails) and reports why; a pinned fingerprint still constrains it.
    return trusted ? { action: 'pin', fingerprint: trusted } : { action: 'verify' };
  }

  const cert = probe.certificate;
  if (trusted) {
    if (cert.fingerprint === trusted) return { action: 'pin', fingerprint: trusted };
    return { action: 'ask', reason: 'changed', certificate: cert, previousFingerprint: trusted };
  }
  if (cert.trusted) return { action: 'verify' };
  return { action: 'ask', reason: 'untrusted', certificate: cert };
}

/* ------------------------------------------------------------ monitors */

export interface LocalMonitor { id: number; width: number; height: number; x: number; y: number; primary: boolean }

/** Parses FreeRDP's monitor listing: `      * [0] 1920x1080\t+0+0`. */
export function parseMonitorList(text: string): LocalMonitor[] {
  const out: LocalMonitor[] = [];
  for (const m of text.matchAll(/^\s*(\*)?\s*\[(\d+)\]\s+(\d+)x(\d+)\s+\+(-?\d+)\+(-?\d+)/gm)) {
    out.push({
      id: Number(m[2]), width: Number(m[3]), height: Number(m[4]),
      x: Number(m[5]), y: Number(m[6]), primary: m[1] === '*',
    });
  }
  return out;
}

/** The monitors FreeRDP would use for a multi-monitor session on this display. */
export async function listFreeRdpMonitors(binary: string, caps: FreeRdpCapabilities): Promise<LocalMonitor[]> {
  if (!caps.monitorList) return [];
  return parseMonitorList(await capture(binary, caps.monitorList));
}
