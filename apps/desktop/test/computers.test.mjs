import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeComputers, methodsFor, defaultMethod, connectability, METHOD_LABELS,
} from '../renderer/computers.js';

/**
 * One list out of two sources, and what each row offers.
 *
 * The case that matters most is the same computer appearing in both: once
 * because this one connected to it before, once because both are on the
 * account. Getting that wrong shows a person the same Mac twice with different
 * buttons under each, which is how someone ends up typing a code for a machine
 * that would have let them straight in.
 */

const mac = {
  deviceId: 'HD-K7XQ-7AY1', name: 'Studio Mac', os: 'macos', publicKey: 'KEY-MAC',
  online: true, lastSeen: 1000, self: false,
};
const linux = {
  deviceId: 'HD-P5H0-V9FX', name: 'Office Linux', os: 'linux', publicKey: 'KEY-LINUX',
  online: false, lastSeen: 500, self: false,
};

test('the same computer from both sources is one row, joined on its key', () => {
  const rows = mergeComputers({
    account: [mac],
    known: [{ deviceId: mac.deviceId, key: 'KEY-MAC', name: 'Studio Mac', lastConnected: 900, paired: true, lastAddress: '192.168.1.42', lastPort: 47631 }],
    signedIn: true,
  });
  assert.equal(rows.length, 1, 'the same computer was listed twice');
  const [row] = rows;
  // Each source contributes what only it knows.
  assert.equal(row.online, true, 'the account knows whether it is online');
  assert.equal(row.paired, true, 'the local record knows it will let this computer in');
  assert.equal(row.address, '192.168.1.42', 'and where it answered last time');
  assert.equal(row.os, 'macos');
});

test('a different key is a different computer, whatever the Device ID says', () => {
  /* A Device ID is 40 bits of hash and could in principle be collided; the key
     is what the handshake proves. Two records claiming one Device ID with
     different keys must not be merged into one row. */
  const rows = mergeComputers({
    account: [mac],
    known: [{ deviceId: mac.deviceId, key: 'KEY-IMPOSTOR', name: 'Studio Mac', lastConnected: 900 }],
    signedIn: true,
  });
  assert.equal(rows.length, 2);
});

test('the computer you are sitting at is never in the list', () => {
  const rows = mergeComputers({ account: [{ ...mac, self: true }, linux], signedIn: true });
  assert.deepEqual(rows.map(r => r.deviceId), [linux.deviceId]);
});

test('a computer not on the account is unknown, not offline', () => {
  /* Saying "offline" about a machine that may be on this very network would
     stop someone from even trying to reach it. */
  const rows = mergeComputers({
    known: [{ deviceId: 'HD-AAAA-BBBB', key: 'KEY-LAN', name: 'Workshop PC', lastConnected: 10 }],
    signedIn: false,
  });
  assert.equal(rows[0].status, 'unknown');
  assert.equal(connectability(rows[0], 'code').ok, true);
});

test('online computers come first, then whoever was seen most recently', () => {
  const rows = mergeComputers({
    account: [linux, mac, { deviceId: 'HD-CCCC-DDDD', name: 'Old Box', os: 'linux', publicKey: 'KEY-OLD', online: false, lastSeen: 10, self: false }],
    signedIn: true,
  });
  assert.deepEqual(rows.map(r => r.name), ['Studio Mac', 'Office Linux', 'Old Box']);
});

test('what a row offers depends on what it actually is', () => {
  // Paired and on the account: everything, best first.
  assert.deepEqual(methodsFor({ paired: true, onAccount: true }), ['trusted', 'ask', 'code']);
  // On the account but not paired: someone there has to allow it.
  assert.deepEqual(methodsFor({ paired: false, onAccount: true }), ['ask', 'code']);
  // Neither: the code is all there is.
  assert.deepEqual(methodsFor({ paired: false, onAccount: false }), ['code']);
  // Every method has words for the person choosing it.
  for (const method of methodsFor({ paired: true, onAccount: true })) {
    assert.ok(METHOD_LABELS[method], `no label for ${method}`);
  }
});

test('the remembered choice is used, unless that way in no longer exists', () => {
  const paired = { methods: ['trusted', 'ask', 'code'] };
  assert.equal(defaultMethod(paired, 'ask'), 'ask');
  assert.equal(defaultMethod(paired, undefined), 'trusted', 'the best way in is the default');
  /* Trust was revoked since the choice was remembered: fall back rather than
     offering something that will now be refused. */
  assert.equal(defaultMethod({ methods: ['ask', 'code'] }, 'trusted'), 'ask');
});

test('an offline account computer cannot be reached, and says why', () => {
  const row = { name: 'Office Linux', onAccount: true, online: false };
  const refused = connectability(row, 'ask');
  assert.equal(refused.ok, false);
  assert.match(refused.why, /Office Linux is not online/);
  /* Except by code: that goes over the network this computer is on, which the
     server knows nothing about. */
  assert.equal(connectability(row, 'code').ok, true);
});
