import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X11Input, X11Unavailable } from '../dist/index.js';

/**
 * Real input injection, verified by asking the X server what it now believes:
 * XQueryPointer for the pointer and buttons, XQueryKeymap for keys. Nothing
 * here is simulated — if XTest did not work, these tests fail.
 *
 * HOPDESK_X11_DISPLAY selects a display to inject into. It defaults to a
 * spare test display rather than $DISPLAY so that running the suite does not
 * move the pointer or press keys on the developer's own desktop.
 */
const display = process.env.HOPDESK_X11_DISPLAY ?? ':31';

function open() {
  try {
    return new X11Input({ display });
  } catch (err) {
    if (err instanceof X11Unavailable) return null;
    throw err;
  }
}

const probe = open();
/**
 * A suite that quietly skips proves nothing. HOPDESK_REQUIRE_DISPLAY=1 — which
 * the full-suite runs and CI set — turns "no display here" into a failure.
 */
function refuseToSkip(reason) {
  if (reason && process.env.HOPDESK_REQUIRE_DISPLAY === '1') {
    throw new Error(`${reason} — and HOPDESK_REQUIRE_DISPLAY=1 says these tests must run`);
  }
  return reason;
}

const skip = refuseToSkip(probe ? false : `no usable X display at ${display} (set HOPDESK_X11_DISPLAY)`);
probe?.close();

test('the display geometry is read from the X server', { skip }, () => {
  const x = open();
  try {
    assert.ok(x.width >= 320 && x.height >= 240, `implausible screen size ${x.width}x${x.height}`);
  } finally { x.close(); }
});

test('the pointer moves to absolute positions and is clamped to the screen', { skip }, () => {
  const x = open();
  try {
    for (const [px, py] of [[10, 20], [300, 200], [1, 1]]) {
      x.movePointer(px, py);
      assert.deepEqual(x.pointerPosition(), { x: px, y: py });
    }
    x.movePointer(-50, -50);
    assert.deepEqual(x.pointerPosition(), { x: 0, y: 0 }, 'a negative position was not clamped');
    x.movePointer(x.width + 500, x.height + 500);
    assert.deepEqual(x.pointerPosition(), { x: x.width - 1, y: x.height - 1 }, 'an oversized position was not clamped');
    x.movePointer(120.6, 80.4);
    assert.deepEqual(x.pointerPosition(), { x: 121, y: 80 }, 'fractional coordinates were not rounded');
  } finally { x.close(); }
});

test('buttons press and release, and releaseAll unsticks everything', { skip }, () => {
  const x = open();
  try {
    const BUTTON1 = 0x100, BUTTON3 = 0x400;
    x.movePointer(50, 50);
    assert.equal(x.pointerButtons() & BUTTON1, 0, 'a button was already held before the test');

    x.button(1, true);
    assert.equal(x.pointerButtons() & BUTTON1, BUTTON1, 'the left button did not press');
    x.button(1, false);
    assert.equal(x.pointerButtons() & BUTTON1, 0, 'the left button did not release');

    x.button(3, true);
    assert.equal(x.pointerButtons() & BUTTON3, BUTTON3, 'the right button did not press');
    x.releaseAll();
    assert.equal(x.pointerButtons() & BUTTON3, 0, 'releaseAll left the right button held');

    // An out-of-range button number is ignored rather than injected.
    x.button(9, true);
    assert.equal(x.pointerButtons() & 0xff00, 0);
  } finally { x.close(); }
});

test('wheel scrolling injects transient button clicks, bounded per message', { skip }, () => {
  const x = open();
  try {
    // Wheel buttons are press+release pairs, so nothing should stay held.
    x.wheel(0, 3);
    x.wheel(0, -3);
    x.wheel(2, 0);
    assert.equal(x.pointerButtons() & 0xff00, 0, 'a wheel button stayed held');
    // A hostile viewer asking for 100000 clicks must not hang the host.
    const started = Date.now();
    x.wheel(0, 100_000);
    assert.ok(Date.now() - started < 2000, 'an enormous wheel delta was not bounded');
    assert.equal(x.pointerButtons() & 0xff00, 0);
  } finally { x.close(); }
});

