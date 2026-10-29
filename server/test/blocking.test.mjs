import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  generateIdentity, deviceIdFromPublicKey, identityFromSecretKey, toBase64, fromBase64, sign, verify, utf8,
} from '@hopdesk/crypto';
import { VERDICT_LABEL, verdictBytes } from '@hopdesk/protocol';
import { testServer, client } from './helpers/server.mjs';
import { enrolDevice, signIn } from './helpers/device.mjs';

/**
 * Disabling an installation from the outside.
 *
 * The thing being tested is not that a flag flips - it is that a blocked
 * installation actually stops: its credential dies, the socket it is holding
 * closes, the sessions being relayed through it end, and registering again
 * does not wash the block off. A block that only shows up in a list is not a
 * block.
 */

const AUTH_KEY = toBase64(randomBytes(32));
// Exactly as the server hashes it (server/src/tokens.ts hashToken).
const hash = token => createHash('sha256').update(token).digest('base64');

/** A server with the authorization service switched on, and an administrator. */
async function serverWithAdmin() {
  const server = await testServer({ HOPDESK_AUTH_SIGNING_KEY: AUTH_KEY, HOPDESK_AUTH_GRACE_HOURS: '168' });
  const token = `hda_${randomBytes(32).toString('base64url')}`;
  server.store.createAdmin('owner@example.com', hash(token), Date.now());
  return { server, adminToken: token };
}

/** An installation registering itself, exactly as the client does. */
async function registerInstallation(server, identity = generateIdentity(), os = 'linux') {
  const installationId = deviceIdFromPublicKey(identity.publicKey);
  const { body: challenge } = await server.call('POST', '/api/installations/challenge', {});
  const signature = toBase64(sign(identity, 'hopdesk/installation/register/v1',
    utf8(`${challenge.nonce}\0${installationId}`)));
  const answer = await server.call('POST', '/api/installations/register', {
    body: { installationId, publicKey: toBase64(identity.publicKey), nonce: challenge.nonce, signature, os, appVersion: '0.2.8' },
  });
  return { identity, installationId, answer, token: answer.body?.token };
}

test('an installation registers, is told it may run, and the answer is signed', async () => {
  const { server } = await serverWithAdmin();
  try {
    const { installationId, answer, token } = await registerInstallation(server);
    assert.equal(answer.status, 201);
    assert.equal(answer.body.status, 'active');
    assert.ok(token.startsWith('hdi_'));

    /* Signed, because a client has to tell this server's answer from anything
       else that might reply to it - a proxy, a hosts file, a server of the
       blocked person's own. The client checks exactly this, against a public
       key built into it. */
    const { token: _token, signature, ...statement } = answer.body;
    void _token;
    const serverKey = identityFromSecretKey(fromBase64(AUTH_KEY)).publicKey;
    assert.equal(verify(serverKey, VERDICT_LABEL, verdictBytes(statement), fromBase64(signature)),
      true, 'the verdict was not signed by this server');
    assert.equal(statement.installationId, installationId);
    assert.ok(statement.validUntil > statement.checkedAt, 'no grace window in the verdict');

    // A verdict signed by anybody else must not verify.
    const impostor = generateIdentity();
    const forged = toBase64(sign(impostor, VERDICT_LABEL, verdictBytes(statement)));
    assert.equal(verify(serverKey, VERDICT_LABEL, verdictBytes(statement), fromBase64(forged)),
      false, 'a forged verdict verified against this server\'s key');
  } finally { await server.close(); }
});

test('an installation cannot register as another one', async () => {
  const { server } = await serverWithAdmin();
  try {
    const mine = generateIdentity();
    const someoneElse = generateIdentity();
    const { body: challenge } = await server.call('POST', '/api/installations/challenge', {});
    // Signing with my key while claiming their id - which is how one
    // installation would inherit another's standing, or shed its own block.
    const signature = toBase64(sign(mine, 'hopdesk/installation/register/v1',
      utf8(`${challenge.nonce}\0${deviceIdFromPublicKey(someoneElse.publicKey)}`)));
    const answer = await server.call('POST', '/api/installations/register', {
      body: {
        installationId: deviceIdFromPublicKey(someoneElse.publicKey),
        publicKey: toBase64(mine.publicKey),
        nonce: challenge.nonce, signature,
      },
    });
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'key-mismatch');
  } finally { await server.close(); }
});

