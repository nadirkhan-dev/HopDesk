import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromBase64, toBase64 } from '@hopdesk/crypto';
import {
  HostAuthenticator, GrantStore, acceptViewer, connectToHost,
} from '@hopdesk/protocol';
import { testServer, client } from './helpers/server.mjs';
import { enrolDevice, signIn } from './helpers/device.mjs';

/**
 * The relay, exercised over a real WebSocket: who may connect to whom, what the
 * server refuses, and — the point of the whole design — a complete HopDesk
 * handshake carried end to end through it, with the server unable to read a
 * single byte of the session.
 */

async function connected(server, deviceToken) {
  const c = client(server.ws);
  await c.open;
  c.send({ type: 'auth', token: deviceToken });
  await c.next(m => m.type === 'ready');
  return c;
}

test('a device connects with its token and is then shown as online', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    const device = await enrolDevice(server, session, 'Office PC');
    const c = await connected(server, device.deviceToken);
    assert.equal((await c.next(m => m.type === 'ready')).deviceId, device.deviceId);

    const listed = await server.call('GET', '/api/devices', { token: session.accessToken });
    assert.equal(listed.body.devices[0].online, true);
    assert.ok(listed.body.devices[0].lastSeen > 0, 'lastSeen was not recorded');

    c.close();
    await c.closed;
    await new Promise(r => setTimeout(r, 100));
    assert.equal((await server.call('GET', '/api/devices', { token: session.accessToken })).body.devices[0].online, false);
  } finally { await server.close(); }
});

test('a socket with no credentials, a bad token, or an account token is closed', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);

    const bad = client(server.ws);
    await bad.open;
    bad.send({ type: 'auth', token: 'not-a-token' });
    assert.equal((await bad.closed).code, 4001);

    // An account access token is not a device: it cannot be a session endpoint.
    const accountToken = client(server.ws);
    await accountToken.open;
    accountToken.send({ type: 'auth', token: session.accessToken });
    assert.equal((await accountToken.closed).code, 4001);

    // Anything before authentication is refused.
    const early = client(server.ws);
    await early.open;
    early.send({ type: 'connect', target: 'HD-1234-5678' });
    assert.equal((await early.closed).code, 4001);
  } finally { await server.close(); }
});

test('a device may only reach computers on its own account, and only online ones', async () => {
  const server = await testServer();
  try {
    const mine = await signIn(server, 'mine@example.com');
    const theirs = await signIn(server, 'theirs@example.com');
    const a = await enrolDevice(server, mine, 'A');
    const b = await enrolDevice(server, mine, 'B');
    const stranger = await enrolDevice(server, theirs, 'Stranger');

    const ca = await connected(server, a.deviceToken);

    // Offline, but on the account.
    ca.send({ type: 'connect', target: b.deviceId });
    assert.equal((await ca.next(m => m.type === 'connect-failed')).reason, 'offline');

    // Another account's device is reported exactly as a non-existent one.
    await connected(server, stranger.deviceToken);
    ca.send({ type: 'connect', target: stranger.deviceId });
    assert.equal((await ca.next(m => m.type === 'connect-failed' && m.target === stranger.deviceId)).reason, 'not-found');

    // Itself.
    ca.send({ type: 'connect', target: a.deviceId });
    assert.equal((await ca.next(m => m.type === 'connect-failed' && m.target === a.deviceId)).reason, 'same-device');

    // And once B is online, the introduction succeeds for both sides.
    const cb = await connected(server, b.deviceToken);
    ca.send({ type: 'connect', target: b.deviceId });
    const viewerSide = await ca.next(m => m.type === 'session');
    const hostSide = await cb.next(m => m.type === 'session');
    assert.equal(viewerSide.sessionId, hostSide.sessionId);
    assert.equal(viewerSide.role, 'viewer');
    assert.equal(hostSide.role, 'host');
    assert.equal(viewerSide.peer.deviceId, b.deviceId);
    assert.equal(hostSide.peer.deviceId, a.deviceId);
    // Each side is told the other's registered public key, for pinning.
    assert.equal(viewerSide.peer.publicKey, toBase64(b.identity.publicKey));
    assert.equal(hostSide.peer.publicKey, toBase64(a.identity.publicKey));
  } finally { await server.close(); }
});

