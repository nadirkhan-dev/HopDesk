import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, deviceIdFromPublicKey, toBase64 } from '@hopdesk/crypto';
import { testServer, client } from './helpers/server.mjs';
import { enrolDevice, enrolSignature, signIn } from './helpers/device.mjs';

test('an account is created, signed into, and its password is never stored in the clear', async () => {
  const server = await testServer();
  try {
    const password = 'correct-horse-battery';
    assert.equal((await server.call('POST', '/api/register', { body: { email: 'a@example.com', password } })).status, 201);
    assert.equal((await server.call('POST', '/api/register', { body: { email: 'a@example.com', password } })).status, 409);

    const login = await server.call('POST', '/api/login', { body: { email: 'a@example.com', password } });
    assert.equal(login.status, 200);
    assert.ok(login.body.accessToken && login.body.refreshToken);
    assert.equal(login.body.account.email, 'a@example.com');

    // The stored value is a scrypt hash, and nothing resembling the password.
    const stored = server.store.accountByEmail('a@example.com');
    assert.match(stored.passwordHash, /^scrypt\$32768\$8\$1\$/);
    assert.ok(!stored.passwordHash.includes(password));

    assert.equal((await server.call('POST', '/api/login', { body: { email: 'a@example.com', password: 'wrong' } })).status, 401);
    // An unknown account answers the same way as a wrong password.
    assert.equal((await server.call('POST', '/api/login', { body: { email: 'nobody@example.com', password } })).status, 401);
  } finally { await server.close(); }
});

test('with no token and no open registration, nobody can create an account', async () => {
  /* Not even the first one: "whoever registers first wins" is a race that
     anyone who finds the server before its owner can win. */
  const server = await testServer({ HOPDESK_REGISTRATION_OPEN: 'false' });
  try {
    const first = await server.call('POST', '/api/register', { body: { email: 'first@example.com', password: 'a-long-password' } });
    assert.equal(first.status, 403);
    assert.equal(first.body.error, 'registration-closed');
    assert.equal(server.store.countAccounts(), 0);
  } finally { await server.close(); }
});

test('with a registration token, only someone who has it can create an account', async () => {
  const token = 'a-deploy-time-registration-token';
  const server = await testServer({ HOPDESK_REGISTRATION_OPEN: 'false', HOPDESK_REGISTRATION_TOKEN: token });
  try {
    const missing = await server.call('POST', '/api/register', { body: { email: 'a@example.com', password: 'a-long-password' } });
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error, 'bad-registration-token');

    const wrong = await server.call('POST', '/api/register', { body: { email: 'a@example.com', password: 'a-long-password', token: 'not-the-token' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error, 'bad-registration-token');
    assert.equal(server.store.countAccounts(), 0, 'a refused registration created an account');

    const right = await server.call('POST', '/api/register', { body: { email: 'a@example.com', password: 'a-long-password', token } });
    assert.equal(right.status, 201);
    // The token stays usable: it is the owner's, to hand out as they choose.
    assert.equal((await server.call('POST', '/api/register', { body: { email: 'b@example.com', password: 'a-long-password', token } })).status, 201);
    assert.equal(server.store.countAccounts(), 2);
    // And it is never echoed back to a client.
    assert.ok(!JSON.stringify(right.body).includes(token));
  } finally { await server.close(); }
});

test('guessing the registration token is throttled', async () => {
  const server = await testServer({ HOPDESK_REGISTRATION_OPEN: 'false', HOPDESK_REGISTRATION_TOKEN: 'a-deploy-time-registration-token' });
  try {
    let last;
    for (let i = 0; i < 12; i++) {
      last = await server.call('POST', '/api/register', { body: { email: `x${i}@example.com`, password: 'a-long-password', token: `guess-${i}` } });
    }
    assert.equal(last.status, 429);
    assert.ok(last.body.retryAfterMs > 0);
    // Even the right token waits: the limit is on the attempt, not the answer.
    const correct = await server.call('POST', '/api/register', { body: { email: 'z@example.com', password: 'a-long-password', token: 'a-deploy-time-registration-token' } });
    assert.equal(correct.status, 429);
  } finally { await server.close(); }
});

test('a token that is too short to be a secret is refused at startup', async () => {
  await assert.rejects(
    () => testServer({ HOPDESK_REGISTRATION_OPEN: 'false', HOPDESK_REGISTRATION_TOKEN: 'short' }),
    /at least 16 characters/);
});

test('open registration still works for a server that wants it', async () => {
  const server = await testServer({ HOPDESK_REGISTRATION_OPEN: 'true' });
  try {
    assert.equal((await server.call('POST', '/api/register', { body: { email: 'anyone@example.com', password: 'a-long-password' } })).status, 201);
  } finally { await server.close(); }
});

test('weak passwords and malformed requests are refused with a reason', async () => {
  const server = await testServer();
  try {
    const weak = await server.call('POST', '/api/register', { body: { email: 'b@example.com', password: 'short' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error, 'weak-password');
    assert.equal((await server.call('POST', '/api/register', { body: { email: 'not-an-email', password: 'a-long-password' } })).status, 400);
    assert.equal((await server.call('POST', '/api/login', { body: {} })).status, 400);
  } finally { await server.close(); }
});

test('refresh tokens rotate, and replaying one signs the whole family out', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    const first = await server.call('POST', '/api/token/refresh', { body: { refreshToken: session.refreshToken } });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refreshToken, session.refreshToken, 'the refresh token did not rotate');

    // The rotated-away token is spent: using it again is treated as theft.
    const replay = await server.call('POST', '/api/token/refresh', { body: { refreshToken: session.refreshToken } });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error, 'reused');

    // And the token issued from it no longer works either.
    const after = await server.call('POST', '/api/token/refresh', { body: { refreshToken: first.body.refreshToken } });
    assert.equal(after.status, 401);
    assert.ok(server.logs.some(l => /replayed/.test(l)));
  } finally { await server.close(); }
});

