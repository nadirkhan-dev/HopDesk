import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, deviceIdFromPublicKey, toBase64, fromBase64 } from '@hopdesk/crypto';
import {
  HostAuthenticator, GrantStore, AttemptLimiter, acceptViewer, connectToHost, unattendedVerifier, HandshakeError,
} from '../dist/index.js';
import { linkPair } from './helpers/link.mjs';

function makeHost(overrides = {}) {
  const identity = generateIdentity();
  const state = { code: '739421', rotations: 0, prompts: [], decision: 'allow', unattended: null };
  const grants = new GrantStore();
  const auth = new HostAuthenticator({
    identity, hostName: 'Office PC', grants,
    accessCode: () => state.code,
    rotateAccessCode: () => { state.rotations++; state.code = '000111'; },
    unattended: () => state.unattended,
    ...overrides,
  });
  const accept = (link, opts = {}) => acceptViewer(link, auth, {
    grants,
    authorize: async (request) => { state.prompts.push(request); return typeof state.decision === 'function' ? state.decision() : state.decision; },
    ...opts,
  });
  return { identity, id: deviceIdFromPublicKey(identity.publicKey), auth, grants, state, accept };
}

const viewerIdentity = generateIdentity();
const connect = (link, host, extra = {}) => connectToHost(link, {
  identity: viewerIdentity, viewerName: 'Laptop', hostId: host.id, credential: { kind: 'code', code: '739421' }, ...extra,
});

async function run(host, viewerOpts = {}, hostOpts = {}, tap) {
  const { viewer, host: hostLink } = linkPair(tap);
  const [v, h] = await Promise.allSettled([connect(viewer, host, viewerOpts), host.accept(hostLink, hostOpts)]);
  return { v, h, viewer, hostLink };
}

test('a correct access code, once allowed, gives both sides the same encrypted session', async () => {
  const host = makeHost();
  const { v, h } = await run(host);
  assert.equal(v.status, 'fulfilled', v.reason?.stack);
  assert.equal(h.status, 'fulfilled', h.reason?.stack);
  const viewer = v.value, hs = h.value;

  assert.deepEqual(viewer.root, hs.root);
  assert.equal(viewer.sessionId, hs.sessionId);
  assert.deepEqual(viewer.host.hostKey, host.identity.publicKey);
  assert.equal(viewer.host.hostName, 'Office PC');
  assert.equal(hs.viewer.viewerId, deviceIdFromPublicKey(viewerIdentity.publicKey));
  assert.equal(hs.viewer.viewerName, 'Laptop');
  assert.deepEqual(host.state.prompts, [{ viewerId: hs.viewer.viewerId, viewerName: 'Laptop', auth: 'code' }]);
  assert.ok(viewer.grant && viewer.grant.secret.length === 32);

  const got = new Promise(resolve => hs.control.onMessage(resolve));
  viewer.control.send({ type: 'rtc-offer', sdp: 'v=0 fake-but-well-formed' });
  assert.deepEqual(await got, { type: 'rtc-offer', sdp: 'v=0 fake-but-well-formed' });
  const back = new Promise(resolve => viewer.control.onMessage(resolve));
  hs.control.send({ type: 'pong', t: 5 });
  assert.deepEqual(await back, { type: 'pong', t: 5 });
  viewer.control.close();
});

test('the access code never appears on the wire', async () => {
  const host = makeHost();
  const wire = [];
  const { v } = await run(host, {}, {}, (dir, m) => { wire.push(JSON.stringify(m)); return m; });
  assert.equal(v.status, 'fulfilled');
  const all = wire.join('\n');
  assert.ok(!all.includes('739421') && !all.includes('739 421'));
  v.value.control.close();
});

test('a wrong code fails on both sides without a consent prompt, and counts as a failure', async () => {
  const host = makeHost();
  const { v, h } = await run(host, { credential: { kind: 'code', code: '111111' } });
  assert.equal(v.reason.code, 'bad-auth');
  assert.equal(h.status, 'rejected');
  assert.equal(host.state.prompts.length, 0);
  assert.equal(host.auth.limiter.failuresSinceRotation, 1);
});

