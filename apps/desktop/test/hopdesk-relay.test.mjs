import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { launchApp, electronUnavailableReason, waitFor } from './helpers/electron.mjs';
import { X11Input, X11Unavailable } from '@hopdesk/platform';
import { startServer, loadConfig } from '../../../server/dist/exports.js';

/**
 * A session carried by a real TURN relay.
 *
 * Both computers are on this machine, so they could always reach each other
 * directly; the point of this test is the relay path itself, which is what a
 * session across the internet falls back to when neither side can be reached.
 * HopDesk's "always use the relay" setting forces it, and the ICE statistics
 * afterwards confirm the media really went through coturn rather than straight
 * across.
 *
 * coturn runs in Docker, the same image the bundled Compose file uses.
 */

const hostDisplay = process.env.HOPDESK_HOST_DISPLAY ?? ':31';
const viewerDisplay = process.env.HOPDESK_VIEWER_DISPLAY ?? ':32';
const COTURN_IMAGE = 'coturn/coturn:4.6-alpine';
const CONTAINER = 'hopdesk-test-coturn';

function displayUsable(display) {
  try { new X11Input({ display }).close(); return true; }
  catch (err) { if (err instanceof X11Unavailable) return false; throw err; }
}

function dockerUsable() {
  const probe = spawnSync('docker', ['image', 'inspect', COTURN_IMAGE], { stdio: 'ignore' });
  if (probe.status === 0) return true;
  // Only pull when a network is available; otherwise the test skips honestly.
  return spawnSync('docker', ['pull', COTURN_IMAGE], { stdio: 'ignore' }).status === 0;
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
  ?? (dockerUsable() ? null : `${COTURN_IMAGE} is not available to Docker`)
  ?? false);

const ENV = { HOPDESK_CREDENTIAL_BACKEND: 'file' };
const EMAIL = 'relay@example.com';
const PASSWORD = 'a-long-enough-password';

function startCoturn(secret) {
  execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '-d', '--name', CONTAINER, '--network', 'host', COTURN_IMAGE,
    // -v so allocations appear in the log, which the test reads as evidence.
    '-n', '-v', '--no-cli', '--use-auth-secret', `--static-auth-secret=${secret}`,
    '--realm=hopdesk.test', '--listening-port=3478', '--listening-ip=127.0.0.1',
    '--min-port=49200', '--max-port=49260', '--external-ip=127.0.0.1',
    // The relay and its clients are all on this machine in this test.
    '--allow-loopback-peers',
  ], { stdio: 'ignore' });
  return () => { try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }); } catch { /* already gone */ } };
}

async function relayServer(secret) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hopdesk-relay-server-'));
  const config = loadConfig({
    HOPDESK_TOKEN_SECRET: 'a-relay-test-secret-of-sufficient-length-here',
    HOPDESK_PORT: '0',
    HOPDESK_HOST: '127.0.0.1',
    HOPDESK_DATA_DIR: dataDir,
    HOPDESK_REGISTRATION_OPEN: 'true',
    HOPDESK_TURN_SECRET: secret,
    HOPDESK_TURN_URLS: 'turn:127.0.0.1:3478',
    // No public STUN: this test must not depend on the internet.
    HOPDESK_STUN_URLS: 'stun:127.0.0.1:3478',
  });
  const logs = [];
  const server = await startServer({ config, databaseFile: ':memory:', log: m => logs.push(m) });
  return { ...server, logs, url: `http://127.0.0.1:${server.port}` };
}

const signIn = (app, url, create) => app.eval(`
  return await window.hopdesk.accountSignIn({
    serverUrl: ${JSON.stringify(url)}, email: ${JSON.stringify(EMAIL)},
    password: ${JSON.stringify(PASSWORD)}, create: ${create} })`);

