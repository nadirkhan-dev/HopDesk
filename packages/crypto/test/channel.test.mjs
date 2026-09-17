import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SealedChannel, deriveSessionRoot, utf8 } from '../dist/index.js';

const root = () => deriveSessionRoot(randomBytes(16), randomBytes(32));
const text = b => new TextDecoder().decode(b);

test('host and viewer ends of a channel interoperate in both directions', () => {
  const r = root();
  const host = new SealedChannel(r, 'control', 'host');
  const viewer = new SealedChannel(r, 'control', 'viewer');
  assert.equal(text(viewer.open(host.seal(utf8('to viewer')))), 'to viewer');
  assert.equal(text(host.open(viewer.seal(utf8('to host')))), 'to host');
  const empty = host.seal(new Uint8Array());
  assert.equal(viewer.open(empty).length, 0);
});

test('ciphertext does not contain the plaintext and differs per frame', () => {
  const host = new SealedChannel(root(), 'clipboard', 'host');
  const a = host.seal(utf8('secret clipboard canary'));
  const b = host.seal(utf8('secret clipboard canary'));
  assert.ok(!Buffer.from(a).includes('canary'));
  assert.notDeepEqual(a.subarray(8), b.subarray(8));
});

test('replayed, reordered and tampered frames are rejected; loss is tolerated', () => {
  const r = root();
  const host = new SealedChannel(r, 'input', 'host');
  const viewer = new SealedChannel(r, 'input', 'viewer');
  const f1 = host.seal(utf8('1')), f2 = host.seal(utf8('2')), f3 = host.seal(utf8('3')), f4 = host.seal(utf8('4'));
  viewer.open(f1);
  assert.throws(() => viewer.open(f1), /Replayed/);
  viewer.open(f3);                                  // f2 lost
  assert.throws(() => viewer.open(f2), /Replayed or reordered/);
  const bad = f4.slice(); bad[bad.length - 20] ^= 1;
  assert.throws(() => viewer.open(bad), /authentication/);
  const forgedCounter = f4.slice(); forgedCounter[7] ^= 0x10;
  assert.throws(() => viewer.open(forgedCounter), /authentication/);
  assert.equal(text(viewer.open(f4)), '4', 'a forged frame advanced the replay window');
  assert.throws(() => viewer.open(new Uint8Array(10)), /too short/);
});

test('frames cannot cross directions, channels or sessions', () => {
  const r = root();
  const host = new SealedChannel(r, 'control', 'host');
  const frame = host.seal(utf8('x'));
  assert.throws(() => new SealedChannel(r, 'control', 'host').open(frame), /authentication/, 'reflected to sender');
  assert.throws(() => new SealedChannel(r, 'clipboard', 'viewer').open(frame), /authentication/, 'moved to another channel');
  assert.throws(() => new SealedChannel(root(), 'control', 'viewer').open(frame), /authentication/, 'moved to another session');
});

test('session roots depend on both the secret and the handshake hash', () => {
  const ke = randomBytes(16), hh = randomBytes(32);
  assert.deepEqual(deriveSessionRoot(ke, hh), deriveSessionRoot(ke, hh));
  assert.notDeepEqual(deriveSessionRoot(ke, hh), deriveSessionRoot(ke, randomBytes(32)));
  assert.throws(() => deriveSessionRoot(ke, randomBytes(16)), /32 bytes/);
});
