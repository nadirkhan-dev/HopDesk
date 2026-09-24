import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitText, executablePath, UNIT_NAME } from '../dist/login-item.js';
import { trayState } from '../dist/tray-state.js';

/**
 * Being reachable after a restart, and saying so from the tray.
 *
 * On Linux "open at login" did nothing at all - Electron's login item is a
 * silent no-op there - so a computer meant to be reachable stopped being
 * reachable the moment it rebooted, without ever saying so.
 */

test('the unit starts HopDesk with the graphical session, and knows where it lives', () => {
  const unit = unitText('/opt/HopDesk/hopdesk');
  assert.match(unit, /ExecStart=\/opt\/HopDesk\/hopdesk/);
  assert.match(unit, /WantedBy=graphical-session\.target/);
  /* A user service inherits nothing from the session, so without this the app
     starts and finds no desktop to draw on. */
  assert.match(unit, /import-environment DISPLAY WAYLAND_DISPLAY/);
  // Leading '-' so a failure to import does not stop the service starting.
  assert.match(unit, /ExecStartPre=-/);
  assert.equal(UNIT_NAME, 'hopdesk.service');
});

test('an AppImage is named by the file, not by the path inside it', () => {
  /* An AppImage mounts itself and runs from inside that mount, a path that
     exists only while it is running: a unit pointing there starts nothing. */
  assert.equal(
    executablePath({ APPIMAGE: '/home/someone/Apps/HopDesk.AppImage' }, '/tmp/.mount_HopDes123/hopdesk'),
    '/home/someone/Apps/HopDesk.AppImage');
  // Installed from a package, argv is the right answer.
  assert.equal(executablePath({}, '/opt/HopDesk/hopdesk'), '/opt/HopDesk/hopdesk');
});

test('the tray says which of three things is true', () => {
  assert.equal(trayState({ enabled: false, listening: false, sessions: [] }).state, 'offline');
  assert.equal(trayState({ enabled: true, listening: true, sessions: [] }).state, 'ready');
  assert.equal(trayState({ enabled: true, listening: true, sessions: [{ id: 'a' }] }).state, 'in-session');

  // Switched on but not listening yet is not reachable, and must not say Ready.
  const starting = trayState({ enabled: true, listening: false, sessions: [] });
  assert.equal(starting.state, 'offline');
  assert.match(starting.label, /starting/i);

  // One computer connected reads as one, not "1 computers".
  assert.match(trayState({ enabled: true, listening: true, sessions: [{ id: 'a' }] }).label, /1 computer connected/);
  assert.match(trayState({ enabled: true, listening: true, sessions: [{ id: 'a' }, { id: 'b' }] }).label, /2 computers connected/);

  // Nothing at all to report on is still a sentence, not a crash.
  assert.equal(trayState(null).state, 'offline');
});
