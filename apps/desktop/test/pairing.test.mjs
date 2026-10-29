import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateIdentity, deviceIdFromPublicKey, toBase64 } from '@hopdesk/crypto';
import { connectToHost, HandshakeError, GrantStore } from '@hopdesk/protocol';
import { linkPair } from '../../../packages/protocol/test/helpers/link.mjs';
import { HostRole } from '../dist/host.js';
import { TrustedDevices } from '../dist/trusted.js';
import { KnownDevices } from '../dist/devices.js';

/**
 * Connecting to the same computer a second time.
 *
 * "Pair once, then one click" is two records that have to agree: the host
 * keeps the viewer on a trusted list, and the viewer remembers that the host
 * will not ask again. Either one going missing silently puts the person back
 * to typing an access code with no idea why - which is the complaint these
 * tests exist to stop coming back.
 *
 * What must keep working is the other half: a pairing the person revoked, one
 * that lapsed, an installation that has been disabled, and a host whose
 * identity key is not the one that was pinned. None of those may be waved
 * through by any of this.
 */

async function hostWith({ consent = async () => 'allow-and-trust', authorized, trusted, now } = {}) {
  const identity = generateIdentity();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hopdesk-pairing-'));
  // The second argument is the clock itself, not a bag of options.
  const trustedDevices = trusted ?? (now ? new TrustedDevices(dataDir, now) : new TrustedDevices(dataDir));
  await trustedDevices.load();
  const host = new HostRole({
    identity: {
      identity,
      deviceId: deviceIdFromPublicKey(identity.publicKey),
      osProtected: false,
      protectionDetail: 'test',
    },
    hostName: 'Studio Mac',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    settings: () => ({ enabled: true, port: 0, announce: false, screen: null }),
    consent,
    ...(authorized ? { authorized } : {}),
    createPeer: async () => ({ peer: {}, close: () => {} }),
    trusted: () => trustedDevices,
    input: () => null,
    inputProblem: () => null,
    notices: () => [],
    clipboard: { read: () => '', write: () => {} },
    displayBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    shareClipboard: () => true,
    dataDir,
  });
  /* Started, because the access code only exists while this computer is
     accepting connections - which is also the only state in which any of this
     is reachable. The links below bypass the listener, but the code is real. */
  await host.start();
  return {
    host,
    identity,
    deviceId: deviceIdFromPublicKey(identity.publicKey),
    code: host.status().accessCode,
    trustedDevices,
    dataDir,
  };
}

/** One connection attempt, with whichever credential, from one viewer. */
async function attempt(host, deviceId, credential, viewerIdentity = generateIdentity(), expectedHostKey) {
  const { viewer: viewerLink, host: hostLink } = linkPair();
  const [result] = await Promise.allSettled([
    connectToHost(viewerLink, {
      identity: viewerIdentity,
      viewerName: 'Office Linux',
      hostId: deviceId,
      credential,
      ...(expectedHostKey ? { expectedHostKey } : {}),
    }),
    host.acceptLink(hostLink, 'lan:10.0.0.9', 'lan:10.0.0.9'),
  ]);
  /* Closed as soon as it is made: what each test is about is whether the
     connection was allowed and what it was told, and a session left open keeps
     its heartbeat - and the test process - alive for ever. Everything read
     afterwards is data already in hand. */
  if (result.status === 'fulfilled') {
    try { result.value.control.close(); } catch { /* already gone */ }
  }
  return result;
}

/** The credential a viewer types in, for a host that is listening. */
const withCode = code => ({ kind: 'code', code });

test('pairing once: the host remembers the computer, and tells it so', async () => {
  const { host, deviceId, code, trustedDevices } = await hostWith();
  const viewer = generateIdentity();
  try {
    const first = await attempt(host, deviceId, withCode(code), viewer);
    assert.equal(first.status, 'fulfilled', `the first connection failed: ${first.reason?.message}`);

    /* The viewer is told, in the same answer that allowed it, that it will not
       be asked again. This is the flag the window turns into one click. */
    assert.equal(first.value.trusted, true, 'the host allowed it but did not say it was trusted');

    // And the host kept it, with the key it arrived with.
    const remembered = trustedDevices.list();
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0].deviceId, deviceIdFromPublicKey(viewer.publicKey));
    assert.equal(trustedDevices.trusts(deviceIdFromPublicKey(viewer.publicKey), viewer.publicKey), true);
  } finally { await host.stop().catch(() => {}); }
});

