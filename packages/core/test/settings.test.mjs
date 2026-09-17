import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore, DEFAULT_SETTINGS } from '../dist/index.js';

const dir = () => mkdtemp(path.join(tmpdir(), 'hopdesk-settings-'));

test('settings persist across restarts, private to the user', async () => {
  const d = await dir();
  const s = new SettingsStore(d);
  await s.load();
  assert.deepEqual(s.get(), DEFAULT_SETTINGS);
  await s.update({ defaults: { scaling: 'none', shareClipboard: false } });

  const again = new SettingsStore(d);
  const loaded = await again.load();
  assert.equal(loaded.defaults.scaling, 'none');
  assert.equal(loaded.defaults.shareClipboard, false);
  assert.equal(loaded.defaults.autoReconnect, true, 'a partial update reset another setting');
  assert.equal((await stat(path.join(d, 'settings.json'))).mode & 0o777, 0o600);
});

test('unknown keys and wrong types are ignored rather than stored', async () => {
  const d = await dir();
  const s = new SettingsStore(d);
  await s.load();
  const after = await s.update({ defaults: { scaling: 'stretch', viewOnly: 'yes', trustedCertificate: 'aa:bb', redirectFolder: '/' } });
  assert.equal(after.defaults.scaling, 'fit');
  assert.equal(after.defaults.viewOnly, false);
  assert.ok(!('trustedCertificate' in after.defaults), 'a per-computer value became a global default');
  const raw = await readFile(path.join(d, 'settings.json'), 'utf8');
  assert.ok(!raw.includes('aa:bb'));
});

test('a corrupt settings file falls back to defaults instead of crashing', async () => {
  const d = await dir();
  await writeFile(path.join(d, 'settings.json'), '{ not json');
  const s = new SettingsStore(d);
  assert.deepEqual(await s.load(), DEFAULT_SETTINGS);
});