test('frames reach the other end of a session and nowhere else', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const a = await enrolDevice(server, account, 'A');
    const b = await enrolDevice(server, account, 'B');
    const c = await enrolDevice(server, account, 'C');
    const ca = await connected(server, a.deviceToken);
    const cb = await connected(server, b.deviceToken);
    const cc = await connected(server, c.deviceToken);

    ca.send({ type: 'connect', target: b.deviceId });
    const { sessionId } = await ca.next(m => m.type === 'session');
    await cb.next(m => m.type === 'session');

    ca.send({ type: 'frame', sessionId, payload: { type: 'error', code: 'busy' } });
    const relayed = await cb.next(m => m.type === 'frame');
    assert.deepEqual(relayed.payload, { type: 'error', code: 'busy' });
    assert.equal(cc.messages.some(m => m.type === 'frame'), false, 'a third device received the frame');

    // A device not in the session cannot push frames into it.
    cc.send({ type: 'frame', sessionId, payload: { type: 'error', code: 'busy' } });
    assert.equal((await cc.next(m => m.type === 'session-ended')).reason, 'unknown-session');

    // Closing one end ends the session for both.
    ca.send({ type: 'close', sessionId });
    assert.ok(await cb.next(m => m.type === 'session-ended' && m.sessionId === sessionId));

    // As does the socket going away.
    ca.send({ type: 'connect', target: b.deviceId });
    const second = await ca.next(m => m.type === 'session' && m.sessionId !== sessionId);
    ca.close();
    assert.ok(await cb.next(m => m.type === 'session-ended' && m.sessionId === second.sessionId));
  } finally { await server.close(); }
});

test('malformed messages, binary frames and floods are refused', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const device = await enrolDevice(server, account);

    const junk = await connected(server, device.deviceToken);
    junk.socket.send('not json at all');
    assert.equal((await junk.closed).code, 4002);

    const wrongShape = await connected(server, device.deviceToken);
    wrongShape.send({ type: 'connect', target: 'not-a-device-id' });
    assert.equal((await wrongShape.closed).code, 4002);

    const binary = await connected(server, device.deviceToken);
    binary.socket.send(new Uint8Array([1, 2, 3]));
    assert.equal((await binary.closed).code, 4002);

    const flood = await connected(server, device.deviceToken);
    for (let i = 0; i < 600; i++) flood.send({ type: 'ping' });
    assert.equal((await flood.closed).code, 4029);
  } finally { await server.close(); }
});

test('a newer connection for the same device replaces the older one', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const device = await enrolDevice(server, account);
    const first = await connected(server, device.deviceToken);
    const second = await connected(server, device.deviceToken);
    assert.equal((await first.closed).code, 4001);
    assert.equal(second.socket.readyState, WebSocket.OPEN);
  } finally { await server.close(); }
});

test('removing a device disconnects it immediately', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const device = await enrolDevice(server, account);
    const c = await connected(server, device.deviceToken);
    await server.call('DELETE', `/api/devices/${device.deviceId}`, { token: account.accessToken });
    assert.equal((await c.closed).code, 4003);
  } finally { await server.close(); }
});