test('connecting again needs no code and asks nobody', async () => {
  /* The whole point. The second connection carries no secret at all: being on
     the list is the authorisation, and the person at the host is not
     interrupted to confirm what they already said. */
  let asked = 0;
  const { host, deviceId, code } = await hostWith({
    consent: async () => { asked++; return 'allow-and-trust'; },
  });
  const viewer = generateIdentity();
  try {
    const first = await attempt(host, deviceId, withCode(code), viewer);
    assert.equal(first.status, 'fulfilled');
    assert.equal(asked, 1);

    const again = await attempt(host, deviceId, { kind: 'paired' }, viewer);
    assert.equal(again.status, 'fulfilled', `the paired connection was refused: ${again.reason?.message}`);
    assert.equal(again.value.trusted, true);
    assert.equal(asked, 1, 'the person at the host was asked again for a computer they had trusted');
  } finally { await host.stop().catch(() => {}); }
});

test('the pairing survives the application being restarted', async () => {
  /* Both halves are files, and this is the test that they are really written
     and really read back - a pairing held only in memory would look identical
     until the first restart. */
  const { host, deviceId, code, trustedDevices, dataDir } = await hostWith();
  const viewer = generateIdentity();
  const viewerId = deviceIdFromPublicKey(viewer.publicKey);
  try {
    const first = await attempt(host, deviceId, withCode(code), viewer);
    assert.equal(first.status, 'fulfilled');

    // The host, started again from the same folder.
    await trustedDevices.flush?.();
    const reloaded = new TrustedDevices(dataDir);
    await reloaded.load();
    assert.equal(reloaded.trusts(viewerId, viewer.publicKey), true,
      'the host forgot the computer it trusted when it restarted');

    // The viewer, likewise: the flag that makes the row one click.
    const viewerDir = await mkdtemp(path.join(tmpdir(), 'hopdesk-pairing-viewer-'));
    const known = new KnownDevices(viewerDir);
    await known.load();
    known.remember(deviceId, first.value.host.hostKey, 'Studio Mac', { paired: first.value.trusted });
    await known.flush();

    const afterRestart = new KnownDevices(viewerDir);
    await afterRestart.load();
    assert.equal(afterRestart.list()[0]?.paired, true,
      'the computer did not remember that it had been paired');
    void trustedDevices;
  } finally { await host.stop().catch(() => {}); }
});

test('a later connection that was not trusted does not un-pair the computer', async () => {
  /* The defect behind the complaint. `paired` was stored as
     "whatever the last session said", so using the access code once on a
     computer already paired - or connecting over an account, where trust is
     not offered at all - reported "not trusted" and quietly erased a pairing
     that was still perfectly good. The next connection then asked for a code
     again, for no reason the person could see. */
  const dir = await mkdtemp(path.join(tmpdir(), 'hopdesk-pairing-keep-'));
  const identity = generateIdentity();
  const hostId = deviceIdFromPublicKey(identity.publicKey);
  const known = new KnownDevices(dir);
  await known.load();

  known.remember(hostId, identity.publicKey, 'Studio Mac', { paired: true });
  assert.equal(known.list()[0].paired, true);

  // An ordinary session that granted nothing: the pairing stands.
  known.remember(hostId, identity.publicKey, 'Studio Mac', { paired: false });
  assert.equal(known.list()[0].paired, true, 'an untrusted session erased the pairing');

  // Written through, not just held: a restart agrees.
  await known.flush();
  const reloaded = new KnownDevices(dir);
  await reloaded.load();
  assert.equal(reloaded.list()[0].paired, true);

  /* And the one thing that does take it away: the host saying it no longer
     knows this computer. */
  reloaded.setPaired(hostId, false);
  assert.equal(reloaded.list()[0].paired, undefined);
  await reloaded.flush();
  const afterRevoke = new KnownDevices(dir);
  await afterRevoke.load();
  assert.equal(afterRevoke.list()[0].paired, undefined, 'the revocation was not written down');
});

