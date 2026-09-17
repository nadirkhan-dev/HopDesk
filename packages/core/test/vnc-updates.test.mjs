import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RfbClient, Session, decodeRre, explainVncError, SUPPORTED_ENCODINGS } from '../dist/index.js';
import {
  startFakeRfbServer, update, rawRect, copyRect, rreRect, hextileRect, hextileTile,
  desktopSize, serverCutText, applyRects, rgbaAt,
} from './helpers/fake-rfb-server.mjs';

/**
 * Framebuffer updates, encodings, the update loop and reconnect, against a
 * scripted in-process RFB server. These need no external VNC server.
 */

const conn = (port, over = {}) => ({
  id: 'fake', name: 'Fake', protocol: 'vnc', host: '127.0.0.1', port,
  favorite: false, createdAt: '', updatedAt: '', connectCount: 0,
  options: {
    scaling: 'fit', fullscreenOnConnect: false, viewOnly: false,
    shareClipboard: true, enableAudio: false, multiMonitor: false, autoReconnect: true,
  },
  ...over,
});

const until = (fn, ms = 5000, what = 'condition') => new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const v = fn();
    if (v) return resolve(v);
    if (Date.now() - start > ms) return reject(new Error(`timed out waiting for ${what}`));
    setTimeout(tick, 10);
  };
  tick();
});

const solid = colour => () => colour;

/* ----------------------------------------------------------- encodings */

test('the client advertises CopyRect, Hextile, RRE, Raw, DesktopSize and its extensions', async () => {
  const server = await startFakeRfbServer();
  const client = new RfbClient({ host: '127.0.0.1', port: server.port });
  await client.connect();
  await until(() => server.of('setEncodings').length, 2000, 'SetEncodings');
  // Pseudo-encodings follow: ExtendedDesktopSize and Extended Clipboard.
  assert.deepEqual(server.of('setEncodings')[0].encodings, [1, 5, 2, 0, -223, -308, 0xc0a1e5ce | 0]);
  assert.deepEqual(SUPPORTED_ENCODINGS, [1, 5, 2, 0, -223, -308, 0xc0a1e5ce | 0]);
  client.disconnect();
  await server.close();
});

test('CopyRect reports its source position and copies existing pixels', async () => {
  const server = await startFakeRfbServer({ width: 8, height: 4 });
  const client = new RfbClient({ host: '127.0.0.1', port: server.port });
  await client.connect();

  const rects = [];
  let ended = 0;
  client.on('rect', r => rects.push(r));
  client.on('updateEnd', () => ended++);

  // Paint a gradient into the left half, then copy it to the right half.
  const socket = await serverSocket(server);
  socket.write(update(
    rawRect(0, 0, 4, 4, (x, y) => [x * 40, y * 40, 200]),
    copyRect(4, 0, 4, 4, 0, 0),
  ));
  await until(() => ended === 1, 3000, 'update end');

  assert.equal(rects.length, 2);
  assert.deepEqual(rects[1].src, { x: 0, y: 0 }, 'CopyRect source position was not parsed');
  assert.equal(rects[1].data, undefined, 'CopyRect must not carry pixel data');

  const fb = Buffer.alloc(8 * 4 * 4);
  applyRects(fb, 8, rects);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      assert.deepEqual(rgbaAt(fb, 8, x + 4, y), [x * 40, y * 40, 200, 255], `pixel ${x + 4},${y} not copied`);
    }
  }
  client.disconnect();
  await server.close();
});

