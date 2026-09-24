import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PortalToken } from '../dist/portal-token.js';

/**
 * The Wayland desktop's "again without asking" token.
 *
 * Without it the portal asks the person at the keyboard every session, which
 * for a computer meant to be reachable is once too often and for one nobody is
 * sitting at is fatal. HopDesk asked for this token for a year and threw it
 * away every time, because nothing kept it.
 */
const store = () => new PortalToken(mkdtempSync(path.join(tmpdir(), 'hopdesk-portal-')));

test('a token is kept, comes back, and is readable only by this user', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-portal-'));
  const tokens = new PortalToken(dir);
  assert.equal(tokens.get(), undefined, 'a token appeared from nowhere');

  tokens.set('restore-me-please');
  assert.equal(tokens.get(), 'restore-me-please');
  // A fresh reader sees it too: it is on disk, not just in memory.
  assert.equal(new PortalToken(dir).get(), 'restore-me-please');

  /* It is a capability - whoever holds it can ask this desktop for input
     without the dialog - so it is nobody else's business. */
  const mode = statSync(path.join(dir, 'wayland-portal.json')).mode & 0o777;
  assert.equal(mode, 0o600, `token file is ${mode.toString(8)}`);
});

test('a refused token is forgotten, so it is not offered forever', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-portal-'));
  const tokens = new PortalToken(dir);
  tokens.set('stale');
  tokens.clear();
  assert.equal(tokens.get(), undefined);
  assert.equal(existsSync(path.join(dir, 'wayland-portal.json')), false, 'the file outlived the token');
  assert.equal(new PortalToken(dir).get(), undefined);
});

test('nonsense on disk is no token, not a crash', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-portal-'));
  writeFileSync(path.join(dir, 'wayland-portal.json'), 'not json at all');
  assert.equal(new PortalToken(dir).get(), undefined);

  writeFileSync(path.join(dir, 'wayland-portal.json'), JSON.stringify({ restoreToken: 42 }));
  assert.equal(new PortalToken(dir).get(), undefined, 'a number was taken for a token');

  // Absurdly long is not a token either: the portal's are short handles.
  writeFileSync(path.join(dir, 'wayland-portal.json'), JSON.stringify({ restoreToken: 'x'.repeat(5000) }));
  assert.equal(new PortalToken(dir).get(), undefined);
});

test('an empty or over-long token is not written', () => {
  const tokens = store();
  tokens.set('');
  assert.equal(tokens.get(), undefined);
  tokens.set('y'.repeat(600));
  assert.equal(tokens.get(), undefined);
});
