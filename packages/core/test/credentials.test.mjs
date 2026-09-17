import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CredentialStore, ConnectionManager, MIN_PASSPHRASE_LENGTH } from '../dist/index.js';

/**
 * Security properties of credential storage that the UI now depends on:
 * locking, passphrase verification, the keyring path never exposing a secret
 * in argv, and no plaintext on disk.
 */

const tempDir = () => mkdtemp(path.join(tmpdir(), 'hopdesk-cred-'));

test('an empty vault still rejects a wrong passphrase', async () => {
  const dir = await tempDir();
  const first = new CredentialStore(dir, 'file');
  await first.unlock('the-right-passphrase');

  // No entries yet: the old design had nothing to verify against and accepted anything.
  const second = new CredentialStore(dir, 'file');
  await assert.rejects(() => second.unlock('a-wrong-passphrase'), /not correct/);
  assert.equal(second.isUnlocked, false);

  const third = new CredentialStore(dir, 'file');
  await third.unlock('the-right-passphrase');
  assert.equal(third.isUnlocked, true);
});

test('a vault written before the verifier existed is upgraded on unlock', async () => {
  const dir = await tempDir();
  const store = new CredentialStore(dir, 'file');
  await store.unlock('legacy-passphrase');
  await store.set('c1', 'legacy-secret');

  const vaultPath = path.join(dir, 'credentials.vault');
  const vault = JSON.parse(await readFile(vaultPath, 'utf8'));
  delete vault.check;
  await writeFile(vaultPath, JSON.stringify(vault));

  await assert.rejects(() => new CredentialStore(dir, 'file').unlock('wrong-passphrase'), /not correct/);
  const reopened = new CredentialStore(dir, 'file');
  await reopened.unlock('legacy-passphrase');
  assert.equal(await reopened.get('c1'), 'legacy-secret');
  assert.ok(JSON.parse(await readFile(vaultPath, 'utf8')).check, 'the verifier was not added');
});

test('a new vault requires a passphrase of a minimum length', async () => {
  const dir = await tempDir();
  const store = new CredentialStore(dir, 'file');
  await assert.rejects(() => store.unlock('short'), new RegExp(`at least ${MIN_PASSPHRASE_LENGTH}`));
  assert.equal(store.vaultExists, false, 'a vault was created with a rejected passphrase');
});

test('the file backend reports that it needs unlocking, and refuses to store while locked', async () => {
  const dir = await tempDir();
  const store = new CredentialStore(dir, 'file');
  assert.equal(await store.needsUnlock(), true);
  assert.equal(store.vaultExists, false);
  await assert.rejects(() => store.set('c', 'secret'), /locked/);
  await assert.rejects(() => store.get('c'), /locked/);

  await store.unlock('a-fine-passphrase');
  assert.equal(await store.needsUnlock(), false);
  assert.equal(store.vaultExists, true);

  store.lock();
  assert.equal(await store.needsUnlock(), true);
});

test('vault and connection files hold no plaintext after add, update and reload', async () => {
  const dir = await tempDir();
  const creds = new CredentialStore(dir, 'file');
  await creds.unlock('a-fine-passphrase');
  const mgr = new ConnectionManager(dir, creds);
  await mgr.load();

  const c = await mgr.add({ name: 'x', protocol: 'rdp', host: 'h', username: 'u', password: 'first-canary-pw' });
  await mgr.update(c.id, { password: 'second-canary-pw' });
  assert.equal(await mgr.passwordFor(c.id), 'second-canary-pw');

  for (const file of await readdir(dir)) {
    const raw = await readFile(path.join(dir, file), 'utf8');
    assert.ok(!raw.includes('canary-pw'), `plaintext password found in ${file}`);
  }
});

/* ---------------------------------------------------------- keyring */

/** A fake `secret-tool` on PATH that records its argv and stdin. */
async function fakeSecretTool() {
  const dir = await tempDir();
  const script = `#!/bin/sh
LOG="${dir}"
printf '%s\\n' "$*" >> "$LOG/argv.log"
case "$1" in
  store)  cat > "$LOG/secret" ;;
  lookup)
    if [ "$4" = "probe" ]; then exit 1; fi
    if [ -f "$LOG/secret" ]; then cat "$LOG/secret"; else exit 1; fi ;;
  clear)  rm -f "$LOG/secret" ;;
esac
`;
  await writeFile(path.join(dir, 'secret-tool'), script);
  await chmod(path.join(dir, 'secret-tool'), 0o755);
  return dir;
}

