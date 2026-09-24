import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, electronUnavailableReason, waitFor } from './helpers/electron.mjs';
import { clickConnect, addViaUi } from './helpers/ui.mjs';
import {
  startFakeRfbServer, update, rawRect, extendedDesktopSize,
} from '../../../packages/core/test/helpers/fake-rfb-server.mjs';

/**
 * The computer list, editor, display modes, settings and hardening, in the
 * real Electron app. Needs a display; skipped without one.
 */

const skip = electronUnavailableReason() ?? false;
const ENV = { HOPDESK_CREDENTIAL_BACKEND: 'file' };
const click = (app, sel) => app.eval(`document.querySelector(${JSON.stringify(sel)}).click(); return true`);
const text = (app, sel) => app.eval(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);

test('adding, validating, searching, duplicating and deleting computers', { skip, timeout: 90_000 }, async () => {
  const app = await launchApp({ env: ENV });
  try {
    await app.eval(`await window.hopdesk.unlockVault('ui-test-passphrase'); return true`);

    // Choosing Windows picks Remote Desktop and its port.
    await click(app, '#btn-new');
    await click(app, '#os-picker [data-os="windows"]');
    assert.equal(await app.eval(`return document.querySelector('#f-protocol').value`), 'rdp');
    assert.equal(await app.eval(`return document.querySelector('#f-port').value`), '3389');
    assert.match(await text(app, '#proto-hint'), /Remote Desktop/);
    await click(app, '#os-picker [data-os="macos"]');
    assert.equal(await app.eval(`return document.querySelector('#f-protocol').value`), 'vnc');
    assert.equal(await app.eval(`return document.querySelector('#f-port').value`), '5900');

    // An empty address is caught in the dialog, with the field marked.
    await click(app, '#dlg-save');
    assert.equal(await app.eval(`return document.querySelector('#dlg-edit').open`), true);
    assert.match(await text(app, '#err-host'), /name or IP address/);
    assert.equal(await app.eval(`return document.querySelector('#f-host').getAttribute('aria-invalid')`), 'true');
    // An address with a username in it is refused by the core with a clear sentence.
    await app.eval(`const h = document.querySelector('#f-host'); h.value = 'bob@mac.local'; return true`);
    await click(app, '#dlg-save');
    await app.waitFor(`return !document.querySelector('#dlg-error').hidden`, 8000, 'core validation error');
    assert.match(await text(app, '#dlg-error'), /username has its own field/);
    await click(app, '#dlg-edit [data-close="cancel"]');

    const mac = await addViaUi(app, { os: 'macos', protocol: 'vnc', name: 'Studio Mac', host: 'studio.local', port: 5900, password: 'mac-pw-1' });
    const win = await addViaUi(app, { os: 'windows', protocol: 'rdp', name: 'Office PC', host: '10.0.0.5', port: 3389, username: 'alice' });
    const saved = await app.eval(`return await window.hopdesk.list()`);
    assert.equal(saved.find(c => c.id === mac).os, 'macos');
    assert.equal(saved.find(c => c.id === win).os, 'windows');

    // Search narrows the list, by name, address or username.
    await app.eval(`const s = document.querySelector('#search'); s.value = 'alice'; s.dispatchEvent(new Event('input')); return true`);
    assert.deepEqual(await app.eval(`return [...document.querySelectorAll('.item .name')].map(n => n.textContent)`), ['Office PC']);
    await app.eval(`const s = document.querySelector('#search'); s.value = ''; s.dispatchEvent(new Event('input')); return true`);

    // Duplicate from the detail view: settings and the saved password come along.
    await app.eval(`document.querySelector('.item[data-id="${mac}"]').click(); return true`);
    await click(app, '#btn-dup');
    await app.waitFor(`return [...document.querySelectorAll('.item .name')].some(n => n.textContent === 'Studio Mac (copy)')`, 5000, 'duplicate in list');
    await app.waitFor(`return /same saved password/.test(document.querySelector('#toasts').textContent)`, 8000, 'duplicate toast');

    // Right-click menu offers the same actions.
    await app.eval(`document.querySelector('.item[data-id="${win}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); return true`);
    assert.deepEqual(await app.eval(`return [...document.querySelectorAll('#menu button')].map(b => b.dataset.act)`),
      ['connect', 'edit', 'duplicate', 'favorite', 'delete']);
    await app.eval(`document.querySelector('#menu [data-act="delete"]').click(); return true`);
    await app.waitFor(`return document.querySelector('#dlg-confirm').open`, 8000, 'confirm dialog');
    assert.match(await text(app, '#confirm-text'), /history are removed/);
    // Cancel keeps it; confirming deletes it.
    await click(app, '#dlg-confirm [data-close="cancel"]');
    assert.equal((await app.eval(`return await window.hopdesk.list()`)).length, 3);
    await click(app, '#btn-del');
    await app.waitFor(`return document.querySelector('#dlg-confirm').open`, 8000, 'confirm dialog again');
    await click(app, '#confirm-ok');
    /* Waits on the data and the list separately, because "the list still shows
       three" and "the delete never happened" are different bugs, and a busy
       machine running several Electron instances can make the round trip slow
       without either being true. */
    await app.waitFor(`return (await window.hopdesk.list()).length === 2`, 15_000, 'the computer to be deleted');
    await app.waitFor(`return document.querySelectorAll('.item').length === 2`, 5000,
      'the list to stop showing a deleted computer (the delete itself worked)');
    assert.ok(!(await app.eval(`return await window.hopdesk.list()`)).some(c => c.id === win));
  } finally {
    await app.close();
  }
});