test('blocking an installation: it is told, and it cannot register the block away', async () => {
  const { server, adminToken } = await serverWithAdmin();
  try {
    const { identity, installationId, token } = await registerInstallation(server);

    const blocked = await server.call('POST', `/api/admin/installations/${installationId}/block`,
      { token: adminToken, body: { reason: 'licence shared' } });
    assert.equal(blocked.status, 200);

    // What the installation is told when it next asks.
    const verdict = await server.call('POST', '/api/installations/verify', { body: { token } });
    assert.equal(verdict.status, 200);
    assert.equal(verdict.body.status, 'blocked');
    assert.equal(verdict.body.reason, 'licence shared');

    /* Reinstalling over it keeps the block: the record stays, which is the
       whole reason blocking is not removal. */
    const again = await registerInstallation(server, identity);
    assert.equal(again.answer.body.status, 'blocked', 'registering again cleared the block');

    // And it is reversible, with the history to show for it.
    await server.call('POST', `/api/admin/installations/${installationId}/unblock`, { token: adminToken });
    const after = await server.call('POST', '/api/installations/verify', { body: { token: again.token } });
    assert.equal(after.body.status, 'active');

    const history = await server.call('GET', `/api/admin/installations/${installationId}/history`, { token: adminToken });
    assert.deepEqual(history.body.events.map(e => e.action), ['unblock', 'block']);
    assert.equal(history.body.events[1].reason, 'licence shared');
  } finally { await server.close(); }
});

test('a blocked account device loses the relay, and its live session ends with it', async () => {
  const { server, adminToken } = await serverWithAdmin();
  try {
    const session = await signIn(server);
    const host = await enrolDevice(server, session, 'Studio Mac');
    const viewer = await enrolDevice(server, session, 'Office Linux');

    const a = client(server.ws);
    await a.open;
    a.send({ type: 'auth', token: host.deviceToken });
    await a.next(m => m.type === 'ready');
    const b = client(server.ws);
    await b.open;
    b.send({ type: 'auth', token: viewer.deviceToken });
    await b.next(m => m.type === 'ready');

    // A session actually running between them.
    b.send({ type: 'connect', target: host.deviceId });
    const intro = await b.next(m => m.type === 'session');
    assert.ok(intro.sessionId);

    // Blocked while connected.
    const answer = await server.call('POST', `/api/admin/installations/${viewer.deviceId}/block`,
      { token: adminToken, body: { reason: 'blocked mid-session' } });
    assert.equal(answer.status, 200);

    /* The socket goes, and with it the session - both ends are told, so the
       host is not left showing a viewer that is gone. */
    const closed = await b.closed;
    assert.ok(closed.code >= 4000, `the blocked device kept its socket: ${JSON.stringify(closed)}`);
    await a.next(m => m.type === 'session-ended');

    // And it cannot come back.
    const retry = client(server.ws);
    await retry.open;
    retry.send({ type: 'auth', token: viewer.deviceToken });
    const refused = await retry.closed;
    assert.equal(refused.code, 4006, `expected the disabled code, got ${JSON.stringify(refused)}`);
    assert.match(refused.reason, /disabled/i);

    // Its account credentials are refused over HTTP too, not just the relay.
    const listed = await server.call('GET', '/api/devices', { token: viewer.deviceToken });
    assert.equal(listed.status, 401);
    a.close();
  } finally { await server.close(); }
});

