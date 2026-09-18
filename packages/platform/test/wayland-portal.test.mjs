import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probePortal, WaylandInput, PortalUnavailable, linuxBackend, createInputController, UnsupportedPlatform } from '../dist/index.js';

/**
 * The Wayland backend, as far as a machine can check it alone.
 *
 * Everything up to `Start` needs no permission, so a session can be created and
 * the devices and screen selected here. `Start` shows the compositor's dialog,
 * which nothing may click on the user's behalf — that is the entire point of
 * the permission — so injection itself is verified by scripts/verify-wayland.mjs
 * with a person present.
 */

const onWayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
const skip = onWayland ? false : 'not a Wayland session';

test('a Wayland session chooses the portal, not XTest', { skip }, () => {
  assert.equal(linuxBackend(), 'wayland');
  /* XTest on a Wayland session would reach Xwayland's clients only, so a viewer
     could control an X11 application and nothing else. Refusing is better. */
  assert.throws(() => createInputController(), UnsupportedPlatform);
  assert.throws(() => createInputController(), /desktop's permission/);
});

test('an X11 session still chooses XTest', () => {
  assert.equal(linuxBackend({ XDG_SESSION_TYPE: 'x11' }), 'x11');
  assert.equal(linuxBackend({}), 'x11');
  assert.equal(linuxBackend({ XDG_SESSION_TYPE: 'wayland' }), 'wayland');
});

test('the portal accepts a remote control session up to the point it asks', { skip, timeout: 60_000 }, async () => {
  const probe = await probePortal();
  assert.equal(probe.available, true, probe.available ? '' : probe.reason);
  assert.ok(probe.version >= 1, `RemoteDesktop portal version ${probe.version}`);
  /* GNOME refuses to remember a session that can control the machine. Whichever
     way this desktop answers, HopDesk has to cope with it. */
  assert.equal(typeof probe.persistSupported, 'boolean');
});

test('without a session bus the portal says so rather than hanging', { skip }, async () => {
  const saved = { bus: process.env.DBUS_SESSION_BUS_ADDRESS, runtime: process.env.XDG_RUNTIME_DIR };
  delete process.env.DBUS_SESSION_BUS_ADDRESS;
  delete process.env.XDG_RUNTIME_DIR;
  try {
    await assert.rejects(() => WaylandInput.create({ promptTimeoutMs: 1000 }), PortalUnavailable);
  } finally {
    if (saved.bus) process.env.DBUS_SESSION_BUS_ADDRESS = saved.bus;
    if (saved.runtime) process.env.XDG_RUNTIME_DIR = saved.runtime;
  }
});
