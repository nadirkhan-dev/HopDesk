import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { TLSSocket } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFreeRdpCapabilities, buildRdpLaunch, BASELINE_RDP_CAPABILITIES, detectFreeRdpCapabilities,
  rdpAvailable, rdpErrorIn, explainRdpError, probeRdpCertificate, decideRdpCertificate,
  normalizeFingerprint, ExternalEngine,
} from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Splits a captured `/version` + `/help` + `/buildconfig` transcript. */
function fixture(name) {
  const text = readFileSync(path.join(here, 'fixtures', name), 'utf8');
  const [version, rest] = text.split('===HELP===');
  const [help, build] = rest.split('===BUILDCONFIG===');
  return { version, help, build };
}
const caps = name => { const f = fixture(name); return parseFreeRdpCapabilities(f.version, f.help, f.build); };

const conn = (over = {}) => ({
  id: 'r', name: 'RDP', protocol: 'rdp', host: 'win.example', port: 3389,
  username: 'alice', favorite: false, createdAt: '', updatedAt: '', connectCount: 0,
  options: {
    scaling: 'fit', fullscreenOnConnect: false, viewOnly: false, shareClipboard: true,
    enableAudio: false, colorDepth: 32, multiMonitor: false, autoReconnect: true,
  },
  ...over,
});

const PASSWORD = 'Sup3r-Secret!pw';
const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

/* ------------------------------------------------ capability detection */

test('stock Ubuntu FreeRDP 2.6.1 is detected without AVC444', () => {
  const c = caps('freerdp-2.6.1-ubuntu.txt');
  assert.deepEqual(c.version, { major: 2, minor: 6, patch: 1 });
  assert.equal(c.avc444, false, 'this build has WITH_GFX_H264=OFF');
  assert.equal(c.gfx, true);
  assert.equal(c.fromStdinForce, true);
  assert.equal(c.certFingerprint, true);
  assert.equal(c.networkAuto, true);
  assert.equal(c.sound, 'pulse');
  assert.equal(c.plusClipboard, true);
});

test('FreeRDP 3 lists AVC444 in its help even without H.264 — detection is not fooled', () => {
  const c = caps('freerdp-3.31.0-ubuntu-24.04.txt');
  assert.equal(c.version.major, 3);
  assert.match(fixture('freerdp-3.31.0-ubuntu-24.04.txt').help, /AVC444/);
  assert.equal(c.avc444, false);
  assert.equal(c.gfx, true);
  assert.equal(c.fromStdinForce, true, '"/from-stdin[: force]" (with a space) was not recognised');
  assert.equal(c.certFingerprint, true, '"/cert: [..fingerprint" (with a space) was not recognised');
  assert.equal(c.networkAuto, true);
  assert.equal(c.sound, 'pulse');
});

test('AVC444 is used only when the H.264 decoder is compiled in', () => {
  const f = fixture('freerdp-2.6.1-ubuntu.txt');
  const withH264 = parseFreeRdpCapabilities(f.version, f.help.replace('/gfx[:RFX]', '/gfx[:[RFX|AVC444]]'),
    f.build.replace('WITH_GFX_H264=OFF', 'WITH_GFX_H264=ON'));
  assert.equal(withH264.avc444, true);
  assert.ok(buildRdpLaunch(conn(), withH264).args.includes('/gfx:AVC444'));
  assert.ok(!buildRdpLaunch(conn(), caps('freerdp-2.6.1-ubuntu.txt')).args.some(a => /AVC/i.test(a)));
});

test('audio falls back from PulseAudio to ALSA, and is dropped with a warning when neither exists', () => {
  const f = fixture('freerdp-2.6.1-ubuntu.txt');
  const alsaOnly = parseFreeRdpCapabilities(f.version, f.help, f.build.replace('WITH_PULSE=ON', 'WITH_PULSE=OFF'));
  assert.equal(alsaOnly.sound, 'alsa');
  const none = parseFreeRdpCapabilities(f.version, f.help,
    f.build.replace('WITH_PULSE=ON', 'WITH_PULSE=OFF').replace('WITH_ALSA=ON', 'WITH_ALSA=OFF'));
  assert.equal(none.sound, null);

  const c = conn({ options: { ...conn().options, enableAudio: true } });
  assert.ok(buildRdpLaunch(c, alsaOnly).args.includes('/sound:sys:alsa'));
  const plan = buildRdpLaunch(c, none);
  assert.ok(!plan.args.some(a => a.startsWith('/sound')));
  assert.match(plan.warnings.join(), /audio is unavailable/i);
});