test('rejecting the prompt, or not answering, refuses the viewer', async () => {
  const host = makeHost();
  host.state.decision = 'reject';
  let r = await run(host);
  assert.equal(r.v.reason.code, 'rejected');
  assert.match(r.v.reason.message, /user-rejected/);
  assert.equal(r.h.reason.code, 'rejected');

  host.state.decision = () => new Promise(() => {});
  r = await run(host, { consentTimeoutMs: 1000 }, { consentTimeoutMs: 50 });
  assert.match(r.v.reason.message, /timeout/);
  assert.equal(host.grants.size, 0, 'a grant was issued without consent');
});

test('the consent prompt is cancelled when the viewer leaves', async () => {
  const host = makeHost();
  let aborted = false;
  let prompted;
  const promptShown = new Promise(resolve => { prompted = resolve; });
  const { viewer, host: hostLink } = linkPair();
  const hostSide = host.accept(hostLink, {
    authorize: (_req, signal) => new Promise(resolve => {
      prompted();
      signal.addEventListener('abort', () => { aborted = true; resolve('allow'); });
    }),
  });
  connect(viewer, host).catch(() => {});
  await promptShown;
  viewer.close();
  await assert.rejects(hostSide, err => err.code === 'closed');
  assert.equal(aborted, true);
  assert.equal(host.grants.size, 0);
});

test('a grant reconnects the same viewer without asking again; other viewers and revoked grants cannot use it', async () => {
  const host = makeHost();
  const first = await run(host);
  const grant = first.v.value.grant;
  first.v.value.control.close();

  const again = await run(host, { credential: { kind: 'grant', id: grant.id, secret: grant.secret } });
  assert.equal(again.v.status, 'fulfilled', again.v.reason?.stack);
  assert.equal(host.state.prompts.length, 1, 'the grant reconnect prompted again');
  assert.equal(again.v.value.grant, undefined);
  again.v.value.control.close();

  const stranger = await run(host, { identity: generateIdentity(), credential: { kind: 'grant', id: grant.id, secret: grant.secret } });
  assert.equal(stranger.v.reason.code, 'grant-invalid');

  const wrongSecret = await run(host, { credential: { kind: 'grant', id: grant.id, secret: new Uint8Array(32) } });
  assert.equal(wrongSecret.v.reason.code, 'bad-auth');

  host.grants.revoke(grant.id);
  const revoked = await run(host, { credential: { kind: 'grant', id: grant.id, secret: grant.secret } });
  assert.equal(revoked.v.reason.code, 'grant-invalid');
});

test('unattended access is refused unless enabled, then works without a prompt', async () => {
  const host = makeHost();
  const cred = { kind: 'unattended', password: 'correct horse battery' };
  assert.equal((await run(host, { credential: cred })).v.reason.code, 'unattended-disabled');

  host.state.unattended = await unattendedVerifier('correct horse battery', host.id);
  const ok = await run(host, { credential: cred });
  assert.equal(ok.v.status, 'fulfilled', ok.v.reason?.stack);
  assert.equal(host.state.prompts.length, 0);
  ok.v.value.control.close();
  assert.equal((await run(host, { credential: { kind: 'unattended', password: 'wrong' } })).v.reason.code, 'bad-auth');
});

test('turning off access by code refuses code connections', async () => {
  const host = makeHost({ accessCode: () => null });
  assert.equal((await run(host)).v.reason.code, 'code-disabled');
});

test('connecting to the wrong Device ID is refused by the host', async () => {
  const host = makeHost();
  const other = makeHost();
  const { v } = await run(host, { hostId: other.id });
  assert.equal(v.reason.code, 'unknown-device');
});