test('display modes: fit, actual size with zoom, and matching the window size', { skip, timeout: 90_000 }, async () => {
  const W = 400, H = 300;
  let size = { w: W, h: H };
  const server = await startFakeRfbServer({
    width: W, height: H,
    onRequest: req => req.incremental
      ? null
      : update(extendedDesktopSize(size.w, size.h), rawRect(0, 0, size.w, size.h, () => [30, 90, 160])),
    onSetDesktopSize: ({ width, height }) => {
      size = { w: width, h: height };
      return update(extendedDesktopSize(width, height, { reason: 1 }), rawRect(0, 0, width, height, () => [30, 90, 160]));
    },
  });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hopdesk-ui-view-'));
  let app;
  let id;
  try {
  app = await launchApp({ env: ENV, dataDir });
  try {
    id = await addViaUi(app, { protocol: 'vnc', name: 'Resizable', host: '127.0.0.1', port: server.port });
    await clickConnect(app, id);
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Connected')`, 10_000, 'connected');
    await app.waitFor(`return document.querySelector('#screen').width === ${W}`, 5000, 'canvas size');

    // Fit: scaled to the viewport, aspect ratio kept.
    const fit = await app.eval(`
      const c = document.querySelector('#screen'), v = document.querySelector('#viewport');
      return { cw: parseFloat(c.style.width), ch: parseFloat(c.style.height), vw: v.clientWidth, vh: v.clientHeight }`);
    assert.ok(Math.abs(fit.cw / fit.ch - W / H) < 0.02, `aspect ratio not kept: ${JSON.stringify(fit)}`);
    assert.ok(fit.cw <= fit.vw && fit.ch <= fit.vh);
    assert.ok(fit.cw >= fit.vw - 2 || fit.ch >= fit.vh - 2, 'fit did not fill the viewport along one axis');

    // Actual size, then zoom in.
    await app.eval(`const m = document.querySelector('#view-mode'); m.value = 'none'; m.dispatchEvent(new Event('change')); return true`);
    await app.waitFor(`return parseFloat(document.querySelector('#screen').style.width) === ${W}`, 8000, 'actual size');
    await click(app, '#btn-zoom-in');
    await app.waitFor(`return document.querySelector('#zoom-label').textContent === '110%'`, 8000, 'zoom label');
    assert.equal(await app.eval(`return parseFloat(document.querySelector('#screen').style.width)`), Math.round(W * 1.1));

    // Match window size: the remote desktop is asked to take the viewport's size.
    await app.eval(`const m = document.querySelector('#view-mode'); m.value = 'fill'; m.dispatchEvent(new Event('change')); return true`);
    const asked = await waitFor(() => server.of('setDesktopSize').at(-1), 5000, 'SetDesktopSize');
    const vp = await app.eval(`const v = document.querySelector('#viewport'); return { w: v.clientWidth, h: v.clientHeight }`);
    assert.ok(Math.abs(asked.width - vp.w) <= 2 && Math.abs(asked.height - vp.h) <= 2,
      `asked for ${asked.width}x${asked.height} for a ${vp.w}x${vp.h} viewport`);
    await app.waitFor(`return document.querySelector('#screen').width === ${asked.width}`, 5000, 'canvas follows the new remote size');

    // Ctrl+Alt+Enter toggles full screen and is never typed on the remote computer.
    const before = server.of('key').length;
    const key = (type, o) => app.cdp.send('Input.dispatchKeyEvent', { type, ...o });
    await app.eval(`document.querySelector('.keysink').focus(); return true`);
    await key('keyDown', { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
    await key('keyDown', { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 3 });
    await key('keyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 3 });
    await key('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 3 });
    await key('keyUp', { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 2 });
    await key('keyUp', { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
    await waitFor(() => server.of('key').length >= before + 4, 3000, 'modifier events');
    assert.ok(!server.of('key').slice(before).some(k => k.keysym === 0xff0d), 'Enter reached the remote computer');

    await click(app, '#btn-disconnect');
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Disconnected')`, 5000, 'disconnected');
  } finally {
    await app.close();
  }

  // The chosen mode is remembered for this computer.
  app = await launchApp({ env: ENV, dataDir });
  try {
    const c = (await app.eval(`return await window.hopdesk.list()`)).find(x => x.id === id);
    assert.equal(c.options.scaling, 'fill');
    assert.equal(c.options.zoom, 110);
  } finally {
    await app.close();
  }
  } finally {
    await server.close();
  }
});

test('failures read as sentences with details kept aside, and history belongs to its computer', { skip, timeout: 90_000 }, async () => {
  const server = await startFakeRfbServer({ onRequest: req => req.incremental ? null : update(rawRect(0, 0, 4, 4, () => [1, 1, 1])) });
  const app = await launchApp({ env: ENV });
  try {
    const good = await addViaUi(app, { protocol: 'vnc', name: 'Reachable', host: '127.0.0.1', port: server.port });
    const bad = await addViaUi(app, { protocol: 'vnc', name: 'Nothing listening', host: '127.0.0.1', port: 9 });
    // No retries for this one, so the failure shows at once.
    await app.eval(`await window.hopdesk.update(${JSON.stringify(bad)}, { options: { autoReconnect: false } }); return true`);

    await clickConnect(app, good);
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Connected')`, 10_000, 'connected');
    await click(app, '#btn-disconnect');
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Disconnected')`, 5000, 'disconnected');

    await app.eval(`await window.hopdesk.list(); return true`);
    await clickConnect(app, bad);
    await app.waitFor(`return /Failed/.test(document.querySelector('#status')?.textContent ?? '')`, 10_000, 'failed');
    assert.match(await text(app, '#status'), /Failed — Connection refused/);
    const card = await app.eval(`
      const a = document.querySelector('.alert.error');
      return { title: a.querySelector('.t').textContent, visible: a.innerText, details: a.querySelector('details pre').textContent,
               open: a.querySelector('details').open }`);
    assert.equal(card.title, 'Connection refused');
    assert.doesNotMatch(card.visible, /ECONNREFUSED/, 'a socket error code is shown to the user');
    assert.match(card.details, /ECONNREFUSED/, 'the technical detail is not kept for diagnostics');
    assert.equal(card.open, false);
    assert.equal(await app.eval(`return !!document.querySelector('#btn-retry')`), true);

    // Each computer lists only its own sessions.
    await app.waitFor(`return document.querySelectorAll('#history .history-row').length === 1`, 5000, 'history of the failed computer');
    assert.match(await text(app, '#history'), /Failed · Connection refused/);
    await app.eval(`document.querySelector('.item[data-id="${good}"]').click(); return true`);
    await app.waitFor(`return document.querySelectorAll('#history .history-row').length === 1`, 5000, 'history of the good computer');
    assert.match(await text(app, '#history'), /Connected · \d+ s/);
  } finally {
    await app.close();
    await server.close();
  }
});

test('defaults for new computers persist across restarts', { skip, timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hopdesk-ui-settings-'));
  let app = await launchApp({ env: ENV, dataDir });
  try {
    await click(app, '#btn-settings');
    await app.waitFor(`return document.querySelector('#dlg-settings').open`, 8000, 'settings');
    await app.eval(`document.querySelector('.switch[data-key="viewOnly"]').click(); return true`);
    await app.eval(`const s = document.querySelector('#s-scaling'); s.value = 'none'; s.dispatchEvent(new Event('change')); return true`);
    await app.waitFor(`return (await window.hopdesk.getSettings()).defaults.scaling === 'none'`, 8000, 'saved');
  } finally {
    await app.close();
  }
  app = await launchApp({ env: ENV, dataDir });
  try {
    const d = (await app.eval(`return await window.hopdesk.getSettings()`)).defaults;
    assert.equal(d.viewOnly, true);
    assert.equal(d.scaling, 'none');
    await click(app, '#btn-new');
    assert.equal(await app.eval(`return document.querySelector('#f-viewonly').checked`), true, 'the editor ignored the saved defaults');
    assert.equal(await app.eval(`return document.querySelector('#f-scaling').value`), 'none');
    const settingsFile = readFileSync(path.join(dataDir, 'hopdesk', 'settings.json'), 'utf8');
    assert.match(settingsFile, /"viewOnly": true/);
  } finally {
    await app.close();
  }
});

test('quitting during a VNC session closes it and records how it ended', { skip, timeout: 60_000 }, async () => {
  const server = await startFakeRfbServer({ onRequest: req => req.incremental ? null : update(rawRect(0, 0, 4, 4, () => [1, 1, 1])) });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hopdesk-ui-quit-'));
  const app = await launchApp({ env: ENV, dataDir });
  try {
    const id = await addViaUi(app, { protocol: 'vnc', name: 'Quit test', host: '127.0.0.1', port: server.port });
    await clickConnect(app, id);
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Connected')`, 10_000, 'connected');
    const socket = server.lastSocket;
    const closed = new Promise(r => socket.once('close', r));
    const exited = new Promise(r => app.child.once('exit', (code, signal) => r({ code, signal })));
    // One termination request, as a logout or `kill` sends. (A second one
    // forces an immediate exit, by design.)
    app.child.kill('SIGTERM');
    const timeout = what => new Promise((_, rej) => setTimeout(() => rej(new Error(what)), 5000));
    await Promise.race([closed, timeout('the VNC connection outlived the app')]);
    const how = await Promise.race([exited, timeout('the app did not exit after SIGTERM')]);
    assert.deepEqual(how, { code: 0, signal: null }, 'the app was killed instead of shutting down');
  } finally {
    await app.close();
    await server.close();
  }
  await new Promise(r => setTimeout(r, 300));
  const store = JSON.parse(readFileSync(path.join(dataDir, 'hopdesk', 'connections.json'), 'utf8'));
  const entry = store.history[0];
  assert.equal(entry.outcome, 'connected');
  assert.ok(entry.connectedAt && entry.endedAt, `session end not recorded: ${JSON.stringify(entry)}`);
  assert.equal(entry.endReason, 'user');
});

test('the window cannot be navigated away or open new windows', { skip, timeout: 60_000 }, async () => {
  const app = await launchApp({ env: ENV });
  try {
    const url = await app.eval(`return location.href`);
    assert.equal(await app.eval(`return window.open('https://example.com/') === null`), true, 'a new window was opened');
    await app.eval(`location.href = 'https://example.com/'; return true`).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    assert.equal(await app.eval(`return location.href`), url, 'the UI navigated away');
    assert.equal(await app.eval(`return typeof window.hopdesk.connect`), 'function');
    // The renderer has no Node.
    assert.equal(await app.eval(`return typeof require === 'undefined' && typeof process === 'undefined'`), true);
    // The Content-Security-Policy forbids injected script.
    const csp = await app.eval(`return document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
  } finally {
    await app.close();
  }
});

/**
 * Which screen is shared, on a computer with more than one.
 *
 * Written on a laptop with an external monitor, where sharing showed the
 * laptop screen and every window on the other monitor was simply missing. A
 * machine with one screen - a CI runner, usually - has nothing to choose, and
 * the check for that is half the point: the choice must not appear there.
 */
test('the screen being shared is listed, chosen and remembered', { skip, timeout: 90_000 }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hopdesk-screens-'));
  let app = await launchApp({ env: ENV, dataDir });
  try {
    const status = await app.eval(`return await window.hopdesk.hostStatus()`);
    assert.ok(status.screens.length >= 1, 'a computer always has at least one screen');
    assert.ok(status.screens.some(s => s.id === status.sharedScreen), 'shares a screen that exists');
    assert.ok(status.screens.some(s => s.primary), 'one of them is the main screen');
    assert.match(status.screens[0].label, /^Screen 1 — \d+ × \d+/);

    const hidden = await app.eval(`return document.querySelector('#mine-screen-field').hidden`);
    assert.equal(hidden, status.screens.length < 2,
      'the choice appears only where there is something to choose between');

    const other = status.screens.find(s => s.id !== status.sharedScreen);
    if (!other) return;                       // one screen: nothing more to prove here

    await app.eval(`return await window.hopdesk.setRemoteAccess({ screen: ${other.id} })`);
    assert.equal((await app.eval(`return await window.hopdesk.hostStatus()`)).sharedScreen, other.id);

    // The choice outlives the app, or every restart goes back to the wrong monitor.
    await app.close();
    app = await launchApp({ env: ENV, dataDir });
    assert.equal((await app.eval(`return await window.hopdesk.hostStatus()`)).sharedScreen, other.id);
    assert.equal(await app.eval(`return document.querySelector('#mine-screen').value`), String(other.id));
  } finally {
    await app.close();
  }
});

/**
 * The computers list, in the real app: one row per machine, what it offers,
 * and the choice being remembered.
 *
 * The merging rules are tested on their own (test/computers.test.mjs); this is
 * about the row a person actually sees and presses.
 */
test('one list of computers, with the ways in and the choice remembered', { skip, timeout: 90_000 }, async () => {
  const { generateIdentity, deviceIdFromPublicKey, toBase64 } =
    await import('../../../packages/crypto/dist/index.js');
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hopdesk-list-'));
  mkdirSync(path.join(dataDir, 'hopdesk'), { recursive: true });
  const device = (name, paired, ago) => {
    const identity = generateIdentity();
    return {
      deviceId: deviceIdFromPublicKey(identity.publicKey),
      key: toBase64(identity.publicKey),
      name, lastConnected: Date.now() - ago, lastAddress: '192.168.1.42', lastPort: 47631,
      ...(paired ? { paired: true } : {}),
    };
  };
  const trusted = device('Studio Mac', true, 60_000);
  const asksForCode = device('Office Linux', false, 5_000);
  writeFileSync(path.join(dataDir, 'hopdesk', 'devices.json'),
    JSON.stringify({ devices: [trusted, asksForCode] }));

  let app = await launchApp({ env: ENV, dataDir });
  try {
    await app.waitFor(`return document.querySelectorAll('.computer-row').length === 2`, 10_000, 'both computers');
    const rows = await app.eval(`return [...document.querySelectorAll('.computer-row')].map(r => ({
      name: r.querySelector('b').textContent,
      button: r.querySelector('.connect-go').textContent,
      options: [...r.querySelectorAll('.connect-option')].map(o => o.dataset.method),
      hasMore: !r.querySelector('.connect-more').hidden,
    }))`);

    // A trusted computer offers to connect outright; the other can only ask for a code.
    const mac = rows.find(r => r.name === 'Studio Mac');
    const linux = rows.find(r => r.name === 'Office Linux');
    assert.equal(mac.button, 'Connect');
    assert.deepEqual(mac.options, ['trusted', 'code']);
    assert.equal(mac.hasMore, true);
    assert.equal(linux.button, 'Use access code');
    assert.deepEqual(linux.options, ['code'], 'offered a way in that would be refused');
    assert.equal(linux.hasMore, false, 'a single way in needs no menu');

    /* Choosing the code for the trusted computer, then pressing it: the form is
       filled in and the cursor is in the code box. */
    await click(app, `.computer-row[data-device-id="${trusted.deviceId}"] .connect-more`);
    await click(app, `.computer-row[data-device-id="${trusted.deviceId}"] .connect-option[data-method="code"]`);
    await click(app, `.computer-row[data-device-id="${trusted.deviceId}"] .connect-go`);
    assert.equal(await app.eval(`return document.querySelector('#cd-id').value`), trusted.deviceId);
    assert.equal(await app.eval(`return document.activeElement.id`), 'cd-code');

    // And that choice is still the one offered after a restart.
    await app.close();
    app = await launchApp({ env: ENV, dataDir });
    await app.waitFor(`return document.querySelectorAll('.computer-row').length === 2`, 10_000, 'the list again');
    assert.equal(
      await app.eval(`return document.querySelector('.computer-row[data-device-id="${trusted.deviceId}"] .connect-go').textContent`),
      'Use access code', 'the remembered choice was forgotten');
  } finally {
    await app.close();
  }
});
