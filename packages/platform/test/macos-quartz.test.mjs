import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MacInput, MacOsUnavailable, loadQuartz, createInputController, inputUnavailableReason, UnsupportedPlatform } from '../dist/index.js';

/**
 * The macOS binding layer, on macOS.
 *
 * These run on a Mac (including a CI runner) and check the parts that need no
 * permission: that Quartz loads, that the struct-by-value calls work, and that
 * the display and pointer can be read. Posting events needs the Accessibility
 * permission, which a CI runner does not have and cannot be given, so that is
 * left to scripts/verify-macos.mjs on a real desktop.
 */

const onMac = process.platform === 'darwin';
const skip = onMac ? false : `not macOS (this is ${process.platform})`;

test('Quartz loads and the main display has a plausible size', { skip }, () => {
  const q = loadQuartz();
  const display = q.CGMainDisplayID();
  assert.ok(display > 0, 'no main display');
  const width = Number(q.CGDisplayPixelsWide(display));
  const height = Number(q.CGDisplayPixelsHigh(display));
  assert.ok(width >= 640 && height >= 480, `display reported ${width}x${height}`);
});

test('the pointer position comes back as two numbers on the screen', { skip }, () => {
  const input = new MacInput();
  try {
    const point = input.pointerPosition();
    // A struct returned by value: wrong ABI handling shows up here as nonsense.
    assert.equal(typeof point.x, 'number');
    assert.equal(typeof point.y, 'number');
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `pointer at ${point.x},${point.y}`);
    assert.ok(point.x >= -10_000 && point.x <= 20_000, `implausible x ${point.x}`);
    assert.equal(input.width >= 640, true);
  } finally {
    input.close();
  }
});

test('posting events does not throw, whatever the permission state', { skip }, () => {
  /* Without the Accessibility permission macOS drops these silently — that is
     the behaviour this test pins down: HopDesk must not crash, and the missing
     permission is reported elsewhere rather than as an exception here. */
  const input = new MacInput();
  try {
    input.movePointer(100, 100);
    input.button(1, true);
    input.button(1, false);
    input.wheel(0, 1);
    input.key(0xff0d, true);       // Return, a virtual key code
    input.key(0xff0d, false);
    input.key(0x61, true);         // "a", injected as text
    input.key(0x61, false);
    input.key(0x01000634, true);   // Arabic sheen, outside Latin-1
    input.key(0x01000634, false);
    input.releaseAll();
    assert.equal(input.heldFlags(), 0);
  } finally {
    input.close();
  }
});

test('modifier flags are held and cleared as keys go down and up', { skip }, () => {
  const input = new MacInput();
  try {
    input.key(0xffeb, true);                     // Command down
    assert.notEqual(input.heldFlags(), 0, 'Command did not set a flag');
    input.key(0x61, true); input.key(0x61, false);
    input.key(0xffeb, false);                    // Command up
    assert.equal(input.heldFlags(), 0, 'Command left its flag set');

    input.key(0xffe1, true);                     // Shift down
    assert.notEqual(input.heldFlags(), 0);
    input.releaseAll();
    assert.equal(input.heldFlags(), 0, 'releaseAll left a modifier held');
  } finally {
    input.close();
  }
});

test('a closed controller refuses to inject', { skip }, () => {
  const input = new MacInput();
  input.close();
  assert.throws(() => input.movePointer(1, 1), /closed/);
  input.close();                                  // twice is harmless
});

/* ------------------------------------------ what every platform can check */

test('the factory picks a backend for this platform, or explains why it cannot', () => {
  if (process.platform === 'linux' || process.platform === 'darwin') {
    // It may still fail for want of a display or a library; that is reported, not thrown.
    const reason = inputUnavailableReason({ display: ':99' });
    assert.ok(reason === null || typeof reason === 'string');
  } else {
    assert.throws(() => createInputController(), UnsupportedPlatform);
    assert.match(inputUnavailableReason() ?? '', /cannot/i);
  }
});

test('the macOS backend refuses politely on other platforms', { skip: onMac ? 'this is macOS' : false }, () => {
  assert.throws(() => new MacInput(), MacOsUnavailable);
  assert.throws(() => loadQuartz(), /only available on macOS/);
});

test('importing the package does not load any system library', async () => {
  /* The Host imports this on every platform, including ones with no X11 and no
     Quartz. Loading a library at import time would crash the app before it
     could say anything useful, so both backends load on first use. */
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../dist/linux/x11.js', import.meta.url), 'utf8'));
  const topLevelLoad = /^koffi\.load|^const \w+ = koffi\.load/m.test(source);
  assert.equal(topLevelLoad, false, 'x11.js loads a library at import time');
});