test('blocking an account disables every computer signed in to it', async () => {
  const { server, adminToken } = await serverWithAdmin();
  try {
    const session = await signIn(server);
    const first = await enrolDevice(server, session, 'Studio Mac');
    const second = await enrolDevice(server, session, 'Office Linux');

    const answer = await server.call('POST', `/api/admin/accounts/${session.account.id}/block`,
      { token: adminToken, body: { reason: 'account closed' } });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.installations, 2);

    for (const device of [first, second]) {
      const listed = await server.call('GET', '/api/devices', { token: device.deviceToken });
      assert.equal(listed.status, 401, `${device.name} still had the account API`);
    }
    // Signing in again does not help: the account itself is disabled.
    const login = await server.call('POST', '/api/login',
      { body: { email: 'owner@example.com', password: 'a-long-enough-password' } });
    const token = login.body?.accessToken;
    if (token) assert.equal((await server.call('GET', '/api/devices', { token })).status, 401);
  } finally { await server.close(); }
});

test('administration is refused to everyone else', async () => {
  const { server, adminToken } = await serverWithAdmin();
  try {
    const session = await signIn(server);
    const device = await enrolDevice(server, session, 'Studio Mac');

    for (const [who, token] of [['nobody', undefined], ['a sign-in', session.accessToken], ['a device', device.deviceToken]]) {
      const answer = await server.call('GET', '/api/admin/installations', token ? { token } : {});
      assert.equal(answer.status, 401, `${who} could read the installation list`);
      const block = await server.call('POST', `/api/admin/installations/${device.deviceId}/block`,
        token ? { token } : {});
      assert.equal(block.status, 401, `${who} could block a computer`);
    }

    // The administrator can.
    const ok = await server.call('GET', '/api/admin/installations', { token: adminToken });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.devices));
  } finally { await server.close(); }
});

test('with no signing key, the authorization service is off and says so', async () => {
  /* A server that was never set up to authorize must not answer questions
     about it - least of all with a cheerful "active". */
  const server = await testServer();
  try {
    const answer = await server.call('POST', '/api/installations/challenge', {});
    assert.equal(answer.status, 501);
    assert.equal(answer.body.error, 'authorization-not-enabled');
  } finally { await server.close(); }
});

test('a block applied from the command line reaches a socket already open', async () => {
  /* The administrative HTTP route closes the socket itself. The command line
     cannot: it is another process, with no access to this one's sockets, and
     it is the interface the documentation recommends. Without the server
     looking for itself, a computer blocked while connected would keep the
     relay - and keep starting sessions on it - until it chose to reconnect. */
  const { server } = await serverWithAdmin();
  try {
    const session = await signIn(server);
    const host = await enrolDevice(server, session, 'Studio Mac');
    const viewer = await enrolDevice(server, session, 'Office Linux');

    const a = client(server.ws);
    await a.open;
    a.send({ type: 'auth', token: host.deviceToken });
    await a.next(m => m.type === 'ready');
    const b = client(server.ws);
    await b.open;
    b.send({ type: 'auth', token: viewer.deviceToken });
    await b.next(m => m.type === 'ready');
    b.send({ type: 'connect', target: host.deviceId });
    await b.next(m => m.type === 'session');

    /* Exactly what `hopdesk-admin block` does: the database, and nothing
       else. No HTTP route is called, so nothing closes the socket here. */
    const now = Date.now();
    server.store.blockInstallation(viewer.deviceId, now, 'licence shared', 'cli');
    server.store.blockDevice(viewer.deviceId, now, 'licence shared', 'cli');

    // What the server does of its own accord, a sweep at a time.
    server.signaling.dropBlocked();

    const closed = await b.closed;
    assert.equal(closed.code, 4006, `the blocked device kept its socket: ${JSON.stringify(closed)}`);
    // The session it was carrying ends with the socket, and the host is told.
    await a.next(m => m.type === 'session-ended');
    a.close();
  } finally { await server.close(); }
});

test('a device blocked while connected cannot start one more session', async () => {
  /* Belt as well as braces: between a block being applied and the sweep
     noticing, the socket is still open and still authenticated. */
  const { server } = await serverWithAdmin();
  try {
    const session = await signIn(server);
    const host = await enrolDevice(server, session, 'Studio Mac');
    const viewer = await enrolDevice(server, session, 'Office Linux');

    const a = client(server.ws);
    await a.open;
    a.send({ type: 'auth', token: host.deviceToken });
    await a.next(m => m.type === 'ready');
    const b = client(server.ws);
    await b.open;
    b.send({ type: 'auth', token: viewer.deviceToken });
    await b.next(m => m.type === 'ready');

    server.store.blockDevice(viewer.deviceId, Date.now(), null, 'cli');
    b.send({ type: 'connect', target: host.deviceId });

    const closed = await b.closed;
    assert.equal(closed.code, 4006, `it was introduced anyway: ${JSON.stringify(closed)}`);
    a.close();
  } finally { await server.close(); }
});

