import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, electronUnavailableReason, waitFor } from './helpers/electron.mjs';
import { X11Input, X11Unavailable } from '@hopdesk/platform';
import { startServer, loadConfig } from '../../../server/dist/exports.js';

/**
 * Two HopDesk applications and a real HopDesk server, all on this machine:
 * signing in, this computer appearing under "My computers", and a session
 * arranged by the server rather than by a Device ID typed in by hand.
 *
 * The server here is the same code the container runs. It carries the handshake
 * and the sealed frames and can read neither, which the server's own tests
 * prove; what these tests prove is that the application really uses it.
 */

const hostDisplay = process.env.HOPDESK_HOST_DISPLAY ?? ':31';
const viewerDisplay = process.env.HOPDESK_VIEWER_DISPLAY ?? ':32';

function displayUsable(display) {
  try { new X11Input({ display }).close(); return true; }
  catch (err) { if (err instanceof X11Unavailable) return false; throw err; }
}

/**
 * A suite that quietly skips proves nothing. HOPDESK_REQUIRE_DISPLAY=1 — which
 * the full-suite runs and CI set — turns "nothing to test on here" into a
 * failure instead of a silent pass.
 */
function refuseToSkip(reason) {
  if (reason && process.env.HOPDESK_REQUIRE_DISPLAY === '1') {
    throw new Error(`${reason} — and HOPDESK_REQUIRE_DISPLAY=1 says these tests must run`);
  }
  return reason;
}

const skip = refuseToSkip(electronUnavailableReason()
  ?? (displayUsable(hostDisplay) ? null : `no X display at ${hostDisplay}`)
  ?? (displayUsable(viewerDisplay) ? null : `no X display at ${viewerDisplay}`)
  ?? false);

const ENV = { HOPDESK_CREDENTIAL_BACKEND: 'file' };
const EMAIL = 'owner@example.com';
const PASSWORD = 'a-long-enough-password';

async function localServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hopdesk-account-server-'));
  const config = loadConfig({
    HOPDESK_TOKEN_SECRET: 'an-integration-test-secret-of-sufficient-length',
    HOPDESK_PORT: '0',
    HOPDESK_HOST: '127.0.0.1',
    HOPDESK_DATA_DIR: dataDir,
    HOPDESK_REGISTRATION_OPEN: 'true',
  });
  const logs = [];
  const server = await startServer({ config, databaseFile: ':memory:', log: m => logs.push(m) });
  return { ...server, logs, url: `http://127.0.0.1:${server.port}` };
}

/** Signs an app in through the dialog a person would use. */
async function signIn(app, url, { create = false } = {}) {
  await app.eval(`document.querySelector('#btn-signin').click(); return true`);
  await app.waitFor(`return document.querySelector('#dlg-signin')?.open === true`, 8000, 'the sign-in dialog');
  await app.eval(`
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input')); };
    set('#si-server', ${JSON.stringify(url)});
    set('#si-email', ${JSON.stringify(EMAIL)});
    set('#si-password', ${JSON.stringify(PASSWORD)});
    document.querySelector('#si-create').checked = ${create};
    document.querySelector('#si-submit').click();
    return true`);
  await app.waitFor(`
    const error = document.querySelector('#si-error');
    if (error && !error.hidden) throw new Error(error.textContent);
    return document.querySelector('#computers')?.hidden === false`, 30_000, 'to be signed in');
}

