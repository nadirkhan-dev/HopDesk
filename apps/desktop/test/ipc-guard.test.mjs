import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedSender } from '../dist/ipc-guard.js';

const UI = 'file:///opt/HopDesk/resources/app.asar/apps/desktop/renderer/index.html';
const app = { id: 'main-window' };
const frame = (url = UI, parent = null) => ({ url, parent });

test('messages from the app window showing the bundled UI are trusted', () => {
  assert.equal(isTrustedSender({ sender: app, senderFrame: frame() }, app, UI), true);
  assert.equal(isTrustedSender({ sender: app, senderFrame: frame(`${UI}#computers`) }, app, UI), true);
});

test('other windows, iframes, navigated pages and destroyed frames are refused', () => {
  assert.equal(isTrustedSender({ sender: { id: 'other' }, senderFrame: frame() }, app, UI), false, 'another window');
  assert.equal(isTrustedSender({ sender: app, senderFrame: frame(UI, { url: UI }) }, app, UI), false, 'a child frame');
  assert.equal(isTrustedSender({ sender: app, senderFrame: frame('https://evil.example/') }, app, UI), false, 'navigated away');
  assert.equal(isTrustedSender({ sender: app, senderFrame: frame('file:///tmp/index.html') }, app, UI), false, 'another local file');
  assert.equal(isTrustedSender({ sender: app, senderFrame: null }, app, UI), false, 'destroyed frame');
  assert.equal(isTrustedSender({ sender: app, senderFrame: frame() }, null, UI), false, 'no app window');
});
