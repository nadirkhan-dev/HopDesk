import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVncError, classifyRdpError } from '../dist/index.js';

const c = { host: 'office-pc', port: 5900 };
const TECHNICAL = /ECONN|ERRCONNECT|errno|exit code|xfreerdp|RFB|decoder|0x/i;

test('VNC failures map to the category a UI acts on, with no jargon in title or message', () => {
  const cases = [
    ['connect ECONNREFUSED 10.0.0.5:5900', 'refused'],
    ['getaddrinfo ENOTFOUND office-pc', 'unreachable'],
    ['connect EHOSTUNREACH 10.0.0.5:5900', 'unreachable'],
    ['No response from office-pc:5900 after 12000ms', 'timeout'],
    ['connect ETIMEDOUT 10.0.0.5:5900', 'timeout'],
    ['This server needs a password', 'auth-required'],
    ['Authentication failed: Authentication failure', 'auth-failed'],
    ['Authentication failed — check the password', 'auth-failed'],
    ['No supported authentication method. The server offers: Apple Remote Desktop', 'unsupported'],
    ['No supported authentication method. The server offers: VeNCrypt', 'unsupported'],
    ['Not a VNC server — it replied "HTTP/1.1 200 OK"', 'unsupported'],
    ['The server closed the connection during the handshake', 'closed-by-remote'],
    ['read ECONNRESET', 'network-lost'],
    ['The connection closed', 'network-lost'],
    ['Unexpected message type 77 from server', 'unknown'],
  ];
  for (const [raw, category] of cases) {
    const e = classifyVncError(raw, c);
    assert.equal(e.category, category, raw);
    assert.equal(e.detail, raw, 'the technical text must be kept for diagnostics');
    assert.doesNotMatch(`${e.title} ${e.message}`, TECHNICAL, `jargon shown to the user for: ${raw}`);
  }
});

test('a Mac with VNC password access turned off gets instructions, not a protocol name', () => {
  const e = classifyVncError('No supported authentication method. The server offers: Apple Remote Desktop', c);
  assert.match(e.message, /VNC viewers may control screen with password/);
});

test('RDP failures map to categories, and authentication is never blamed on the firewall', () => {
  const rdp = { host: 'office-pc', port: 3389 };
  const cases = [
    ['ERRCONNECT_LOGON_FAILURE', 'auth-failed'],
    ['ERRCONNECT_AUTHENTICATION_FAILED', 'auth-failed'],
    ['ERRCONNECT_PASSWORD_EXPIRED', 'account-restricted'],
    ['ERRCONNECT_ACCOUNT_LOCKED_OUT', 'account-restricted'],
    ['ERRCONNECT_INSUFFICIENT_PRIVILEGES', 'account-restricted'],
    ['ERRCONNECT_TLS_CONNECT_FAILED', 'certificate-rejected'],
    ['ERRCONNECT_DNS_NAME_NOT_FOUND', 'unreachable'],
    ['ERRCONNECT_SECURITY_NEGO_CONNECT_FAILED', 'unsupported'],
    ['ERRCONNECT_SOMETHING_NEW', 'unknown'],
  ];
  for (const [code, category] of cases) {
    const e = classifyRdpError(code, rdp);
    assert.equal(e.category, category, code);
    assert.equal(e.detail, code);
    assert.doesNotMatch(`${e.title} ${e.message}`, TECHNICAL, `jargon shown to the user for: ${code}`);
    if (category === 'auth-failed') assert.doesNotMatch(e.message, /firewall/i);
  }
  // A dropped connection from a server just shown to be reachable is a sign-in problem.
  const reachable = classifyRdpError('ERRCONNECT_CONNECT_TRANSPORT_FAILED', rdp, { reachable: true });
  assert.equal(reachable.category, 'auth-failed');
  assert.match(reachable.message, /Remote Desktop is enabled and that the username and password are correct/);
  assert.equal(classifyRdpError('ERRCONNECT_CONNECT_TRANSPORT_FAILED', rdp, { reachable: false }).category, 'unreachable');
  // No error name, only an exit code: still a sentence, with the code kept as detail.
  const exit = classifyRdpError(null, rdp, { exitCode: 131 });
  assert.doesNotMatch(`${exit.title} ${exit.message}`, TECHNICAL);
  assert.match(exit.detail, /131/);
});

/* ------------------------------------------- errors reach session state */

import { Session, ExternalEngine, BASELINE_RDP_CAPABILITIES } from '../dist/index.js';
import { startFakeRfbServer } from './helpers/fake-rfb-server.mjs';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const vncConn = port => ({
  id: 'e', name: 'E', protocol: 'vnc', host: '127.0.0.1', port, favorite: false, createdAt: '', updatedAt: '', connectCount: 0,
  options: { scaling: 'fit', fullscreenOnConnect: false, viewOnly: false, shareClipboard: true, enableAudio: false, multiMonitor: false, autoReconnect: false },
});

const failedState = session => new Promise(resolve => {
  session.on('state', (s, stats) => { if (s === 'failed') resolve(stats); });
});

test('a session that fails carries the classified error in its state', async () => {
  const refused = new Session(vncConn(9), null, { enabled: false, maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 });
  const p1 = failedState(refused);
  await refused.start();
  assert.equal((await p1).error.category, 'refused');

  const server = await startFakeRfbServer({ securityTypes: [2], password: 'right-one' });
  const wrong = new Session(vncConn(server.port), 'wrong-one');
  const p2 = failedState(wrong);
  await wrong.start();
  const stats = await p2;
  assert.equal(stats.error.category, 'auth-failed');
  assert.ok(!JSON.stringify(stats).includes('wrong-one'), 'the password leaked into session state');
  await server.close();
});

test('a failed RDP engine carries the classified error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-err-'));
  const bin = path.join(dir, 'xfreerdp');
  writeFileSync(bin, '#!/bin/sh\necho "[ERROR] - freerdp_set_last_error_ex ERRCONNECT_ACCOUNT_LOCKED_OUT [0x0002000F]" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  const engine = new ExternalEngine({ ...vncConn(3389), protocol: 'rdp', username: 'u' }, 'pw-not-logged', {
    binary: bin, capabilities: BASELINE_RDP_CAPABILITIES, settleMs: 1500,
  });
  const failed = new Promise(r => engine.on('state', e => { if (e.state === 'failed') r(e); }));
  await engine.start();
  const e = await failed;
  assert.equal(e.error.category, 'account-restricted');
  assert.equal(e.error.title, 'Account locked');
});