test('a session forced through the relay connects, and the media really goes through coturn',
  { skip, timeout: 300_000 }, async () => {
  const secret = randomBytes(24).toString('base64url');
  const stopCoturn = startCoturn(secret);
  const server = await relayServer(secret);
  const host = await launchApp({ env: { ...ENV, DISPLAY: hostDisplay } });
  const viewer = await launchApp({ env: { ...ENV, DISPLAY: viewerDisplay } });
  try {
    /* Both computers are told to use the relay only, which is what a session
       between two computers that cannot reach each other has to do. */
    for (const app of [host, viewer]) {
      await app.eval(`await window.hopdesk.updateSettings({ account: { forceRelay: true } }); return true`);
    }

    await host.eval(`document.querySelector('#mine-toggle').click(); return true`);
    await host.waitFor(`return document.querySelector('#mine-state')?.textContent === 'Online'`, 20_000, 'the host online');
    await signIn(host, server.url, true);
    await signIn(viewer, server.url, false);

    /* The viewer is the account's second computer, so it waits until the
       first one vouches for it - approved here through the interface, the way
       a person does it, because until then the relay will not have it. */
    await host.waitFor(`
      document.querySelector('#mc-refresh').click();
      return [...document.querySelectorAll('.computer-row')]
        .some(r => r.querySelector('.sub').textContent.includes('Waiting to be approved'))`,
      30_000, 'the viewer to appear as waiting');
    await host.eval(`
      [...document.querySelectorAll('.computer-row')]
        .find(r => r.querySelector('.sub').textContent.includes('Waiting to be approved'))
        .querySelector('.connect-go').click();
      return true`);
    await host.waitFor(`return document.querySelector('#dlg-confirm')?.open === true`, 15_000, 'the approve dialog');
    await host.eval(`document.querySelector('#confirm-ok').click(); return true`);

    for (const app of [host, viewer]) {
      await app.waitFor(`return (await window.hopdesk.accountState()).relay === 'online'`, 45_000, 'the server connection');
    }

    /* The relay credentials the app is handed come from the server and are
       accepted by coturn — otherwise no relay candidate can be gathered. */
    const ice = await viewer.eval(`return await window.hopdesk.accountState()`);
    assert.equal(ice.signedIn, true);

    const target = (await viewer.eval(`return (await window.hopdesk.accountRefresh()).computers`)).find(c => !c.self);
    assert.ok(target, 'the host was not listed');

    const connecting = viewer.eval(`
      try { return { ok: true, value: await window.hopdesk.connectComputer(${JSON.stringify(target.deviceId)}) }; }
      catch (e) { return { ok: false, error: e.message }; }`);
    await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 40_000, 'the Allow prompt');
    await host.eval(`document.querySelector('#consent-allow').click(); return true`);

    const result = await connecting;
    assert.equal(result.ok, true, `connect failed: ${result.error}`);
    assert.equal(result.value.state, 'connected');
    // The session reports how it is carried, and here it must be the relay.
    assert.equal(result.value.connection, 'relay', `connection was "${result.value.connection}"`);

    await viewer.waitFor(`return document.querySelector('#hd-how')?.textContent === 'Through the relay'`, 15_000, 'the relay badge');

    /* Video really arrives over the relayed connection. */
    const video = await waitFor(async () => {
      const v = await viewer.eval(`
        const v = document.querySelector('#hd-video');
        return { width: v.videoWidth, state: v.readyState }`);
      return v.width > 0 && v.state >= 2 ? v : null;
    }, 60_000, 'video through the relay');
    assert.ok(video.width >= 320);

    /* coturn's own log is the second witness: it allocated a relay address for
       a client that authenticated with the credentials this server issued. */
    const allocated = await waitFor(() => {
      const log = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
      return /realm=<hopdesk.test>/i.test(log) && /(allocate|new, realm)/i.test(log) ? log : null;
    }, 20_000, 'coturn to log an authenticated allocation');
    // The shared secret itself never travels to a client, so it cannot be in there.
    assert.ok(!allocated.includes(secret), 'the TURN secret appeared in coturn\'s log');

    await viewer.eval(`document.querySelector('#hd-disconnect').click(); return true`);
    /* After the session, coturn reports how much it carried: proof that the
       media went through the relay rather than straight between the two. */
    const usage = await waitFor(() => {
      const log = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
      const match = /usage: realm=<hopdesk.test>.*?rb=(\d+).*?sb=(\d+)/s.exec(log);
      return match && (Number(match[1]) > 10_000 || Number(match[2]) > 10_000) ? match[0] : null;
    }, 30_000, 'coturn to report the traffic it relayed');
    assert.match(usage, /rb=\d+/);
  } finally {
    await viewer.close();
    await host.close();
    await server.close();
    stopCoturn();
  }
});
