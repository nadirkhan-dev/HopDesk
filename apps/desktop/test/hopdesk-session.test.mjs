import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import koffi from 'koffi';
import path from 'node:path';
import { launchApp, electronUnavailableReason, waitFor } from './helpers/electron.mjs';
import { launchEnvironment, ozoneArgs } from '../scripts/launch-args.mjs';
import { X11Input, X11Unavailable } from '@hopdesk/platform';

/**
 * Two real HopDesk applications, one acting as Host and one as Viewer, on this
 * machine: the native handshake over a real socket, an Allow prompt answered by
 * a real click, a real WebRTC connection carrying the screen, and input that
 * arrives on the host's actual X display.
 *
 * Nothing is stubbed. The Host runs against a spare X display (HOPDESK_HOST_DISPLAY,
 * :31 by default) so its screen, pointer and clipboard are not the developer's
 * own, and the Viewer against another (:32) for the same reason.
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

/** Starts the app as the Host, turns remote access on, and reads its details. */
async function startHost(env = {}) {
  const app = await launchApp({ env: { ...ENV, DISPLAY: hostDisplay, ...env } });
  await app.eval(`document.querySelector('#mine-toggle').click(); return true`);
  try {
    await app.waitFor(`return document.querySelector('#mine-state')?.textContent === 'Online'`, 15_000, 'the host to come online');
  } catch (err) {
    /* The usual cause is another HopDesk still holding the port — often one
       left behind by an interrupted run. The app knows; say what it said. */
    const detail = await app.eval(`return document.querySelector('#mine-detail')?.textContent ?? ''`);
    throw new Error(`${err.message}${detail ? ` — the app says: ${detail}` : ''}`);
  }
  const details = await app.eval(`
    return {
      deviceId: document.querySelector('#mine-id').textContent,
      code: document.querySelector('#mine-code').textContent.replace(/\\s/g, ''),
      detail: document.querySelector('#mine-detail').textContent,
    }`);
  assert.match(details.deviceId, /^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, `Device ID was ${details.deviceId}`);
  assert.match(details.code, /^\d{6}$/, `access code was ${details.code}`);
  // The app handle itself, with this host's details on it.
  return Object.assign(app, details);
}

async function startViewer() {
  return launchApp({ env: { ...ENV, DISPLAY: viewerDisplay } });
}

/** Types the Device ID and code into the Viewer and presses Connect. */
async function connect(viewer, { deviceId, code, address = '127.0.0.1' }) {
  await viewer.eval(`
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input')); };
    set('#cd-id', ${JSON.stringify(deviceId)});
    set('#cd-code', ${JSON.stringify(code)});
    set('#cd-address', ${JSON.stringify(address)});
    document.querySelector('#btn-connect-device').click();
    return true`);
}

const allow = host => host.eval(`document.querySelector('#consent-allow').click(); return true`);

/**
 * Proves input reaches the host now: parks the host's real pointer in a corner,
 * moves the viewer's mouse to a fraction of the video, and waits for the host
 * pointer to arrive near the same fraction of its screen. Seeing video is not
 * enough — a session once showed the screen while every input went nowhere.
 */
async function pointerReachesHost(viewer, fraction, what) {
  const box = await viewer.eval(`
    const r = document.querySelector('#hd-video').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height }`);
  const probe = new X11Input({ display: hostDisplay });
  try {
    probe.movePointer(1, 1);
    await viewer.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: box.left + box.width * fraction, y: box.top + box.height * fraction,
    });
    return await waitFor(() => {
      const p = probe.pointerPosition();
      const near = (v, size) => Math.abs(v / size - fraction) < 0.2;
      return near(p.x, probe.width) && near(p.y, probe.height) ? p : null;
    }, 15_000, `the host pointer to follow the viewer (${what})`);
  } finally {
    probe.close();
  }
}

/** The host's log, where input counters are written. */
const hostLogText = app => hostLog(app).catch(() => '');
async function hostLog(app) {
  const { readFile } = await import('node:fs/promises');
  return readFile(path.join(app.dataDir, 'hopdesk', 'hopdesk.log'), 'utf8');
}

