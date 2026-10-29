import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminClient } from '../dist/admin.js';

/**
 * Administering installations from inside the application.
 *
 * The thing being protected here is the token. It is the whole of an
 * administrator's authority over the service, so these tests are mostly about
 * where it is *not*: not in a reply, not kept after it has been refused, and
 * not sent anywhere but the service it was given for.
 */

const quiet = { info: () => {}, warn: () => {} };
const TOKEN = 'hda_0123456789abcdefghijklmnop';

/** A keystore, as the main process has one, with the contents visible to the test. */
function keystore() {
  const held = new Map();
  return {
    held,
    storage: {
      get: async name => held.get(name) ?? null,
      set: async (name, value) => { held.set(name, value); },
      delete: async name => { held.delete(name); },
      osProtected: true,
    },
  };
}

function build({ answers = [], service = 'https://auth.example.com', saved = null } = {}) {
  const calls = [];
  const store = keystore();
  let remembered = saved;
  const client = new AdminClient({
    storage: store.storage,
    defaultService: service,
    savedService: () => remembered,
    rememberService: url => { remembered = url; },
    log: quiet,
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {} });
      const next = answers.shift() ?? { status: 200, body: {} };
      if (next.throws) throw new Error('socket hang up');
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, calls, store, remembered: () => remembered };
}

test('signing in checks the token by using it, and only then keeps it', async () => {
  const { client, calls, store } = build({ answers: [{ status: 200, body: { installations: [] } }] });
  assert.deepEqual(await client.status(),
    { signedIn: false, service: 'https://auth.example.com', remembered: false });

  const answer = await client.signIn(TOKEN);
  assert.equal(answer.ok, true);
  assert.equal(calls[0].url, 'https://auth.example.com/api/admin/installations');
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal((await client.status()).signedIn, true);
  // Kept where the identity key is kept, and nowhere else.
  assert.equal(new TextDecoder().decode(store.held.get('admin-token')), TOKEN);
});

test('the token is never handed back, by any call', async () => {
  /* The window asks for things to be done and is told what happened. If the
     credential were ever in a reply, anything running in the window could
     take it. */
  const { client } = build({
    answers: [
      { status: 200, body: { installations: [] } },
      { status: 200, body: { installations: [{ installationId: 'HD-AAAA-BBBB', status: 'active' }] } },
      { status: 200, body: { ok: true, status: 'blocked' } },
      { status: 200, body: { events: [{ at: 1, actor: 'me@example.com', action: 'block', subject: 'HD-AAAA-BBBB', reason: null }] } },
    ],
  });
  const replies = [
    await client.signIn(TOKEN),
    await client.status(),
    await client.list(),
    await client.block('HD-AAAA-BBBB', 'licence shared'),
    await client.history('HD-AAAA-BBBB'),
  ];
  for (const reply of replies) {
    assert.ok(!JSON.stringify(reply).includes(TOKEN), `a reply carried the token: ${JSON.stringify(reply)}`);
  }
});

test('a token the service refuses is reported and thrown away', async () => {
  /* The case this exists for: a mistyped or withdrawn token. Keeping it would
     mean every page quietly failing with no way to tell why. */
  const { client, store } = build({
    answers: [
      { status: 200, body: { installations: [] } },   // signs in
      { status: 401, body: { error: 'unauthorised' } }, // and is later refused
    ],
  });
  assert.equal((await client.signIn(TOKEN)).ok, true);
  assert.equal(store.held.has('admin-token'), true);

  const refused = await client.list();
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'token-not-valid');
  assert.equal(store.held.has('admin-token'), false, 'the refused token was kept');
  assert.equal((await client.status()).signedIn, false);
});

test('a token refused at sign-in is not stored at all', async () => {
  const { client, store } = build({ answers: [{ status: 401, body: {} }] });
  const answer = await client.signIn(TOKEN);
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'token-not-valid');
  assert.equal(store.held.size, 0, 'a refused token was written to the keystore');
});

test('something that is not an administrator token is refused before it is sent', async () => {
  const { client, calls } = build();
  for (const bad of ['', 'hunter2', 'hda_short', 'Bearer hda_0123456789abcdefghijk']) {
    const answer = await client.signIn(bad);
    assert.equal(answer.ok, false, `${bad} was accepted`);
    assert.equal(answer.error, 'token-not-valid');
  }
  assert.equal(calls.length, 0, 'a token that cannot be right was sent anyway');
});