/* --------------------------------------------------------- arguments */

for (const name of ['freerdp-2.6.1-ubuntu.txt', 'freerdp-3.31.0-ubuntu-24.04.txt']) {
  test(`${name}: the password is only ever on stdin, and credentials cannot be mis-prompted`, () => {
    const plan = buildRdpLaunch(conn(), caps(name), { password: PASSWORD });
    assert.ok(!plan.args.join('\0').includes(PASSWORD), 'the password appeared in argv');
    assert.ok(!plan.args.some(a => a.startsWith('/p:')));
    assert.equal(plan.stdin, `${PASSWORD}\n`);
    assert.ok(plan.args.includes('/from-stdin:force'), 'password must be read before connecting');
    assert.ok(plan.args.includes('/u:alice'));
    // Without /d:, FreeRDP prompts for a domain and that read swallows the password.
    assert.ok(plan.args.includes('/d:'), 'an empty domain must still be passed');
    assert.ok(!plan.args.some(a => /cert:ignore|cert-ignore/.test(a)), 'certificate checks were disabled');
  });
}

test('connection options map to FreeRDP flags for a stock FreeRDP 2', () => {
  const plan = buildRdpLaunch(conn({
    domain: 'CORP',
    options: {
      ...conn().options, scaling: 'fit', fullscreenOnConnect: true, multiMonitor: true,
      enableAudio: true, redirectFolder: '/home/user/Shared', colorDepth: 24,
    },
  }), caps('freerdp-2.6.1-ubuntu.txt'), { pathExists: () => true });
  const a = plan.args;
  for (const flag of ['/v:win.example:3389', '/d:CORP', '/smart-sizing', '/f', '/multimon',
    '/sound:sys:pulse', '/drive:home,/home/user/Shared', '/bpp:24', '/gfx', '/network:auto', '+clipboard']) {
    assert.ok(a.includes(flag), `missing ${flag} in ${a.join(' ')}`);
  }
  assert.deepEqual(plan.warnings, []);
});

test('unsupported options degrade to warnings instead of failing the connection', () => {
  const limited = {
    ...BASELINE_RDP_CAPABILITIES, smartSizing: false, multimon: false, drive: false, certFingerprint: false,
  };
  const plan = buildRdpLaunch(conn({
    options: { ...conn().options, scaling: 'fit', multiMonitor: true, redirectFolder: '/x' },
  }), limited, { trustedFingerprint: FP });
  assert.ok(!plan.args.includes('/smart-sizing'));
  assert.ok(!plan.args.includes('/multimon'));
  assert.ok(!plan.args.some(a => a.startsWith('/drive') || a.startsWith('/cert')));
  assert.equal(plan.warnings.length, 4, plan.warnings.join('\n'));
});

test('a shared folder that does not exist is skipped with a warning', () => {
  const plan = buildRdpLaunch(conn({ options: { ...conn().options, redirectFolder: '/nope/missing' } }),
    BASELINE_RDP_CAPABILITIES, { pathExists: () => false });
  assert.ok(!plan.args.some(a => a.startsWith('/drive')));
  assert.match(plan.warnings[0], /does not exist/);
});

test('a trusted certificate is pinned by fingerprint, in the form FreeRDP accepts', () => {
  const plan = buildRdpLaunch(conn(), BASELINE_RDP_CAPABILITIES, { trustedFingerprint: FP });
  assert.ok(plan.args.includes(`/cert:fingerprint:sha256:${FP.toLowerCase()}`));
  assert.equal(normalizeFingerprint(FP.replace(/:/g, '')), FP.toLowerCase());
  assert.throws(() => normalizeFingerprint('ab:cd'), /64 hex digits/);
});

test('IPv6 addresses are bracketed so the port is not misread', () => {
  assert.ok(buildRdpLaunch(conn({ host: 'fe80::1' }), BASELINE_RDP_CAPABILITIES).args.includes('/v:[fe80::1]:3389'));
});