test('two computers sign in to a HopDesk server and connect through it, with no Device ID typed',
  { skip, timeout: 240_000 }, async () => {
  const server = await localServer();
  const host = await launchApp({ env: { ...ENV, DISPLAY: hostDisplay } });
  const viewer = await launchApp({ env: { ...ENV, DISPLAY: viewerDisplay } });
  try {
    /* The host: accepting connections, and signed in so it can be reached. */
    await host.eval(`document.querySelector('#mine-toggle').click(); return true`);
    await host.waitFor(`return document.querySelector('#mine-state')?.textContent === 'Online'`, 20_000, 'the host online');
    await signIn(host, server.url, { create: true });
    await host.waitFor(`return document.querySelector('#mc-relay')?.textContent === 'Connected'`, 20_000, 'the host connected to the server');
    const hostName = await host.eval(`return (await window.hopdesk.accountState()).deviceName`);

    /* The viewer: signed in to the same account - and then approved from the
       host, because signing in adds a computer to an account and does not make
       it one of yours. Until the host says yes, the viewer cannot reach the
       server's relay at all, which is the whole point of the arrangement. */
    await signIn(viewer, server.url);
    const viewerName = await viewer.eval(`return (await window.hopdesk.accountState()).deviceName`);
    await host.waitFor(`
      document.querySelector('#mc-refresh').click();
      return [...document.querySelectorAll('.computer-row')]
        .some(r => r.querySelector('.sub').textContent.includes('Waiting to be approved'))`,
      30_000, 'the new computer to appear as waiting on the host');

    /* Approved by pressing Approve and confirming, as a person would: the
       dialog shows the fingerprint of the computer being let in. */
    await host.eval(`
      const row = [...document.querySelectorAll('.computer-row')]
        .find(r => r.querySelector('.sub').textContent.includes('Waiting to be approved'));
      row.querySelector('.connect-go').click();
      return true`);
    await host.waitFor(`return document.querySelector('#dlg-confirm')?.open === true`, 15_000, 'the approve dialog');
    const question = await host.eval(`return document.querySelector('#confirm-text').textContent`);
    assert.match(question, /fingerprint is [0-9a-f]{4} /, question);
    await host.eval(`document.querySelector('#confirm-ok').click(); return true`);

    await viewer.waitFor(`return document.querySelector('#mc-relay')?.textContent === 'Connected'`, 40_000, 'the viewer connected to the server');
    void viewerName;

    /* The host appears in the computers list, online, with a way in. */
    await viewer.eval(`document.querySelector('#mc-refresh').click(); return true`);
    const listed = await waitFor(async () => {
      const rows = await viewer.eval(`
        return [...document.querySelectorAll('.computer-row')].map(r => ({
          id: r.dataset.deviceId,
          name: r.querySelector('b').textContent,
          online: r.dataset.status === 'online',
          canConnect: !r.querySelector('.connect-go').disabled,
        }))`);
      return rows.length && rows[0].online && rows[0].canConnect ? rows : null;
    }, 30_000, 'the host to be listed as online');
    assert.equal(listed.length, 1, JSON.stringify(listed));
    assert.equal(listed[0].name, hostName);
    assert.match(listed[0].id, /^HD-/);

    /* One click connects: the server introduces the two computers. */
    await viewer.eval(`document.querySelector('.computer-row .connect-go').click(); return true`);
    await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 30_000, 'the Allow prompt');
    const method = await host.eval(`return document.querySelector('#consent-method').textContent`);
    assert.match(method, /same HopDesk account/i, method);
    await host.eval(`document.querySelector('#consent-allow').click(); return true`);

    /* A real session, with the host's screen arriving over WebRTC. */
    await viewer.waitFor(`return document.querySelector('#hd-view')?.hidden === false`, 40_000, 'the session view');
    await viewer.waitFor(`return document.querySelector('#hd-status')?.textContent === 'Connected'`, 40_000, 'connected status');
    const video = await waitFor(async () => {
      const v = await viewer.eval(`
        const v = document.querySelector('#hd-video');
        return { width: v.videoWidth, height: v.videoHeight, state: v.readyState }`);
      return v.width > 0 && v.state >= 2 ? v : null;
    }, 60_000, 'video frames through the server-arranged session');
    assert.ok(video.width >= 320, `video was ${video.width}x${video.height}`);

    /* The session is a real remote-control session: the pointer moves. */
    const probe = new X11Input({ display: hostDisplay });
    try {
      probe.movePointer(2, 2);
      const box = await viewer.eval(`
        const r = document.querySelector('#hd-video').getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height }`);
      await viewer.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: box.left + box.width * 0.5, y: box.top + box.height * 0.5,
      });
      await waitFor(() => {
        const p = probe.pointerPosition();
        return p.x > probe.width * 0.3 && p.x < probe.width * 0.7 ? p : null;
      }, 20_000, 'the host pointer to follow the viewer');
    } finally {
      probe.close();
    }

    /* The host's own session list shows who is connected. */
    const sessions = await host.eval(`return document.querySelectorAll('#mine-sessions .session-row').length`);
    assert.equal(sessions, 1);

    await viewer.eval(`document.querySelector('#hd-disconnect').click(); return true`);
    await viewer.waitFor(`return document.querySelector('#hd-view')?.hidden === true`, 15_000, 'the session to end');
  } finally {
    await viewer.close();
    await host.close();
    await server.close();
  }
});