test('a viewer connects to a host by Device ID and access code, sees its screen and controls it',
  { skip, timeout: 180_000 }, async () => {
  const host = await startHost();
  const viewer = await startViewer();
  const xev = startXev(hostDisplay);
  try {
    /* The host asks before anyone gets in. */
    await connect(viewer, host);
    await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 20_000, 'the Allow prompt');
    const who = await host.eval(`return document.querySelector('#consent-id').textContent`);
    assert.match(who, /^HD-/, 'the prompt did not name the viewer’s Device ID');
    await allow(host);

    /* A real WebRTC connection, with frames actually arriving. */
    await viewer.waitFor(`return document.querySelector('#hd-view')?.hidden === false`, 30_000, 'the session view');
    await viewer.waitFor(`return document.querySelector('#hd-status')?.textContent === 'Connected'`, 30_000, 'connected status');
    const video = await waitFor(async () => {
      const v = await viewer.eval(`
        const v = document.querySelector('#hd-video');
        return { width: v.videoWidth, height: v.videoHeight, time: v.currentTime, state: v.readyState };`);
      return v.width > 0 && v.height > 0 && v.state >= 2 ? v : null;
    }, 45_000, 'video frames from the host');
    assert.ok(video.width >= 320 && video.height >= 240, `implausible video size ${video.width}x${video.height}`);
    await waitFor(async () => (await viewer.eval(`return document.querySelector('#hd-video').currentTime`)) > 0,
      20_000, 'the video to keep playing');
    /* A host with nothing wrong tells the viewer so, and no warning is shown. */
    await waitFor(async () => /the other computer reports no problems/.test(await hostLogText(viewer)) || null,
      15_000, 'the host to report its state to the viewer');
    assert.equal(await viewer.eval(`return document.querySelector('#hd-notice').hidden`), true,
      'a warning is shown for a host with nothing wrong');

    /* The host shows the session, named after the viewer. */
    const sessions = await host.eval(`
      return [...document.querySelectorAll('#mine-sessions .session-row')].map(r => r.textContent)`);
    assert.equal(sessions.length, 1, `host sessions: ${JSON.stringify(sessions)}`);
    assert.match(sessions[0], /Viewing|Connecting/);

    /* Mouse: a click in the middle of the video moves the host's real pointer. */
    const box = await viewer.eval(`
      const r = document.querySelector('#hd-video').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height }`);
    const probe = new X11Input({ display: hostDisplay });
    try {
      probe.movePointer(1, 1);                      // somewhere known first
      const target = { x: box.left + box.width * 0.5, y: box.top + box.height * 0.5 };
      await viewer.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
      const moved = await waitFor(() => {
        const p = probe.pointerPosition();
        return p.x > probe.width * 0.3 && p.x < probe.width * 0.7 && p.y > probe.height * 0.3 && p.y < probe.height * 0.7 ? p : null;
      }, 15_000, 'the host pointer to follow the viewer');
      assert.ok(moved, 'pointer did not move');

      /* Keyboard: a key pressed in the viewer arrives at an application on the host. */
      const window = await xev.window();
      focusWindow(hostDisplay, window);
      await viewer.eval(`document.querySelector('#hd-video').focus(); return true`);
      await viewer.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 });
      await viewer.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await xev.waitFor(/keysym 0x61, a/, 'the letter a on the host');
    } finally {
      probe.close();
    }

    /* Disconnecting ends it on both sides. */
    await viewer.eval(`document.querySelector('#hd-disconnect').click(); return true`);
    await viewer.waitFor(`return document.querySelector('#hd-view')?.hidden === true`, 10_000, 'the session view to close');
    await host.waitFor(`return document.querySelectorAll('#mine-sessions .session-row').length === 0`, 15_000, 'the host session to end');
  } finally {
    xev.child.kill('SIGKILL');
    await viewer.close();
    await host.close();
  }
});

test('a wrong access code is refused without prompting the host, and the host says so',
  { skip, timeout: 120_000 }, async () => {
  const host = await startHost();
  const viewer = await startViewer();
  try {
    await connect(viewer, { deviceId: host.deviceId, code: '000000' });
    await viewer.waitFor(`return document.querySelector('#cd-error')?.hidden === false`, 30_000, 'an error message');
    const message = await viewer.eval(`return document.querySelector('#cd-error').textContent`);
    assert.match(message, /access code is not correct/i, message);
    assert.equal(await host.eval(`return document.querySelector('#dlg-consent')?.open === true`), false,
      'a wrong code still prompted the person at the host');
    assert.equal(await viewer.eval(`return document.querySelector('#hd-view')?.hidden`), true);
  } finally {
    await viewer.close();
    await host.close();
  }
});

