import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateIdentity, identityFromSecretKey, toBase64, utf8, sign } from '@hopdesk/crypto';
import { Authorization, installationIdFor, mayHostWith } from '../dist/authorization.js';
import { VERDICT_LABEL, verdictBytes } from '@hopdesk/protocol';

/**
 * Whether this installation may run, as the client decides it.
 *
 * The checks that matter are not "does active mean yes" but the awkward ones:
 * an answer from the wrong server, an answer edited on disk, no answer at all,
 * and an answer that has gone stale. Each of those has to end somewhere other
 * than "carry on", or the whole arrangement is decoration.
 */

const service = identityFromSecretKey(generateIdentity().secretKey);
const quiet = { info: () => {}, warn: () => {} };

/** An answer as the service gives it, signed by whoever is named. */
function verdict({ installationId, status = 'active', reason = null, now = Date.now(), graceMs = 7 * 24 * 3600_000, signer = service }) {
  const statement = { installationId, status, reason, checkedAt: now, validUntil: now + graceMs };
  // Signed exactly as the service signs it - named fields, fixed order.
  return { ...statement, signature: toBase64(sign(signer, VERDICT_LABEL, verdictBytes(statement))) };
}

function build({ answers = {}, serviceKey = service.publicKey, url = 'https://auth.example.com', now = () => Date.now(), dataDir } = {}) {
  const identity = generateIdentity();
  const dir = dataDir ?? mkdtempSync(path.join(tmpdir(), 'hopdesk-auth-'));
  const installationId = installationIdFor(identity);
  const stored = new Map();
  const calls = [];
  const authorization = new Authorization({
    dataDir: dir,
    identity,
    installationId,
    storage: {
      get: async name => stored.get(name) ?? null,
      set: async (name, value) => { stored.set(name, value); },
      delete: async name => { stored.delete(name); },
    },
    serviceUrl: url,
    servicePublicKey: serviceKey,
    appVersion: '0.2.8',
    os: 'linux',
    log: quiet,
    now,
    fetch: async (target, init) => {
      const route = String(target).replace(url, '');
      calls.push(route);
      const reply = answers[route];
      if (!reply) throw new Error(`nothing answers ${route}`);
      const body = typeof reply === 'function' ? reply(JSON.parse(String(init.body))) : reply;
      return { ok: true, status: 200, json: async () => body };
    },
  });
  return { authorization, identity, installationId, dir, calls, stored };
}

test('an installation registers once, is told it may run, and may host', async () => {
  const pending = {};
  const made = build({ answers: pending });
  Object.assign(pending, {
    '/api/installations/challenge': { nonce: 'a-nonce-that-is-long-enough', expiresInMs: 300000 },
    '/api/installations/register': () => ({ token: 'hdi_test', ...verdict({ installationId: made.installationId }) }),
  });

  const status = await made.authorization.check();
  assert.equal(status.state, 'active');
  assert.equal(made.authorization.mayHost(), true);
  // The credential is kept where secrets are kept, not in the open.
  assert.ok(made.stored.has('installation-token'), 'the token was not stored');
});

test('blocked means blocked: it will not host, and says why', async () => {
  const pending = {};
  const made = build({ answers: pending });
  Object.assign(pending, {
    '/api/installations/challenge': { nonce: 'a-nonce-that-is-long-enough', expiresInMs: 300000 },
    '/api/installations/register': () => ({
      token: 'hdi_test',
      ...verdict({ installationId: made.installationId, status: 'blocked', reason: 'licence shared' }),
    }),
  });

  const status = await made.authorization.check();
  assert.equal(status.state, 'blocked');
  assert.equal(status.reason, 'licence shared');
  assert.match(status.detail, /has been disabled/i);
  assert.equal(made.authorization.mayHost(), false, 'a blocked installation was allowed to host');
});

test('an answer signed by anybody else is not an answer', async () => {
  /* The case this exists for: a blocked installation pointing the check at a
     server of its own, or a proxy that says yes. */
  const impostor = identityFromSecretKey(generateIdentity().secretKey);
  const pending = {};
  const made = build({ answers: pending });
  Object.assign(pending, {
    '/api/installations/challenge': { nonce: 'a-nonce-that-is-long-enough', expiresInMs: 300000 },
    '/api/installations/register': () => ({
      token: 'hdi_test',
      ...verdict({ installationId: made.installationId, signer: impostor }),
    }),
  });

  const status = await made.authorization.check();
  assert.equal(status.state, 'unverified', 'an answer from the wrong signer was believed');
  assert.equal(made.authorization.mayHost(), false);
});

test('an answer about a different installation is not an answer either', async () => {
  const pending = {};
  const made = build({ answers: pending });
  Object.assign(pending, {
    '/api/installations/challenge': { nonce: 'a-nonce-that-is-long-enough', expiresInMs: 300000 },
    '/api/installations/register': () => ({
      token: 'hdi_test',
      // Correctly signed, but about somebody else - a replayed "active".
      ...verdict({ installationId: 'HD-AAAA-AAAA' }),
    }),
  });
  const status = await made.authorization.check();
  assert.equal(status.state, 'unverified');
  assert.equal(made.authorization.mayHost(), false);
});

