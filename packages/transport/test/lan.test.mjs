import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { generateIdentity, deviceIdFromPublicKey } from '@hopdesk/crypto';
import { HostAuthenticator, GrantStore, acceptViewer, connectToHost } from '@hopdesk/protocol';
import { FramedLink, LanListener, connectLan } from '../dist/index.js';

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

async function socketPair() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const accepted = new Promise(r => server.once('connection', r));
  const client = net.connect(server.address().port, '127.0.0.1');
  await new Promise(r => client.once('connect', r));
  const serverSide = await accepted;
  server.close();
  return { client, serverSide };
}

test('frames survive being split byte by byte and coalesced', async () => {
  const { client, serverSide } = await socketPair();
  const link = new FramedLink(serverSide);
  const got = [];
  const msgs = [{ type: 'error', code: 'busy' }, { type: 'sealed', data: 'AAAA' }, { type: 'error', code: 'replay', retryAfterMs: 5 }];
  const bytes = Buffer.concat(msgs.map(m => {
    const body = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32BE(body.length);
    return Buffer.concat([h, body]);
  }));
  for (const b of bytes.subarray(0, 10)) { client.write(Buffer.from([b])); await tick(1); }
  client.write(bytes.subarray(10));
  await tick(50);
  link.onMessage(m => got.push(m));            // messages before a handler are kept
  await tick(20);
  assert.deepEqual(got, msgs);
  client.destroy();
});

test('an oversized frame header or invalid JSON closes the link without buffering', async () => {
  let { client, serverSide } = await socketPair();
  let link = new FramedLink(serverSide, 1024);
  let closedWith = new Promise(r => link.onClose(r));
  const h = Buffer.alloc(4); h.writeUInt32BE(0xffffffff);
  client.write(h);
  assert.match((await closedWith).message, /exceeds/);
  client.destroy();

  ({ client, serverSide } = await socketPair());
  link = new FramedLink(serverSide);
  closedWith = new Promise(r => link.onClose(r));
  const body = Buffer.from('{not json'); const h2 = Buffer.alloc(4); h2.writeUInt32BE(body.length);
  client.write(Buffer.concat([h2, body]));
  assert.match((await closedWith).message, /JSON/);
  client.destroy();
});

function lanHost({ decision = 'allow' } = {}) {
  const identity = generateIdentity();
  const grants = new GrantStore();
  const state = { code: '482913', prompts: 0, sessions: [], errors: [] };
  const auth = new HostAuthenticator({
    identity, hostName: 'LAN host', grants, accessCode: () => state.code, rotateAccessCode: () => {},
  });
  const listener = new LanListener(link => {
    acceptViewer(link, auth, { grants, authorize: async () => { state.prompts++; return decision; } })
      .then(s => state.sessions.push(s), e => state.errors.push(e));
  });
  return { identity, id: deviceIdFromPublicKey(identity.publicKey), listener, state };
}

test('two HopDesk endpoints authenticate and exchange sealed messages over real TCP', async () => {
  const host = lanHost();
  const { port } = await host.listener.listen({ port: 0, host: '127.0.0.1' });
  const link = await connectLan('127.0.0.1', port);
  const session = await connectToHost(link, {
    identity: generateIdentity(), viewerName: 'Viewer', hostId: host.id, credential: { kind: 'code', code: '482 913'.replace(' ', '') },
  });
  assert.equal(host.state.prompts, 1);
  await tick();
  const hostSession = host.state.sessions[0];
  assert.ok(hostSession);
  assert.deepEqual(session.root, hostSession.root);

  const received = new Promise(r => hostSession.control.onMessage(r));
  const bigSdp = `v=0\r\n${'a=x\r\n'.repeat(5000)}`;
  session.control.send({ type: 'rtc-offer', sdp: bigSdp });
  assert.equal((await received).sdp, bigSdp);

  const closed = new Promise(r => hostSession.control.onClose(r));
  session.control.close();
  await closed;
  await host.listener.close();
});

test('over TCP, a wrong code and a rejected prompt are reported to the viewer', async () => {
  const host = lanHost();
  const { port } = await host.listener.listen({ port: 0, host: '127.0.0.1' });
  const viewer = { identity: generateIdentity(), viewerName: 'V', hostId: host.id };
  await assert.rejects(connectToHost(await connectLan('127.0.0.1', port), { ...viewer, credential: { kind: 'code', code: '000000' } }),
    e => e.code === 'bad-auth');
  await host.listener.close();

  const rejecting = lanHost({ decision: 'reject' });
  const r = await rejecting.listener.listen({ port: 0, host: '127.0.0.1' });
  await assert.rejects(connectToHost(await connectLan('127.0.0.1', r.port), { ...viewer, hostId: rejecting.id, credential: { kind: 'code', code: '482913' } }),
    e => e.code === 'rejected' && /user-rejected/.test(e.message));
  await rejecting.listener.close();
});

test('connecting to a port with nothing listening fails promptly', async () => {
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  await assert.rejects(connectLan('127.0.0.1', port, 2000), e => e.code === 'ECONNREFUSED');
});

test('the listener caps concurrent unauthenticated connections', async () => {
  const links = [];
  const listener = new LanListener(link => links.push(link));
  const { port } = await listener.listen({ port: 0, host: '127.0.0.1', maxConnections: 2 });
  const sockets = [];
  for (let i = 0; i < 3; i++) { const s = net.connect(port, '127.0.0.1'); s.on('error', () => {}); sockets.push(s); await tick(30); }
  await tick(50);
  assert.equal(links.length, 2);
  assert.equal(sockets[2].destroyed || sockets[2].readyState === 'closed', true);
  for (const s of sockets) s.destroy();
  await listener.close();
});