test('rejecting the prompt refuses the connection, and remote access can be turned off again',
  { skip, timeout: 120_000 }, async () => {
  const host = await startHost();
  const viewer = await startViewer();
  try {
    await connect(viewer, host);
    await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 20_000, 'the Allow prompt');
    await host.eval(`document.querySelector('#consent-reject').click(); return true`);
    await viewer.waitFor(`return document.querySelector('#cd-error')?.hidden === false`, 20_000, 'an error message');
    const message = await viewer.eval(`return document.querySelector('#cd-error').textContent`);
    assert.match(message, /did not allow/i, message);

    /* Turning remote access off stops the listener: a new attempt cannot connect. */
    await host.eval(`document.querySelector('#mine-toggle').click(); return true`);
    await host.waitFor(`return document.querySelector('#mine-state')?.textContent === 'Off'`, 15_000, 'remote access off');
    await connect(viewer, host);
    await viewer.waitFor(`
      const box = document.querySelector('#cd-error');
      return box && !box.hidden && /refused|did not answer|No computer/i.test(box.textContent)`, 30_000, 'a refusal after turning access off');
  } finally {
    await viewer.close();
    await host.close();
  }
});

test('the host is found on the network by its Device ID alone, with no address',
  { skip, timeout: 150_000 }, async () => {
  const host = await startHost();
  const viewer = await startViewer();
  try {
    /* No address given: the Device ID has to be resolved by mDNS. */
    await connect(viewer, { deviceId: host.deviceId, code: host.code, address: '' });
    let found = true;
    try {
      await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 25_000, 'the Allow prompt');
    } catch (err) {
      const message = await viewer.eval(`return document.querySelector('#cd-error').textContent`);
      // Multicast is blocked in some environments; that is a network fact, not a pass.
      if (/No computer with that Device ID/i.test(message)) { found = false; }
      else throw err;
    }
    assert.ok(found, 'the host was not found by mDNS on this network (multicast may be blocked here)');
    await allow(host);
    await viewer.waitFor(`return document.querySelector('#hd-view')?.hidden === false`, 30_000, 'the session view');
  } finally {
    await viewer.close();
    await host.close();
  }
});

test('text copied on the viewer is placed on the host\'s real clipboard',
  { skip, timeout: 150_000 }, async () => {
  const host = await startHost();
  const viewer = await startViewer();
  try {
    await connect(viewer, host);
    await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 20_000, 'the Allow prompt');
    await allow(host);
    await viewer.waitFor(`return document.querySelector('#hd-status')?.textContent === 'Connected'`, 30_000, 'connected status');

    const canary = `hopdesk-clip-${Date.now()}`;
    // Put it on the viewer's own clipboard, then use the button a user would.
    await viewer.eval(`await window.hopdesk.viewerClipboardWrite(${JSON.stringify(canary)}); return true`);
    await viewer.eval(`document.querySelector('#hd-send-clipboard').click(); return true`);

    /* Read the host's clipboard with a separate real X client on its display. */
    const text = await waitFor(async () => {
      const value = await readClipboard(hostDisplay);
      return value === canary ? value : null;
    }, 20_000, 'the text to arrive on the host clipboard');
    assert.equal(text, canary);
  } finally {
    await viewer.close();
    await host.close();
  }
});

test('an unexpected network drop resumes the session without asking the host again',
  { skip, timeout: 180_000 }, async () => {
  const host = await startHost();
  const viewer = await startViewer();
  /* The viewer reaches the host through a proxy the test can cut, which is how a
     dropped network is produced without touching the application. */
  const proxy = await startProxy(47631);
  try {
    await viewer.eval(`
      window.__connect = window.hopdesk.connectDevice({
        deviceId: ${JSON.stringify(host.deviceId)}, code: ${JSON.stringify(host.code)},
        address: '127.0.0.1', port: ${proxy.port},
      }).catch(e => e.message);
      return true`);
    await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 25_000, 'the Allow prompt');
    await allow(host);
    await viewer.waitFor(`return document.querySelector('#hd-status')?.textContent === 'Connected'`, 30_000, 'connected status');

    /* Cut every connection, as a lost network would. */
    proxy.cut();
    await viewer.waitFor(`return document.querySelector('#hd-status')?.textContent === 'Reconnecting…'`, 20_000, 'the reconnecting state');

    /* It comes back by itself, and the person at the host is not asked again. */
    await viewer.waitFor(`return document.querySelector('#hd-status')?.textContent === 'Connected'`, 45_000, 'the session to resume');
    assert.equal(await host.eval(`return document.querySelector('#dlg-consent')?.open === true`), false,
      'the host was asked to allow the same viewer twice');
    const sessions = await host.eval(`return document.querySelectorAll('#mine-sessions .session-row').length`);
    assert.equal(sessions, 1, 'the resumed session is not the only one');

    /* And it is a working session, not just a picture: input reaches the host. */
    await viewer.waitFor(`const v = document.querySelector('#hd-video'); return v.videoWidth > 0 && v.readyState >= 2`,
      45_000, 'video after resuming');
    await pointerReachesHost(viewer, 0.5, 'after resuming');
  } finally {
    proxy.close();
    await viewer.close();
    await host.close();
  }
});