test('clipboard is disabled for view-only and when sharing is off', () => {
  for (const o of [{ viewOnly: true }, { shareClipboard: false }]) {
    const a = buildRdpLaunch(conn({ options: { ...conn().options, ...o } }), BASELINE_RDP_CAPABILITIES).args;
    assert.ok(a.includes('-clipboard') && !a.includes('+clipboard'));
  }
});

test('a password containing a line break is refused rather than truncated', () => {
  assert.throws(() => buildRdpLaunch(conn(), BASELINE_RDP_CAPABILITIES, { password: 'a\nb' }), /line break/);
});

test('the installed FreeRDP accepts every flag HopDesk generates for it', async t => {
  const binary = await rdpAvailable();
  if (!binary) { t.skip('FreeRDP is not installed'); return; }
  const detected = await detectFreeRdpCapabilities(binary);
  const plan = buildRdpLaunch(conn({
    host: '127.0.0.1', port: 9, domain: 'CORP',
    options: { ...conn().options, enableAudio: true, multiMonitor: true, fullscreenOnConnect: false, redirectFolder: tmpdir() },
  }), detected, { password: PASSWORD, trustedFingerprint: FP });

  // Port 9 (discard) is closed: FreeRDP parses the command line, fails to
  // connect, and exits. A rejected flag instead prints the usage text.
  const out = await new Promise(resolve => {
    const child = spawn(binary, plan.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':0' } });
    let text = '';
    child.stdout.on('data', d => { text += d; });
    child.stderr.on('data', d => { text += d; });
    child.stdin.end(plan.stdin);
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('exit', () => { clearTimeout(timer); resolve(text); });
  });
  assert.doesNotMatch(out, /More documentation is coming|Usage:/, `FreeRDP rejected the generated command line:\n${plan.args.join(' ')}`);
  assert.ok(!out.includes(PASSWORD), 'FreeRDP echoed the password');
});

/* ------------------------------------------------- engine and process */

/** A stand-in for xfreerdp that records how it was started. */
function fakeFreeRdp(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-fakerdp-'));
  const bin = path.join(dir, 'xfreerdp');
  writeFileSync(bin, `#!/bin/sh\nDIR="${dir}"\n${script}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir, read: f => existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : '' };
}

const waitState = (engine, wanted, ms = 8000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ${wanted.join('/')} state`)), ms);
  engine.on('state', e => { if (wanted.includes(e.state)) { clearTimeout(timer); resolve(e); } });
});

test('a running FreeRDP never has the password in /proc/<pid>/cmdline, only on stdin', async () => {
  const fake = fakeFreeRdp(`
    printf '%s\\n' "$@" > "$DIR/argv"
    IFS= read -r line; printf '%s' "$line" > "$DIR/stdin"
    touch "$DIR/ready"
    sleep 5`);
  const engine = new ExternalEngine(conn(), PASSWORD, {
    binary: fake.bin, capabilities: BASELINE_RDP_CAPABILITIES, settleMs: 300,
  });
  const running = waitState(engine, ['running']);
  await engine.start();
  await running;

  const cmdline = readFileSync(`/proc/${engine.pid}/cmdline`, 'utf8');
  assert.ok(cmdline.includes('/from-stdin:force'), `unexpected command line: ${cmdline}`);
  assert.ok(!cmdline.includes(PASSWORD), 'the password is visible in /proc/<pid>/cmdline');
  assert.ok(!fake.read('argv').includes(PASSWORD));
  assert.equal(fake.read('stdin'), PASSWORD, 'the password did not arrive on stdin');

  const exited = waitState(engine, ['exited']);
  engine.stop();
  assert.equal((await exited).state, 'exited');
});

test('FreeRDP errors become actionable messages, with the password redacted from logs', async () => {
  const fake = fakeFreeRdp(`
    IFS= read -r line
    echo "[ERROR][com.freerdp.core] - debug echo of input: $line" >&2
    echo "[ERROR][com.freerdp.core] - nla_recv_pdu:freerdp_set_last_error_ex ERRCONNECT_LOGON_FAILURE [0x00020014]" >&2
    exit 131`);
  const engine = new ExternalEngine(conn(), PASSWORD, { binary: fake.bin, capabilities: BASELINE_RDP_CAPABILITIES, settleMs: 2000 });
  const logs = [];
  engine.on('log', l => logs.push(l));
  const failed = waitState(engine, ['failed']);
  const states = [];
  engine.on('state', e => states.push(e.state));
  await engine.start();
  const event = await failed;

  assert.equal(event.errorCode, 'ERRCONNECT_LOGON_FAILURE');
  assert.match(event.message, /username or password was not accepted/);
  assert.ok(!states.includes('running'), 'a failed logon was reported as connected');
  assert.ok(logs.length >= 2);
  assert.ok(logs.every(l => !l.includes(PASSWORD)), 'the password reached the log');
  assert.ok(logs.some(l => l.includes('********')));
  assert.ok(engine.recentLog.every(l => !l.includes(PASSWORD)));
});

