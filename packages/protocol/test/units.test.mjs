import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity } from '@hopdesk/crypto';
import {
  AttemptLimiter, PeerThrottle, NonceCache, GrantStore, signalingMessage, controlMessage, inputMessage,
  clipboardMessage, parseJson, SchemaError, MAX_CLIPBOARD_CHARS,
} from '../dist/index.js';

test('limiter: lockout grows exponentially and caps; success resets the streak', () => {
  let t = 0;
  let rotated = 0;
  const lim = new AttemptLimiter(() => rotated++, {
    maxPending: 2, maxPendingPerPeer: 2, freeFailures: 2, baseLockoutMs: 1000, maxLockoutMs: 4000,
    rotateAfter: 5, peerTtlMs: 60_000, maxPeers: 8,
  }, () => t);
  const fail = () => { const d = lim.begin(); assert.ok(d.ok); d.attempt.fail(); };
  fail(); fail();
  let d = lim.begin();
  assert.deepEqual([d.ok, d.retryAfterMs, d.reason], [false, 1000, 'locked']);
  t += 1000; fail();
  assert.equal(lim.begin().retryAfterMs, 2000);
  t += 2000; fail();
  t += 4000; fail();                              // would be 8000, capped
  assert.equal(lim.begin().retryAfterMs, 4000);
  assert.equal(rotated, 1);
  t += 4000;
  d = lim.begin(); d.attempt.succeed();
  d = lim.begin(); assert.ok(d.ok); d.attempt.fail();
  assert.ok(lim.begin().ok, 'a success did not reset the consecutive count');
});

test('limiter: pending handshakes are capped and settle only once', () => {
  const lim = new AttemptLimiter(() => {}, {
    maxPending: 1, maxPendingPerPeer: 1, freeFailures: 99, baseLockoutMs: 1, maxLockoutMs: 1,
    rotateAfter: 99, peerTtlMs: 60_000, maxPeers: 8,
  });
  const a = lim.begin();
  assert.equal(lim.begin().reason, 'busy');
  a.attempt.fail(); a.attempt.fail(); a.attempt.succeed();
  assert.equal(lim.failuresSinceRotation, 1);
  assert.ok(lim.begin().ok);
});

test('nonce cache: replay, skew and bounded memory', () => {
  let t = 100_000_000;
  const cache = new NonceCache(60_000, 3, () => t);
  assert.equal(cache.check('a', t), 'ok');
  assert.equal(cache.check('a', t), 'replay');
  assert.equal(cache.check('b', t - 61_000), 'clock-skew');
  cache.check('b', t); cache.check('c', t); cache.check('d', t);
  assert.equal(cache.check('a', t), 'ok', 'oldest entry was not evicted at capacity');
  t += 200_000;
  assert.equal(cache.check('d', t), 'ok', 'expired entries were not pruned');
});

test('grants expire, are bound to a viewer key and wipe their secret on revoke', () => {
  let t = 0;
  const store = new GrantStore(() => t);
  const v1 = generateIdentity().publicKey, v2 = generateIdentity().publicKey;
  const g = store.issue(v1, 1000);
  assert.ok(store.find(g.id, v1));
  assert.equal(store.find(g.id, v2), null);
  t = 999; store.extend(g.id, 1000);
  t = 1500; assert.ok(store.find(g.id, v1));
  t = 2000; assert.equal(store.find(g.id, v1), null);
  const g2 = store.issue(v2, 1000);
  store.revokeViewer(v2);
  assert.ok(g2.secret.every(b => b === 0));
  assert.equal(store.size, 0);
});

test('schemas reject malformed, oversized and unknown messages and drop extra fields', () => {
  assert.throws(() => signalingMessage({ type: 'nope' }, ''), SchemaError);
  assert.throws(() => signalingMessage({ type: 'confirm', confirm: 'AAAA', signature: 'x' }, ''), /32 bytes|base64/);
  assert.throws(() => parseJson(signalingMessage, '{', 10), /JSON/);
  assert.throws(() => parseJson(signalingMessage, 'x'.repeat(20), 10), /larger/);
  const ok = controlMessage({ type: 'bye', reason: 'idle', __proto__: { evil: 1 }, extra: 'dropped' }, '');
  assert.deepEqual(ok, { type: 'bye', reason: 'idle' });
  assert.throws(() => controlMessage({ type: 'bye', reason: 'because' }, ''), /one of/);
  assert.throws(() => inputMessage({ type: 'pointer', x: 1.5, y: 0, buttons: 0 }, ''), /0\.\.1/);
  assert.throws(() => inputMessage({ type: 'pointer', x: NaN, y: 0, buttons: 0 }, ''), SchemaError);
  assert.throws(() => clipboardMessage({ type: 'clipboard', seq: 1, text: 'x'.repeat(MAX_CLIPBOARD_CHARS + 1) }, ''), /length/);
  assert.throws(() => signalingMessage({ type: 'hello', v: 1, hostId: 'HD-OOOO-1111' }, ''), /hostId/);
});

