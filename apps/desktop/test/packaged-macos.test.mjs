import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchApp, waitFor } from './helpers/electron.mjs';

/**
 * The macOS package, installed from its .dmg and started — run by the release
 * workflow on a Mac for each architecture before anything is published.
 *
 * What a CI Mac can prove: the app starts from the bundle; it lists both
 * permissions macOS gates hosting on, with the state macOS reports, in the
 * window and in the log; and switching remote access on loads Quartz through
 * koffi's native module for *this* architecture — the part that would be
 * missing from an Intel build made on an Apple Silicon machine.
 *
 * What it cannot: a CI machine cannot be granted Screen Recording or
 * Accessibility, so whether events move a real pointer and capture shows a
 * real screen is for a Mac with a person at it.
 *
 * HOPDESK_MAC_APP is the installed HopDesk.app.
 */

const appPath = process.env.HOPDESK_MAC_APP;
const skip = process.platform !== 'darwin' ? 'not macOS'
  : !appPath ? 'HOPDESK_MAC_APP is not set'
    : !existsSync(appPath) ? `no app at ${appPath}` : false;
if (skip && process.env.HOPDESK_REQUIRE_PACKAGE === '1') {
  throw new Error(`${skip} — and HOPDESK_REQUIRE_PACKAGE=1 says this test must run`);
}

test('the installed Mac app starts, lists what macOS allows it, and loads its input backend',
  { skip, timeout: 180_000 }, async () => {
  // The bundle's own name for its executable, not an assumed one.
  const executable = execFileSync('/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleExecutable', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  const app = await launchApp({
    binary: path.join(appPath, 'Contents', 'MacOS', executable),
    env: { HOPDESK_CREDENTIAL_BACKEND: 'file' },
  });
  try {
    const href = await app.eval('return location.href');
    assert.ok(href.includes(`/${path.basename(appPath)}/Contents/Resources/app.asar/`), `not running from the bundle: ${href}`);

    /* Both permissions are listed from the start, each with a state. */
    const perms = await app.waitFor(`
      const rows = [...document.querySelectorAll('#mine-perms .perm')];
      return rows.length === 2 && !document.querySelector('#mine-perms').hidden
        ? rows.map(r => ({ id: r.dataset.permission, state: r.querySelector('.perm-state').textContent, text: r.textContent }))
        : null`, 20_000, 'the permissions panel');
    assert.deepEqual(perms.map(p => p.id), ['screen-recording', 'accessibility']);
    for (const p of perms) {
      assert.match(p.state, /^(✓ Allowed|✗ Not allowed)$/, `${p.id}: ${p.state}`);
      if (p.state.includes('Not allowed')) {
        assert.match(p.text, /Privacy & Security/, `${p.id} does not say where to turn it on`);
        assert.match(p.text, /Open .* settings/, `${p.id} has no button to the settings`);
      }
    }

    /* The window and the log agree about what macOS said. */
    const logFile = path.join(app.dataDir, 'hopdesk', 'hopdesk.log');
    const log = await waitFor(async () => {
      const text = await readFile(logFile, 'utf8').catch(() => '');
      return /permissions: Screen Recording (allowed|not allowed), Accessibility (allowed|not allowed)/.test(text) ? text : null;
    }, 10_000, 'the permissions in the log');
    const [, screenLogged, accessLogged] = /permissions: Screen Recording (allowed|not allowed), Accessibility (allowed|not allowed)/.exec(log);
    assert.equal(perms[0].state.includes('Not allowed'), screenLogged === 'not allowed', 'window and log disagree on Screen Recording');
    assert.equal(perms[1].state.includes('Not allowed'), accessLogged === 'not allowed', 'window and log disagree on Accessibility');
    console.log(`macOS reports: Screen Recording ${screenLogged}, Accessibility ${accessLogged}`);

    /* Remote access on: the host listens, and Quartz loads through koffi. */
    await app.eval(`document.querySelector('#mine-toggle').click(); return true`);
    await app.waitFor(`return document.querySelector('#mine-state')?.textContent === 'Online'`, 30_000, 'the host to come online');
    const after = await waitFor(async () => {
      const text = await readFile(logFile, 'utf8');
      return /input ready \(darwin\)|input injection unavailable/.test(text) ? text : null;
    }, 20_000, 'the input backend to load or refuse');
    assert.match(after, /input ready \(darwin\)/,
      `the input backend did not load: ${(/input injection unavailable: .*/.exec(after) ?? [''])[0]}`);

    /* Without Accessibility the window says so, rather than looking ready. */
    if (accessLogged === 'not allowed') {
      const detail = await app.eval(`return document.querySelector('#mine-detail').textContent`);
      assert.match(detail, /Accessibility/, `nothing says input will not work: "${detail}"`);
    }
  } finally {
    await app.close();
  }
});
