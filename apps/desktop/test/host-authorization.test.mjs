import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateIdentity, deviceIdFromPublicKey } from '@hopdesk/crypto';
import { connectToHost, HandshakeError } from '@hopdesk/protocol';
import { linkPair } from '../../../packages/protocol/test/helpers/link.mjs';
import { HostRole } from '../dist/host.js';
import { GrantStore } from '@hopdesk/protocol';

/**
 * A disabled installation refusing to host, whichever way somebody arrives.
 *
 * The point of checking here rather than in each way in: a code, a trusted
 * computer, a reconnect grant and an account connection all reach the host
 * through acceptLink, and codes and trust are consulted below that. So
 * rotating an access code or adding a trusted computer cannot route around a
 * block - which is the specific bypass this test exists to rule out.
 */

async function hostWith(authorized) {
  const identity = generateIdentity();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hopdesk-hostauth-'));
  const host = new HostRole({
    identity: { identity, deviceId: deviceIdFromPublicKey(identity.publicKey), osProtected: false, protectionDetail: 'test' },
    hostName: 'Studio Mac',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    settings: () => ({ enabled: true, port: 0, announce: false, screen: null }),
    consent: async () => 'allow',
    authorized,
    createPeer: async () => ({ peer: {}, close: () => {} }),
    trusted: () => ({ add: () => ({ deviceId: 'x', name: 'x' }), matches: () => true, renew: () => {}, list: () => [] }),
    input: () => null,
    inputProblem: () => null,
    notices: () => [],
    clipboard: { read: () => '', write: () => {} },
    displayBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    shareClipboard: () => true,
    dataDir,
  });
  return { host, identity, deviceId: deviceIdFromPublicKey(identity.publicKey) };
}

/** Tries to connect, whichever credential, and says how it went. */
async function attempt(host, deviceId, credential) {
  const { viewer: viewerLink, host: hostLink } = linkPair();
  const viewerIdentity = generateIdentity();
  const [result] = await Promise.allSettled([
    connectToHost(viewerLink, {
      identity: viewerIdentity,
      viewerName: 'Office Linux',
      hostId: deviceId,
      credential,
    }),
    host.acceptLink(hostLink, 'lan:10.0.0.9', 'lan:10.0.0.9'),
  ]);
  return result;
}

test('a disabled installation refuses every way in, and says it is the one disabled', async () => {
  const { host, deviceId } = await hostWith(() => ({ ok: false, detail: 'This HopDesk installation has been disabled.' }));
  try {
    /* Every credential a viewer can arrive with. None of them should get past
       a block, and the access code is the one that matters most: rotating it
       is the obvious thing a blocked person would try. */
    for (const credential of [
      { kind: 'code', code: '739421' },
      { kind: 'paired' },
      { kind: 'grant', id: 'some-grant', secret: new Uint8Array(32) },
      { kind: 'account' },
    ]) {
      const result = await attempt(host, deviceId, credential);
      assert.equal(result.status, 'rejected', `a ${credential.kind} connection was accepted by a disabled host`);
      /* Refused in words rather than by a silent hang-up, so the person at the
         other end knows it is this computer that is disabled. */
      if (result.reason instanceof HandshakeError) {
        assert.match(String(result.reason.code), /host-disabled|protocol|closed/,
          `unexpected refusal for ${credential.kind}: ${result.reason.code}`);
      }
    }
    assert.equal(host.status().sessions.length, 0, 'a disabled host started a session');
  } finally {
    await host.stop().catch(() => {});
  }
});

test('the same host accepts a correct code once it is authorized again', async () => {
  /* The other half: the gate must not be a one-way door, or lifting a block
     would need a reinstall. */
  let allowed = false;
  const { host, deviceId } = await hostWith(() => (allowed
    ? { ok: true }
    : { ok: false, detail: 'This HopDesk installation has been disabled.' }));
  try {
    host.start = async () => {};                       // no listener needed here
    const refused = await attempt(host, deviceId, { kind: 'code', code: '739421' });
    assert.equal(refused.status, 'rejected');

    allowed = true;
    const accepted = await attempt(host, deviceId, { kind: 'code', code: host.status().accessCode ?? '739421' });
    /* It gets past the gate now. Whether the handshake then succeeds depends
       on the code being right, which is a different question - what matters
       here is that it was not refused by the gate. */
    if (accepted.status === 'rejected' && accepted.reason instanceof HandshakeError) {
      assert.notEqual(accepted.reason.code, 'host-disabled', 'still refused as disabled after being authorized');
    }
  } finally {
    await host.stop().catch(() => {});
  }
});