test('a cached answer edited on disk is discarded, not believed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-auth-'));
  const made = build({ dataDir: dir });
  // Someone writes themselves an approval.
  writeFileSync(path.join(dir, 'authorization.json'), JSON.stringify({
    installationId: made.installationId, status: 'active', reason: null,
    checkedAt: Date.now(), validUntil: Date.now() + 86_400_000, signature: 'not-a-signature',
  }));
  const fresh = build({ dataDir: dir });
  assert.equal(fresh.authorization.status().state, 'unverified', 'a forged cache was accepted');
  assert.equal(fresh.authorization.mayHost(), false);
});

test('an answer that has gone stale stops counting', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-auth-'));
  let clock = 1_000_000;
  const pending = {};
  const made = build({ answers: pending, dataDir: dir, now: () => clock });
  Object.assign(pending, {
    '/api/installations/challenge': { nonce: 'a-nonce-that-is-long-enough', expiresInMs: 300000 },
    '/api/installations/register': () => ({
      token: 'hdi_test',
      ...verdict({ installationId: made.installationId, now: clock, graceMs: 7 * 24 * 3600_000 }),
    }),
  });
  assert.equal((await made.authorization.check()).state, 'active');

  // Six days later, with the service unreachable, it still stands.
  clock += 6 * 24 * 3600_000;
  assert.equal(made.authorization.status().state, 'active', 'the grace window ended early');

  // Eight days later it does not.
  clock += 2 * 24 * 3600_000;
  assert.equal(made.authorization.status().state, 'unverified');
  assert.equal(made.authorization.mayHost(), false, 'an expired answer still allowed hosting');
});

test('a service that cannot be reached does not crash, and does not grant', async () => {
  const made = build({ answers: {} });                    // every route throws
  const status = await made.authorization.check();
  assert.equal(status.state, 'unverified');
  assert.match(status.detail, /could not|has not been able/i);
  assert.equal(made.authorization.mayHost(), false);
});

test('a build with no service configured asks nobody and keeps working', async () => {
  /* A build from source. It must not phone anywhere, must not claim to be
     blocked, and must host exactly as HopDesk always has. */
  const identity = generateIdentity();
  const authorization = new Authorization({
    dataDir: mkdtempSync(path.join(tmpdir(), 'hopdesk-auth-')),
    identity,
    installationId: installationIdFor(identity),
    storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    serviceUrl: null,
    servicePublicKey: null,
    appVersion: '0.2.8',
    os: 'linux',
    log: quiet,
    fetch: async () => { throw new Error('a build with no service must not call anything'); },
  });
  assert.equal(authorization.configured, false);
  assert.equal((await authorization.check()).state, 'disabled');
  assert.equal(authorization.mayHost(), true);
});

test('the installation identity is the identity key it already has', async () => {
  /* Which is why an update keeps it: the key lives outside the package, so
     reinstalling HopDesk over itself is the same installation. */
  const identity = generateIdentity();
  assert.match(installationIdFor(identity), /^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(installationIdFor(identity), installationIdFor(identityFromSecretKey(identity.secretKey)));
});

test('a build with a service to ask may not host before it has asked', () => {
  /* The failure this guards against is an ordering one, not an attack: the
     check is built after the identity is loaded, and a host that started
     listening in between would be accepting connections on the strength of
     nobody having said no yet. A build with no service configured is the
     opposite case and must not be caught by it. */
  assert.deepEqual(mayHostWith(false, null), { ok: true });
  assert.deepEqual(mayHostWith(false, { state: 'disabled' }), { ok: true });

  const unasked = mayHostWith(true, null);
  assert.equal(unasked.ok, false);
  assert.match(unasked.detail, /has not been able to check/);

  for (const state of ['blocked', 'unverified']) {
    assert.equal(mayHostWith(true, { state, detail: 'no' }).ok, false);
  }
  assert.deepEqual(mayHostWith(true, { state: 'active' }), { ok: true });
});

test('an answer cannot stand for ever, however long it says', async () => {
  /* Signed by the real service, so this is not forgery - it is a server with
     a mistaken grace window, or a clock that is wrong, and neither should be
     able to hand out a licence that never expires. */
  const identity = generateIdentity();
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-auth-cap-'));
  const installationId = installationIdFor(identity);
  const now = Date.UTC(2026, 0, 1);
  const century = 100 * 365 * 24 * 3600_000;
  writeFileSync(path.join(dir, 'authorization.json'),
    JSON.stringify(verdict({ installationId, now, graceMs: century })));

  const make = at => new Authorization({
    dataDir: dir,
    identity,
    installationId,
    storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    serviceUrl: 'https://auth.example.com',
    servicePublicKey: service.publicKey,
    appVersion: '0.2.8',
    os: 'linux',
    log: quiet,
    fetch: async () => { throw new Error('offline'); },
    now: () => at,
  });

  // Inside the ceiling it stands; a year later it does not, whatever it said.
  assert.equal(make(now + 3600_000).status().state, 'active');
  assert.equal(make(now + 365 * 24 * 3600_000).status().state, 'unverified');

  // An answer dated in this computer's future is not an answer yet.
  writeFileSync(path.join(dir, 'authorization.json'),
    JSON.stringify(verdict({ installationId, now: now + 90 * 24 * 3600_000 })));
  assert.equal(make(now).status().state, 'unverified');
});