test('the keyring backend passes secrets on stdin, never in argv', async () => {
  const bin = await fakeSecretTool();
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    const store = new CredentialStore(await tempDir());
    assert.equal(await store.backend(), 'keyring', 'a working secret-tool was not detected');
    assert.equal(await store.needsUnlock(), false, 'the keyring must not ask for a vault passphrase');

    await store.set('conn-1', 'keyring-canary-secret');
    const argv = await readFile(path.join(bin, 'argv.log'), 'utf8');
    assert.ok(!argv.includes('keyring-canary-secret'), 'the secret was passed as an argument');
    assert.equal(await readFile(path.join(bin, 'secret'), 'utf8'), 'keyring-canary-secret');
    assert.equal(await store.get('conn-1'), 'keyring-canary-secret');

    await store.delete('conn-1');
    assert.equal(await store.get('conn-1'), null);
  } finally {
    process.env.PATH = savedPath;
  }
});

test('a missing secret-tool falls back to the encrypted vault', async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = await tempDir();          // nothing on PATH
  try {
    assert.equal(await new CredentialStore(await tempDir()).backend(), 'file');
  } finally {
    process.env.PATH = savedPath;
  }
});

/* ------------------------------------------------- connection metadata */

test('certificate trust is dropped when the address changes, and kept otherwise', async () => {
  const dir = await tempDir();
  const mgr = new ConnectionManager(dir);
  await mgr.load();
  const fp = 'ab'.repeat(32).match(/../g).join(':');
  const c = await mgr.add({ name: 'Win', protocol: 'rdp', host: '10.0.0.5', options: { trustedCertificate: fp, enableAudio: true } });

  await mgr.update(c.id, { name: 'Renamed' });
  assert.equal(mgr.get(c.id).options.trustedCertificate, fp, 'a rename must not drop trust');

  // A partial options patch must not reset the other options.
  await mgr.update(c.id, { options: { multiMonitor: true } });
  assert.equal(mgr.get(c.id).options.enableAudio, true, 'a partial options update discarded other options');
  assert.equal(mgr.get(c.id).options.trustedCertificate, fp);

  await mgr.update(c.id, { host: '10.0.0.99' });
  assert.equal(mgr.get(c.id).options.trustedCertificate, undefined, 'trust carried over to a different host');

  await mgr.update(c.id, { options: { trustedCertificate: fp } });
  await mgr.update(c.id, { port: 3390 });
  assert.equal(mgr.get(c.id).options.trustedCertificate, undefined, 'trust carried over to a different port');
});

test('history can be listed for one connection', async () => {
  const mgr = new ConnectionManager(await tempDir());
  await mgr.load();
  const a = await mgr.add({ name: 'a', protocol: 'vnc', host: 'a' });
  const b = await mgr.add({ name: 'b', protocol: 'vnc', host: 'b' });
  await mgr.recordEnd(await mgr.recordStart(a.id), 'connected');
  await mgr.recordEnd(await mgr.recordStart(b.id), 'failed', 'x');
  assert.equal(mgr.history().length, 2);
  assert.deepEqual(mgr.history(50, a.id).map(h => h.connectionId), [a.id]);
});

test('passwords saved at the same moment all survive, with no half-written vault', async () => {
  const dir = await tempDir();
  const store = new CredentialStore(dir, 'file');
  await store.unlock('concurrent-passphrase');
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.set(`c${i}`, `secret-${i}`)));

  const reopened = new CredentialStore(dir, 'file');
  await reopened.unlock('concurrent-passphrase');
  for (let i = 0; i < 25; i++) assert.equal(await reopened.get(`c${i}`), `secret-${i}`, `lost c${i}`);
  assert.deepEqual((await readdir(dir)).sort(), ['credentials.vault'], 'a temporary file was left behind');
});
