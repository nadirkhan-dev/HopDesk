import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Spake2, spake2KeySchedule, SPAKE2_M, SPAKE2_N, bytesToScalar, passwordScalar, secretScalar,
  fromHex, toHex, utf8,
} from '../dist/index.js';

const { vectors } = JSON.parse(readFileSync(new URL('./fixtures/rfc9382-vectors.json', import.meta.url), 'utf8'));
const big = hex => BigInt(`0x${hex}`);

test('the fixture holds all four RFC 9382 Appendix B vectors', () => {
  assert.deepEqual(vectors.map(v => [v.A, v.B]), [['server', 'client'], ['', 'client'], ['server', ''], ['', '']]);
});

for (const v of vectors) {
  test(`RFC 9382 vector A='${v.A}' B='${v.B}': shares, transcript, keys and confirmations match`, () => {
    const common = { idA: utf8(v.A), idB: utf8(v.B), w: big(v.w) };
    const a = new Spake2({ ...common, role: 'A', ephemeral: big(v.x) });
    const b = new Spake2({ ...common, role: 'B', ephemeral: big(v.y) });
    assert.equal(toHex(a.outbound), v.pA);
    assert.equal(toHex(b.outbound), v.pB);

    const ra = a.finish(fromHex(v.pB));
    const rb = b.finish(fromHex(v.pA));
    assert.equal(toHex(ra.transcript), v.TT);
    assert.equal(toHex(rb.transcript), v.TT);

    const ks = spake2KeySchedule(fromHex(v.TT));
    assert.equal(toHex(ks.Ke), v.Ke);
    assert.equal(toHex(ks.Ka), v.Ka);
    assert.equal(toHex(ks.KcA), v.KcA);
    assert.equal(toHex(ks.KcB), v.KcB);

    assert.equal(toHex(ra.Ke), v.Ke);
    assert.equal(toHex(rb.Ke), v.Ke);
    assert.equal(toHex(ra.confirmation), v.Aconf);
    assert.equal(toHex(rb.confirmation), v.Bconf);
    assert.ok(ra.verifyPeer(fromHex(v.Bconf)));
    assert.ok(rb.verifyPeer(fromHex(v.Aconf)));
    assert.ok(!ra.verifyPeer(fromHex(v.Aconf)), 'A accepted its own confirmation as B\'s (reflection)');
  });
}

test('M and N are the RFC 9382 P-256 constants', () => {
  assert.equal(SPAKE2_M.toHex(true), '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f');
  assert.equal(SPAKE2_N.toHex(true), '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49');
});

test('random exchanges agree with the same password and disagree with a different one', async () => {
  const w = await passwordScalar('123456', 'HD-TEST-0001');
  const ids = { idA: utf8('viewer'), idB: utf8('host'), aad: utf8('ctx') };
  const a = new Spake2({ ...ids, role: 'A', w });
  const b = new Spake2({ ...ids, role: 'B', w });
  const ra = a.finish(b.outbound);
  const rb = b.finish(a.outbound);
  assert.deepEqual(ra.Ke, rb.Ke);
  assert.ok(ra.verifyPeer(rb.confirmation) && rb.verifyPeer(ra.confirmation));

  const wrong = await passwordScalar('123457', 'HD-TEST-0001');
  const c = new Spake2({ ...ids, role: 'A', w: wrong });
  const d = new Spake2({ ...ids, role: 'B', w });
  const rc = c.finish(d.outbound);
  const rd = d.finish(c.outbound);
  assert.notDeepEqual(rc.Ke, rd.Ke);
  assert.ok(!rc.verifyPeer(rd.confirmation) && !rd.verifyPeer(rc.confirmation));
});

test('different associated data or identities break confirmation', () => {
  const w = secretScalar(new Uint8Array(32).fill(7), 'grant-1');
  const a = new Spake2({ role: 'A', idA: utf8('v'), idB: utf8('h'), w, aad: utf8('one') });
  const b = new Spake2({ role: 'B', idA: utf8('v'), idB: utf8('h'), w, aad: utf8('two') });
  assert.ok(!a.finish(b.outbound).verifyPeer(b.finish(a.outbound).confirmation));

  const c = new Spake2({ role: 'A', idA: utf8('v'), idB: utf8('h'), w });
  const d = new Spake2({ role: 'B', idA: utf8('mallory'), idB: utf8('h'), w });
  assert.ok(!c.finish(d.outbound).verifyPeer(d.finish(c.outbound).confirmation));
});

test('invalid peer shares are refused', () => {
  const w = 5n;
  const mk = () => new Spake2({ role: 'A', idA: utf8(''), idB: utf8(''), w });
  assert.throws(() => mk().finish(new Uint8Array(65)), /uncompressed|point|invalid/i);
  const offCurve = fromHex(vectors[0].pB); offCurve[64] ^= 1;
  assert.throws(() => mk().finish(offCurve));
  assert.throws(() => mk().finish(SPAKE2_N.toBytes(true)), /uncompressed/);
  // pB = w·N makes K the identity; an attacker must not be able to force that.
  assert.throws(() => mk().finish(SPAKE2_N.multiply(w).toBytes(false)), /identity/);
});

test('an exchange cannot be finished twice (ephemeral scalar reuse)', () => {
  const a = new Spake2({ role: 'A', idA: utf8(''), idB: utf8(''), w: 9n });
  const b = new Spake2({ role: 'B', idA: utf8(''), idB: utf8(''), w: 9n });
  a.finish(b.outbound);
  assert.throws(() => a.finish(b.outbound), /already/);
});

test('password and secret scalars are deterministic, context bound and in range', async () => {
  assert.equal(await passwordScalar('739421', 'HD-AAAA-BBBB'), await passwordScalar('739421', 'HD-AAAA-BBBB'));
  assert.notEqual(await passwordScalar('739421', 'HD-AAAA-BBBB'), await passwordScalar('739421', 'HD-AAAA-BBBC'));
  // NFKC: a full-width digit typed through an IME is the same password.
  assert.equal(await passwordScalar('７39421', 'x'), await passwordScalar('739421', 'x'));
  assert.throws(() => secretScalar(new Uint8Array(16), 'x'), /32 bytes/);
  assert.throws(() => bytesToScalar(new Uint8Array(32)), /40 bytes/);
  assert.throws(() => new Spake2({ role: 'A', idA: utf8(''), idB: utf8(''), w: 0n }), /out of range/);
});
