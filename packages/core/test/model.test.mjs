import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectionManager, CredentialStore, cleanHost } from '../dist/index.js';

/** The connection model: history per session, duplication, input validation. */

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'hopdesk-model-'));
  const creds = new CredentialStore(dir, 'file');
  await creds.unlock('model-test-passphrase');
  const mgr = new ConnectionManager(dir, creds);
  await mgr.load();
  return { dir, creds, mgr };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('a connected session records when it connected, when it ended, how, and its real length', async () => {
  const { mgr } = await setup();
  const c = await mgr.add({ name: 'Win', protocol: 'rdp', host: '10.0.0.5' });
  const h = await mgr.recordStart(c.id);
  await wait(30);
  await mgr.recordConnected(h);
  await wait(60);
  await mgr.recordSessionEnd(h, { reason: 'remote', error: 'The connection to the remote computer was interrupted.', errorCategory: 'network-lost' });

  const [entry] = mgr.history(50, c.id);
  assert.equal(entry.outcome, 'connected');
  assert.ok(entry.connectedAt && entry.endedAt);
  assert.equal(entry.durationMs, Date.parse(entry.endedAt) - Date.parse(entry.connectedAt),
    'duration must measure the session, not the time to connect');
  assert.ok(entry.durationMs >= 50);
  assert.equal(entry.endReason, 'remote');
  assert.equal(entry.errorCategory, 'network-lost');
  assert.equal(entry.protocol, 'rdp');
  assert.equal(mgr.get(c.id).connectCount, 1);

  // Ending twice (e.g. a late process exit after Disconnect) changes nothing.
  const endedAt = entry.endedAt;
  await mgr.recordSessionEnd(h, { reason: 'error' });
  assert.equal(mgr.history(50, c.id)[0].endedAt, endedAt);
  assert.equal(mgr.history(50, c.id)[0].endReason, 'remote');
});

test('an attempt that never connected is recorded as failed or cancelled', async () => {
  const { mgr } = await setup();
  const c = await mgr.add({ name: 'Mac', protocol: 'vnc', host: 'mac.local' });
  await mgr.recordSessionEnd(await mgr.recordStart(c.id), { reason: 'error', error: 'Wrong password', errorCategory: 'auth-failed' });
  await mgr.recordSessionEnd(await mgr.recordStart(c.id), { reason: 'user' });
  const [cancelled, failed] = mgr.history(50, c.id);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.errorCategory, 'auth-failed');
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(mgr.get(c.id).connectCount, 0, 'a failure counted as a connection');
});

test('each connection sees only its own history, and deleting a connection removes its history', async () => {
  const { mgr } = await setup();
  const a = await mgr.add({ name: 'A', protocol: 'vnc', host: 'a' });
  const b = await mgr.add({ name: 'B', protocol: 'rdp', host: 'b' });
  await mgr.recordConnected(await mgr.recordStart(a.id));
  await mgr.recordConnected(await mgr.recordStart(b.id));
  await mgr.recordConnected(await mgr.recordStart(b.id));
  assert.equal(mgr.history(50, a.id).length, 1);
  assert.equal(mgr.history(50, b.id).length, 2);
  assert.ok(mgr.history(50, b.id).every(h => h.connectionId === b.id));

  await mgr.remove(b.id);
  assert.equal(mgr.history().length, 1);
  assert.equal(mgr.history()[0].connectionId, a.id);
});

test('history never contains a password', async () => {
  const { mgr, dir } = await setup();
  const c = await mgr.add({ name: 'X', protocol: 'rdp', host: 'x', username: 'u', password: 'history-canary-pw' });
  const h = await mgr.recordStart(c.id);
  await mgr.recordSessionEnd(h, { reason: 'error', error: 'Wrong username or password' });
  const raw = await readFile(path.join(dir, 'connections.json'), 'utf8');
  assert.ok(!raw.includes('history-canary-pw'));
});

test('duplicating a connection copies its settings and saved password under a new name', async () => {
  const { mgr, creds } = await setup();
  const c = await mgr.add({
    name: 'Office', protocol: 'rdp', os: 'windows', host: 'office', username: 'me', domain: 'CORP',
    password: 'dup-secret', options: { multiMonitor: true }, favorite: true,
  });
  const first = await mgr.duplicate(c.id);
  assert.equal(first.connection.name, 'Office (copy)');
  assert.notEqual(first.connection.id, c.id);
  assert.equal(first.connection.favorite, false);
  assert.equal(first.connection.connectCount, 0);
  assert.equal(first.connection.options.multiMonitor, true);
  assert.equal(first.connection.domain, 'CORP');
  assert.equal(first.passwordCopied, true);
  assert.equal(await creds.get(first.connection.id), 'dup-secret');

  // Options are a copy, not shared by reference.
  await mgr.update(first.connection.id, { options: { multiMonitor: false } });
  assert.equal(mgr.get(c.id).options.multiMonitor, true);

  const second = await mgr.duplicate(c.id);
  assert.equal(second.connection.name, 'Office (copy 2)');
});

test('duplicating while the vault is locked still works, and says the password was not copied', async () => {
  const { mgr, creds } = await setup();
  const c = await mgr.add({ name: 'Locked', protocol: 'vnc', host: 'l', password: 'x-secret' });
  creds.lock();
  const r = await mgr.duplicate(c.id);
  assert.equal(r.passwordCopied, false);
  assert.equal(r.connection.name, 'Locked (copy)');
  assert.equal(mgr.get(r.connection.id).host, 'l');
});

test('the kind of computer is stored, inferred for older RDP entries, and validated', async () => {
  const { mgr, dir } = await setup();
  const mac = await mgr.add({ name: 'Mac', protocol: 'vnc', os: 'macos', host: 'm' });
  const win = await mgr.add({ name: 'Win', protocol: 'rdp', host: 'w' });
  assert.equal(mac.os, 'macos');
  assert.equal(win.os, 'windows');
  await assert.rejects(() => mgr.add({ name: 'x', protocol: 'vnc', os: 'amiga', host: 'x' }), /kind of computer/);
  await assert.rejects(() => mgr.add({ name: 'x', protocol: 'telnet', host: 'x' }), /RDP or VNC/);

  const reopened = new ConnectionManager(dir);
  await reopened.load();
  assert.equal(reopened.get(mac.id).os, 'macos');
});

test('hosts pasted as URLs or with ports are cleaned, and mistakes are explained', () => {
  assert.equal(cleanHost('  10.0.0.5 '), '10.0.0.5');
  assert.equal(cleanHost('vnc://mac.local:5900/'), 'mac.local');
  assert.equal(cleanHost('rdp://office-pc'), 'office-pc');
  assert.equal(cleanHost('office-pc:3389'), 'office-pc');
  assert.equal(cleanHost('fe80::1'), 'fe80::1', 'an IPv6 address lost a part');
  assert.equal(cleanHost('[fe80::1]:3389'), 'fe80::1');
  assert.throws(() => cleanHost('   '), /hostname or IP/);
  assert.throws(() => cleanHost('alice@office-pc'), /username has its own field/);
  assert.throws(() => cleanHost('office pc'), /does not look like/);
});