test('a man in the middle cannot substitute its own identity or alter the request', async () => {
  // Each tampered handshake spends a real guess, so each scenario gets a fresh host
  // (otherwise the third one is, correctly, rate limited).
  let host = makeHost();
  const mallory = generateIdentity();

  // Swapping the host key: the Device ID no longer matches.
  let r = await run(host, {}, {}, (dir, m) => (m.type === 'challenge' ? { ...m, hostKey: toBase64(mallory.publicKey) } : m));
  assert.equal(r.v.reason.code, 'identity-mismatch');

  host = makeHost();
  // Changing the name shown in the consent prompt breaks SPAKE2 confirmation.
  r = await run(host, {}, {}, (dir, m) => (m.type === 'hello' ? { ...m, viewerName: 'IT Support' } : m));
  assert.equal(r.v.reason.code, 'bad-auth');
  assert.equal(host.state.prompts.length, 0);

  host = makeHost();
  // A corrupted host signature.
  r = await run(host, {}, {}, (dir, m) => {
    if (m.type !== 'challenge') return m;
    const sig = fromBase64(m.signature); sig[0] ^= 1;
    return { ...m, signature: toBase64(sig) };
  });
  assert.equal(r.v.reason.code, 'identity-mismatch');

  host = makeHost();
  // A pinned key that differs from the one presented.
  r = await run(host, { expectedHostKey: generateIdentity().publicKey });
  assert.equal(r.v.reason.code, 'identity-mismatch');
});

test('tampered or unsealed traffic after the handshake closes the session', async () => {
  const host = makeHost();
  let corrupt = false;
  const { v, h, hostLink } = await run(host, {}, {}, (dir, m) => {
    if (corrupt && m.type === 'sealed') {
      const d = fromBase64(m.data); d[d.length - 1] ^= 1;
      return { ...m, data: toBase64(d) };
    }
    return m;
  });
  assert.equal(v.status, 'fulfilled');
  corrupt = true;
  const closed = new Promise(resolve => h.value.control.onClose(resolve));
  v.value.control.send({ type: 'ping', t: 1 });
  const err = await closed;
  assert.equal(err.code, 'protocol');
  assert.ok(hostLink.closed);

  const second = await run(host);
  const closed2 = new Promise(resolve => second.h.value.control.onClose(resolve));
  second.viewer.send({ type: 'confirm', confirm: toBase64(new Uint8Array(32)), signature: toBase64(new Uint8Array(64)) });
  assert.equal((await closed2).code, 'protocol');
});

test('a replayed hello is refused, as is one from a badly wrong clock', async () => {
  const host = makeHost();
  let recorded;
  const first = await run(host, {}, {}, (dir, m) => { if (m.type === 'hello') recorded = m; return m; });
  first.v.value.control.close();

  const { viewer, host: hostLink } = linkPair();
  const replies = [];
  viewer.onMessage(m => replies.push(m));
  const hostSide = host.accept(hostLink);
  viewer.send(recorded);
  await assert.rejects(hostSide, err => err.code === 'replay');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(replies, [{ type: 'error', code: 'replay' }]);

  const skewed = await run(host, { now: () => Date.now() - 3600_000 });
  assert.equal(skewed.v.reason.code, 'clock-skew');
});

test('repeated wrong codes lock out guessing and rotate the code; abandoned handshakes count', async () => {
  let t = 1_000_000;
  const now = () => t;
  const host = makeHost({ now });
  // Default policy: 3 free failures, then lockout; rotate the code after 10.
  const wrong = { credential: { kind: 'code', code: '222222' }, now };

  for (let i = 0; i < 2; i++) assert.equal((await run(host, wrong)).v.reason.code, 'bad-auth');

  // An attacker that takes the challenge and never answers still spends a guess.
  const { viewer, host: hostLink } = linkPair((dir, m) => (m.type === 'confirm' ? null : m));
  const hostSide = host.accept(hostLink, { handshakeTimeoutMs: 100 });
  connect(viewer, host, { now, handshakeTimeoutMs: 5000 }).catch(() => {});
  await assert.rejects(hostSide, err => err.code === 'timeout');
  viewer.close();
  assert.equal(host.auth.limiter.failuresSinceRotation, 3);

  const locked = await run(host, { now });
  assert.equal(locked.v.reason.code, 'rate-limited');
  assert.ok(locked.v.reason.retryAfterMs > 0);

  for (let i = 0; i < 7; i++) {
    t += 10 * 60_000;
    assert.equal((await run(host, wrong)).v.reason.code, 'bad-auth');
  }
  assert.equal(host.state.rotations, 1);
  assert.equal(host.state.code, '000111');
  t += 10 * 60_000;
  assert.equal((await run(host, { now })).v.reason.code, 'bad-auth', 'the old code still worked after rotation');
});
