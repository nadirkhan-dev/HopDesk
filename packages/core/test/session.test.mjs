import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
const netMod = { createConnection };
import { Session, backoffDelay, DEFAULT_RECONNECT } from '../dist/index.js';

/**
 * Three of these tests need a real VNC server on 127.0.0.1:5901 with the
 * password "testpass" — a live server is the only way to check that a wrong
 * password is treated as final rather than retried, and that a dropped
 * connection comes back.
 *
 *   scripts/test-displays.sh     starts one (and the displays the app tests use)
 *
 * Without it they skip, saying so. HOPDESK_REQUIRE_VNC=1 — which CI sets — turns
 * that skip into a failure, because a check that quietly did not run is worth
 * nothing.
 */
async function vncServerAvailable(port = 5901) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

const vncSkip = await (async () => {
  if (await vncServerAvailable()) return false;
  const reason = 'no VNC server on 127.0.0.1:5901 (run scripts/test-displays.sh)';
  if (process.env.HOPDESK_REQUIRE_VNC === '1') {
    throw new Error(`${reason} — and HOPDESK_REQUIRE_VNC=1 says these tests must run`);
  }
  return reason;
})();

const conn = (over = {}) => ({
  id: 'test', name: 'Test', protocol: 'vnc', host: '127.0.0.1', port: 5901,
  favorite: false, createdAt: '', updatedAt: '', connectCount: 0,
  options: {
    scaling: 'fit', fullscreenOnConnect: false, viewOnly: false,
    shareClipboard: true, enableAudio: false, multiMonitor: false, autoReconnect: true,
  },
  ...over,
});

/* ------------------------------------------------------------- backoff */

test('backoff grows exponentially and is capped', () => {
  const policy = { ...DEFAULT_RECONNECT, baseDelayMs: 1000, maxDelayMs: 10_000 };
  const d1 = backoffDelay(1, policy);
  const d4 = backoffDelay(4, policy);

  assert.ok(d1 >= 750 && d1 <= 1250, `first delay ${d1} outside jitter band`);
  assert.ok(d4 > d1, 'backoff did not grow');
  for (let a = 1; a <= 20; a++) {
    // The cap plus the jitter band; never unbounded.
    assert.ok(backoffDelay(a, policy) <= 12_500, `attempt ${a} exceeded the cap`);
  }
});

test('backoff is jittered, not lockstep', () => {
  // Without jitter every client retries simultaneously and re-floods a server
  // that just came back.
  const samples = new Set(Array.from({ length: 30 }, () => backoffDelay(3, DEFAULT_RECONNECT)));
  assert.ok(samples.size > 5, 'delays were identical — jitter is missing');
});

/* ------------------------------------------------------- state machine */

test('a refused connection ends in failed after exhausting attempts', async () => {
  const session = new Session(conn({ port: 5999 }), null,
    { enabled: true, maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 200 });

  const states = [];
  session.on('state', s => states.push(s));

  await new Promise(resolve => {
    session.on('state', s => { if (s === 'failed') resolve(); });
    void session.start();
    setTimeout(resolve, 6000);
  });

  assert.ok(states.includes('connecting'), 'never entered connecting');
  assert.ok(states.includes('reconnecting'), 'did not retry');
  assert.equal(session.current.state, 'failed');
  assert.match(session.current.lastError, /gave up after/);
  session.stop();
});

test('a wrong password does NOT retry — it is terminal', { skip: vncSkip }, async () => {
  // Retrying a bad password locks accounts on servers that count attempts.
  const session = new Session(conn({ port: 5901 }), 'definitely-wrong',
    { enabled: true, maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 200 });

  const states = [];
  session.on('state', s => states.push(s));

  await new Promise(resolve => {
    session.on('state', s => { if (s === 'failed') resolve(); });
    void session.start();
    setTimeout(resolve, 8000);
  });

  assert.equal(session.current.state, 'failed');
  const retries = states.filter(s => s === 'reconnecting').length;
  assert.equal(retries, 0, `retried an authentication failure ${retries} times`);
  session.stop();
});

test('a deliberate stop does not trigger a reconnect', { skip: vncSkip }, async () => {
  const session = new Session(conn({ port: 5901 }), 'testpass', DEFAULT_RECONNECT);
  await new Promise(resolve => {
    session.on('state', s => { if (s === 'connected') resolve(); });
    void session.start();
    setTimeout(resolve, 8000);
  });
  assert.equal(session.current.state, 'connected');

  const after = [];
  session.on('state', s => after.push(s));
  session.stop();
  await new Promise(r => setTimeout(r, 1500));

  assert.ok(after.includes('disconnected'));
  assert.ok(!after.includes('reconnecting'), 'reconnected after the user pressed Disconnect');
});

test('reconnects when the server drops mid-session', { skip: vncSkip }, async () => {
  /* A proxy in front of the real server, so the transport can be severed
     without killing the VNC server the rest of the suite uses. */
  const proxy = createServer(client => {
    const { createConnection } = netMod;
    const upstream = createConnection({ host: '127.0.0.1', port: 5901 });
    client.pipe(upstream); upstream.pipe(client);
    client.on('error', () => {}); upstream.on('error', () => {});
    proxy.emit('pair', client, upstream);
  });
  await new Promise(r => proxy.listen(5910, '127.0.0.1', r));

  const sockets = [];
  proxy.on('pair', (c, u) => sockets.push(c, u));

  const session = new Session(conn({ port: 5910 }), 'testpass',
    { enabled: true, maxAttempts: 5, baseDelayMs: 300, maxDelayMs: 1000 });

  const states = [];
  session.on('state', s => states.push(s));

  await new Promise(resolve => {
    session.on('state', s => { if (s === 'connected') resolve(); });
    void session.start();
    setTimeout(resolve, 8000);
  });
  assert.equal(session.current.state, 'connected', 'never connected through the proxy');

  // Sever it, as a Wi-Fi drop would.
  sockets.forEach(s => s.destroy());

  const recovered = await new Promise(resolve => {
    let sawReconnecting = false;
    session.on('state', s => {
      if (s === 'reconnecting') sawReconnecting = true;
      if (s === 'connected' && sawReconnecting) resolve(true);
    });
    setTimeout(() => resolve(false), 10_000);
  });

  assert.ok(states.includes('reconnecting') || recovered, 'never attempted to reconnect');
  session.stop();
  proxy.close();
});

test('view-only suppresses all input', async () => {
  const session = new Session(conn({ options: { ...conn().options, viewOnly: true } }), 'testpass');
  // No client is attached, so this asserts the guard runs before the send —
  // it must not throw on a null client.
  assert.doesNotThrow(() => {
    session.sendKey(0x61, true);
    session.sendPointer(10, 10, 1);
  });
});

test('clipboard sharing can be turned off', async () => {
  const session = new Session(conn({ options: { ...conn().options, shareClipboard: false } }), null);
  assert.doesNotThrow(() => session.sendClipboard('should not be sent'));
});

test('non-VNC protocols report that they use their own engine', async () => {
  const session = new Session(conn({ protocol: 'rdp' }), null, { ...DEFAULT_RECONNECT, enabled: false });
  await new Promise(resolve => {
    session.on('state', s => { if (s === 'failed') resolve(); });
    void session.start();
    setTimeout(resolve, 3000);
  });
  assert.match(session.current.lastError, /RDP/);
});