test('signing out revokes the refresh token, and a bad one is refused', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    assert.equal((await server.call('POST', '/api/logout', { body: { refreshToken: session.refreshToken } })).status, 200);
    assert.equal((await server.call('POST', '/api/token/refresh', { body: { refreshToken: session.refreshToken } })).status, 401);
    assert.equal((await server.call('POST', '/api/token/refresh', { body: { refreshToken: 'nonsense.token' } })).status, 401);
  } finally { await server.close(); }
});

test('repeated wrong passwords are throttled, and the lockout is reported', async () => {
  const server = await testServer();
  try {
    await signIn(server, 'c@example.com', 'a-long-enough-password');
    let last;
    for (let i = 0; i < 12; i++) {
      last = await server.call('POST', '/api/login', { body: { email: 'c@example.com', password: 'wrong' } });
    }
    assert.equal(last.status, 429);
    assert.ok(last.body.retryAfterMs > 0);
    // Even the right password waits until the lockout passes.
    assert.equal((await server.call('POST', '/api/login', { body: { email: 'c@example.com', password: 'a-long-enough-password' } })).status, 429);
  } finally { await server.close(); }
});

test('a device is enrolled only with proof that it holds its own key', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    const device = await enrolDevice(server, session, 'Office PC');
    assert.equal(device.response.status, 201);
    assert.ok(device.deviceToken, 'no device token was issued');

    const listed = await server.call('GET', '/api/devices', { token: session.accessToken });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.devices.map(d => [d.deviceId, d.name, d.online]), [[device.deviceId, 'Office PC', false]]);

    /* A stranger's key with someone else's Device ID, and a signature that does
       not match the challenge, are both refused. */
    const other = generateIdentity();
    const { body: challenge } = await server.call('POST', '/api/devices/challenge', { token: session.accessToken });
    const mismatched = await server.call('POST', '/api/devices', {
      token: session.accessToken,
      body: {
        deviceId: device.deviceId, publicKey: toBase64(other.publicKey), name: 'Impostor',
        nonce: challenge.nonce, signature: enrolSignature(other, challenge.nonce, session.account.id),
      },
    });
    assert.equal(mismatched.status, 400);
    assert.equal(mismatched.body.error, 'key-mismatch');

    const { body: challenge2 } = await server.call('POST', '/api/devices/challenge', { token: session.accessToken });
    const forged = await server.call('POST', '/api/devices', {
      token: session.accessToken,
      body: {
        deviceId: deviceIdFromPublicKey(other.publicKey), publicKey: toBase64(other.publicKey), name: 'Forged',
        nonce: challenge2.nonce, signature: enrolSignature(generateIdentity(), challenge2.nonce, session.account.id),
      },
    });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error, 'bad-signature');

    // A challenge is single use.
    const reused = await server.call('POST', '/api/devices', {
      token: session.accessToken,
      body: {
        deviceId: deviceIdFromPublicKey(other.publicKey), publicKey: toBase64(other.publicKey), name: 'Second',
        nonce: challenge2.nonce, signature: enrolSignature(other, challenge2.nonce, session.account.id),
      },
    });
    assert.equal(reused.body.error, 'bad-challenge');
  } finally { await server.close(); }
});

