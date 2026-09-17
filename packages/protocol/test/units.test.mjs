import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity } from '@hopdesk/crypto';
import {
  AttemptLimiter, NonceCache, GrantStore, signalingMessage, controlMessage, inputMessage, clipboardMessage,
  parseJson, SchemaError, MAX_CLIPBOARD_CHARS,
} from '../dist/index.js';

test('limiter: lockout grows exponentially and caps; success resets the streak', () => {
  let t = 0;
  let rotated = 0;
  const lim = new AttemptLimiter(() => rotated++, { maxPending: 2, freeFailures: 2, baseLockoutMs: 1000, maxLockoutMs: 4000, rotateAfter: 5 }, () => t);
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
  const lim = new AttemptLimiter(() => {}, { maxPending: 1, freeFailures: 99, baseLockoutMs: 1, maxLockoutMs: 1, rotateAfter: 99 });
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
