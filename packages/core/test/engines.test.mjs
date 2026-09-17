import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalEngine, rdpAvailable, spiceAvailable, explainRdpExit } from '../dist/index.js';

const conn = (over = {}) => ({
  id: 'e', name: 'Engine Test', protocol: 'rdp', host: '127.0.0.1', port: 3389,
  favorite: false, createdAt: '', updatedAt: '', connectCount: 0,
  options: {
    scaling: 'fit', fullscreenOnConnect: false, viewOnly: false, shareClipboard: true,
    enableAudio: false, colorDepth: 32, multiMonitor: false, autoReconnect: true,
  },
  ...over,
});

test('FreeRDP is detected when installed', async () => {
  const binary = await rdpAvailable();
  assert.ok(binary, 'no FreeRDP binary found — RDP will not work on this machine');
});

test('a missing SPICE viewer is reported, not crashed on', async () => {
  const binary = await spiceAvailable();
  // virt-viewer may legitimately be absent; the contract is that we say so.
  assert.ok(binary === null || typeof binary === 'string');
});

test('RDP exit codes become sentences a user can act on', () => {
  assert.match(explainRdpExit(131), /username or password/i);
  assert.match(explainRdpExit(0x10008), /Could not reach/i);
  assert.match(explainRdpExit(0x2000c), /Remote Desktop Users/i);
  assert.match(explainRdpExit(0), /ended normally/i);
  // An unknown code still produces something readable rather than "undefined".
  assert.match(explainRdpExit(9999), /9999/);
  assert.match(explainRdpExit(null), /stopped unexpectedly/i);
});

test('the password is NEVER placed in the argument list', async () => {
  const engine = new ExternalEngine(conn({ username: 'admin' }), 'super-secret-password');
  // Reach the private builder the way the engine does, to assert on real args.
  const args = engine.rdpArgs ? engine.rdpArgs() : (engine['rdpArgs'])();

  const joined = args.join(' ');
  assert.ok(!joined.includes('super-secret-password'),
    'the password appeared in argv, where /proc makes it world-readable');
  // `:force` specifically: without it FreeRDP reads the password only on
  // server request, after prompts whose buffered reads can swallow it.
  assert.ok(args.includes('/from-stdin:force'), 'FreeRDP was not told to read the password from stdin before connecting');
  assert.ok(joined.includes('/u:admin'), 'the username was not passed');
});

test('connection options map to real FreeRDP flags', () => {
  const engine = new ExternalEngine(conn({
    options: {
      ...conn().options,
      scaling: 'fit', fullscreenOnConnect: true, multiMonitor: true,
      enableAudio: true, redirectFolder: '/home/user/Shared', colorDepth: 24,
    },
  }), null);
  const args = (engine['rdpArgs'])().join(' ');

  assert.match(args, /\/smart-sizing/);
  assert.match(args, /\/f\b/);
  assert.match(args, /\/multimon/);
  assert.match(args, /\/sound:sys:pulse/);
  assert.match(args, /\/drive:home,\/home\/user\/Shared/);
  assert.match(args, /\/bpp:24/);
});

test('clipboard sharing can be disabled', () => {
  const on = new ExternalEngine(conn(), null);
  const off = new ExternalEngine(conn({
    options: { ...conn().options, shareClipboard: false },
  }), null);

  assert.ok((on['rdpArgs'])().includes('+clipboard'));
  assert.ok((off['rdpArgs'])().includes('-clipboard'));
});

test('a missing binary fails with an installable instruction', async () => {
  const engine = new ExternalEngine(conn({ protocol: 'spice' }), null);
  const events = [];
  engine.on('state', e => events.push(e));

  const available = await spiceAvailable();
  if (available) return;                      // nothing to assert on this machine

  await assert.rejects(() => engine.start());
  const failure = events.find(e => e.state === 'failed');
  assert.ok(failure, 'no failure event was emitted');
  assert.match(failure.message, /virt-viewer/, 'the message does not say what to install');
});

test('starting against a dead port fails and explains why', async () => {
  const engine = new ExternalEngine(conn({ port: 3399 }), null);
  const events = [];
  engine.on('state', e => events.push(e));

  await engine.start().catch(() => {});
  // FreeRDP takes a moment to give up on a closed port.
  await new Promise(r => setTimeout(r, 6000));
  engine.stop();

  const terminal = events.find(e => e.state === 'failed' || e.state === 'exited');
  assert.ok(terminal, `no terminal state; saw ${events.map(e => e.state).join(', ')}`);
  if (terminal.message) assert.ok(terminal.message.length > 10, 'error message was not useful');
});
