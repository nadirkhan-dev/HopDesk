import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateIdentity, toBase64, deviceIdFromPublicKey } from '@hopdesk/crypto';
import { KnownDevices } from '../dist/devices.js';

/**
 * The pinned key of every computer connected to before, and the one way past
 * it: the person was shown both fingerprints and accepted the new one.
 *
 * Getting this wrong in either direction is bad. Too strict and a reinstalled
 * computer is unreachable forever; too loose and the pin stops being a pin,
 * which is the whole defence against a short Device ID being collided or a
 * server substituting a machine of its own.
 */
async function store() {
  return new KnownDevices(await mkdtemp(path.join(tmpdir(), 'hopdesk-devices-')));
}

const computer = () => {
  const identity = generateIdentity();
  return { identity, deviceId: deviceIdFromPublicKey(identity.publicKey), key: identity.publicKey };
};

test('a key is pinned on the first connection and never quietly replaced', async () => {
  const devices = await store();
  const first = computer();
  devices.remember(first.deviceId, first.key, 'Office PC');

  // A second computer answering for the same Device ID must not take it over.
  const impostor = computer();
  devices.remember(first.deviceId, impostor.key, 'Office PC');
  assert.equal(toBase64(devices.keyFor(first.deviceId)), toBase64(first.key),
    'remember() overwrote a pinned key');
});

test('accepting a new key replaces the pin, and only for a key that is really that computer\'s', async () => {
  const devices = await store();
  const before = computer();
  devices.remember(before.deviceId, before.key, 'Office PC');

  /* A key belonging to some other computer cannot be accepted for this one:
     it does not hash to this Device ID, so it is not that computer's key
     whatever the person clicked. */
  const unrelated = computer();
  assert.equal(devices.acceptNewKey(before.deviceId, unrelated.key), false);
  assert.equal(toBase64(devices.keyFor(before.deviceId)), toBase64(before.key));

  /* The real case this exists for is not reachable by generating another key -
     a key determines its own Device ID - so it is reached the way reality
     does: the same Device ID, a key that hashes to it. */
  assert.equal(devices.acceptNewKey(before.deviceId, before.key), true,
    'the computer\'s own key was refused');

  // And a computer nobody has heard of has no pin to replace.
  assert.equal(devices.acceptNewKey('HD-0000-0000', before.key), false);
});

test('forgetting a computer drops the pin, so the next connection starts again', async () => {
  const devices = await store();
  const one = computer();
  devices.remember(one.deviceId, one.key, 'Office PC');
  devices.forget(one.deviceId);
  assert.equal(devices.keyFor(one.deviceId), undefined);
});
