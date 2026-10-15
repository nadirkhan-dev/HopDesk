import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateIdentity, toBase64, deviceIdFromPublicKey } from '@hopdesk/crypto';
import { KnownDevices, looksLikeAddress } from '../dist/devices.js';

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

/**
 * A name that is really an address.
 *
 * It happens - a host with no system name of its own, or a connection made by
 * address before the other end said what it was called - and "192.168.1.21" in
 * a list of computers tells nobody which computer it is, since an address
 * belongs to whoever has it this week.
 */
test('an address is not a name, and is replaced the next time the computer says what it is called', async () => {
  const devices = await store();
  const pc = computer();

  // Saved under an address, as an older connection did.
  devices.remember(pc.deviceId, pc.key, '192.168.1.21');
  assert.equal(devices.list()[0].name, pc.deviceId, 'an address was kept as the name');

  // The next connection, where the host says what it is called.
  devices.remember(pc.deviceId, pc.key, 'studio-mac');
  assert.equal(devices.list()[0].name, 'studio-mac');

  // And a rename on the other machine follows too.
  devices.remember(pc.deviceId, pc.key, 'studio-mac-2');
  assert.equal(devices.list()[0].name, 'studio-mac-2');
});

test('what counts as an address', () => {
  for (const address of ['192.168.1.21', '10.0.0.5:47631', '[::1]', '[fe80::1]:47631', 'fe80::1', '::1']) {
    assert.equal(looksLikeAddress(address), true, `${address} should read as an address`);
  }
  // Real names, including ones with digits and dashes, must survive.
  for (const name of ['studio-mac', 'thinkpad-t14-gen3', 'PC-192', 'office.local', 'mac1']) {
    assert.equal(looksLikeAddress(name), false, `${name} should read as a name`);
  }
});
