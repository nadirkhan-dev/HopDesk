import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, deviceIdFromPublicKey } from '@hopdesk/crypto';
import { HostAuthenticator, GrantStore, acceptViewer, connectToHost } from '@hopdesk/protocol';
import { negotiateAsViewer, negotiateAsHost, LanListener, connectLan } from '../dist/index.js';

/**
 * These tests cover the negotiation *rules* over a real sealed TCP session.
 * The PeerAdapter here is a scripted stand-in, not WebRTC: it proves message
 * order, candidate buffering and SDP checks, and says nothing about whether a
 * real RTCPeerConnection connects (that is verified in the Electron tests).
 */

const FP = 'BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD';
const sdp = kind => `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${FP}\r\na=${kind}\r\n`;

function scriptedAdapter(name, log, { offer = sdp('offer'), answerSdp = sdp('answer') } = {}) {
  let emit = () => {};
  let connect;
  const connected = new Promise(r => { connect = r; });
  let remoteDescribed = false;
  return {
    async createOffer() { log.push(`${name}:offer`); setTimeout(() => { emit({ candidate: `candidate:${name}`, sdpMid: '0' }); emit(null); }, 5); return offer; },
    async answer(o) { log.push(`${name}:answer(${/a=offer/.test(o)})`); remoteDescribed = true; setTimeout(() => { emit({ candidate: `candidate:${name}`, sdpMLineIndex: 0 }); emit(null); }, 5); return answerSdp; },
    async applyAnswer(a) { log.push(`${name}:applyAnswer(${/a=answer/.test(a)})`); remoteDescribed = true; },
    async addRemoteCandidate(c) {
      assert.ok(remoteDescribed, `${name} got a candidate before the remote description`);
      log.push(`${name}:cand(${c ? c.candidate : 'end'})`);
      if (c === null) connect();
    },
    onLocalCandidate(h) { emit = h; },
    connected: timeout => Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('ICE timeout')), timeout))]),
  };
}

async function sessionPair() {
  const identity = generateIdentity();
  const grants = new GrantStore();
  const auth = new HostAuthenticator({ identity, hostName: 'h', grants, accessCode: () => '123456', rotateAccessCode: () => {} });
  let hostSession;
  const ready = new Promise(r => { hostSession = r; });
  const listener = new LanListener(link => acceptViewer(link, auth, { grants, authorize: async () => 'allow' }).then(hostSession));
  const { port } = await listener.listen({ port: 0, host: '127.0.0.1' });
  const viewer = await connectToHost(await connectLan('127.0.0.1', port), {
    identity: generateIdentity(), viewerName: 'v', hostId: deviceIdFromPublicKey(identity.publicKey), credential: { kind: 'code', code: '123456' },
  });
  return { viewer, host: await ready, listener };
}

test('viewer offers, host answers, and candidates are exchanged in a valid order', async () => {
  const { viewer, host, listener } = await sessionPair();
  const log = [];
  await Promise.all([
    negotiateAsViewer(viewer.control, scriptedAdapter('viewer', log), 3000),
    negotiateAsHost(host.control, scriptedAdapter('host', log), 3000),
  ]);
  assert.ok(log.includes('host:answer(true)'));
  assert.ok(log.includes('viewer:applyAnswer(true)'));
  assert.ok(log.includes('host:cand(candidate:viewer)') && log.includes('viewer:cand(candidate:host)'));
  viewer.control.close();
  await listener.close();
});

test('an insecure answer aborts negotiation on the viewer and tells the host', async () => {
  const { viewer, host, listener } = await sessionPair();
  const log = [];
  const insecure = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
  const results = await Promise.allSettled([
    negotiateAsViewer(viewer.control, scriptedAdapter('viewer', log), 3000),
    negotiateAsHost(host.control, scriptedAdapter('host', log, { answerSdp: insecure }), 3000),
  ]);
  assert.match(results[0].reason.message, /fingerprint/);
  assert.match(results[1].reason.message, /ended the session \(error\)/);
  assert.ok(!log.includes('viewer:applyAnswer(true)') && !log.includes('viewer:applyAnswer(false)'));
  viewer.control.close();
  await listener.close();
});
