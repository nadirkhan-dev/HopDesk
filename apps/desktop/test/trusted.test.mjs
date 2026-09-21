import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateIdentity, toBase64, deviceIdFromPublicKey } from '@hopdesk/crypto';
import { TrustedDevices, TRUST_TTL_MS, fingerprint } from '../dist/trusted.js';

function viewer(name = 'Laptop') {
  const identity = generateIdentity();
  return { viewerId: deviceIdFromPublicKey(identity.publicKey), viewerKey: identity.publicKey, viewerName: name, identity };
}

async function store(now = () => Date.now()) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hopdesk-trusted-'));
  return { dir, trusted: new TrustedDevices(dir, now) };
}

test('a trusted device is recognised by key, not by Device ID alone', async () => {
  const { trusted } = await store();
  const laptop = viewer();
  trusted.add(laptop);

  assert.equal(trusted.trusts(laptop.viewerId, laptop.viewerKey), true);

  /* Someone claiming that Device ID with a different key is not the same
     computer: the ID is a handle, the key is the proof. */
  const impostor = generateIdentity();
  assert.equal(trusted.trusts(laptop.viewerId, impostor.publicKey), false);
  assert.equal(trusted.trusts('HD-0000-0000', laptop.viewerKey), false);
});

test('what is written to disk is a public key and nothing else', async () => {
  const { dir, trusted } = await store();
  const laptop = viewer('Kitchen PC');
  trusted.add(laptop);
  await trusted.flush();

  const file = path.join(dir, 'trusted.json');
  const raw = await readFile(file, 'utf8');
  const saved = JSON.parse(raw).devices[0];
  assert.equal(saved.key, toBase64(laptop.viewerKey));
  assert.equal(saved.name, 'Kitchen PC');
  // The private half is what proves identity, and it is not ours to hold.
  assert.equal(raw.includes(toBase64(laptop.identity.secretKey)), false);
  // Only this user may read it, even though it holds no secret.
  assert.equal((await stat(file)).mode & 0o077, 0);
});

test('a pairing expires, and using it puts the expiry back', async () => {
  let now = 1_000_000;
  const { trusted } = await store(() => now);
  const laptop = viewer();
  trusted.add(laptop);

  now += TRUST_TTL_MS - 1000;
  assert.equal(trusted.trusts(laptop.viewerId, laptop.viewerKey), true, 'expired early');
  trusted.renew(laptop.viewerId);

  now += TRUST_TTL_MS - 1000;
  assert.equal(trusted.trusts(laptop.viewerId, laptop.viewerKey), true, 'renewing did not extend it');

  now += TRUST_TTL_MS + 1000;
  assert.equal(trusted.trusts(laptop.viewerId, laptop.viewerKey), false, 'an unused pairing never expired');
  assert.deepEqual(trusted.list(), []);
});

test('removing a device stops it, and the list survives a restart', async () => {
  const { dir, trusted } = await store();
  const laptop = viewer('Laptop');
  const desktop = viewer('Desktop');
  trusted.add(laptop);
  trusted.add(desktop);
  assert.equal(trusted.remove(laptop.viewerId)?.name, 'Laptop');
  assert.equal(trusted.trusts(laptop.viewerId, laptop.viewerKey), false);
  assert.equal(trusted.remove('HD-0000-0000'), null);
  await trusted.flush();

  const reopened = new TrustedDevices(dir);
  await reopened.load();
  assert.deepEqual(reopened.list().map(d => d.name), ['Desktop']);
  assert.equal(reopened.trusts(desktop.viewerId, desktop.viewerKey), true);
});

test('an expired or tampered entry on disk is not honoured', async () => {
  const { dir } = await store();
  const laptop = viewer();
  const other = generateIdentity();
  await writeFile(path.join(dir, 'trusted.json'), JSON.stringify({
    devices: [
      // Expired.
      { deviceId: laptop.viewerId, key: toBase64(laptop.viewerKey), name: 'Old', addedAt: 1, lastUsed: 1, expiresAt: Date.now() - 1 },
      // A key that does not hash to the Device ID it claims.
      { deviceId: 'HD-7K3M-Q9TX', key: toBase64(other.publicKey), name: 'Liar', addedAt: 1, lastUsed: 1, expiresAt: Date.now() + 1e9 },
    ],
  }));
  const trusted = new TrustedDevices(dir);
  await trusted.load();
  assert.deepEqual(trusted.list(), []);
});

test('a corrupt file means nothing is trusted, not a crash', async () => {
  const { dir } = await store();
  await writeFile(path.join(dir, 'trusted.json'), 'not json at all');
  const trusted = new TrustedDevices(dir);
  await trusted.load();
  assert.deepEqual(trusted.list(), []);
});

test('the fingerprint is short, stable and readable', () => {
  const key = new Uint8Array(32).fill(0xab);
  assert.equal(fingerprint(key), 'abab abab abab abab');
  assert.equal(fingerprint(toBase64(key)), fingerprint(key));
});
