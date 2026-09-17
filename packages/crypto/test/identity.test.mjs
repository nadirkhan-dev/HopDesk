import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  generateIdentity, identityFromSecretKey, sign, verify, deviceIdFromPublicKey, normalizeDeviceId,
  generateAccessCode, formatAccessCode, normalizeAccessCode,
  FileSecureStorage, loadOrCreateIdentity, IDENTITY_SECRET_NAME, fromHex, toHex, utf8, toBase64,
} from '../dist/index.js';

test('Ed25519 matches the RFC 8032 section 7.1 TEST 1 vector', () => {
  const id = identityFromSecretKey(fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
  assert.equal(toHex(id.publicKey), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
});

test('signatures are domain separated and tamper evident', () => {
  const id = generateIdentity();
  const msg = utf8('transcript');
  const sig = sign(id, 'hopdesk/host-auth', msg);
  assert.ok(verify(id.publicKey, 'hopdesk/host-auth', msg, sig));
  assert.ok(!verify(id.publicKey, 'hopdesk/viewer-auth', msg, sig), 'label not bound');
  assert.ok(!verify(id.publicKey, 'hopdesk/host-auth', utf8('transcripu'), sig));
  assert.ok(!verify(generateIdentity().publicKey, 'hopdesk/host-auth', msg, sig));
  assert.ok(!verify(id.publicKey, 'hopdesk/host-auth', msg, sig.slice(0, 63)));
  const bad = sig.slice(); bad[10] ^= 1;
  assert.ok(!verify(id.publicKey, 'hopdesk/host-auth', msg, bad));
});

test('Device IDs are stable, well formed, and differ between keys', () => {
  const pub = fromHex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const idA = deviceIdFromPublicKey(pub);
  assert.match(idA, /^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(deviceIdFromPublicKey(pub), idA);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(deviceIdFromPublicKey(generateIdentity().publicKey));
  assert.equal(seen.size, 200);
});

test('Device ID input is normalized forgivingly but strictly validated', () => {
  const id = deviceIdFromPublicKey(generateIdentity().publicKey);
  const bare = id.slice(3).replace('-', '');
  assert.equal(normalizeDeviceId(id), id);
  assert.equal(normalizeDeviceId(id.toLowerCase()), id);
  assert.equal(normalizeDeviceId(` ${bare.slice(0, 4)} ${bare.slice(4)} `), id);
  assert.equal(normalizeDeviceId('hd-0o1i-l234'), 'HD-0011-1234');
  assert.equal(normalizeDeviceId('HD7K3MQ9TX'), 'HD-7K3M-Q9TX');
  assert.equal(normalizeDeviceId('HD7K3MQ9'), 'HD-HD7K-3MQ9', 'an 8-character ID starting with HD is not a prefix');
  for (const bad of ['', 'HD-1234', 'HD-1234-5678-9', 'HD-UUUU-1234', 'HD-12#4-5678']) assert.equal(normalizeDeviceId(bad), null, bad);
});

test('access codes are six uniform digits, formatted and normalized', () => {
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 2000; i++) {
    const code = generateAccessCode();
    assert.match(code, /^\d{6}$/);
    for (const c of code) counts[Number(c)]++;
  }
  // 12000 digits, 1200 expected each; a biased generator lands far outside this.
  for (const n of counts) assert.ok(n > 1000 && n < 1400, `digit distribution skewed: ${counts}`);
  assert.equal(formatAccessCode('739421'), '739 421');
  assert.equal(normalizeAccessCode(' 739 421 '), '739421');
  assert.equal(normalizeAccessCode('739-421'), '739421');
  for (const bad of ['73942', '7394211', '73942a', '']) assert.equal(normalizeAccessCode(bad), null);
});

test('file storage keeps the identity with private permissions and reloads it', async () => {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), 'hopdesk-id-')), 'secrets');
  const first = await loadOrCreateIdentity(new FileSecureStorage(dir));
  const again = await loadOrCreateIdentity(new FileSecureStorage(dir));
  assert.deepEqual(again.publicKey, first.publicKey);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const file = path.join(dir, `${IDENTITY_SECRET_NAME}.secret`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), [`${IDENTITY_SECRET_NAME}.secret`]);
  assert.equal(new FileSecureStorage(dir).osProtected, false);
});

test('a protector encrypts at rest, and its secrets are not readable without it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hopdesk-prot-'));
  const xor = b => b.map(x => x ^ 0x5a);
  const storage = new FileSecureStorage(dir, { encrypt: xor, decrypt: xor });
  assert.equal(storage.osProtected, true);
  const id = await loadOrCreateIdentity(storage);
  const raw = await readFile(path.join(dir, `${IDENTITY_SECRET_NAME}.secret`), 'utf8');
  assert.ok(!raw.includes(toBase64(id.secretKey)), 'secret stored unprotected');
  assert.deepEqual((await loadOrCreateIdentity(storage)).publicKey, id.publicKey);
  await assert.rejects(() => new FileSecureStorage(dir).get(IDENTITY_SECRET_NAME), /keystore/);
  await assert.rejects(() => storage.set('../escape', new Uint8Array(1)), /Invalid secret name/);
  await storage.delete(IDENTITY_SECRET_NAME);
  await storage.delete(IDENTITY_SECRET_NAME);
  assert.equal(await storage.get(IDENTITY_SECRET_NAME), null);
});
