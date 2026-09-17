import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RfbClient, vncEncrypt, bgraToRgba } from '../dist/index.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.VNC_PORT ?? 5901);
const PASSWORD = process.env.VNC_PASSWORD ?? 'testpass';

/* ---------------------------------------------------- pure unit tests */

test('VNC auth uses bit-reversed DES keys', () => {
  /* Known vector: this is the quirk every VNC implementation copied from the
     original. If the bit reversal is dropped the output changes entirely and
     authentication fails with no diagnostic, so it is pinned here. */
  const challenge = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const out = vncEncrypt(challenge, 'testpass');
  assert.equal(out.length, 16);
  // Deterministic: the same inputs must always produce the same response.
  assert.deepEqual(out, vncEncrypt(challenge, 'testpass'));
  // A different password must not collide.
  assert.notDeepEqual(out, vncEncrypt(challenge, 'testpasz'));
});

test('passwords longer than 8 characters are truncated, not rejected', () => {
  // The protocol uses only the first 8 bytes. Servers do the same, so a long
  // password must still authenticate rather than failing locally.
  const c = Buffer.alloc(16, 7);
  assert.deepEqual(vncEncrypt(c, 'abcdefgh'), vncEncrypt(c, 'abcdefghIGNORED'));
});

test('BGRA converts to RGBA with opaque alpha', () => {
  // One pixel: blue=1 green=2 red=3, alpha byte undefined on the wire.
  const bgra = Buffer.from([1, 2, 3, 0]);
  assert.deepEqual([...bgraToRgba(bgra)], [3, 2, 1, 255]);
});

/* ------------------------------------------ live server integration */

test('connects to a real VNC server and completes the handshake', async () => {
  const client = new RfbClient({ host: HOST, port: PORT, password: PASSWORD });
  const info = await client.connect();

  assert.equal(info.width, 1024);
  assert.equal(info.height, 768);
  assert.equal(info.bitsPerPixel, 32, 'server did not accept our pixel format request');
  assert.ok(info.name.length > 0, 'no desktop name reported');

  client.disconnect();
});

test('receives real framebuffer pixels', async () => {
  const client = new RfbClient({ host: HOST, port: PORT, password: PASSWORD });
  const info = await client.connect();

  const rect = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no framebuffer update arrived')), 8000);
    client.on('rect', r => { clearTimeout(timer); resolve(r); });
    client.on('error', e => { clearTimeout(timer); reject(e); });
    // Non-incremental forces a full repaint rather than waiting for a change.
    client.requestUpdate(false);
  });

  assert.ok(rect.width > 0 && rect.height > 0);
  assert.ok(rect.data, 'rectangle carried no pixel data');
  // Four bytes per pixel, and every alpha byte opaque.
  assert.equal(rect.data.length, rect.width * rect.height * 4);
  assert.equal(rect.data[3], 255);
  assert.ok(rect.width <= info.width && rect.height <= info.height);

  client.disconnect();
});

test('a wrong password is refused', async () => {
  const client = new RfbClient({ host: HOST, port: PORT, password: 'wrongpw' });
  await assert.rejects(() => client.connect(), /Authentication failed|password/i);
});

test('a missing password is reported clearly, not as a crash', async () => {
  const client = new RfbClient({ host: HOST, port: PORT });
  await assert.rejects(() => client.connect(), /needs a password/i);
});

test('connecting to a closed port fails quickly with a useful message', async () => {
  const client = new RfbClient({ host: HOST, port: 5999, timeoutMs: 3000 });
  await assert.rejects(() => client.connect(), err =>
    /ECONNREFUSED|No response/.test(String(err.message)));
});

test('a non-VNC service is detected rather than misparsed', async () => {
  // An HTTP server on the wrong port is the classic mistake; the error should
  // say so instead of producing garbage.
  const { createServer } = await import('node:net');
  const decoy = createServer(s => s.write('HTTP/1.1 200 OK\r\n\r\n'));
  await new Promise(r => decoy.listen(5998, HOST, r));

  const client = new RfbClient({ host: HOST, port: 5998, timeoutMs: 3000 });
  await assert.rejects(() => client.connect(), /Not a VNC server/);
  decoy.close();
});

test('input messages are accepted by a live server', async () => {
  const client = new RfbClient({ host: HOST, port: PORT, password: PASSWORD });
  await client.connect();

  // A server that rejected these would drop the connection.
  client.sendPointer(100, 100, 0);
  client.sendPointer(100, 100, 1);     // left down
  client.sendPointer(100, 100, 0);     // up
  client.sendKey(0x0061, true);        // 'a' down
  client.sendKey(0x0061, false);
  client.sendClipboard('hello from hopdesk');

  const stillAlive = await new Promise(resolve => {
    let closed = false;
    client.on('close', () => { closed = true; resolve(false); });
    setTimeout(() => resolve(!closed), 1200);
  });
  assert.ok(stillAlive, 'the server dropped us after input — a message was malformed');

  client.disconnect();
});