test('a device token authenticates as its own device, and stops working when the device is removed', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    const device = await enrolDevice(server, session);

    // The device can read its account's device list with its own token.
    const listed = await server.call('GET', '/api/devices', { token: device.deviceToken });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.devices[0].self, true);

    assert.equal((await server.call('DELETE', `/api/devices/${device.deviceId}`, { token: session.accessToken })).status, 200);
    assert.equal((await server.call('GET', '/api/devices', { token: device.deviceToken })).status, 401);
    assert.equal((await server.call('DELETE', `/api/devices/${device.deviceId}`, { token: session.accessToken })).status, 404);
  } finally { await server.close(); }
});

test('one account cannot see or remove another account\'s computers', async () => {
  const server = await testServer();
  try {
    const mine = await signIn(server, 'mine@example.com');
    const theirs = await signIn(server, 'theirs@example.com');
    const myDevice = await enrolDevice(server, mine, 'Mine');
    await enrolDevice(server, theirs, 'Theirs');

    const list = await server.call('GET', '/api/devices', { token: theirs.accessToken });
    assert.deepEqual(list.body.devices.map(d => d.name), ['Theirs']);
    assert.equal((await server.call('DELETE', `/api/devices/${myDevice.deviceId}`, { token: theirs.accessToken })).status, 404);
    // And the device is still there.
    assert.equal((await server.call('GET', '/api/devices', { token: mine.accessToken })).body.devices.length, 1);
  } finally { await server.close(); }
});

test('unauthenticated and expired credentials are refused everywhere', async () => {
  const server = await testServer({ HOPDESK_ACCESS_TTL_SECONDS: '1' });
  try {
    for (const route of [['GET', '/api/devices'], ['POST', '/api/devices/challenge'], ['GET', '/api/turn']]) {
      assert.equal((await server.call(route[0], route[1])).status, 401, `${route[1]} without a token`);
      assert.equal((await server.call(route[0], route[1], { token: 'nonsense' })).status, 401, `${route[1]} with a bad token`);
    }
    const session = await signIn(server);
    assert.equal((await server.call('GET', '/api/devices', { token: session.accessToken })).status, 200);
    await new Promise(r => setTimeout(r, 1200));
    assert.equal((await server.call('GET', '/api/devices', { token: session.accessToken })).status, 401, 'an expired access token was accepted');
    assert.equal((await server.call('GET', '/api/unknown')).status, 404);
  } finally { await server.close(); }
});

test('relay credentials are time limited, and absent when no relay is configured', async () => {
  const plain = await testServer();
  try {
    const session = await signIn(plain);
    const none = await plain.call('GET', '/api/turn', { token: session.accessToken });
    assert.deepEqual(none.body, { iceServers: [], relay: false });
  } finally { await plain.close(); }

  const server = await testServer({
    HOPDESK_TURN_SECRET: 'the-turn-shared-secret',
    HOPDESK_TURN_URLS: 'turn:relay.example.com:3478,turns:relay.example.com:5349',
    HOPDESK_TURN_TTL_SECONDS: '600',
  });
  try {
    const session = await signIn(server);
    const device = await enrolDevice(server, session);
    const turn = await server.call('GET', '/api/turn', { token: device.deviceToken });
    assert.equal(turn.status, 200);
    assert.equal(turn.body.relay, true);
    const relay = turn.body.iceServers.find(s => s.username);
    const [expiry, identifier] = relay.username.split(':');
    assert.equal(identifier, device.deviceId);
    const seconds = Number(expiry) - Math.floor(Date.now() / 1000);
    assert.ok(seconds > 500 && seconds <= 600, `credential lasts ${seconds}s`);
    // The secret itself is never handed out.
    assert.ok(!JSON.stringify(turn.body).includes('the-turn-shared-secret'));
    assert.match(relay.credential, /^[A-Za-z0-9+/]+=*$/);
  } finally { await server.close(); }
});

