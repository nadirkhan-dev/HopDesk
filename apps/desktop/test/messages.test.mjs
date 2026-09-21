import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMessage, friendlyError } from '../renderer/hopdesk.js';

/**
 * What a failure looks like to the person in front of it. Two layers of
 * machinery wrap every error on the way here — Electron's IPC and the
 * protocol's own error codes — and neither is anything to show someone.
 */

test('Electron\'s IPC wrapper and the error class are stripped', () => {
  assert.equal(
    cleanMessage("Error invoking remote method 'connectDevice': HandshakeError: unknown-device"),
    'unknown-device');
  assert.equal(cleanMessage('HandshakeError: not-paired'), 'not-paired');
  assert.equal(cleanMessage('Error: something plain'), 'something plain');
  assert.equal(cleanMessage(undefined), '');
});

test('every handshake failure a person can cause reads as a sentence', () => {
  const cases = {
    'bad-auth': /access code is not correct/,
    'rate-limited': /Too many attempts/,
    'not-found': /No computer with that Device ID/,
    'unknown-device': /different Device ID/,
    'code-disabled': /not accepting connections by access code/,
    'not-paired': /not paired with this one/,
    'user-rejected': /did not allow the connection/,
    timeout: /did not answer in time/,
  };
  for (const [code, expected] of Object.entries(cases)) {
    const wrapped = `Error invoking remote method 'connectDevice': HandshakeError: ${code}`;
    const text = friendlyError(wrapped);
    assert.match(text, expected, `${code} → ${text}`);
    assert.doesNotMatch(text, /invoking remote method|HandshakeError/, `${code} leaked machinery: ${text}`);
  }
});

test('an error nobody has written words for is passed through, tidied', () => {
  const text = friendlyError("Error invoking remote method 'connectDevice': Error: the toaster is on fire");
  assert.equal(text, 'the toaster is on fire');
});
