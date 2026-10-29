import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateIdentity, identityFromSecretKey, toBase64 } from '@hopdesk/crypto';
import { RelayClient } from '@hopdesk/transport';
import { Authorization, installationIdFor } from '../../apps/desktop/dist/authorization.js';
import { testServer } from './helpers/server.mjs';
import { enrolDevice, signIn } from './helpers/device.mjs';

/**
 * The whole arrangement, end to end, with nothing stubbed out.
 *
 * Every other test here proves one piece: that a verdict verifies, that a
 * socket closes, that a gate refuses. This one walks the path a person
 * actually walks - install, register, be approved, connect, be blocked
 * mid-session, fail to come back, be unblocked, come back - against a real
 * server over real HTTP and a real WebSocket, with the client's own
 * authorization code doing the asking. If this passes, the feature works; if
 * it does not, nothing else here matters.
 */

const AUTH_KEY = toBase64(randomBytes(32));
const SERVICE = identityFromSecretKey(Buffer.from(AUTH_KEY, 'base64'));
const hash = token => createHash('sha256').update(token).digest('base64');
const quiet = { info: () => {}, warn: () => {} };

/** The client's authorization, pointed at a server that is really running. */
async function installation(server) {
  const identity = generateIdentity();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hopdesk-e2e-auth-'));
  const stored = new Map();
  const authorization = new Authorization({
    dataDir,
    identity,
    installationId: installationIdFor(identity),
    storage: {
      get: async name => stored.get(name) ?? null,
      set: async (name, value) => { stored.set(name, value); },
      delete: async name => { stored.delete(name); },
    },
    serviceUrl: server.base,
    servicePublicKey: SERVICE.publicKey,
    appVersion: '0.2.8',
    os: 'linux',
    log: quiet,
  });
  return { authorization, installationId: installationIdFor(identity), dataDir };
}

test('the whole flow: register, approve, connect, block, reconnect refused, unblock, connect again', async () => {
  const server = await testServer({
    HOPDESK_AUTH_SIGNING_KEY: AUTH_KEY,
    HOPDESK_AUTH_GRACE_HOURS: '168',
  }, { revocationSweepMs: 200 });
  const adminToken = `hda_${randomBytes(32).toString('base64url')}`;
  server.store.createAdmin('owner@example.com', hash(adminToken), Date.now());

  try {
    /* 1. A fresh install registers itself and is told it may run. The answer
          is signed by the service and checked against the key the build
          carries - this is the client's own code doing it, not the test. */
    const { authorization, installationId } = await installation(server);
    let status = await authorization.check();
    assert.equal(status.state, 'active', `a fresh installation was not allowed: ${status.detail}`);
    assert.equal(authorization.mayHost(), true);
    assert.equal(server.store.installationById(installationId)?.blockedAt, null);

    /* 2. It signs in to an account. The first computer vouches for itself;
          the second waits to be approved, and is. */
    const session = await signIn(server);
    const host = await enrolDevice(server, session, 'Studio Mac');
    assert.equal(host.approved, true, 'the first computer on an account should vouch for itself');
    const viewer = await enrolDevice(server, session, 'Office Linux', { approve: false });
    assert.equal(viewer.approved, false, 'the second computer should wait');
    assert.equal((await server.call('GET', '/api/devices', { token: viewer.deviceToken })).status, 200,
      'a computer waiting for approval should still be able to sign in and be told so');
    const approved = await enrolDevice(server, session, 'Office Linux 2');
    assert.equal(approved.approved, true, 'approval from an approved computer should work');

    /* 3. Both connect to the relay and a session runs between them. */
    const incoming = [];
    const hostClient = new RelayClient({
      url: server.ws, token: host.deviceToken, reconnect: false,
      onIncoming: (intro, link) => incoming.push({ intro, link }),
    });
    const states = [];
    const viewerClient = new RelayClient({
      url: server.ws, token: approved.deviceToken, reconnect: false,
      onIncoming: () => {},
      onState: (state, detail) => states.push([state, detail]),
    });
    await hostClient.connect();
    await viewerClient.connect();
    const { intro, link } = await viewerClient.requestSession(host.deviceId);
    assert.equal(intro.role, 'viewer');
    await waitFor(() => incoming.length === 1, 'the host to be told about the session');
    // A frame really travels between them, so this is a session and not a row.
    const seen = [];
    incoming[0].link.onMessage(m => seen.push(m));
    link.send({ type: 'error', code: 'busy' });
    await waitFor(() => seen.length === 1, 'a frame to cross the relay');

    /* 4. The viewer's computer is blocked exactly as `hopdesk-admin block`
          does it: the database, from another process, closing nothing. */
    const now = Date.now();
    server.store.blockInstallation(approved.deviceId, now, 'licence shared', 'cli');
    server.store.blockDevice(approved.deviceId, now, 'licence shared', 'cli');

    /* 5. The live session ends, because the server closes the socket of its
          own accord within a sweep. */
    await waitFor(() => states.some(([s]) => s === 'offline'), 'the blocked computer to lose the relay');
    assert.equal(viewerClient.deviceSessions.length, 0, 'the blocked computer kept its session');
    assert.equal(viewerClient.connected, false);

    /* 6. It cannot come back, and does not keep trying. */
    const again = new RelayClient({
      url: server.ws, token: approved.deviceToken, reconnect: false, onIncoming: () => {},
    });
    await assert.rejects(again.connect(), e => e.code === 'unauthorised',
      'a blocked computer was let back onto the relay');
    assert.equal((await server.call('GET', '/api/devices', { token: approved.deviceToken })).status, 401,
      'a blocked computer kept the account API');

    /* 7. And the installation is told, in a signed answer, that it may not
          host - which is the half that reaches a local network. */
    const { authorization: blockedSide, installationId: blockedId } = await installation(server);
    assert.equal((await blockedSide.check()).state, 'active');
    server.store.blockInstallation(blockedId, now, 'licence shared', 'cli');
    const after = await blockedSide.check();
    assert.equal(after.state, 'blocked', `the installation was not told: ${JSON.stringify(after)}`);
    assert.equal(after.reason, 'licence shared');
    assert.equal(blockedSide.mayHost(), false, 'a blocked installation still thinks it may host');

    /* 8. Unblocked, everything comes back - no reinstall, no new credential. */
    const answer = await server.call('POST', `/api/admin/installations/${approved.deviceId}/unblock`,
      { token: adminToken });
    assert.equal(answer.status, 200);
    const back = new RelayClient({
      url: server.ws, token: approved.deviceToken, reconnect: false, onIncoming: () => {},
    });
    await back.connect();
    const resumed = await back.requestSession(host.deviceId);
    assert.equal(resumed.intro.role, 'viewer', 'an unblocked computer could not be introduced again');
    assert.equal(resumed.intro.peer.deviceId, host.deviceId);
    // Its account credentials work again too, with the token it already had.
    assert.equal((await server.call('GET', '/api/devices', { token: approved.deviceToken })).status, 200);

    back.close();
    hostClient.close();
    viewerClient.close();
  } finally {
    await server.close();
  }
});