test('a device token can sign that computer out, but cannot touch the account\'s other computers', async () => {
  const server = await testServer();
  try {
    const account = await signIn(server);
    const mine = await enrolDevice(server, account, 'Mine');
    const other = await enrolDevice(server, account, 'Other');

    /* A device token is for staying reachable, not for administering the
       account: it cannot enrol more computers or remove someone else's. */
    assert.equal((await server.call('POST', '/api/devices/challenge', { token: mine.deviceToken })).status, 403);
    const removeOther = await server.call('DELETE', `/api/devices/${other.deviceId}`, { token: mine.deviceToken });
    assert.equal(removeOther.status, 403);
    assert.equal(removeOther.body.error, 'needs-sign-in');
    assert.equal((await server.call('GET', '/api/devices', { token: account.accessToken })).body.devices.length, 2);

    // It may remove itself, which is what signing out on that computer does.
    assert.equal((await server.call('DELETE', `/api/devices/${mine.deviceId}`, { token: mine.deviceToken })).status, 200);
    assert.deepEqual((await server.call('GET', '/api/devices', { token: account.accessToken })).body.devices.map(d => d.name), ['Other']);
  } finally { await server.close(); }
});

/**
 * A computer added to an account has to be vouched for by one already on it.
 *
 * This is the hole the architecture doc admitted to: email and password were
 * enough to add a computer that could then reach every other computer on the
 * account - so anyone who learned the password, or a server that decided to
 * add a machine of its own, was one enrolment away from being let in. Adding
 * is still easy. Being trusted is not.
 */
test('the first computer vouches for itself; the next one waits', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    // Nobody to ask, so the first computer approves itself - otherwise a new
    // account could never approve anything and would be useless.
    const first = await enrolDevice(server, session, 'Studio Mac');
    assert.equal(first.response.body.device.approved, true);

    const second = await enrolDevice(server, session, 'Office Linux', { approve: false });
    assert.equal(second.response.body.device.approved, false, 'a second computer let itself in');

    /* Both are listed - the waiting one has to be visible, with its key, or
       nobody could decide about it - and the list says which is which. */
    const listed = await server.call('GET', '/api/devices', { token: session.accessToken });
    const rows = listed.body.devices.map(d => [d.name, d.approved]);
    assert.deepEqual(rows.sort(), [['Office Linux', false], ['Studio Mac', true]]);
    // With the key, so a person can be shown a fingerprint before deciding.
    assert.ok(listed.body.devices.every(d => typeof d.publicKey === 'string' && d.publicKey.length > 0));
  } finally { await server.close(); }
});

test('a computer waiting for approval cannot use the relay at all', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    const approved = await enrolDevice(server, session, 'Studio Mac');
    const waiting = await enrolDevice(server, session, 'Office Linux', { approve: false });

    /* Refused at the door rather than at the introduction: it cannot reach
       another computer, cannot be reached, and cannot see who is online. */
    const c = client(server.ws);
    await c.open;
    c.send({ type: 'auth', token: waiting.deviceToken });
    const closed = await c.closed;
    /* 4005, not 4003: a computer waiting for approval will be let in when
       somebody says so, and has to keep trying until then - where a computer
       removed from the account must stop. */
    assert.equal(closed.code, 4005, `expected the socket to be refused, got ${JSON.stringify(closed)}`);
    assert.match(closed.reason, /waiting to be approved/i);

    // The approved one is unaffected.
    const ok = client(server.ws);
    await ok.open;
    ok.send({ type: 'auth', token: approved.deviceToken });
    assert.ok(await ok.next(m => m.type === 'ready'));
    ok.close();
  } finally { await server.close(); }
});

