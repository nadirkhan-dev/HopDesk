import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, deviceIdFromPublicKey, toBase64 } from '@hopdesk/crypto';
import { HostAuthenticator, GrantStore, acceptViewer, HandshakeError } from '@hopdesk/protocol';
import { linkPair } from '../../../packages/protocol/test/helpers/link.mjs';
import { ViewerRole, KeyAccepted } from '../dist/viewer.js';

/**
 * A computer answering with a different identity key than the one pinned for
 * it: the question, and both answers to it.
 *
 * This is the case the pin exists for, and until recently it was a dead end -
 * refused, with no way on but forgetting the computer entirely, which throws
 * away the very record that would catch a real substitution. Now the person is
 * shown both fingerprints and decides, so both decisions need to hold:
 * Refuse must leave the pin alone and end the connection, and Accept must
 * replace the pin and only with a key that really belongs to that computer.
 *
 * Driven through the real handshake against a real host, because the value is
 * in what the protocol does with the answer, not in a mocked decision.
 */

/** A host that will complete an account handshake with anyone. */
function host() {
  const identity = generateIdentity();
  const grants = new GrantStore();
  const auth = new HostAuthenticator({
    identity, hostName: 'Studio Mac', grants,
    accessCode: () => null,
    rotateAccessCode: () => {},
    accountAuthorised: () => true,
  });
  return {
    identity,
    deviceId: deviceIdFromPublicKey(identity.publicKey),
    accept: link => acceptViewer(link, auth, { grants, authorize: async () => 'allow' }),
  };
}

/**
 * A viewer whose pin for that computer is some other key - which is what a
 * substituted machine, or a server handing out a key of its own, looks like
 * from here.
 */
function viewerAgainst(target, { answer, acceptNewKey }) {
  const asked = [];
  const pins = new Map([[target.deviceId, generateIdentity().publicKey]]);
  const role = new ViewerRole({
    identity: { identity: generateIdentity(), deviceId: 'HD-VIEW-0001', osProtected: false, protectionDetail: 'test' },
    viewerName: 'Office Linux',
    log: { info: () => {}, warn: () => {} },
    createPeer: async () => ({ peer: {}, close: () => {} }),
    pinnedKey: deviceId => pins.get(deviceId),
    rememberKey: () => {},
    acceptNewKey: (deviceId, key) => {
      if (acceptNewKey === false) return false;
      pins.set(deviceId, key);
      return true;
    },
    keyChanged: async info => { asked.push(info); return answer; },
  });
  return { role, asked, pins };
}

async function attempt(target, options) {
  const { role, asked, pins } = viewerAgainst(target, options);
  const { viewer: viewerLink, host: hostLink } = linkPair();
  const [result] = await Promise.allSettled([
    role.connectAccount(viewerLink, { deviceId: target.deviceId, name: 'Studio Mac' }),
    target.accept(hostLink).catch(() => {}),
  ]);
  return { result, asked, pins };
}

test('Refuse: the connection ends and the pinned key is left alone', async () => {
  const target = host();
  const { result, asked, pins } = await attempt(target, { answer: false });

  assert.equal(result.status, 'rejected', 'a refused key change still connected');
  assert.ok(result.reason instanceof HandshakeError);
  assert.equal(result.reason.code, 'identity-mismatch');

  // The person was asked, and shown both keys - which is what they compare.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].deviceId, target.deviceId);
  assert.equal(toBase64(asked[0].newKey), toBase64(target.identity.publicKey),
    'the key actually presented was not the one shown');
  assert.notEqual(toBase64(asked[0].oldKey), toBase64(asked[0].newKey));

  // And the pin is untouched: refusing must not quietly trust anything.
  assert.notEqual(toBase64(pins.get(target.deviceId)), toBase64(target.identity.publicKey));
});

test('Accept: the pin is replaced, and the caller is told to connect again', async () => {
  const target = host();
  const { result, asked, pins } = await attempt(target, { answer: true });

  /* A relayed link is spent by the attempt that failed, so accepting cannot
     simply retry on it: the caller asks the server for another introduction. */
  assert.equal(result.status, 'rejected');
  assert.ok(result.reason instanceof KeyAccepted, `expected KeyAccepted, got ${result.reason}`);
  assert.equal(result.reason.deviceId, target.deviceId);

  assert.equal(asked.length, 1);
  assert.equal(toBase64(pins.get(target.deviceId)), toBase64(target.identity.publicKey),
    'the new key was accepted but never pinned');
});

test('a key the store refuses is not treated as accepted', async () => {
  /* acceptNewKey checks the key really hashes to that Device ID. If it says
     no, the person's click cannot make it so: the connection must still fail. */
  const target = host();
  const { result, asked } = await attempt(target, { answer: true, acceptNewKey: false });
  assert.equal(result.status, 'rejected');
  assert.ok(result.reason instanceof HandshakeError, 'a refused key change was reported as accepted');
  assert.equal(result.reason.code, 'identity-mismatch');
  assert.equal(asked.length, 1);
});

test('no question, no change: without someone to ask, the connection just fails', async () => {
  const target = host();
  const { viewer: viewerLink, host: hostLink } = linkPair();
  const pins = new Map([[target.deviceId, generateIdentity().publicKey]]);
  const role = new ViewerRole({
    identity: { identity: generateIdentity(), deviceId: 'HD-VIEW-0002', osProtected: false, protectionDetail: 'test' },
    viewerName: 'Headless',
    log: { info: () => {}, warn: () => {} },
    createPeer: async () => ({ peer: {}, close: () => {} }),
    pinnedKey: deviceId => pins.get(deviceId),
    rememberKey: () => {},
    // No keyChanged: nobody is there to be shown the fingerprints.
  });
  const [result] = await Promise.allSettled([
    role.connectAccount(viewerLink, { deviceId: target.deviceId, name: 'Studio Mac' }),
    target.accept(hostLink).catch(() => {}),
  ]);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason.code, 'identity-mismatch');
  assert.equal(toBase64(pins.get(target.deviceId)) === toBase64(target.identity.publicKey), false);
});