async function waitFor(condition, what, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('blocking the person, not the computer: every computer on the account, at once', async () => {
  /* The decisive form for anything through this server. A person with three
     computers is one account, and blocking them one computer at a time is a
     race they can win by signing in on a fourth. */
  const server = await testServer({ HOPDESK_AUTH_SIGNING_KEY: AUTH_KEY }, { revocationSweepMs: 200 });
  try {
    const session = await signIn(server);
    const first = await enrolDevice(server, session, 'Studio Mac');
    const second = await enrolDevice(server, session, 'Office Linux');

    const clients = [];
    for (const device of [first, second]) {
      const states = [];
      const client = new RelayClient({
        url: server.ws, token: device.deviceToken, reconnect: false,
        onIncoming: () => {}, onState: (s, d) => states.push([s, d]),
      });
      await client.connect();
      assert.equal(client.connected, true);
      clients.push({ client, states, device });
    }

    // Exactly what `hopdesk-admin block-account` does: the database alone.
    const account = server.store.accountByEmail(session.account.email);
    assert.ok(account, 'the account should be findable by the address it signed up with');
    server.store.blockAccount(account.id, Date.now(), 'not paid', 'cli');

    for (const { client, states, device } of clients) {
      await waitFor(() => states.some(([s]) => s === 'offline'),
        `${device.name} to lose the relay`);
      assert.equal(client.connected, false);
    }

    // And nobody on it can sign in again, with a password or with a token.
    const signInAgain = await server.call('POST', '/api/login',
      { body: { email: session.account.email, password: 'a-long-enough-password' } });
    assert.ok(signInAgain.status >= 400, `a blocked account signed in: ${signInAgain.status}`);
    assert.equal((await server.call('GET', '/api/devices', { token: first.deviceToken })).status, 401);

    // Unblocked, the computers reconnect with the tokens they already had.
    server.store.unblockAccount(account.id);
    const back = new RelayClient({
      url: server.ws, token: first.deviceToken, reconnect: false, onIncoming: () => {},
    });
    await back.connect();
    assert.equal(back.connected, true);
    back.close();
    for (const { client } of clients) client.close();
  } finally { await server.close(); }
});
