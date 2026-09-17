import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, electronUnavailableReason, waitFor } from './helpers/electron.mjs';
import { clickConnect, addViaUi, pixel, canvasPoint } from './helpers/ui.mjs';
import {
  startFakeRfbServer, update, rawRect, copyRect,
} from '../../../packages/core/test/helpers/fake-rfb-server.mjs';

/**
 * The whole path, in the real Electron app: UI → preload bridge → IPC → main
 * process → Session/ExternalEngine → a server, and back to pixels on the
 * canvas. Needs a display (X11 or Wayland). Uses the encrypted-vault backend
 * so the user's keyring is never touched.
 */

const skipReason = electronUnavailableReason();
const ENV = { HOPDESK_CREDENTIAL_BACKEND: 'file' };

const W = 320, H = 200;
const RED = [220, 30, 40], BLUE = [20, 60, 230];

test('Electron: preload bridge, VNC framebuffer, input, disconnect and reconnect', { skip: skipReason ?? false, timeout: 120_000 }, async () => {
  let tick = 0;
  const server = await startFakeRfbServer({
    width: W, height: H, name: 'e2e-desktop',
    onRequest: (req, { socket }) => {
      if (!req.incremental && req.width === W) {
        // Full frame: left half red, right half blue, then a CopyRect moving
        // the top-left 40×40 of red to (200, 120) inside the blue half.
        return update(
          rawRect(0, 0, W / 2, H, () => RED),
          rawRect(W / 2, 0, W / 2, H, () => BLUE),
          copyRect(200, 120, 40, 40, 0, 0),
        );
      }
      // Incremental: a small changing square, so continuous updates are visible.
      setTimeout(() => {
        if (socket.destroyed) return;
        tick = (tick + 1) % 250;
        socket.write(update(rawRect(4, 4, 8, 8, () => [tick, 255 - tick, 7])));
      }, 40);
      return null;
    },
  });

  const app = await launchApp({ env: ENV });
  try {
    /* The renderer is using the real bridge, not the browser mock. */
    const bridge = await app.eval(`
      const s = await window.hopdesk.getSettings();
      return { isElectron: window.hopdesk.isElectron === true, banner: document.querySelector('#banner').hidden,
               logPath: s.logPath, backend: s.credentialBackend }`);
    assert.equal(bridge.isElectron, true, 'window.hopdesk is not the preload bridge');
    assert.equal(bridge.banner, true, 'a preview or broken-bridge banner is showing');
    assert.equal(bridge.backend, 'file');
    assert.ok(bridge.logPath.startsWith(app.dataDir), 'main process did not use the test data directory');

    const id = await addViaUi(app, { protocol: 'vnc', name: 'Fake VNC', host: '127.0.0.1', port: server.port });
    await clickConnect(app, id);

    /* Connected and painting through the real canvas. */
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Connected')`, 10_000, 'Connected status');
    await app.waitFor(`const c = document.querySelector('#screen'); return c && c.width === ${W} && c.height === ${H}`, 5000, 'canvas sized to the remote screen');
    await waitFor(async () => (await pixel(app, 300, 10))[2] === BLUE[2], 5000, 'first frame painted');
    assert.deepEqual(await pixel(app, 10, 100), [...RED, 255], 'raw rectangle not painted');
    assert.deepEqual(await pixel(app, 300, 100), [...BLUE, 255], 'second raw rectangle not painted');
    assert.deepEqual(await pixel(app, 210, 130), [...RED, 255], 'CopyRect did not copy the source pixels');
    assert.deepEqual(await pixel(app, 250, 130), [...BLUE, 255], 'CopyRect wrote outside its rectangle');

    /* Continuous updates: the square keeps changing without any user action. */
    const first = (await pixel(app, 6, 6))[0];
    await waitFor(async () => (await pixel(app, 6, 6))[0] !== first, 3000, 'the screen to keep updating');
    const requests = server.of('request').length;
    await new Promise(r => setTimeout(r, 600));
    assert.ok(server.of('request').length > requests + 3, 'update requests stopped after the first frames');

    /* The canvas element survives re-renders instead of being recreated. */
    await app.eval(`window.__canvasProbe = document.querySelector('#screen'); document.querySelector('#search').dispatchEvent(new Event('input')); return true`);
    await app.eval(`document.querySelector('#btn-fav').click(); return true`);
    await app.waitFor(`return document.querySelector('#btn-fav')?.textContent.includes('★ Favourite')`, 5000, 'favourite toggled');
    assert.equal(await app.eval(`return document.querySelector('#screen') === window.__canvasProbe`), true,
      'the canvas was recreated on re-render');
    assert.deepEqual(await pixel(app, 300, 100), [...BLUE, 255], 'the framebuffer was lost on re-render');

    /* Mouse: press, move, release and wheel arrive with the right coordinates and mask. */
    const p = await canvasPoint(app, 100, 50);
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: 120 });
    await waitFor(() => server.of('pointer').some(e => e.mask === 16), 3000, 'wheel event');
    const pointers = server.of('pointer').filter(e => e.x === 100 && e.y === 50);
    assert.ok(pointers.some(e => e.mask === 1), `no left-button press at 100,50: ${JSON.stringify(server.of('pointer'))}`);
    const pressAt = pointers.findIndex(e => e.mask === 1);
    assert.ok(pointers.slice(pressAt).some(e => e.mask === 0), 'no button release');
    const wheelAt = pointers.findIndex(e => e.mask === 16);
    assert.equal(pointers[wheelAt + 1]?.mask, 0, 'wheel press was not followed by a release');

    /* Keyboard: plain, modifier, Arabic layout, and IME-committed CJK text. */
    assert.equal(await app.eval(`return document.activeElement?.className`), 'keysink', 'clicking the screen did not focus keyboard input');
    const key = async (type, o) => app.cdp.send('Input.dispatchKeyEvent', { type, ...o });
    await key('keyDown', { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
    await key('keyDown', { key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, modifiers: 2 });
    await key('keyUp', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await key('keyUp', { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
    await key('keyDown', { key: 'ش', code: 'KeyA', text: 'ش', windowsVirtualKeyCode: 65 });
    await key('keyUp', { key: 'ش', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await app.cdp.send('Input.insertText', { text: '你好' });
    await waitFor(() => server.of('key').length >= 10, 3000, 'key events');
    assert.deepEqual(server.of('key').slice(0, 10).map(k => [k.keysym, k.down]), [
      [0xffe3, true], [0x61, true], [0x61, false], [0xffe3, false],
      [0x01000634, true], [0x01000634, false],
      [0x01004f60, true], [0x01004f60, false], [0x0100597d, true], [0x0100597d, false],
    ]);

    /* A held key is released when focus leaves the screen. */
    await key('keyDown', { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await app.eval(`document.querySelector('#search').focus(); return true`);
    await waitFor(() => server.of('key').some(k => k.keysym === 0xffe1 && !k.down), 3000, 'Shift released on blur');

    /* Ctrl+Alt+Del from the toolbar. */
    const before = server.of('key').length;
    await app.eval(`document.querySelector('#btn-cad').click(); return true`);
    await waitFor(() => server.of('key').length >= before + 6, 3000, 'Ctrl+Alt+Del');
    assert.deepEqual(server.of('key').slice(before, before + 6).map(k => [k.keysym, k.down]),
      [[0xffe3, true], [0xffe9, true], [0xffff, true], [0xffff, false], [0xffe9, false], [0xffe3, false]]);

    /* Reconnect after a network drop, without user action. */
    const connectionsBefore = server.connections;
    server.dropAll();
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Reconnecting')`, 5000, 'Reconnecting status');
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Connected')`, 10_000, 'reconnected');
    assert.equal(server.connections, connectionsBefore + 1);

    /* Deliberate disconnect: socket closed, no reconnect. */
    await app.eval(`document.querySelector('#btn-disconnect').click(); return true`);
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Disconnected')`, 5000, 'Disconnected status');
    const afterDisconnect = server.connections;
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(server.connections, afterDisconnect, 'reconnected after the user disconnected');
    assert.equal(await app.eval(`return !!document.querySelector('#btn-connect')`), true);

    /* History is recorded per connection. */
    const history = await app.eval(`return window.hopdesk.history(${JSON.stringify(id)})`);
    assert.ok(history.length >= 1 && history.every(h => h.connectionId === id));
  } finally {
    await app.close();
    await server.close();
  }
});

test('Electron: a VNC password is requested, saved to a newly created vault, and never stored or logged in plaintext', { skip: skipReason ?? false, timeout: 90_000 }, async () => {
  const PASSWORD = 'vnc-e2e-pass';
  const PASSPHRASE = 'e2e-master-passphrase';
  const server = await startFakeRfbServer({
    width: 64, height: 48, securityTypes: [2], password: PASSWORD,
    onRequest: req => req.incremental ? null : update(rawRect(0, 0, 64, 48, () => [1, 2, 3])),
  });
  const app = await launchApp({ env: ENV });
  try {
    const id = await addViaUi(app, { protocol: 'vnc', name: 'Locked VNC', host: '127.0.0.1', port: server.port });
    await clickConnect(app, id);

    // The server demands a password: the UI asks for it.
    await app.waitFor(`return document.querySelector('#dlg-cred').open`, 10_000, 'password dialog');
    assert.match(await app.eval(`return document.querySelector('#cred-intro').textContent`), /needs a password/i);
    await app.eval(`
      document.querySelector('#cred-pass').value = ${JSON.stringify(PASSWORD)};
      document.querySelector('#cred-save').checked = true;
      document.querySelector('#cred-ok').click();
      return true`);

    // Saving needs the vault, which does not exist yet: create it.
    await app.waitFor(`return document.querySelector('#dlg-unlock').open`, 10_000, 'vault passphrase dialog');
    assert.equal(await app.eval(`return document.querySelector('#unlock-ok').textContent`), 'Create');
    await app.eval(`
      document.querySelector('#unlock-pass').value = 'short';
      document.querySelector('#unlock-confirm').value = 'short';
      document.querySelector('#unlock-ok').click(); return true`);
    await app.waitFor(`return !document.querySelector('#unlock-error').hidden && document.querySelector('#dlg-unlock').open`, 5000, 'short passphrase rejected');
    assert.match(await app.eval(`return document.querySelector('#unlock-error').textContent`), /at least 8/);
    await app.eval(`
      document.querySelector('#unlock-pass').value = ${JSON.stringify(PASSPHRASE)};
      document.querySelector('#unlock-confirm').value = ${JSON.stringify(PASSPHRASE)};
      document.querySelector('#unlock-ok').click(); return true`);

    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Connected')`, 15_000, 'connected with the password');

    // Next time the saved password is used without asking.
    await app.eval(`document.querySelector('#btn-disconnect').click(); return true`);
    await app.waitFor(`return !!document.querySelector('#btn-connect')`, 5000, 'Connect button again');
    await app.eval(`document.querySelector('#btn-connect').click(); return true`);
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Connected')`, 10_000, 'connected with the saved password');
    assert.equal(await app.eval(`return document.querySelector('#dlg-cred').open`), false, 'asked again for a saved password');
    await app.eval(`document.querySelector('#btn-disconnect').click(); return true`);
    await new Promise(r => setTimeout(r, 500));
  } finally {
    await app.close();
    await server.close();
  }

  // Nothing on disk or in the log contains the password or the passphrase.
  const dir = path.join(app.dataDir, 'hopdesk');
  const files = await readdir(dir);
  assert.ok(files.includes('credentials.vault') && files.includes('connections.json') && files.includes('hopdesk.log'), files.join());
  for (const f of files) {
    const raw = await readFile(path.join(dir, f), 'utf8');
    assert.ok(!raw.includes(PASSWORD), `password in plaintext in ${f}`);
    assert.ok(!raw.includes(PASSPHRASE), `passphrase in plaintext in ${f}`);
  }
});

test('Electron: an untrusted RDP certificate is shown for an explicit decision, and remembered only when asked', { skip: skipReason ?? false, timeout: 90_000 }, async t => {
  let pair;
  try {
    const d = mkdtempSync(path.join(tmpdir(), 'hopdesk-e2e-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=e2e-rdp',
      '-keyout', path.join(d, 'k.pem'), '-out', path.join(d, 'c.pem')], { stdio: 'ignore' });
    pair = { key: readFileSync(path.join(d, 'k.pem')), cert: readFileSync(path.join(d, 'c.pem')) };
  } catch {
    t.skip('openssl is needed to create a test certificate');
    return;
  }
  // Negotiates like an RDP server, then presents the self-signed certificate.
  const rdp = createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write(Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, 2, 0, 8, 0, 1, 0, 0, 0]));
      new TLSSocket(socket, { isServer: true, ...pair }).on('error', () => {});
    });
  });
  await new Promise(r => rdp.listen(0, '127.0.0.1', r));
  const port = rdp.address().port;

  const app = await launchApp({ env: ENV });
  try {
    await app.eval(`await window.hopdesk.unlockVault('e2e-master-passphrase'); return true`);
    const id = await addViaUi(app, { protocol: 'rdp', name: 'Fake Windows', host: '127.0.0.1', port, username: 'alice', password: 'rdp-e2e-pass' });
    await clickConnect(app, id);

    await app.waitFor(`return document.querySelector('#dlg-cert').open`, 15_000, 'certificate dialog')
      .catch(async err => {
        const pane = await app.eval(`return document.querySelector('#pane').innerText`);
        throw new Error(`${err.message}\nUI showed:\n${pane}`);
      });
    const shown = await app.eval(`return document.querySelector('#cert-details').textContent`);
    assert.match(shown, /CN = e2e-rdp/);
    const { X509Certificate } = await import('node:crypto');
    const fp = new X509Certificate(pair.cert).fingerprint256.toLowerCase();
    assert.ok(shown.includes(fp), 'the dialog did not show the SHA-256 fingerprint');

    // Cancel: nothing is trusted and nothing is launched.
    await app.eval(`document.querySelector('#dlg-cert [data-close="cancel"]').click(); return true`);
    await new Promise(r => setTimeout(r, 500));
    let saved = JSON.parse(await readFile(path.join(app.dataDir, 'hopdesk', 'connections.json'), 'utf8'));
    assert.equal(saved.connections[0].options.trustedCertificate, undefined, 'trust was stored after Cancel');

    // Always trust: stored, and FreeRDP is launched pinned to it.
    await app.eval(`document.querySelector('#btn-connect').click(); return true`);
    await app.waitFor(`return document.querySelector('#dlg-cert').open`, 15_000, 'certificate dialog again');
    await app.eval(`document.querySelector('#cert-always').click(); return true`);
    await waitFor(async () => {
      saved = JSON.parse(await readFile(path.join(app.dataDir, 'hopdesk', 'connections.json'), 'utf8'));
      return saved.connections[0].options.trustedCertificate === fp;
    }, 10_000, 'trusted fingerprint saved');

    // This fake server is not a real RDP server, so FreeRDP (if installed)
    // fails after TLS; the UI must show a sentence, not an exit code.
    await app.waitFor(`return /Failed|Connected/.test(document.querySelector('#status')?.textContent ?? '')`, 20_000, 'a result from FreeRDP');
    const text = await app.eval(`return document.querySelector('#pane').textContent`);
    assert.doesNotMatch(text, /exited with code \d+\.$/m);
  } finally {
    await app.close();
    rdp.close();
  }
  const raw = await readFile(path.join(app.dataDir, 'hopdesk', 'connections.json'), 'utf8');
  assert.ok(!raw.includes('rdp-e2e-pass'));
});

test('Electron: terminating the app ends a running RDP session instead of orphaning FreeRDP', { skip: skipReason ?? false, timeout: 60_000 }, async () => {
  const { mkdtempSync: mk, writeFileSync, chmodSync, existsSync } = await import('node:fs');
  // A stand-in xfreerdp: like the real one it answers /help, /version and the
  // monitor listing and exits; a session (/v:) stays alive and records its pid.
  const bin = mk(path.join(tmpdir(), 'hopdesk-e2e-bin-'));
  const pidFile = path.join(bin, 'pid');
  writeFileSync(path.join(bin, 'xfreerdp'),
    `#!/bin/sh\ncase "$1" in /v:*) echo $$ > "${pidFile}"; exec sleep 300;; *) exit 0;; esac\n`);
  chmodSync(path.join(bin, 'xfreerdp'), 0o755);

  const app = await launchApp({ env: { ...ENV, PATH: `${bin}:${process.env.PATH}` } });
  let pid = null;
  try {
    await app.eval(`await window.hopdesk.unlockVault('e2e-master-passphrase'); return true`);
    // Port 9 is closed, so the certificate probe finds nothing to ask about.
    const id = await addViaUi(app, { protocol: 'rdp', name: 'Orphan check', host: '127.0.0.1', port: 9, username: 'u', password: 'orphan-check-pw' });
    await clickConnect(app, id);
    await app.waitFor(`return document.querySelector('#status')?.textContent.includes('Connected')`, 15_000, 'fake FreeRDP running');
    await waitFor(() => existsSync(pidFile), 5000, 'pid file');
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(processAlive(pid));
    assert.ok(!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('orphan-check-pw'));

    app.child.kill('SIGTERM');
    await new Promise(r => app.child.once('exit', r));
    await waitFor(() => !processAlive(pid), 5000, 'FreeRDP to exit with the app');
  } finally {
    await app.close();
    if (pid && processAlive(pid)) process.kill(pid, 'SIGKILL');
  }
});

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