test('a FreeRDP that hangs after a fatal error is killed and reported', async () => {
  const fake = fakeFreeRdp(`
    echo "[ERROR][com.freerdp.core] - transport_connect_tls:freerdp_set_last_error_ex ERRCONNECT_TLS_CONNECT_FAILED [0x00020008]" >&2
    exec sleep 60`);
  const engine = new ExternalEngine(conn(), null, {
    binary: fake.bin, capabilities: BASELINE_RDP_CAPABILITIES, settleMs: 5000, hangKillMs: 300,
  });
  const failed = waitState(engine, ['failed'], 5000);
  const t0 = Date.now();
  await engine.start();
  const event = await failed;
  assert.ok(Date.now() - t0 < 4000, 'the hung process was not killed promptly');
  assert.equal(event.errorCode, 'ERRCONNECT_TLS_CONNECT_FAILED');
  assert.match(event.message, /certificate/);
});

test('error names are recognised in real FreeRDP log lines', () => {
  assert.equal(rdpErrorIn('[09:41:44:109] [1:2] [ERROR][com.freerdp.core] - freerdp_set_last_error_ex ERRCONNECT_CONNECT_TRANSPORT_FAILED [0x0002000D]'),
    'ERRCONNECT_CONNECT_TRANSPORT_FAILED');
  assert.equal(rdpErrorIn('[INFO][com.freerdp.core] - ERRCONNECT_SUCCESS'), null);
  assert.equal(rdpErrorIn('nothing to see'), null);
  const c = { host: 'pc', port: 3389 };
  assert.match(explainRdpError('ERRCONNECT_CONNECT_TRANSPORT_FAILED', c), /Remote Desktop is turned on/);
  assert.match(explainRdpError('ERRCONNECT_DNS_NAME_NOT_FOUND', c), /could not be found/);
  assert.match(explainRdpError('ERRCONNECT_INSUFFICIENT_PRIVILEGES', c), /Remote Desktop Users/);
  assert.match(explainRdpError('ERRCONNECT_SOMETHING_NEW', c), /ERRCONNECT_SOMETHING_NEW/);
});

test('a dropped connection from a server that was reachable points at sign-in, not the firewall', () => {
  // Observed with FreeRDP's own NLA server: a wrong password is answered by
  // closing the connection, which the client reports as a transport failure.
  const c = { host: 'pc', port: 3389 };
  assert.match(explainRdpError('ERRCONNECT_CONNECT_TRANSPORT_FAILED', c, { reachable: true }), /during sign-in.*username and password/);
  assert.match(explainRdpError('ERRCONNECT_CONNECT_TRANSPORT_FAILED', c, { reachable: false }), /firewall/);
  assert.match(explainRdpError('ERRCONNECT_CONNECT_TRANSPORT_FAILED', c), /firewall/);
});

/* ------------------------------------------------------- certificates */

function selfSignedCert(t) {
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=rdp-test-host', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
    { stdio: 'ignore' });
    return { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) };
  } catch {
    t.skip('openssl is not available to create a test certificate');
    return null;
  }
}

