import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBase64, fromBase64 } from '@hopdesk/crypto';
import { HostAuthenticator, GrantStore, acceptViewer, connectToHost } from '@hopdesk/protocol';
import { RelayClient, negotiateAsHost, negotiateAsViewer } from '@hopdesk/transport';
import { testServer } from './helpers/server.mjs';
import { enrolDevice, signIn } from './helpers/device.mjs';

/**
 * The client half of the relay, against the real server: two devices connect,
 * one asks for the other, and a complete authenticated session runs between
 * them through the server — the same code the app uses.
 */

async function pair(server, account) {
  const hostDevice = await enrolDevice(server, account, 'Office PC');
  const viewerDevice = await enrolDevice(server, account, 'Laptop');
  const incoming = [];
  const host = new RelayClient({
    url: server.ws, token: hostDevice.deviceToken, reconnect: false,
    onIncoming: (intro, link) => incoming.push({ intro, link }),
  });
  const viewer = new RelayClient({
    url: server.ws, token: viewerDevice.deviceToken, reconnect: false,
    onIncoming: () => { throw new Error('the viewer should not receive incoming sessions here'); },
  });
  await host.connect();
  await viewer.connect();
  return { hostDevice, viewerDevice, host, viewer, incoming };
}

test('a relay client connects, is introduced, and both ends get a link', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const { hostDevice, viewerDevice, host, viewer, incoming } = await pair(server, account);
    assert.equal(host.connected, true);

    const { intro, link } = await viewer.requestSession(hostDevice.deviceId);
    assert.equal(intro.role, 'viewer');
    assert.equal(intro.peer.deviceId, hostDevice.deviceId);
    assert.equal(intro.peer.name, 'Office PC');
    assert.equal(intro.peer.publicKey, toBase64(hostDevice.identity.publicKey));

    await waitFor(() => incoming.length === 1, 'the host to be told about the session');
    assert.equal(incoming[0].intro.role, 'host');
    assert.equal(incoming[0].intro.peer.deviceId, viewerDevice.deviceId);

    // The two links carry messages to each other.
    const seen = [];
    incoming[0].link.onMessage(m => seen.push(m));
    link.send({ type: 'error', code: 'busy' });
    await waitFor(() => seen.length === 1, 'a frame to arrive');
    assert.deepEqual(seen[0], { type: 'error', code: 'busy' });

    host.close();
    viewer.close();
  } finally { await server.close(); }
});

test('asking for a computer that cannot be reached says why', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const other = await signIn(server, 'other@example.com');
    const offline = await enrolDevice(server, account, 'Switched off');
    const stranger = await enrolDevice(server, other, 'Not mine');
    const device = await enrolDevice(server, account, 'Mine');
    const client = new RelayClient({ url: server.ws, token: device.deviceToken, reconnect: false, onIncoming: () => {} });
    await client.connect();

    await assert.rejects(client.requestSession(offline.deviceId), e => e.code === 'offline' && /not connected/i.test(e.message));
    await assert.rejects(client.requestSession(stranger.deviceId), e => e.code === 'not-found');
    await assert.rejects(client.requestSession(device.deviceId), e => e.code === 'same-device');
    client.close();
  } finally { await server.close(); }
});

test('a device whose token has been revoked is told, and does not keep retrying', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const device = await enrolDevice(server, account);
    const states = [];
    const client = new RelayClient({
      url: server.ws, token: device.deviceToken, onIncoming: () => {},
      onState: (state, detail) => states.push([state, detail]),
    });
    await client.connect();
    await server.call('DELETE', `/api/devices/${device.deviceId}`, { token: account.accessToken });
    await waitFor(() => states.some(([s]) => s === 'offline'), 'the client to notice');

    // Reconnecting with the same token is refused rather than retried forever.
    const again = new RelayClient({ url: server.ws, token: device.deviceToken, reconnect: false, onIncoming: () => {} });
    await assert.rejects(again.connect(), e => e.code === 'unauthorised');
    client.close();
  } finally { await server.close(); }
});

test('a full session runs over the relay, and WebRTC negotiation rules hold through it', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const { hostDevice, viewerDevice, host, viewer, incoming } = await pair(server, account);

    const { intro, link: viewerLink } = await viewer.requestSession(hostDevice.deviceId);
    await waitFor(() => incoming.length === 1, 'the host side');
    const hostSide = incoming[0];

    const grants = new GrantStore();
    const auth = new HostAuthenticator({
      identity: hostDevice.identity, hostName: 'Office PC', grants,
      accessCode: () => null, rotateAccessCode: () => {},
      accountAuthorised: (id, key) => id === hostSide.intro.peer.deviceId
        && toBase64(key) === hostSide.intro.peer.publicKey,
    });

    const [viewerSession, hostSession] = await Promise.all([
      connectToHost(viewerLink, {
        identity: viewerDevice.identity, viewerName: 'Laptop', hostId: hostDevice.deviceId,
        credential: { kind: 'account' }, expectedHostKey: fromBase64(intro.peer.publicKey),
      }),
      acceptViewer(hostSide.link, auth, { grants, authorize: async () => 'allow' }),
    ]);
    assert.deepEqual(viewerSession.root, hostSession.root);

    /* Negotiation over the relay, with scripted peers: this checks the message
       path, not WebRTC itself (that needs a browser, and is covered by the
       Electron tests). */
    const FP = 'BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD';
    const sdp = kind => `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${FP}\r\na=${kind}\r\n`;
    const adapter = (name, log) => {
      let emit = () => {};
      let connect;
      const connected = new Promise(r => { connect = r; });
      return {
        async createOffer() { setTimeout(() => { emit({ candidate: `c-${name}` }); emit(null); }, 5); return sdp('offer'); },
        async answer() { setTimeout(() => { emit({ candidate: `c-${name}` }); emit(null); }, 5); return sdp('answer'); },
        async applyAnswer() { log.push(`${name}:answer-applied`); },
        async addRemoteCandidate(c) { log.push(`${name}:${c ? c.candidate : 'end'}`); if (c === null) connect(); },
        onLocalCandidate(h) { emit = h; },
        connected: ms => Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('ice timeout')), ms))]),
      };
    };
    const log = [];
    await Promise.all([
      negotiateAsViewer(viewerSession.control, adapter('viewer', log), 8000),
      negotiateAsHost(hostSession.control, adapter('host', log), 8000),
    ]);
    assert.ok(log.includes('viewer:answer-applied'), log.join(','));
    assert.ok(log.includes('host:c-viewer') && log.includes('viewer:c-host'), log.join(','));

    // Ending the session tells the other side through the server.
    const ended = new Promise(resolve => hostSession.control.onClose(resolve));
    viewerSession.control.close();
    await ended;
    host.close();
    viewer.close();
  } finally { await server.close(); }
});

test('when the server goes away, sessions end and the client reports it', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const { hostDevice, host, viewer, incoming } = await pair(server, account);
    const { link } = await viewer.requestSession(hostDevice.deviceId);
    await waitFor(() => incoming.length === 1, 'the host side');

    let closedReason = null;
    link.onClose(err => { closedReason = err?.message ?? 'closed'; });
    await server.close();
    await waitFor(() => closedReason !== null, 'the session to end');
    assert.match(closedReason, /connection to the server was lost|closed/i);
    host.close();
    viewer.close();
  } finally { /* already closed */ }
});

async function waitFor(condition, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}