test('a complete HopDesk handshake runs through the relay, which cannot read it', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const hostDevice = await enrolDevice(server, account, 'Office PC');
    const viewerDevice = await enrolDevice(server, account, 'Laptop');
    const hostSocket = await connected(server, hostDevice.deviceToken);
    const viewerSocket = await connected(server, viewerDevice.deviceToken);

    /* Every frame the server relays is recorded, so the test can check
       afterwards that nothing readable passed through it. */
    const relayed = [];
    const link = (socket, sessionId) => {
      let handler = () => {};
      let closeHandler = () => {};
      const self = {
        closed: false,
        send(message) {
          relayed.push(JSON.stringify(message));
          socket.send({ type: 'frame', sessionId, payload: message });
        },
        onMessage(h) { handler = h; },
        onClose(h) { closeHandler = h; },
        close() { if (!self.closed) { self.closed = true; closeHandler(); } },
      };
      const pump = setInterval(() => {
        for (const message of socket.messages.splice(0)) {
          if (message.type === 'frame' && message.sessionId === sessionId) handler(message.payload);
          if (message.type === 'session-ended') self.close();
        }
      }, 5);
      pump.unref?.();
      return self;
    };

    viewerSocket.send({ type: 'connect', target: hostDevice.deviceId });
    const viewerIntro = await viewerSocket.next(m => m.type === 'session');
    const hostIntro = await hostSocket.next(m => m.type === 'session');

    const grants = new GrantStore();
    const auth = new HostAuthenticator({
      identity: hostDevice.identity,
      hostName: 'Office PC',
      grants,
      accessCode: () => null,                       // no code: this is an account connection
      rotateAccessCode: () => {},
      // The host checks the caller against the key the account knows for it.
      accountAuthorised: (id, key) => id === viewerIntro.peer.deviceId || toBase64(key) === hostIntro.peer.publicKey,
    });

    const [viewerResult, hostResult] = await Promise.all([
      connectToHost(link(viewerSocket, viewerIntro.sessionId), {
        identity: viewerDevice.identity,
        viewerName: 'Laptop',
        hostId: hostDevice.deviceId,
        credential: { kind: 'account' },
        expectedHostKey: fromBase64(viewerIntro.peer.publicKey),
      }),
      acceptViewer(link(hostSocket, hostIntro.sessionId), auth, { grants, authorize: async () => 'allow' }),
    ]);

    assert.deepEqual(viewerResult.root, hostResult.root, 'the two sides did not agree on a session key');
    assert.equal(hostResult.viewer.auth, 'account');

    /* Sealed traffic through the relay, and a check that the relay saw only
       ciphertext: the plaintext never appears in anything it carried. */
    const secret = 'v=0 a-session-description-only-they-can-read';
    const got = new Promise(resolve => hostResult.control.onMessage(resolve));
    viewerResult.control.send({ type: 'rtc-offer', sdp: secret });
    assert.deepEqual(await got, { type: 'rtc-offer', sdp: secret });

    const everything = relayed.join('\n');
    assert.ok(!everything.includes(secret), 'the relay carried the session description in the clear');
    assert.ok(!everything.includes('a-session-description'), 'plaintext leaked into the relay');
    assert.ok(relayed.some(f => f.includes('"sealed"')), 'no sealed frames were relayed');
    // Nor could the server log anything about the contents.
    assert.ok(!server.logs.join('\n').includes(secret));
    viewerResult.control.close();
  } finally { await server.close(); }
});

/**
 * Live status: the other devices on the account are told when one arrives or
 * leaves, rather than finding out when somebody presses Refresh.
 *
 * The message carries no more than `GET /api/devices` already says - a device
 * id, whether it is here, and when it was last seen - so a live list costs the
 * account no privacy it had not already given the server.
 */
test('the account is told when one of its computers comes and goes', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    const watcher = await enrolDevice(server, session, 'Desk Mac');
    const comer = await enrolDevice(server, session, 'Office PC');

    const a = await connected(server, watcher.deviceToken);
    const b = await connected(server, comer.deviceToken);

    const arrived = await a.next(m => m.type === 'presence');
    assert.equal(arrived.deviceId, comer.deviceId);
    assert.equal(arrived.online, true);
    assert.ok(arrived.lastSeen > 0, 'no time came with the arrival');

    b.close();
    await b.closed;
    const left = await a.next(m => m.type === 'presence' && m.online === false);
    assert.equal(left.deviceId, comer.deviceId);

    /* Leaving is also when "last seen" is written: for a computer that stayed
       connected for a week, when it arrived is the wrong answer. */
    const listed = await server.call('GET', '/api/devices', { token: session.accessToken });
    const row = listed.body.devices.find(d => d.deviceId === comer.deviceId);
    assert.equal(row.online, false);
    assert.ok(row.lastSeen >= arrived.lastSeen, 'lastSeen was not stamped on the way out');
  } finally { await server.close(); }
});

test('another account is never told who is online', async () => {
  const server = await testServer();
  try {
    const mine = await signIn(server);
    const theirs = await signIn(server, 'someone-else@example.com');
    const watcher = await enrolDevice(server, theirs, 'Their Laptop');
    const comer = await enrolDevice(server, mine, 'My PC');

    const a = await connected(server, watcher.deviceToken);
    const b = await connected(server, comer.deviceToken);
    b.close();
    await b.closed;

    // Nothing about my computer may reach their socket.
    await new Promise(r => setTimeout(r, 150));
    assert.equal(a.messages.filter(m => m.type === 'presence').length, 0,
      'presence leaked across accounts');
  } finally { await server.close(); }
});

test('a computer that keeps saying it is here is not closed as idle', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    const device = await enrolDevice(server, session, 'Quiet PC');
    const c = await connected(server, device.deviceToken);
    // What the heartbeat sends, and what proves the socket is still counted.
    c.send({ type: 'ping' });
    assert.ok(await c.next(m => m.type === 'pong'), 'no answer to a heartbeat');
    assert.equal((await server.call('GET', '/api/devices', { token: session.accessToken }))
      .body.devices[0].online, true);
    c.close();
  } finally { await server.close(); }
});