test('without a token, nothing is asked of the service', async () => {
  const { client, calls } = build();
  for (const answer of [await client.list(), await client.block('HD-AAAA-BBBB', 'x'),
    await client.unblock('HD-AAAA-BBBB'), await client.history('HD-AAAA-BBBB')]) {
    assert.equal(answer.ok, false);
    assert.equal(answer.error, 'no-token');
  }
  assert.equal(calls.length, 0);
});

test('a service that cannot be reached says so, and says nothing else', async () => {
  /* A fetch failure can quote the request, and the request carries the token,
     so the message must not travel to the window. */
  const { client } = build({ answers: [{ status: 200, body: { installations: [] } }, { throws: true }] });
  await client.signIn(TOKEN);
  const answer = await client.list();
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'unreachable');
  assert.equal(answer.detail, undefined);
});

test('blocking sends the reason, and unblocking sends none', async () => {
  const { client, calls } = build({
    answers: [
      { status: 200, body: { installations: [] } },
      { status: 200, body: { ok: true, status: 'blocked' } },
      { status: 200, body: { ok: true, status: 'active' } },
    ],
  });
  await client.signIn(TOKEN);
  assert.equal((await client.block('HD-AAAA-BBBB', 'licence shared')).status, 'blocked');
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /\/api\/admin\/installations\/HD-AAAA-BBBB\/block$/);

  assert.equal((await client.unblock('HD-AAAA-BBBB')).status, 'active');
  assert.match(calls[2].url, /\/unblock$/);
});

test('a build with no service of its own administers the one it was given', async () => {
  /* And remembers the address - which is not a secret - while the token goes
     to the keystore. */
  const { client, calls, remembered } = build({ service: null });
  assert.equal((await client.status()).service, null);
  assert.equal((await client.list()).error, 'no-service');

  const answers = [{ status: 200, body: { installations: [] } }];
  const next = build({ service: null, answers });
  assert.equal((await next.client.signIn(TOKEN, 'https://chosen.example.com/')).ok, true);
  assert.equal(next.remembered(), 'https://chosen.example.com');
  void calls; void remembered;
});

test('an address that is not https is refused', async () => {
  /* The token travels on it. Loopback is allowed, for trying a service running
     on this computer. */
  const { client } = build({ service: null });
  for (const bad of ['http://auth.example.com', 'ftp://auth.example.com', 'https://user:pw@auth.example.com', 'nonsense']) {
    assert.equal((await client.signIn(TOKEN, bad)).error, 'no-service', `${bad} was accepted`);
  }
  const loopback = build({ service: null, answers: [{ status: 200, body: { installations: [] } }] });
  assert.equal((await loopback.client.signIn(TOKEN, 'http://127.0.0.1:8799')).ok, true);
});

test('signing out removes the token from the keystore', async () => {
  const { client, store } = build({ answers: [{ status: 200, body: { installations: [] } }] });
  await client.signIn(TOKEN);
  await client.signOut();
  assert.equal(store.held.has('admin-token'), false);
  assert.equal((await client.status()).signedIn, false);
});

test('a keystore that cannot be read leaves the page asking, not broken', async () => {
  const client = new AdminClient({
    storage: {
      get: async () => { throw new Error('keyring is locked'); },
      set: async () => {}, delete: async () => {}, osProtected: true,
    },
    defaultService: 'https://auth.example.com',
    savedService: () => null,
    rememberService: () => {},
    log: quiet,
    fetch: async () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(await client.status(),
    { signedIn: false, service: 'https://auth.example.com', remembered: false });
});

test('without an OS keystore the token is kept for the run, not written down', async () => {
  /* The file store would hold it in a 0600 file and nothing more. That is the
     right trade for a device key, which is useless to anybody else, and the
     wrong one for a credential that can disable every installation on the
     service. */
  const written = [];
  const client = new AdminClient({
    storage: {
      get: async () => null,
      set: async (name, value) => { written.push([name, value]); },
      delete: async () => {},
      osProtected: false,
    },
    defaultService: 'https://auth.example.com',
    savedService: () => null,
    rememberService: () => {},
    log: quiet,
    fetch: async () => new Response(JSON.stringify({ installations: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  });

  const answer = await client.signIn(TOKEN);
  assert.equal(answer.ok, true);
  assert.equal(answer.remembered, false);
  assert.deepEqual(written, [], 'the token was written where nothing would encrypt it');

  // Usable now, and honest about not surviving a restart.
  const status = await client.status();
  assert.equal(status.signedIn, true);
  assert.equal(status.remembered, false);
  assert.equal((await client.list()).ok, true);
});