test('signing out removes that computer from the account and from the other computer\'s list',
  { skip, timeout: 180_000 }, async () => {
  const server = await localServer();
  const host = await launchApp({ env: { ...ENV, DISPLAY: hostDisplay } });
  const viewer = await launchApp({ env: { ...ENV, DISPLAY: viewerDisplay } });
  try {
    await signIn(host, server.url, { create: true });
    await signIn(viewer, server.url);
    await viewer.waitFor(`return document.querySelector('.computer-row') !== null`, 30_000, 'the host in the list');

    /* Signing out on the host removes it from the account, so the viewer can no
       longer reach it — the door closes rather than just being hidden. */
    const state = await host.eval(`return await window.hopdesk.accountSignOut()`);
    assert.equal(state.signedIn, false);
    assert.equal(state.computers.length, 0);

    await viewer.eval(`document.querySelector('#mc-refresh').click(); return true`);
    await viewer.waitFor(`return document.querySelectorAll('.computer-row').length === 0`, 20_000, 'the host to disappear');

    // And the host's own interface shows it is no longer signed in.
    assert.equal(await host.eval(`return document.querySelector('#computers')?.hidden`), true);
    assert.equal(await host.eval(`return document.querySelector('#btn-signin')?.hidden`), false);
  } finally {
    await viewer.close();
    await host.close();
    await server.close();
  }
});

test('a wrong password, and a server that is not there, are reported without signing in',
  { skip, timeout: 120_000 }, async () => {
  const server = await localServer();
  const app = await launchApp({ env: { ...ENV, DISPLAY: viewerDisplay } });
  try {
    // Create the account first, then try the wrong password.
    await signIn(app, server.url, { create: true });
    await app.eval(`return await window.hopdesk.accountSignOut()`);

    await app.eval(`document.querySelector('#btn-signin').click(); return true`);
    await app.waitFor(`return document.querySelector('#dlg-signin')?.open === true`, 8000, 'the dialog');
    await app.eval(`
      const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input')); };
      set('#si-server', ${JSON.stringify(server.url)});
      set('#si-email', ${JSON.stringify(EMAIL)});
      set('#si-password', 'not-the-password');
      document.querySelector('#si-create').checked = false;
      document.querySelector('#si-submit').click();
      return true`);
    await app.waitFor(`return document.querySelector('#si-error')?.hidden === false`, 20_000, 'an error message');
    const wrong = await app.eval(`return document.querySelector('#si-error').textContent`);
    assert.match(wrong, /do not match an account/i, wrong);
    assert.equal(await app.eval(`return document.querySelector('#computers')?.hidden`), true);

    /* A plain http address that is not loopback is refused before anything is
       sent, so a password cannot go out unencrypted. */
    await app.eval(`
      const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input')); };
      set('#si-server', 'http://hopdesk.example.com');
      set('#si-password', ${JSON.stringify(PASSWORD)});
      document.querySelector('#si-submit').click();
      return true`);
    await app.waitFor(`return /https/.test(document.querySelector('#si-error').textContent)`, 20_000, 'the https warning');

    // A server that is not listening says so rather than hanging.
    await app.eval(`
      const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input')); };
      set('#si-server', 'http://127.0.0.1:1');
      document.querySelector('#si-submit').click();
      return true`);
    await app.waitFor(`return /Could not reach/.test(document.querySelector('#si-error').textContent)`, 25_000, 'an unreachable-server message');
  } finally {
    await app.close();
    await server.close();
  }
});