test('RRE decodes background and clipped subrectangles', () => {
  const block = rreRect(0, 0, 4, 3, [10, 20, 30], [
    { x: 1, y: 1, w: 2, h: 1, colour: [255, 0, 0] },
    { x: 3, y: 2, w: 9, h: 9, colour: [0, 255, 0] },       // overflows: must be clipped
  ]).subarray(12);
  const out = decodeRre(block, 4, 3);
  assert.equal(out.length, 4 * 3 * 4);
  assert.deepEqual(rgbaAt(out, 4, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(rgbaAt(out, 4, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(rgbaAt(out, 4, 2, 1), [255, 0, 0, 255]);
  assert.deepEqual(rgbaAt(out, 4, 3, 1), [10, 20, 30, 255]);
  assert.deepEqual(rgbaAt(out, 4, 3, 2), [0, 255, 0, 255]);
});

test('Hextile decodes every tile kind, including when bytes arrive one at a time', async () => {
  // 20×18: tiles are 16×16, 4×16, 16×2 and 4×2, so partial edge tiles are covered.
  const raw4x16 = Array.from({ length: 4 * 16 }, (_, i) => [i, 255 - i, 7]);
  const tiles = [
    hextileTile({ bg: [0, 0, 255], fg: [255, 255, 0], subrects: [{ x: 2, y: 3, w: 4, h: 5 }] }),
    hextileTile({ raw: raw4x16 }),
    // Background and foreground are inherited from the previous non-raw tile.
    hextileTile({ subrects: [{ x: 15, y: 1, w: 1, h: 1, colour: [9, 8, 7] }] }),
    hextileTile({ bg: [1, 2, 3] }),
  ];

  const server = await startFakeRfbServer({ width: 20, height: 18, chunkSize: 1 });
  const client = new RfbClient({ host: '127.0.0.1', port: server.port });
  await client.connect();
  const rects = [];
  let ended = false;
  client.on('rect', r => rects.push(r));
  client.on('updateEnd', () => { ended = true; });

  const socket = await serverSocket(server);
  const msg = update(hextileRect(0, 0, 20, 18, tiles));
  for (let i = 0; i < msg.length; i++) socket.write(msg.subarray(i, i + 1));
  await until(() => ended, 5000, 'hextile update');

  assert.equal(rects.length, 1);
  const fb = rects[0].data;
  assert.equal(fb.length, 20 * 18 * 4);
  assert.deepEqual(rgbaAt(fb, 20, 0, 0), [0, 0, 255, 255], 'tile 1 background');
  assert.deepEqual(rgbaAt(fb, 20, 2, 3), [255, 255, 0, 255], 'tile 1 foreground subrect');
  assert.deepEqual(rgbaAt(fb, 20, 5, 7), [255, 255, 0, 255], 'tile 1 subrect far corner');
  assert.deepEqual(rgbaAt(fb, 20, 6, 3), [0, 0, 255, 255], 'tile 1 outside subrect');
  assert.deepEqual(rgbaAt(fb, 20, 16, 0), [0, 255, 7, 255], 'raw tile first pixel');
  assert.deepEqual(rgbaAt(fb, 20, 19, 15), [63, 192, 7, 255], 'raw tile last pixel');
  assert.deepEqual(rgbaAt(fb, 20, 0, 16), [0, 0, 255, 255], 'inherited background');
  assert.deepEqual(rgbaAt(fb, 20, 15, 17), [9, 8, 7, 255], 'coloured subrect');
  assert.deepEqual(rgbaAt(fb, 20, 17, 17), [1, 2, 3, 255], 'last tile background');

  client.disconnect();
  await server.close();
});

/* --------------------------------------------------------- update loop */

test('the session keeps requesting updates, one at a time, after the first frame', async () => {
  let outstanding = 0;
  let maxOutstanding = 0;
  let n = 0;
  const server = await startFakeRfbServer({
    width: 16, height: 16,
    onRequest: (req, { socket }) => {
      outstanding++;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      // Reply after a delay, so a client that sent more than one request at a
      // time would be caught with two outstanding.
      const colour = [n++ % 256, 0, 0];
      setTimeout(() => {
        outstanding--;
        socket.write(update(rawRect(req.x, req.y, req.width, req.height, solid(colour))));
      }, 15);
      return null;
    },
  });

  const session = new Session(conn(server.port), null);
  const updates = [];
  session.on('update', u => updates.push(u));
  await session.start();
  await until(() => updates.length >= 10, 5000, '10 updates');

  const requests = server.of('request');
  assert.equal(requests[0].incremental, false, 'the first request must be a full update');
  assert.ok(requests.slice(1).some(r => r.incremental), 'later requests must be incremental');
  assert.equal(maxOutstanding, 1, 'more than one update request was in flight');
  assert.ok(session.current.framesReceived >= 10);
  assert.equal(typeof session.current.latencyMs, 'number', 'no latency was measured');

  session.stop();
  await server.close();
});

test('a session batches every rectangle of one update into a single event', async () => {
  let sent = false;
  const server = await startFakeRfbServer({
    width: 8, height: 8,
    onRequest: () => {
      if (sent) return null;
      sent = true;
      return update(rawRect(0, 0, 4, 4, solid([1, 1, 1])), copyRect(4, 4, 4, 4, 0, 0), rawRect(0, 4, 4, 4, solid([2, 2, 2])));
    },
  });
  const session = new Session(conn(server.port), null);
  const updates = [];
  session.on('update', u => updates.push(u));
  await session.start();
  await until(() => updates.length === 1, 3000, 'batched update');

  assert.equal(updates[0].rects.length, 3);
  assert.equal(updates[0].width, 8);
  assert.deepEqual(updates[0].rects.map(r => r.src ? 'copy' : 'raw'), ['raw', 'copy', 'raw'], 'order must be preserved');
  session.stop();
  await server.close();
});

test('with flow control the next request waits until the UI has painted', async () => {
  const server = await startFakeRfbServer({
    width: 4, height: 4,
    onRequest: req => update(rawRect(0, 0, 1, 1, solid([req.incremental ? 1 : 0, 0, 0]))),
  });
  const session = new Session(conn(server.port), null);
  session.setFlowControl(true);
  let updates = 0;
  session.on('update', () => updates++);
  await session.start();

  await until(() => updates === 1, 3000, 'first update');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(server.of('request').length, 1, 'requested again before the frame was painted');

  session.renderComplete();
  await until(() => updates === 2, 3000, 'second update after ack');
  assert.equal(server.of('request').length >= 2, true);
  session.stop();
  await server.close();
});

test('an unacknowledged frame does not stall the session forever', async () => {
  const server = await startFakeRfbServer({
    width: 4, height: 4,
    onRequest: () => update(rawRect(0, 0, 1, 1, solid([5, 5, 5]))),
  });
  const session = new Session(conn(server.port), null);
  session.setFlowControl(true);
  let updates = 0;
  session.on('update', () => updates++);
  await session.start();
  await until(() => updates >= 2, 4000, 'loop to resume after the render timeout');
  session.stop();
  await server.close();
});

test('a DesktopSize change is reported and followed by a full repaint request', async () => {
  let phase = 0;
  const server = await startFakeRfbServer({
    width: 10, height: 10,
    onRequest: () => {
      phase++;
      if (phase === 1) return update(rawRect(0, 0, 10, 10, solid([0, 0, 0])));
      if (phase === 2) return update(desktopSize(20, 12));
      return null;
    },
  });
  const session = new Session(conn(server.port), null);
  const sizes = [];
  session.on('resize', s => sizes.push(s));
  await session.start();
  await until(() => server.of('request').length >= 3, 3000, 'request after resize');

  assert.deepEqual(sizes, [{ width: 20, height: 12 }]);
  const after = server.of('request')[2];
  assert.equal(after.incremental, false, 'did not ask for a full repaint after the resize');
  assert.equal(after.width, 20, 'the repaint request did not use the new size');
  session.stop();
  await server.close();
});

test('server clipboard text is delivered, and suppressed when sharing is off', async () => {
  for (const share of [true, false]) {
    const server = await startFakeRfbServer({
      onRequest: (req, { events }) => events.filter(e => e.type === 'request').length === 1
        ? Buffer.concat([serverCutText('copied on the remote'), update()]) : null,
    });
    const session = new Session(conn(server.port, { options: { ...conn(0).options, shareClipboard: share } }), null);
    const clips = [];
    session.on('clipboard', t => clips.push(t));
    await session.start();
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(clips, share ? ['copied on the remote'] : []);
    session.stop();
    await server.close();
  }
});

/* ------------------------------------------------------------- input */

test('key and pointer events reach the server with the exact keysym and mask', async () => {
  const server = await startFakeRfbServer();
  const session = new Session(conn(server.port), null);
  await session.start();

  session.sendKey(0xffe3, true);              // Control_L
  session.sendKey(0x01000000 + 0x0627, true); // Arabic alef, Unicode keysym
  session.sendKey(0x01000000 + 0x0627, false);
  session.sendKey(0xffe3, false);
  session.sendPointer(12, 34, 1);
  session.sendPointer(12, 34, 0);
  session.sendPointer(12, 34, 16);            // wheel down
  await until(() => server.of('pointer').length === 3, 2000, 'pointer events');

  assert.deepEqual(server.of('key'), [
    { type: 'key', down: true, keysym: 0xffe3 },
    { type: 'key', down: true, keysym: 0x01000627 },
    { type: 'key', down: false, keysym: 0x01000627 },
    { type: 'key', down: false, keysym: 0xffe3 },
  ]);
  assert.deepEqual(server.of('pointer').map(p => [p.x, p.y, p.mask]), [[12, 34, 1], [12, 34, 0], [12, 34, 16]]);
  session.stop();
  await server.close();
});

/* ------------------------------------------------ disconnect/reconnect */

test('reconnects after the server drops the connection, then resumes updates', async () => {
  const server = await startFakeRfbServer({
    width: 4, height: 4,
    onRequest: req => req.incremental ? null : update(rawRect(0, 0, 4, 4, solid([9, 9, 9]))),
  });
  const session = new Session(conn(server.port), null,
    { enabled: true, maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 200 });
  const states = [];
  let updates = 0;
  session.on('state', s => states.push(s));
  session.on('update', () => updates++);
  await session.start();
  await until(() => updates >= 1, 3000, 'first update');

  const before = updates;
  server.dropAll();
  await until(() => states.lastIndexOf('connected') > states.indexOf('reconnecting') && states.includes('reconnecting'),
    5000, 'reconnect');
  await until(() => updates > before, 3000, 'updates after reconnect');

  // Exactly one new connection: a duplicate retry timer would open two.
  await new Promise(r => setTimeout(r, 500));
  assert.equal(server.connections, 2, `expected 2 connections, saw ${server.connections}`);
  session.stop();
  await server.close();
});

test('a deliberate disconnect closes the socket and never reconnects', async () => {
  const server = await startFakeRfbServer({ onRequest: () => null });
  const session = new Session(conn(server.port), null,
    { enabled: true, maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 100 });
  const states = [];
  session.on('state', s => states.push(s));
  await session.start();
  session.stop();
  await new Promise(r => setTimeout(r, 500));
  assert.equal(states.at(-1), 'disconnected');
  assert.equal(states.filter(s => s === 'disconnected').length, 1, 'disconnected was reported twice');
  assert.ok(!states.includes('reconnecting'));
  assert.equal(server.connections, 1);
  await server.close();
});

test('disconnecting during the handshake settles immediately, without a retry', async () => {
  // A server that accepts TCP and says nothing.
  const { createServer } = await import('node:net');
  const silent = createServer(() => {});
  await new Promise(r => silent.listen(0, '127.0.0.1', r));
  const session = new Session(conn(silent.address().port), null,
    { enabled: true, maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 100 });
  const states = [];
  session.on('state', s => states.push(s));
  const started = session.start();
  await new Promise(r => setTimeout(r, 100));
  session.stop();
  const t0 = Date.now();
  await started;
  assert.ok(Date.now() - t0 < 1000, 'start() waited for the handshake timeout after a disconnect');
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(states, ['connecting', 'disconnected']);
  silent.close();
});

/* ------------------------------------------------------- handshakes */

for (const [version, label] of [['RFB 003.003\n', '3.3'], ['RFB 003.007\n', '3.7']]) {
  test(`RFB ${label} servers without authentication complete the handshake`, async () => {
    const server = await startFakeRfbServer({ version, securityTypes: [1], width: 30, height: 20 });
    const client = new RfbClient({ host: '127.0.0.1', port: server.port, timeoutMs: 2000 });
    const info = await client.connect();
    assert.equal(info.width, 30);
    assert.equal(server.of('version')[0].value, version);
    client.disconnect();
    await server.close();
  });
}

test('RFB 3.3 servers with VNC authentication accept the right password and refuse a wrong one', async () => {
  const server = await startFakeRfbServer({ version: 'RFB 003.003\n', securityTypes: [2], password: 'sesame12' });
  const ok = new RfbClient({ host: '127.0.0.1', port: server.port, password: 'sesame12', timeoutMs: 2000 });
  assert.equal((await ok.connect()).name, 'fake-desktop');
  ok.disconnect();
  const bad = new RfbClient({ host: '127.0.0.1', port: server.port, password: 'wrong', timeoutMs: 2000 });
  await assert.rejects(() => bad.connect(), /Authentication failed|closed the connection/);
  await server.close();
});

test('RFB 3.8 authentication failure carries the server reason', async () => {
  const server = await startFakeRfbServer({ securityTypes: [2], password: 'right' });
  const bad = new RfbClient({ host: '127.0.0.1', port: server.port, password: 'wrong', timeoutMs: 2000 });
  await assert.rejects(() => bad.connect(), /Authentication failed: Authentication failure/);
  await server.close();
});

test('socket errors become actionable sentences', () => {
  const c = { host: 'pc.local', port: 5900 };
  assert.match(explainVncError('connect ECONNREFUSED 10.0.0.1:5900', c), /screen sharing is turned on/);
  assert.match(explainVncError('getaddrinfo ENOTFOUND pc.local', c), /could not be found/);
  assert.match(explainVncError('connect EHOSTUNREACH 10.0.0.1:5900', c), /cannot be reached/);
  assert.match(explainVncError('No response from pc.local:5900 after 12000ms', c), /firewall/);
  assert.match(explainVncError('No supported authentication method. The server offers: Apple Remote Desktop', c),
    /VNC viewers may control screen with password/);
  assert.equal(explainVncError('Authentication failed: bad', c), 'Authentication failed: bad');
});

/** The server side of the client's connection, once its handshake is done. */
async function serverSocket(server) {
  await until(() => server.of('clientinit').length, 2000, 'client init');
  return server.lastSocket;
}

test('disconnecting while a reconnect is waiting cancels it: no further attempts', async () => {
  const server = await startFakeRfbServer({ onRequest: () => null });
  // A long backoff, so the retry is certainly still pending when stop() is called.
  const session = new Session(conn(server.port), null,
    { enabled: true, maxAttempts: 5, baseDelayMs: 800, maxDelayMs: 800 });
  const states = [];
  session.on('state', s => states.push(s));
  await session.start();
  assert.equal(server.connections, 1);

  server.dropAll();
  await until(() => states.includes('reconnecting'), 2000, 'reconnecting');
  session.stop();
  await new Promise(r => setTimeout(r, 1500));

  assert.equal(server.connections, 1, 'a reconnect attempt ran after Disconnect');
  assert.equal(states.at(-1), 'disconnected');
  await server.close();
});

test('a first connection gives up after initialAttempts, while a dropped session retries up to maxAttempts', async () => {
  // Never connected: nothing listens on port 9.
  const first = new Session(conn(9), null, { enabled: true, maxAttempts: 8, initialAttempts: 2, baseDelayMs: 50, maxDelayMs: 50 });
  const firstStates = [];
  first.on('state', s => firstStates.push(s));
  await first.start();
  await until(() => first.current.state === 'failed', 3000, 'first-connection failure');
  assert.equal(firstStates.filter(s => s === 'reconnecting').length, 2, `states: ${firstStates}`);
  assert.match(first.current.lastError, /gave up after 2 attempts/);

  // Connected once, then the server goes away for good: the longer budget applies.
  const server = await startFakeRfbServer({ onRequest: () => null });
  const dropped = new Session(conn(server.port), null, { enabled: true, maxAttempts: 4, initialAttempts: 1, baseDelayMs: 50, maxDelayMs: 50 });
  await dropped.start();
  await server.close();
  await until(() => dropped.current.state === 'failed', 5000, 'failure after drop');
  assert.match(dropped.current.lastError, /gave up after 4 attempts/);
});