/** Answers X.224 negotiation like an RDP server, then speaks TLS. */
async function fakeRdpServer({ key, cert, negotiation = 'tls' }) {
  const server = createServer(socket => {
    socket.once('data', () => {
      if (negotiation === 'legacy') {
        socket.write(Buffer.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0x12, 0x34, 0]));
        return;
      }
      socket.write(Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, 0x02, 0x00, 0x08, 0x00, 0x01, 0, 0, 0]));
      const tls = new TLSSocket(socket, { isServer: true, key, cert });
      tls.on('error', () => {});
    });
    socket.on('error', () => {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}

test('the certificate is read through RDP negotiation, and self-signed is not trusted', async t => {
  const pair = selfSignedCert(t);
  if (!pair) return;
  const server = await fakeRdpServer(pair);
  const probe = await probeRdpCertificate('127.0.0.1', server.address().port);
  server.close();

  assert.equal(probe.kind, 'tls', JSON.stringify(probe));
  const expected = normalizeFingerprint(new X509Certificate(pair.cert).fingerprint256);
  assert.equal(probe.certificate.fingerprint, expected);
  assert.match(probe.certificate.subject, /CN = rdp-test-host/);
  assert.equal(probe.certificate.trusted, false);
  assert.ok(probe.certificate.trustError);
});

test('legacy servers and unreachable hosts are reported, not misparsed', async () => {
  const legacy = await fakeRdpServer({ negotiation: 'legacy' });
  const r1 = await probeRdpCertificate('127.0.0.1', legacy.address().port);
  legacy.close();
  assert.equal(r1.kind, 'no-tls');

  const r2 = await probeRdpCertificate('127.0.0.1', 9, 2000);
  assert.equal(r2.kind, 'unreachable');
});

test('certificate decisions: ask on first sight and on change, pin once trusted, verify CA certificates', () => {
  const cert = fp => ({ kind: 'tls', certificate: { fingerprint: fp, subject: '', issuer: '', validFrom: '', validTo: '', trusted: false, trustError: 'self signed' } });
  const lower = FP.toLowerCase();
  const other = lower.replace(/^ab/, 'ff');

  assert.deepEqual(decideRdpCertificate(cert(lower), null).action, 'ask');
  assert.equal(decideRdpCertificate(cert(lower), null).reason, 'untrusted');
  assert.deepEqual(decideRdpCertificate(cert(lower), FP), { action: 'pin', fingerprint: lower });

  const changed = decideRdpCertificate(cert(other), FP);
  assert.equal(changed.action, 'ask');
  assert.equal(changed.reason, 'changed', 'a changed certificate must never be silently accepted');
  assert.equal(changed.previousFingerprint, lower);

  const ca = { kind: 'tls', certificate: { ...cert(lower).certificate, trusted: true, trustError: null } };
  assert.deepEqual(decideRdpCertificate(ca, null), { action: 'verify' });
  assert.deepEqual(decideRdpCertificate({ kind: 'unreachable', reason: 'x' }, null), { action: 'verify' });
  assert.deepEqual(decideRdpCertificate({ kind: 'unreachable', reason: 'x' }, FP), { action: 'pin', fingerprint: lower });
});

/* ------------------------------------------- live server (opt-in) */

/*
 * Set HOPDESK_RDP_TEST="host:port:user:password" to run against a real RDP
 * server, e.g. a Windows PC or the xrdp container described in README.md.
 * Needs a display for the FreeRDP window.
 */
test('connects to a real RDP server with a pinned certificate and a stdin password', async t => {
  const spec = process.env.HOPDESK_RDP_TEST;
  if (!spec) { t.skip('set HOPDESK_RDP_TEST=host:port:user:password to run'); return; }
  const [host, port, username, ...rest] = spec.split(':');
  const password = rest.join(':');

  const probe = await probeRdpCertificate(host, Number(port));
  assert.equal(probe.kind, 'tls', JSON.stringify(probe));

  const engine = new ExternalEngine(conn({ host, port: Number(port), username }), password,
    { trustedFingerprint: probe.certificate.fingerprint, settleMs: 4000 });
  const states = [];
  engine.on('state', e => states.push(e));
  await engine.start();
  assert.equal(states.at(-1).state, 'running', JSON.stringify(states) + '\n' + engine.recentLog.join('\n'));
  assert.ok(!readFileSync(`/proc/${engine.pid}/cmdline`, 'utf8').includes(password));
  engine.stop();
  await new Promise(r => setTimeout(r, 1000));
});

/* ------------------------------------ monitors, resolution, reconnect */

import { parseMonitorList } from '../dist/index.js';

test('monitor, resolution and reconnect flags are detected in both FreeRDP generations', () => {
  const v2 = caps('freerdp-2.6.1-ubuntu.txt');
  assert.equal(v2.monitorList, '/monitor-list');
  assert.equal(v2.dynamicResolution, '/dynamic-resolution');
  assert.ok(v2.selectMonitors && v2.autoReconnect && v2.title && v2.wmClass && v2.size);

  const v3 = caps('freerdp-3.31.0-ubuntu-24.04.txt');
  assert.equal(v3.monitorList, '/list:monitor', 'FreeRDP 3 lists monitors with /list:monitor');
  assert.equal(v3.dynamicResolution, '+dynamic-resolution', 'FreeRDP 3 spells it +dynamic-resolution');
  assert.ok(v3.selectMonitors && v3.autoReconnect && v3.title && v3.wmClass && v3.size);
});

test('FreeRDP monitor listings are parsed, including the primary marker', () => {
  // Format from xf_monitor.c: "      %s [%d] %dx%d\t+%d+%d\n", "*" marking the primary.
  const text = '      * [0] 2560x1440\t+0+0\n        [1] 1920x1080\t+2560+180\n        [2] 1080x1920\t+-1080+0\n';
  assert.deepEqual(parseMonitorList(text), [
    { id: 0, width: 2560, height: 1440, x: 0, y: 0, primary: true },
    { id: 1, width: 1920, height: 1080, x: 2560, y: 180, primary: false },
    { id: 2, width: 1080, height: 1920, x: -1080, y: 0, primary: false },
  ]);
  assert.deepEqual(parseMonitorList('failed to open display'), []);
});

test('multi-monitor: all monitors, or only the chosen ones', () => {
  const v2 = caps('freerdp-2.6.1-ubuntu.txt');
  const all = buildRdpLaunch(conn({ options: { ...conn().options, multiMonitor: true } }), v2).args;
  assert.ok(all.includes('/multimon'));
  assert.ok(!all.some(a => a.startsWith('/monitors:')));
  assert.ok(!all.some(a => a.startsWith('/size:') || /dynamic-resolution/.test(a)), 'a window size makes no sense across monitors');

  const chosen = buildRdpLaunch(conn({ options: { ...conn().options, multiMonitor: true, monitors: [0, 2] } }), v2);
  assert.ok(chosen.args.includes('/monitors:0,2'));
  const noSelect = buildRdpLaunch(conn({ options: { ...conn().options, multiMonitor: true, monitors: [1] } }),
    { ...v2, selectMonitors: false });
  assert.ok(noSelect.args.includes('/multimon') && !noSelect.args.some(a => a.startsWith('/monitors:')));
  assert.match(noSelect.warnings.join(), /cannot choose monitors/);
});

test('resolution: fit scales the image, fill resizes the remote desktop, never both', () => {
  const v3 = caps('freerdp-3.31.0-ubuntu-24.04.txt');
  const fit = buildRdpLaunch(conn(), v3, { windowSize: { width: 1600, height: 900 } }).args;
  assert.ok(fit.includes('/size:1600x900'));
  assert.ok(fit.includes('/smart-sizing') && !fit.includes('+dynamic-resolution'));

  const fill = buildRdpLaunch(conn({ options: { ...conn().options, scaling: 'fill' } }), v3,
    { windowSize: { width: 1600, height: 900 } }).args;
  assert.ok(fill.includes('+dynamic-resolution'));
  assert.ok(!fill.includes('/smart-sizing'), 'FreeRDP rejects smart sizing with dynamic resolution');

  // Without dynamic resolution, fill falls back to scaling rather than stretching.
  const noDyn = buildRdpLaunch(conn({ options: { ...conn().options, scaling: 'fill' } }), { ...v3, dynamicResolution: null }).args;
  assert.ok(noDyn.includes('/smart-sizing'));

  const none = buildRdpLaunch(conn({ options: { ...conn().options, scaling: 'none' } }), v3).args;
  assert.ok(!none.includes('/smart-sizing') && !none.includes('+dynamic-resolution'));

  const fixed = buildRdpLaunch(conn({ options: { ...conn().options, resolution: '1280x720' } }), v3,
    { windowSize: { width: 1600, height: 900 } }).args;
  assert.ok(fixed.includes('/size:1280x720'));
  assert.ok(!fixed.includes('/size:1600x900') && !fixed.includes('+dynamic-resolution'));

  const full = buildRdpLaunch(conn({ options: { ...conn().options, fullscreenOnConnect: true } }), v3,
    { windowSize: { width: 1600, height: 900 } }).args;
  assert.ok(full.includes('/f') && !full.some(a => a.startsWith('/size:')));

  // A malformed stored value is ignored rather than passed to FreeRDP.
  const bad = buildRdpLaunch(conn({ options: { ...conn().options, resolution: '99999x1; rm -rf' } }), v3).args;
  assert.ok(!bad.some(a => a.includes('rm -rf')));
});

test('the session window is titled after the connection and grouped with HopDesk', () => {
  const a = buildRdpLaunch(conn({ name: 'Office PC' }), caps('freerdp-2.6.1-ubuntu.txt')).args;
  assert.ok(a.includes('/t:Office PC'));
  assert.ok(a.includes('/wm-class:HopDesk'));
});

test('FreeRDP reconnects a dropped session itself only when auto-reconnect is on', () => {
  const on = buildRdpLaunch(conn(), caps('freerdp-2.6.1-ubuntu.txt')).args;
  assert.ok(on.includes('+auto-reconnect'));
  assert.ok(on.includes('/auto-reconnect-max-retries:10'));
  const off = buildRdpLaunch(conn({ options: { ...conn().options, autoReconnect: false } }), caps('freerdp-2.6.1-ubuntu.txt')).args;
  assert.ok(!off.some(a => a.includes('auto-reconnect')));
});

test('the installed FreeRDP accepts the single-monitor flag set too', async t => {
  const binary = await rdpAvailable();
  if (!binary) { t.skip('FreeRDP is not installed'); return; }
  const detected = await detectFreeRdpCapabilities(binary);
  for (const scaling of ['fit', 'fill', 'none']) {
  const plan = buildRdpLaunch(conn({ host: '127.0.0.1', port: 9, name: 'Flag check', options: { ...conn().options, scaling } }), detected,
    { password: PASSWORD, windowSize: { width: 1200, height: 800 } });
  const out = await new Promise(resolve => {
    const child = spawn(binary, plan.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', d => { text += d; });
    child.stderr.on('data', d => { text += d; });
    child.stdin.end(plan.stdin);
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('exit', () => { clearTimeout(timer); resolve(text); });
  });
  assert.doesNotMatch(out, /More documentation is coming|Usage:/, `rejected:\n${plan.args.join(' ')}`);
  }
});

/*
 * Set HOPDESK_RDP_NLA_TEST="host:port:user:password" to run against an RDP
 * server that requires Network Level Authentication, e.g. the FreeRDP NLA
 * container in test-servers/freerdp-nla. Needs a display.
 */
test('NLA server: a wrong password is reported as a sign-in problem; the right one connects and stops cleanly', async t => {
  const spec = process.env.HOPDESK_RDP_NLA_TEST;
  if (!spec) { t.skip('set HOPDESK_RDP_NLA_TEST=host:port:user:password to run'); return; }
  const [host, port, username, ...rest] = spec.split(':');
  const password = rest.join(':');
  const probe = await probeRdpCertificate(host, Number(port));
  assert.equal(probe.kind, 'tls', JSON.stringify(probe));
  const target = conn({ host, port: Number(port), username });
  const opts = { trustedFingerprint: probe.certificate.fingerprint, reachable: true, settleMs: 4000 };

  const wrong = new ExternalEngine(target, 'definitely-not-the-password', opts);
  const failed = new Promise(r => wrong.on('state', e => { if (e.state === 'failed') r(e); }));
  await wrong.start();
  const event = await Promise.race([failed, new Promise((_, rej) => setTimeout(() => rej(new Error('no failure for a wrong password')), 15_000))]);
  assert.equal(event.error.category, 'auth-failed', JSON.stringify(event));
  assert.doesNotMatch(event.error.message, /firewall/i);
  assert.ok(wrong.recentLog.every(l => !l.includes('definitely-not-the-password')));

  const right = new ExternalEngine(target, password, opts);
  const states = [];
  right.on('state', e => states.push(e.state));
  await right.start();
  assert.equal(states.at(-1), 'running', states.join(' > ') + '\n' + right.recentLog.join('\n'));
  const pid = right.pid;
  assert.ok(!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(password));
  const exited = new Promise(r => right.on('state', e => { if (e.state === 'exited') r(); }));
  right.stop();
  await exited;
  await new Promise(r => setTimeout(r, 300));
  assert.equal(existsSync(`/proc/${pid}`), false, 'FreeRDP was still running after stop()');
});
