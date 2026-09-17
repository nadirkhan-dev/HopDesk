import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectionManager, CredentialStore, DEFAULT_PORTS } from '../dist/index.js';

let dir, creds, mgr;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hopdesk-test-'));
  // Force the file backend so tests do not depend on a session keyring.
  creds = new CredentialStore(dir, 'file');
  await creds.unlock('a-test-master-passphrase');
  mgr = new ConnectionManager(dir, creds);
  await mgr.load();
});

test('adds a connection and defaults the port per protocol', async () => {
  const c = await mgr.add({ name: 'Office PC', protocol: 'rdp', host: '10.0.0.5' });
  assert.equal(c.port, DEFAULT_PORTS.rdp);
  assert.equal(c.port, 3389);
  assert.equal(mgr.list().length, 1);
});

test('rejects an empty host and an out-of-range port', async () => {
  await assert.rejects(() => mgr.add({ name: 'x', protocol: 'vnc', host: '   ' }), /hostname or IP/);
  await assert.rejects(() => mgr.add({ name: 'x', protocol: 'vnc', host: 'h', port: 0 }), /between 1 and 65535/);
  await assert.rejects(() => mgr.add({ name: 'x', protocol: 'vnc', host: 'h', port: 70000 }), /between 1 and 65535/);
});

test('falls back to the host as the name when none is given', async () => {
  const c = await mgr.add({ name: '  ', protocol: 'vnc', host: 'nas.local' });
  assert.equal(c.name, 'nas.local');
});

test('NEVER writes a password into the connections file', async () => {
  await mgr.add({
    name: 'Secret Box', protocol: 'vnc', host: '10.0.0.9',
    username: 'admin', password: 'hunter2-the-password',
  });

  const raw = await readFile(path.join(dir, 'connections.json'), 'utf8');
  assert.ok(!raw.includes('hunter2'), 'the password leaked into connections.json');
  assert.ok(raw.includes('10.0.0.9'), 'the connection itself was not saved');
});

test('the connections file is not world readable', async () => {
  await mgr.add({ name: 'x', protocol: 'vnc', host: 'h' });
  const mode = (await stat(path.join(dir, 'connections.json'))).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('a saved password round-trips through the vault', async () => {
  const c = await mgr.add({ name: 'x', protocol: 'vnc', host: 'h', password: 'correct horse' });
  assert.equal(await mgr.passwordFor(c.id), 'correct horse');
});

test('the vault on disk contains no plaintext', async () => {
  await mgr.add({ name: 'x', protocol: 'vnc', host: 'h', password: 'plaintext-canary' });
  const raw = await readFile(path.join(dir, 'credentials.vault'), 'utf8');
  assert.ok(!raw.includes('plaintext-canary'), 'the vault stored the password in the clear');
});

test('a wrong master passphrase is rejected, not silently accepted', async () => {
  await mgr.add({ name: 'x', protocol: 'vnc', host: 'h', password: 'secret' });

  const reopened = new CredentialStore(dir, 'file');
  await assert.rejects(() => reopened.unlock('the-wrong-passphrase'), /not correct/);

  const right = new CredentialStore(dir, 'file');
  await right.unlock('a-test-master-passphrase');
  assert.equal(await right.get((mgr.list())[0].id), 'secret');
});

test('a tampered vault entry fails to decrypt rather than returning garbage', async () => {
  const c = await mgr.add({ name: 'x', protocol: 'vnc', host: 'h', password: 'secret' });
  const vaultPath = path.join(dir, 'credentials.vault');
  const vault = JSON.parse(await readFile(vaultPath, 'utf8'));

  // Flip a byte of ciphertext. GCM must detect it.
  const entry = vault.entries[c.id];
  entry.data = (entry.data[0] === 'a' ? 'b' : 'a') + entry.data.slice(1);
  await (await import('node:fs/promises')).writeFile(vaultPath, JSON.stringify(vault));

  const reopened = new CredentialStore(dir, 'file');
  await assert.rejects(() => reopened.unlock('a-test-master-passphrase'));
});

test('updating with an empty password forgets it', async () => {
  const c = await mgr.add({ name: 'x', protocol: 'vnc', host: 'h', password: 'temp' });
  await mgr.update(c.id, { password: '' });
  assert.equal(await mgr.passwordFor(c.id), null);
});

test('deleting a connection removes its stored secret', async () => {
  const c = await mgr.add({ name: 'x', protocol: 'vnc', host: 'h', password: 'secret' });
  await mgr.remove(c.id);
  assert.equal(mgr.list().length, 0);
  assert.equal(await creds.get(c.id), null, 'an orphaned secret was left behind');
});

test('favourites sort to the top', async () => {
  await mgr.add({ name: 'Zeta', protocol: 'vnc', host: 'z' });
  const alpha = await mgr.add({ name: 'Alpha', protocol: 'vnc', host: 'a' });
  assert.equal(mgr.list()[0].name, 'Alpha');      // alphabetical to begin with

  await mgr.toggleFavorite((mgr.list().find(c => c.name === 'Zeta')).id);
  assert.equal(mgr.list()[0].name, 'Zeta', 'a favourite did not sort first');
  assert.notEqual(alpha.id, mgr.list()[0].id);
});

test('history records an outcome and updates the connection', async () => {
  const c = await mgr.add({ name: 'x', protocol: 'vnc', host: 'h' });

  const h1 = await mgr.recordStart(c.id);
  await mgr.recordEnd(h1, 'connected');
  assert.equal(mgr.get(c.id).connectCount, 1);
  assert.ok(mgr.get(c.id).lastConnectedAt);

  const h2 = await mgr.recordStart(c.id);
  await mgr.recordEnd(h2, 'failed', 'Connection refused');

  const history = mgr.history();
  assert.equal(history.length, 2);
  assert.equal(history[0].outcome, 'failed');
  assert.equal(history[0].error, 'Connection refused');
  assert.ok(typeof history[0].durationMs === 'number');
  // A failure must not count as a successful connection.
  assert.equal(mgr.get(c.id).connectCount, 1);
});

test('data survives a reload', async () => {
  const c = await mgr.add({
    name: 'Persistent', protocol: 'rdp', host: 'srv', username: 'me', domain: 'CORP',
    options: { scaling: 'none', enableAudio: true },
  });
  await mgr.toggleFavorite(c.id);

  const reopened = new ConnectionManager(dir, creds);
  await reopened.load();
  const loaded = reopened.get(c.id);

  assert.equal(loaded.name, 'Persistent');
  assert.equal(loaded.domain, 'CORP');
  assert.equal(loaded.favorite, true);
  assert.equal(loaded.options.scaling, 'none');
  assert.equal(loaded.options.enableAudio, true);
  // Unspecified options must still be filled from defaults.
  assert.equal(loaded.options.autoReconnect, true);
});

test('a corrupt connections file is moved aside instead of crashing forever', async () => {
  await mgr.add({ name: 'x', protocol: 'vnc', host: 'h' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'connections.json'), '{ this is not json');

  const broken = new ConnectionManager(dir, creds);
  await assert.rejects(() => broken.load(), /moved to/);

  // A second attempt now starts clean rather than failing identically.
  const fresh = new ConnectionManager(dir, creds);
  await fresh.load();
  assert.equal(fresh.list().length, 0);
});

test('operations before load() fail loudly', async () => {
  const unloaded = new ConnectionManager(dir, creds);
  assert.throws(() => unloaded.list(), /load\(\) was not called/);
});