test('a blocked computer is not offered to the one trying to reach it', async () => {
  const { server } = await serverWithAdmin();
  try {
    const session = await signIn(server);
    const host = await enrolDevice(server, session, 'Studio Mac');
    const viewer = await enrolDevice(server, session, 'Office Linux');

    const a = client(server.ws);
    await a.open;
    a.send({ type: 'auth', token: host.deviceToken });
    await a.next(m => m.type === 'ready');
    const b = client(server.ws);
    await b.open;
    b.send({ type: 'auth', token: viewer.deviceToken });
    await b.next(m => m.type === 'ready');

    // The host is blocked but still holding its socket, as above.
    server.store.blockDevice(host.deviceId, Date.now(), null, 'cli');
    b.send({ type: 'connect', target: host.deviceId });

    /* Reported as unreachable rather than as blocked: what was done to that
       computer is between its owner and the administrator. */
    const failed = await b.next(m => m.type === 'connect-failed');
    assert.equal(failed.reason, 'offline');
    a.close();
    b.close();
  } finally { await server.close(); }
});

test('the open authorization routes are rate-limited', async () => {
  /* Both of them need no credential, and each answer costs a signature. An
     installation asks twice a day; this is what stops it being asked
     thousands of times a minute by somebody else. */
  const { server } = await serverWithAdmin();
  try {
    const { token } = await registerInstallation(server);
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const answer = await server.call('POST', '/api/installations/verify', { body: { token } });
      if (answer.status === 429) { limited++; }
    }
    assert.ok(limited > 0, 'the verify route answered forty times without a limit');

    const challenge = await server.call('POST', '/api/installations/challenge', {});
    assert.equal(challenge.status, 429, 'the challenge route shares the limit');
  } finally { await server.close(); }
});

test('what was done to a computer is kept, and read back in order', async () => {
  /* The point of keeping this is the decision an administrator has to make:
     before disabling a computer, when did it join, who let it on, and has
     anything been done to it since. The text log answers that until it
     rotates, which is to say not when it matters. */
  const { server, adminToken } = await serverWithAdmin();
  try {
    const session = await signIn(server);
    const first = await enrolDevice(server, session, 'Studio Mac');
    const second = await enrolDevice(server, session, 'Office Linux');

    await server.call('POST', `/api/admin/installations/${second.deviceId}/block`,
      { token: adminToken, body: { reason: 'licence shared' } });

    const { status, body } = await server.call('GET',
      `/api/admin/installations/${second.deviceId}/history`, { token: adminToken });
    assert.equal(status, 200);
    const actions = body.events.map(e => e.action);
    // Newest first: blocked, then approved by the first computer, then enrolled.
    assert.equal(actions[0], 'block');
    assert.ok(actions.includes('enrolled') || actions.includes('enrolled-waiting'), actions.join(','));

    const blocked = body.events.find(e => e.action === 'block');
    assert.equal(blocked.actor, 'owner@example.com');
    assert.equal(blocked.reason, 'licence shared');

    const enrolled = body.events.find(e => e.action.startsWith('enrolled'));
    assert.match(enrolled.actor, /^account:/);
    assert.equal(enrolled.reason, 'Office Linux');

    // The first computer's own history is separate, and does not have the block.
    const other = await server.call('GET',
      `/api/admin/installations/${first.deviceId}/history`, { token: adminToken });
    assert.ok(!other.body.events.some(e => e.action === 'block'));

    // And the record is not kept for ever.
    assert.equal(server.store.pruneEvents(Date.now() + 1), body.events.length + other.body.events.length);
  } finally { await server.close(); }
});