test('a revoked pairing is refused, and the computer stops offering one click', async () => {
  const { host, deviceId, code, trustedDevices } = await hostWith();
  const viewer = generateIdentity();
  const viewerId = deviceIdFromPublicKey(viewer.publicKey);
  try {
    assert.equal((await attempt(host, deviceId, withCode(code), viewer)).status, 'fulfilled');

    // The person at the host changes their mind, under "Computers you trust".
    assert.ok(trustedDevices.remove(viewerId));
    assert.equal(trustedDevices.trusts(viewerId, viewer.publicKey), false);

    const refused = await attempt(host, deviceId, { kind: 'paired' }, viewer);
    assert.equal(refused.status, 'rejected');
    assert.ok(refused.reason instanceof HandshakeError);
    assert.equal(refused.reason.code, 'not-paired');

    // The access code still works: revoking trust is not banishment.
    assert.equal((await attempt(host, deviceId, withCode(code), viewer)).status, 'fulfilled');
  } finally { await host.stop().catch(() => {}); }
});

test('a pairing that has lapsed is refused like one that was revoked', async () => {
  /* Trust expires ninety days after it was last used. A computer that comes
     back after that is a computer the host no longer knows. */
  let clock = Date.UTC(2026, 0, 1);
  const trusted = new TrustedDevices(await mkdtemp(path.join(tmpdir(), 'hopdesk-pairing-ttl-')),
    () => clock);
  await trusted.load();
  const { host, deviceId, code } = await hostWith({ trusted });
  const viewer = generateIdentity();
  try {
    assert.equal((await attempt(host, deviceId, withCode(code), viewer)).status, 'fulfilled');

    clock += 91 * 24 * 3600_000;
    const refused = await attempt(host, deviceId, { kind: 'paired' }, viewer);
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.reason?.code, 'not-paired');
  } finally { await host.stop().catch(() => {}); }
});

test('a paired computer is still refused by a disabled installation', async () => {
  /* Pairing is permission from the person at the host. It is not permission
     from whoever administers the build, and must not be mistaken for it. */
  const { host, deviceId } = await hostWith({
    authorized: () => ({ ok: false, detail: 'This HopDesk installation has been disabled.' }),
  });
  try {
    const refused = await attempt(host, deviceId, { kind: 'paired' });
    assert.equal(refused.status, 'rejected', 'a disabled installation accepted a paired connection');
  } finally { await host.stop().catch(() => {}); }
});

test('a host whose identity key is not the pinned one is refused, paired or not', async () => {
  /* One click must not mean one click to anything answering on that address.
     The pin is checked before any of this. */
  const { host, deviceId } = await hostWith();
  const viewer = generateIdentity();
  const somebodyElse = generateIdentity();
  try {
    const refused = await attempt(host, deviceId, { kind: 'paired' }, viewer, somebodyElse.publicKey);
    assert.equal(refused.status, 'rejected', 'a substituted host key was accepted');
  } finally { await host.stop().catch(() => {}); }
});

test('a host that cannot write its trust list still answers, and says it is not trusted', async () => {
  /* Found by getting this wrong in a test: recording the trust threw, the
     exception escaped before the answer was sent, and the viewer sat waiting
     out its consent timeout - a minute of silence for a connection that had
     just been allowed. A full or read-only disk would do the same to a person.
     The session goes ahead; what is lost is only the promise not to ask
     again, so the viewer must be told it is not trusted rather than told
     nothing. */
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hopdesk-pairing-nodisk-'));
  const broken = {
    add: () => { throw new Error('read-only file system'); },
    trusts: () => false,
    renew: () => {},
    list: () => [],
    remove: () => null,
    load: async () => {},
  };
  const { host, deviceId, code } = await hostWith({ trusted: broken });
  try {
    const result = await attempt(host, deviceId, withCode(code));
    assert.equal(result.status, 'fulfilled', 'the connection was lost instead of being allowed');
    assert.equal(result.value.trusted, false,
      'it was told it would not be asked again, by a host that did not write it down');
  } finally { await host.stop().catch(() => {}); }
  void dataDir;
});