/**
 * A lockout belongs to whoever earned it.
 *
 * One counter for the whole host protected the access code and handed out a
 * denial of service with it: three failures from anyone who could reach the
 * port locked out everybody, doubling to five minutes. These are the tests
 * for that not happening.
 */
test('limiter: one peer failing does not lock out another', () => {
  let t = 0;
  const lim = new AttemptLimiter(() => {}, {
    maxPending: 4, maxPendingPerPeer: 2, freeFailures: 2, baseLockoutMs: 1000, maxLockoutMs: 4000,
    rotateAfter: 99, peerTtlMs: 60_000, maxPeers: 8,
  }, () => t);
  const fail = peer => { const d = lim.begin(peer); assert.ok(d.ok, `${peer} was refused`); d.attempt.fail(); };

  fail('lan:10.0.0.9|HD-AAAA-AAAA');
  fail('lan:10.0.0.9|HD-AAAA-AAAA');
  const attacker = lim.begin('lan:10.0.0.9|HD-AAAA-AAAA');
  assert.deepEqual([attacker.ok, attacker.reason], [false, 'locked'], 'the failing peer was not locked out');

  // The whole point: someone else's computer still gets in.
  const innocent = lim.begin('lan:10.0.0.22|HD-BBBB-BBBB');
  assert.ok(innocent.ok, 'a second computer was locked out by the first one failing');
  innocent.attempt.succeed();
});

test('limiter: the same address claiming many Device IDs is still held apart from others', () => {
  let t = 0;
  const lim = new AttemptLimiter(() => {}, {
    maxPending: 9, maxPendingPerPeer: 2, freeFailures: 1, baseLockoutMs: 1000, maxLockoutMs: 1000,
    rotateAfter: 99, peerTtlMs: 60_000, maxPeers: 4,
  }, () => t);
  // An attacker churning through claimed identities from one address...
  for (let i = 0; i < 6; i++) {
    const d = lim.begin(`lan:10.0.0.9|HD-FAKE-${i}`);
    if (d.ok) d.attempt.fail();
  }
  assert.ok(lim.trackedPeers <= 4, `peer table grew past its cap: ${lim.trackedPeers}`);
  // ...must not have locked out the real computer.
  assert.ok(lim.begin('lan:192.168.1.5|HD-REAL-0001').ok, 'churn locked out an unrelated peer');
});

test('limiter: attempts in flight are capped globally, because each costs the host real work', () => {
  const lim = new AttemptLimiter(() => {}, {
    maxPending: 2, maxPendingPerPeer: 2, freeFailures: 9, baseLockoutMs: 1, maxLockoutMs: 1,
    rotateAfter: 99, peerTtlMs: 60_000, maxPeers: 8,
  });
  assert.ok(lim.begin('a|x').ok);
  assert.ok(lim.begin('b|y').ok);
  // A third peer is told to wait rather than starting a 32 MiB scrypt.
  assert.deepEqual([lim.begin('c|z').ok, lim.begin('c|z').reason], [false, 'busy']);
});

test('limiter: a code is still replaced after enough failures, however they are spread', () => {
  let rotated = 0;
  const lim = new AttemptLimiter(() => rotated++, {
    maxPending: 9, maxPendingPerPeer: 9, freeFailures: 99, baseLockoutMs: 1, maxLockoutMs: 1,
    rotateAfter: 5, peerTtlMs: 60_000, maxPeers: 64,
  });
  // Five different peers, one guess each: the bound is on the code, not on a peer.
  for (let i = 0; i < 5; i++) { const d = lim.begin(`peer-${i}|HD-X`); assert.ok(d.ok); d.attempt.fail(); }
  assert.equal(rotated, 1, 'spreading guesses across peers escaped rotation');
});

/**
 * The light brake on connections that need no code. Guessing is not the threat
 * there - they are proved with a signature - so this only stops churn, and has
 * to be loose enough that a dropped session reconnecting never meets it.
 */
test('throttle: a burst from one peer is slowed, and nobody else is', () => {
  let t = 0;
  const throttle = new PeerThrottle({ perWindow: 3, windowMs: 1000, maxPeers: 4 }, () => t);
  for (let i = 0; i < 3; i++) assert.ok(throttle.allow('relay:HD-AAAA').ok, `attempt ${i + 1} was refused`);
  const refused = throttle.allow('relay:HD-AAAA');
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 1000);
  assert.ok(throttle.allow('relay:HD-BBBB').ok, 'one peer bursting held back another');
  // The window passes and the peer is welcome again.
  t += 1001;
  assert.ok(throttle.allow('relay:HD-AAAA').ok, 'the window never reopened');
});