test('only an approved computer can approve another, never a password alone', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    const approved = await enrolDevice(server, session, 'Studio Mac');
    const waiting = await enrolDevice(server, session, 'Office Linux', { approve: false });

    /* The whole point: signing in is not enough. If it were, the password
       would still be the only thing standing between an attacker and a
       computer of their own on this account. */
    const bySignIn = await server.call('POST', `/api/devices/${waiting.deviceId}/approve`,
      { token: session.accessToken });
    assert.equal(bySignIn.status, 403);
    assert.equal(bySignIn.body.error, 'needs-approved-device');

    // Nor can a computer that is itself waiting approve anything.
    const alsoWaiting = await enrolDevice(server, session, 'Third', { approve: false });
    const byWaiting = await server.call('POST', `/api/devices/${alsoWaiting.deviceId}/approve`,
      { token: waiting.deviceToken });
    assert.equal(byWaiting.status, 403);

    // An approved computer can, and then the relay lets the new one in.
    const done = await server.call('POST', `/api/devices/${waiting.deviceId}/approve`,
      { token: approved.deviceToken });
    assert.equal(done.status, 200);
    const c = client(server.ws);
    await c.open;
    c.send({ type: 'auth', token: waiting.deviceToken });
    assert.ok(await c.next(m => m.type === 'ready'), 'an approved computer was still refused');
    c.close();
  } finally { await server.close(); }
});

test('approving is scoped to the account, and a computer cannot approve itself', async () => {
  const server = await testServer();
  try {
    const mine = await signIn(server);
    const theirs = await signIn(server, 'someone-else@example.com');
    const myDevice = await enrolDevice(server, mine, 'Mine');
    /* Their first computer vouches for itself, so the waiting one has to be
       their second - which is also the only shape in which "cannot approve
       itself" means anything. */
    await enrolDevice(server, theirs, 'Their first');
    const theirWaiting = await enrolDevice(server, theirs, 'Theirs', { approve: false });

    // Another account's computer is not mine to approve, or even to see.
    const across = await server.call('POST', `/api/devices/${theirWaiting.deviceId}/approve`,
      { token: myDevice.deviceToken });
    assert.equal(across.status, 404);

    // And a waiting computer cannot vouch for itself with its own token.
    const itself = await server.call('POST', `/api/devices/${theirWaiting.deviceId}/approve`,
      { token: theirWaiting.deviceToken });
    assert.equal(itself.status, 403, 'a computer approved itself');

    // An approved computer of the same account still can, which is the point.
    const theirFirstToken = (await server.call('GET', '/api/devices', { token: theirs.accessToken })).status;
    assert.equal(theirFirstToken, 200);
  } finally { await server.close(); }
});

test('re-enrolling keeps the answer the account already gave', async () => {
  const server = await testServer();
  try {
    const session = await signIn(server);
    const first = await enrolDevice(server, session, 'Studio Mac');
    const waiting = await enrolDevice(server, session, 'Office Linux', { approve: false });

    /* Reinstalling HopDesk, or rotating a device key, must not re-approve a
       computer that was waiting - nor un-approve one that was let in. */
    const again = await enrolAgain(server, session, waiting);
    assert.equal(again.body.device.approved, false, 'enrolling again approved a waiting computer');

    const firstAgain = await enrolAgain(server, session, first);
    assert.equal(firstAgain.body.device.approved, true, 'enrolling again un-approved a known computer');
  } finally { await server.close(); }
});

/** Enrols the same device id again, as a reinstall would. */
async function enrolAgain(server, session, device) {
  const { body: challenge } = await server.call('POST', '/api/devices/challenge', { token: session.accessToken });
  const signature = enrolSignature(device.identity, challenge.nonce, session.account.id);
  return server.call('POST', '/api/devices', {
    token: session.accessToken,
    body: {
      deviceId: device.deviceId,
      publicKey: toBase64(device.identity.publicKey),
      name: device.name,
      nonce: challenge.nonce,
      signature,
    },
  });
}