test('a second session in the same viewer gets input too, and both sides log what became of it',
  { skip, timeout: 240_000 }, async () => {
  /* The bug this pins down: input was wired to the first session's connection
     only, so every later session in the same app run showed the host's screen
     while the mouse and keyboard went nowhere — and nothing said so. */
  const host = await startHost();
  const viewer = await startViewer();
  const xev = startXev(hostDisplay);
  try {
    for (const round of [1, 2]) {
      await connect(viewer, host);
      await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 25_000, `the Allow prompt (session ${round})`);
      await allow(host);
      await viewer.waitFor(`const v = document.querySelector('#hd-video'); return v.videoWidth > 0 && v.readyState >= 2`,
        45_000, `video (session ${round})`);
      await pointerReachesHost(viewer, round === 1 ? 0.4 : 0.6, `session ${round}`);
      if (round === 1) {
        await viewer.eval(`document.querySelector('#hd-disconnect').click(); return true`);
        await viewer.waitFor(`return document.querySelector('#hd-view')?.hidden === true`, 15_000, 'the first session to close');
        await host.waitFor(`return document.querySelectorAll('#mine-sessions .session-row').length === 0`, 15_000, 'the host to end the first session');
      }
    }

    /* The keyboard as well as the mouse, in the second session. */
    const window = await xev.window();
    focusWindow(hostDisplay, window);
    await viewer.eval(`document.querySelector('#hd-video').focus(); return true`);
    await viewer.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', text: 'b', windowsVirtualKeyCode: 66 });
    await viewer.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
    await xev.waitFor(/keysym 0x62, b/, 'the letter b on the host, in the second session');

    /* Both logs account for the input, for both sessions — so the next time
       input seems to vanish, the log says where. */
    await viewer.eval(`document.querySelector('#hd-disconnect').click(); return true`);
    await host.waitFor(`return document.querySelectorAll('#mine-sessions .session-row').length === 0`, 15_000, 'the host to end the second session');
    const hostLines = await waitFor(async () => {
      const text = await hostLog(host);
      const ends = text.match(/input \(session ended\): received \d+ .*; injected (\d+); dropped/g) ?? [];
      return ends.length >= 2 ? text : null;
    }, 10_000, 'an input summary for each session in the host log');
    assert.equal((hostLines.match(/first input arrived from the viewer/g) ?? []).length, 2,
      'the host log does not say input arrived in both sessions');
    for (const line of hostLines.match(/input \(session ended\).*/g)) {
      assert.match(line, /injected [1-9]\d*;/, `a session ended with nothing injected: ${line}`);
    }
    const viewerLines = await hostLog(viewer);
    assert.equal((viewerLines.match(/viewer: session \S+: first input sent/g) ?? []).length, 2,
      'the viewer log does not say input was sent in both sessions');
    /* Nothing about what was typed: counts, not keys. */
    assert.doesNotMatch(hostLines + viewerLines, /KeyB|"b"|keysym/, 'a log names the keys that were pressed');
  } finally {
    xev.child.kill('SIGKILL');
    await viewer.close();
    await host.close();
  }
});

