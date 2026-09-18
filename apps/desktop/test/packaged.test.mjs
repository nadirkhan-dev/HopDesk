import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { launchApp, electronUnavailableReason, waitFor, desktopDir } from './helpers/electron.mjs';
import { X11Input, X11Unavailable } from '@hopdesk/platform';

/**
 * The packaged application, not the development one.
 *
 * What this catches that nothing else does: a dependency that exists in
 * node_modules but never reached the bundle. Every such mistake so far — the
 * D-Bus library, koffi's JavaScript, koffi's native binary — looked perfect in
 * development and failed the moment the AppImage started.
 *
 * Build it first: packaging/build-appimage.sh
 */

const appImage = path.join(desktopDir, '../../dist-packages/HopDesk-0.1.0.AppImage');
const hostDisplay = process.env.HOPDESK_HOST_DISPLAY ?? ':31';
const viewerDisplay = process.env.HOPDESK_VIEWER_DISPLAY ?? ':32';

function displayUsable(display) {
  try { new X11Input({ display }).close(); return true; }
  catch (err) { if (err instanceof X11Unavailable) return false; throw err; }
}

function refuseToSkip(reason) {
  if (reason && process.env.HOPDESK_REQUIRE_PACKAGE === '1') {
    throw new Error(`${reason} — and HOPDESK_REQUIRE_PACKAGE=1 says this test must run`);
  }
  return reason;
}

const skip = refuseToSkip(electronUnavailableReason()
  ?? (existsSync(appImage) ? null : 'no AppImage built (run packaging/build-appimage.sh)')
  ?? (displayUsable(hostDisplay) ? null : `no X display at ${hostDisplay}`)
  ?? (displayUsable(viewerDisplay) ? null : `no X display at ${viewerDisplay}`)
  ?? false);

const ENV = { HOPDESK_CREDENTIAL_BACKEND: 'file' };

test('two packaged HopDesk applications connect to each other and one controls the other',
  { skip, timeout: 240_000 }, async () => {
  const host = await launchApp({ binary: appImage, env: { ...ENV, DISPLAY: hostDisplay } });
  const viewer = await launchApp({ binary: appImage, env: { ...ENV, DISPLAY: viewerDisplay } });
  try {
    /* Prove the packaged build is what is running, not the development one.
       This test passed for a while against the development build because the
       helper quietly ignored which binary it was asked for — a packaging test
       that tests no package is worse than no test at all. An AppImage serves
       its files from the mount point it creates. */
    for (const [name, app] of [['host', host], ['viewer', viewer]]) {
      const href = await app.eval('return location.href');
      assert.match(href, /^file:\/\/\/tmp\/\.mount_/,
        `the ${name} is not running from the AppImage: ${href}`);
      assert.ok(href.includes('app.asar'), `the ${name} is not running from the bundle: ${href}`);
    }

    /* The bundle has to carry the crypto: without it there is no Device ID. */
    await host.eval(`document.querySelector('#mine-toggle').click(); return true`);
    await host.waitFor(`return document.querySelector('#mine-state')?.textContent === 'Online'`, 25_000, 'the packaged host to come online');
    const details = await host.eval(`
      return {
        deviceId: document.querySelector('#mine-id').textContent,
        code: document.querySelector('#mine-code').textContent.replace(/\\s/g, ''),
      }`);
    assert.match(details.deviceId, /^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.match(details.code, /^\d{6}$/);

    await viewer.eval(`
      const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input')); };
      set('#cd-id', ${JSON.stringify('ID')}.replace('ID', ''));
      return true`);
    await viewer.eval(`
      const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input')); };
      set('#cd-id', ${JSON.stringify(details.deviceId)});
      set('#cd-code', ${JSON.stringify(details.code)});
      set('#cd-address', '127.0.0.1');
      document.querySelector('#btn-connect-device').click();
      return true`);

    await host.waitFor(`return document.querySelector('#dlg-consent')?.open === true`, 30_000, 'the Allow prompt');
    await host.eval(`document.querySelector('#consent-allow').click(); return true`);

    /* Video means the packaged app can capture and encode. */
    await viewer.waitFor(`return document.querySelector('#hd-view')?.hidden === false`, 45_000, 'the session view');
    const video = await waitFor(async () => {
      const v = await viewer.eval(`
        const v = document.querySelector('#hd-video');
        return { width: v.videoWidth, state: v.readyState }`);
      return v.width > 0 && v.state >= 2 ? v : null;
    }, 60_000, 'video from the packaged host');
    assert.ok(video.width >= 320, `video was ${video.width} wide`);

    /* Input means the packaged app found koffi's native binary — the failure
       that started this test's existence. */
    const probe = new X11Input({ display: hostDisplay });
    try {
      probe.movePointer(3, 3);
      const box = await viewer.eval(`
        const r = document.querySelector('#hd-video').getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height }`);
      await viewer.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: box.left + box.width * 0.5, y: box.top + box.height * 0.5,
      });
      await waitFor(() => {
        const p = probe.pointerPosition();
        return p.x > probe.width * 0.3 && p.x < probe.width * 0.7 ? p : null;
      }, 20_000, 'the packaged host\'s pointer to follow the viewer');
    } finally {
      probe.close();
    }
  } finally {
    await viewer.close();
    await host.close();
  }
});
