import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, RfbClient } from '../dist/index.js';
import {
  startFakeRfbServer, update, rawRect, serverCutText, CLIP, extendedClipboardMessage,
  extendedClipboardProvide, extendedDesktopSize,
} from './helpers/fake-rfb-server.mjs';

/** Unicode clipboard (Extended Clipboard) and remote resizing (ExtendedDesktopSize). */

const conn = (port, options = {}) => ({
  id: 'x', name: 'X', protocol: 'vnc', host: '127.0.0.1', port,
  favorite: false, createdAt: '', updatedAt: '', connectCount: 0,
  options: {
    scaling: 'fit', fullscreenOnConnect: false, viewOnly: false, shareClipboard: true,
    enableAudio: false, multiMonitor: false, autoReconnect: false, ...options,
  },
});

const until = (fn, ms = 3000, what = 'condition') => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const v = fn();
    if (v) return resolve(v);
    if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for ${what}`));
    setTimeout(tick, 10);
  };
  tick();
});

const MIXED = 'مرحبا بالعالم — 你好，世界 — こんにちは — 안녕하세요 — émoji 😀\nsecond line';

test('local → remote: Unicode text is announced, requested and provided as UTF-8', async () => {
  const server = await startFakeRfbServer({
    extendedClipboard: true,
    onClipboard: (ev, { socket }) => {
      // A notify from the client: ask for the text, as TigerVNC does.
      if (ev.flags & CLIP.notify && ev.flags & CLIP.text) socket.write(extendedClipboardMessage(CLIP.request | CLIP.text));
    },
  });
  const session = new Session(conn(server.port), null);
  await session.start();
  await until(() => server.of('extClip').some(e => e.flags & CLIP.caps), 2000, 'client capabilities');
  assert.equal(session.unicodeClipboard, true);

  assert.deepEqual(session.sendClipboard(MIXED), { lossless: true });
  const provided = await until(() => server.of('extClip').find(e => e.flags & CLIP.provide && !(e.flags & CLIP.caps)), 2000, 'provide');
  // CRLF and a terminating NUL on the wire, exactly per the specification.
  assert.equal(provided.text, `${MIXED.replace('\n', '\r\n')}\0`);
  assert.equal(server.of('cutText').length, 0, 'fell back to Latin-1 cut text');
  session.stop();
  await server.close();
});

test('remote → local: a notify is answered with a request, and the provided text arrives intact', async () => {
  const server = await startFakeRfbServer({
    extendedClipboard: true,
    onClipboard: (ev, { socket }) => {
      if (ev.flags & CLIP.request) socket.write(extendedClipboardProvide(MIXED));
    },
  });
  const session = new Session(conn(server.port), null);
  const clips = [];
  session.on('clipboard', t => clips.push(t));
  await session.start();
  await until(() => server.of('extClip').some(e => e.flags & CLIP.caps), 2000, 'client capabilities');

  server.lastSocket.write(extendedClipboardMessage(CLIP.notify | CLIP.text));
  await until(() => clips.length === 1, 2000, 'clipboard text');
  assert.equal(clips[0], MIXED, 'Arabic, CJK, Korean or emoji text was corrupted');
  session.stop();
  await server.close();
});

test('an unsolicited Provide is accepted whether the zlib stream is sync-flushed or finished', async () => {
  const server = await startFakeRfbServer({ extendedClipboard: true });
  const session = new Session(conn(server.port), null);
  const clips = [];
  session.on('clipboard', t => clips.push(t));
  await session.start();
  await until(() => server.of('extClip').some(e => e.flags & CLIP.caps), 2000, 'client capabilities');
  // TigerVNC sends the text straight away when its clipboard changes.
  server.lastSocket.write(extendedClipboardProvide('sync-flushed: مرحبا'));
  server.lastSocket.write(extendedClipboardProvide('finished: 你好', { finished: true }));
  await until(() => clips.length === 2, 2000, 'both clipboard messages');
  assert.deepEqual(clips, ['sync-flushed: مرحبا', 'finished: 你好']);
  session.stop();
  await server.close();
});

test('a server without Extended Clipboard gets Latin-1, and non-Latin text is reported as lossy', async () => {
  const server = await startFakeRfbServer({ extendedClipboard: false });
  const session = new Session(conn(server.port), null);
  const clips = [];
  session.on('clipboard', t => clips.push(t));
  await session.start();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(session.unicodeClipboard, false);

  assert.deepEqual(session.sendClipboard('café'), { lossless: true });
  assert.deepEqual(session.sendClipboard('مرحبا'), { lossless: false }, 'Arabic over Latin-1 must be flagged');
  await until(() => server.of('cutText').length === 2, 2000, 'legacy cut text');
  assert.equal(server.of('cutText')[0].text, 'café');

  server.lastSocket.write(serverCutText('résumé'));
  await until(() => clips.length === 1, 2000, 'legacy clipboard from server');
  assert.equal(clips[0], 'résumé');
  session.stop();
  await server.close();
});

test('clipboard sharing turned off sends nothing in either direction', async () => {
  const server = await startFakeRfbServer({ extendedClipboard: true });
  const session = new Session(conn(server.port, { shareClipboard: false }), null);
  const clips = [];
  session.on('clipboard', t => clips.push(t));
  await session.start();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(session.sendClipboard('secret text'), null);
  server.lastSocket.write(extendedClipboardProvide('from remote'));
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(clips, []);
  assert.equal(server.of('extClip').filter(e => !(e.flags & CLIP.caps)).length, 0);
  session.stop();
  await server.close();
});

test('an oversized or corrupt clipboard message does not crash the session', async () => {
  const server = await startFakeRfbServer({ extendedClipboard: true });
  const session = new Session(conn(server.port), null);
  const states = [];
  session.on('state', s => states.push(s));
  await session.start();
  await new Promise(r => setTimeout(r, 200));
  // A Provide whose zlib data is garbage.
  server.lastSocket.write(extendedClipboardMessage(CLIP.provide | CLIP.text, Buffer.from('not zlib at all')));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(session.current.state, 'connected');
  session.stop();
  await server.close();
});

test('remote resizing: support is detected, requests are sent, and the new size is applied', async () => {
  let resized = false;
  const server = await startFakeRfbServer({
    width: 800, height: 600,
    onRequest: req => {
      if (req.incremental || resized) return null;
      // A server that supports resizing announces its layout in the first update.
      return update(extendedDesktopSize(800, 600, { screenId: 42 }), rawRect(0, 0, 4, 4, () => [1, 1, 1]));
    },
    onSetDesktopSize: ({ width, height }) => {
      resized = true;
      return update(extendedDesktopSize(width, height, { reason: 1, status: 0, screenId: 42 }));
    },
  });
  const session = new Session(conn(server.port), null);
  const sizes = [];
  session.on('resize', s => sizes.push(s));
  const screens = [];
  session.on('screens', s => screens.push(s));
  await session.start();
  await until(() => session.canResize, 2000, 'resize support');
  assert.equal(screens[0][0].id, 42);

  assert.equal(session.requestDesktopSize(1280.4, 719.6), true);
  const sent = await until(() => server.of('setDesktopSize')[0], 2000, 'SetDesktopSize');
  assert.deepEqual({ w: sent.width, h: sent.height, id: sent.screenId }, { w: 1280, h: 720, id: 42 },
    'the request did not keep the server’s screen id or rounded the size wrongly');
  await until(() => sizes.length === 1, 2000, 'resize event');
  assert.deepEqual(sizes[0], { width: 1280, height: 720 });
  assert.equal(session.serverInfo.width, 1280);
  session.stop();
  await server.close();
});

test('a refused resize is reported, and servers without support are never sent one', async () => {
  const server = await startFakeRfbServer({
    width: 640, height: 480,
    onRequest: req => req.incremental ? null : update(extendedDesktopSize(640, 480)),
    onSetDesktopSize: () => update(extendedDesktopSize(640, 480, { reason: 1, status: 3 })),
  });
  const session = new Session(conn(server.port), null);
  const rejected = [];
  session.on('resizeRejected', s => rejected.push(s));
  await session.start();
  await until(() => session.canResize, 2000, 'resize support');
  session.requestDesktopSize(1000, 700);
  await until(() => rejected.length === 1, 2000, 'rejection');
  assert.equal(rejected[0], 3);
  assert.equal(session.serverInfo.width, 640, 'a refused size was applied');
  session.stop();
  await server.close();

  const plain = await startFakeRfbServer({ onRequest: () => null });
  const client = new RfbClient({ host: '127.0.0.1', port: plain.port });
  await client.connect();
  assert.equal(client.requestDesktopSize(1000, 700), false);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(plain.of('setDesktopSize').length, 0);
  client.disconnect();
  await plain.close();
});

test('a server that answers every full request with only its layout (TigerVNC) still delivers pixels', async () => {
  // Observed with TigerVNC 1.13: each non-incremental request produces an
  // update holding only the ExtendedDesktopSize rectangle.
  const server = await startFakeRfbServer({
    width: 32, height: 24,
    onRequest: req => req.incremental
      ? update(rawRect(0, 0, 32, 24, () => [9, 8, 7]))
      : update(extendedDesktopSize(32, 24)),
  });
  const client = new RfbClient({ host: '127.0.0.1', port: server.port });
  await client.connect();
  const rects = [];
  let ends = 0;
  client.on('rect', r => rects.push(r));
  client.on('updateEnd', () => ends++);
  client.requestUpdate(false);
  await until(() => rects.length === 1, 2000, 'pixels after a layout-only answer');
  assert.equal(ends, 1, 'the layout-only update must not count as the answer');
  const requests = server.of('request');
  assert.deepEqual(requests.map(r => r.incremental), [false, true], 'expected exactly one repeat, as incremental');
  client.disconnect();
  await server.close();
});