test('a host that cannot fully share its screen tells the viewer, in plain words, on the viewer\'s screen',
  { skip, timeout: 180_000 }, async () => {
  /* What the launcher sets on a Wayland desktop, where capture sees only X11
     windows. The viewer must not be left to find that out by looking. */
  const host = await startHost({ HOPDESK_DESKTOP_SESSION: 'wayland' });
  const viewer = await startViewer();
  try {
    await connect(viewer, host);
    await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 25_000, 'the Allow prompt');
    await allow(host);
    await viewer.waitFor(`const v = document.querySelector('#hd-video'); return v.videoWidth > 0 && v.readyState >= 2`,
      45_000, 'video');
    const notice = await viewer.waitFor(`
      const box = document.querySelector('#hd-notice');
      return box.hidden ? null : box.textContent`, 15_000, 'the notice on the viewer');
    assert.match(notice, /Wayland desktop/);
    assert.match(notice, /only some of its windows/);
    assert.match(await hostLog(host), /telling the viewer: The other computer is on a Wayland desktop/);
    /* Input is not affected by this limit, and still works. */
    await pointerReachesHost(viewer, 0.5, 'with a notice showing');
    /* The notice belongs to that session and goes with it. */
    await viewer.eval(`document.querySelector('#hd-disconnect').click(); return true`);
    await viewer.waitFor(`return document.querySelector('#hd-notice').hidden === true`, 15_000, 'the notice to go with the session');
  } finally {
    await viewer.close();
    await host.close();
  }
});

/* --------------------------------------------------------------- helpers */

/** A TCP proxy whose connections the test can destroy on demand. */
async function startProxy(targetPort) {
  const { createServer, connect: tcpConnect } = await import('node:net');
  const live = new Set();
  const server = createServer(client => {
    const upstream = tcpConnect(targetPort, '127.0.0.1');
    live.add(client); live.add(upstream);
    client.on('close', () => live.delete(client));
    upstream.on('close', () => live.delete(upstream));
    for (const s of [client, upstream]) s.on('error', () => s.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    cut() { for (const s of live) s.destroy(); live.clear(); },
    close() { this.cut(); server.close(); },
  };
}

/** Reads the clipboard of an X display using a separate real Electron client. */
async function readClipboard(display) {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createRequire } = await import('node:module');
  const dir = await mkdtemp(path.join(tmpdir(), 'hopdesk-clip-'));
  const script = path.join(dir, 'read.cjs');
  /* A window is needed to take part in X selections at all: without one, a
     clipboard read comes back empty however much is on the clipboard. */
  await writeFile(script, `
    const { app, clipboard, BrowserWindow } = require('electron');
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      await win.loadURL('data:text/html,clipboard');
      process.stdout.write('CLIP:' + (await clipboard.readText()));
      app.quit();
    });
  `);
  const electronBinary = createRequire(import.meta.url)('electron');
  const env = launchEnvironment({ ...process.env, DISPLAY: display });
  delete env.ELECTRON_RUN_AS_NODE;
  /* Same sandbox rule as launchApp: on a CI runner the setuid helper cannot be
     configured, and Electron refuses to start at all without the switch — which
     showed up here as "the clipboard never arrived" rather than as a crash. */
  const sandbox = env.CI ? ['--no-sandbox'] : [];
  const child = spawn(electronBinary, [script, ...sandbox, ...ozoneArgs(env)],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  await new Promise(resolve => child.on('exit', resolve));
  const m = /CLIP:([\s\S]*)$/.exec(out);
  return m ? m[1] : '';
}

const X11 = koffi.load('libX11.so.6');
const XOpenDisplay = X11.func('void *XOpenDisplay(const char *name)');
const XCloseDisplay = X11.func('int XCloseDisplay(void *dpy)');
const XSetInputFocus = X11.func('int XSetInputFocus(void *dpy, unsigned long w, int revert_to, unsigned long time)');
const XSync = X11.func('int XSync(void *dpy, int discard)');

/** Gives an X window the keyboard focus, so injected keys reach it. */
function focusWindow(display, window) {
  const dpy = XOpenDisplay(display);
  XSetInputFocus(dpy, window, 2 /* RevertToParent */, 0);
  XSync(dpy, 0);
  XCloseDisplay(dpy);
}

/** An xev window on the host's display, to prove keys arrive in an application. */
function startXev(display) {
  const child = spawn('xev', { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  return {
    child,
    async window() {
      return waitFor(() => {
        const m = /Outer window is (0x[0-9a-f]+)/.exec(out);
        return m ? Number(m[1]) : null;
      }, 10_000, 'xev to report its window');
    },
    async waitFor(pattern, what) {
      return waitFor(() => (pattern.test(out) ? true : null), 20_000, `${what} (xev saw: ${out.slice(-600)})`);
    },
  };
}