test('keys the layout has are pressed and released as themselves', { skip }, () => {
  const x = open();
  try {
    const a = x.keycodeFor(0x61);            // XK_a
    assert.ok(a > 0, 'the layout has no key for "a"');
    assert.equal(x.keycodeHeld(a), false);
    x.key(0x61, true);
    assert.equal(x.keycodeHeld(a), true, 'the key did not go down');
    x.key(0x61, false);
    assert.equal(x.keycodeHeld(a), false, 'the key did not come up');

    // Modifiers are ordinary keys to XTest.
    const shift = x.keycodeFor(0xffe1);
    x.key(0xffe1, true);
    assert.equal(x.keycodeHeld(shift), true);
    x.releaseAll();
    assert.equal(x.keycodeHeld(shift), false, 'releaseAll left a modifier held');
  } finally { x.close(); }
});

test('a keysym the layout cannot produce is injected on a borrowed keycode and handed back', { skip }, async () => {
  const x = open();
  try {
    // Arabic sheen, and an emoji: neither exists on a default English layout.
    for (const keysym of [0x01000634, 0x0101f600]) {
      assert.equal(x.keycodeFor(keysym), 0, `the layout already maps ${keysym.toString(16)}`);
      x.key(keysym, true);
      const borrowed = x.borrowedKeycodes().find(s => s.keysym === keysym);
      assert.ok(borrowed, `${keysym.toString(16)} was not mapped onto a keycode`);
      // Read from the server, not Xlib's cache: the mapping really is in place.
      assert.ok(x.serverKeysyms(borrowed.keycode).includes(keysym), 'the X server does not have the keysym on that keycode');
      assert.equal(x.keycodeHeld(borrowed.keycode), true, 'the borrowed keycode was not pressed');

      x.key(keysym, false);
      assert.equal(x.keycodeHeld(borrowed.keycode), false, 'the borrowed keycode stayed held');
      /* The mapping is deliberately kept for a moment after the release, so an
         application that has not yet processed MappingNotify still reads the
         right keysym. It is handed back shortly afterwards. */
      assert.ok(x.serverKeysyms(borrowed.keycode).includes(keysym), 'the mapping was withdrawn immediately');
      await new Promise(r => setTimeout(r, 400));
      assert.ok(!x.serverKeysyms(borrowed.keycode).includes(keysym), 'the borrowed keycode was never handed back');
    }
  } finally { x.close(); }
});

test('two unmapped keysyms can be held at once, and releaseAll hands every keycode back', { skip }, () => {
  const x = open();
  try {
    x.key(0x01000634, true);            // Arabic sheen
    x.key(0x0100062c, true);            // Arabic jeem
    const borrowed = x.borrowedKeycodes();
    assert.equal(borrowed.length, 2, `expected two borrowed keycodes, got ${JSON.stringify(borrowed)}`);
    assert.notEqual(borrowed[0].keycode, borrowed[1].keycode, 'both keysyms took the same keycode');
    for (const slot of borrowed) assert.equal(x.keycodeHeld(slot.keycode), true);

    x.releaseAll();
    for (const slot of borrowed) {
      assert.equal(x.keycodeHeld(slot.keycode), false, 'releaseAll left a borrowed key held');
      assert.ok(!x.serverKeysyms(slot.keycode).includes(slot.keysym), 'releaseAll left a keycode mapped');
    }
  } finally { x.close(); }
});

test('the keysyms a viewer sends map back to real keys on the host', { skip }, () => {
  const x = open();
  try {
    // The keysyms a viewer sends for Enter, "a", F5 and Left.
    for (const [name, keysym] of [['Enter', 0xff0d], ['a', 0x61], ['F5', 0xffc2], ['Left', 0xff51]]) {
      const keycode = x.keycodeFor(keysym);
      assert.ok(keycode > 0, `the host has no key for ${name} (keysym ${keysym.toString(16)})`);
      x.key(keysym, true);
      assert.equal(x.keycodeHeld(keycode), true, `${name} did not press`);
      x.key(keysym, false);
      assert.equal(x.keycodeHeld(keycode), false, `${name} did not release`);
    }
  } finally { x.close(); }
});

test('nonsense input is ignored, and a closed controller refuses to inject', { skip }, () => {
  const x = open();
  try {
    for (const bad of [0, -1, 1.5, NaN, 0x20000000]) x.key(bad, true);
    assert.equal(x.pointerButtons() & 0xff00, 0);
  } finally { x.close(); }
  assert.throws(() => x.movePointer(1, 1), /closed/);
  x.close();                                  // closing twice is harmless
});

test('opening a display that does not exist fails clearly', () => {
  assert.throws(() => new X11Input({ display: ':91' }), X11Unavailable);
});
