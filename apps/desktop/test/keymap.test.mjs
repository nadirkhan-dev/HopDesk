import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keysymFor, buttonMask, wheelMask, SPECIAL_COMBOS } from '../dist/keymap.js';

/**
 * Keyboard mapping is where remote desktop clients quietly fail. These pin the
 * behaviours that are wrong in most implementations.
 */

test('modifiers map to the correct left/right keysyms', () => {
  assert.equal(keysymFor({ code: 'ControlLeft', key: 'Control' }), 0xffe3);
  assert.equal(keysymFor({ code: 'ControlRight', key: 'Control' }), 0xffe4);
  assert.equal(keysymFor({ code: 'ShiftLeft', key: 'Shift' }), 0xffe1);
  assert.equal(keysymFor({ code: 'AltLeft', key: 'Alt' }), 0xffe9);
  // AltGr on most European layouts — distinct from left Alt.
  assert.equal(keysymFor({ code: 'AltRight', key: 'AltGraph' }), 0xffea);
});

test('the Super/Windows key is passed through, not swallowed', () => {
  assert.equal(keysymFor({ code: 'MetaLeft', key: 'Meta' }), 0xffeb);
  assert.equal(keysymFor({ code: 'MetaRight', key: 'Meta' }), 0xffec);
});

test('every function key from F1 to F24 maps', () => {
  assert.equal(keysymFor({ code: 'F1', key: 'F1' }), 0xffbe);
  assert.equal(keysymFor({ code: 'F12', key: 'F12' }), 0xffc9);
  assert.equal(keysymFor({ code: 'F24', key: 'F24' }), 0xffd5);
  // Consecutive, as the X11 tables define them.
  for (let i = 1; i <= 24; i++) {
    assert.equal(keysymFor({ code: `F${i}`, key: `F${i}` }), 0xffbd + i);
  }
});

test('navigation and editing keys map', () => {
  assert.equal(keysymFor({ code: 'Enter', key: 'Enter' }), 0xff0d);
  assert.equal(keysymFor({ code: 'Backspace', key: 'Backspace' }), 0xff08);
  assert.equal(keysymFor({ code: 'Delete', key: 'Delete' }), 0xffff);
  assert.equal(keysymFor({ code: 'Escape', key: 'Escape' }), 0xff1b);
  assert.equal(keysymFor({ code: 'ArrowUp', key: 'ArrowUp' }), 0xff52);
  assert.equal(keysymFor({ code: 'PageDown', key: 'PageDown' }), 0xff56);
  assert.equal(keysymFor({ code: 'Home', key: 'Home' }), 0xff50);
});

test('the numpad is distinct from the number row', () => {
  // A remote application can tell them apart, and some depend on it.
  assert.notEqual(
    keysymFor({ code: 'Numpad1', key: '1' }),
    keysymFor({ code: 'Digit1', key: '1' }));
  assert.equal(keysymFor({ code: 'Numpad1', key: '1' }), 0xffb1);
  assert.equal(keysymFor({ code: 'NumpadEnter', key: 'Enter' }), 0xff8d);
});

test('printable characters follow `key`, so layouts survive the trip', () => {
  /* The important case: on AZERTY the physical Q key reports code 'KeyQ' but
     key 'a'. Sending the positional keysym would type Q on the remote machine.
     The character the user composed is what must be sent. */
  assert.equal(keysymFor({ code: 'KeyQ', key: 'a' }), 0x61);   // 'a'
  assert.equal(keysymFor({ code: 'KeyA', key: 'a' }), 0x61);
  assert.equal(keysymFor({ code: 'KeyA', key: 'A' }), 0x41);   // shifted
  assert.equal(keysymFor({ code: 'Digit1', key: '!' }), 0x21);
});

test('accented and non-Latin characters use the Unicode keysym range', () => {
  assert.equal(keysymFor({ code: 'KeyE', key: 'é' }), 0xe9);           // Latin-1 direct
  // Outside Latin-1: 0x01000000 + code point. Without this, Urdu, Arabic and
  // CJK input cannot reach the remote machine at all.
  assert.equal(keysymFor({ code: 'KeyA', key: 'ا' }), 0x01000000 + 0x0627);
  assert.equal(keysymFor({ code: 'KeyA', key: '好' }), 0x01000000 + 0x597d);
});

test('unknown named keys are ignored rather than sent wrong', () => {
  assert.equal(keysymFor({ code: 'BrightnessUp', key: 'BrightnessUp' }), null);
  assert.equal(keysymFor({ code: 'Unidentified', key: 'Unidentified' }), null);
});

test('mouse buttons map to the RFB mask, with middle and right not swapped', () => {
  assert.equal(buttonMask(1), 1);        // left
  assert.equal(buttonMask(4), 2);        // middle — browser bit 4, RFB bit 2
  assert.equal(buttonMask(2), 4);        // right  — browser bit 2, RFB bit 4
  assert.equal(buttonMask(3), 5);        // left + right together
  assert.equal(buttonMask(0), 0);
});

test('wheel direction maps to transient buttons', () => {
  assert.equal(wheelMask(-1), 8);        // up
  assert.equal(wheelMask(1), 16);        // down
  assert.equal(wheelMask(0, -1), 32);    // left
  assert.equal(wheelMask(0, 1), 64);     // right
  assert.equal(wheelMask(0, 0), 0);
});

test('shortcuts the local desktop steals are available explicitly', () => {
  // Ctrl+Alt+Delete never reaches an application, so the UI must send it.
  assert.deepEqual(SPECIAL_COMBOS['ctrl-alt-del'], [0xffe3, 0xffe9, 0xffff]);
  assert.ok(SPECIAL_COMBOS['alt-tab']);
  assert.ok(SPECIAL_COMBOS['super']);
});

test('a key is released with the keysym it was pressed with, even if `key` changed', async () => {
  const { KeyTracker } = await import('../dist/keymap.js');
  const t = new KeyTracker();
  assert.equal(t.down({ code: 'ShiftLeft', key: 'Shift' }), 0xffe1);
  assert.equal(t.down({ code: 'KeyA', key: 'A' }), 0x41);
  // Shift released first: the A keyup now reports 'a'.
  assert.equal(t.up({ code: 'ShiftLeft', key: 'Shift' }), 0xffe1);
  assert.equal(t.up({ code: 'KeyA', key: 'a' }), 0x41, 'released a different keysym than was pressed');
  assert.deepEqual(t.releaseAll(), []);
});

test('focus loss releases every held key, including non-Latin ones', async () => {
  const { KeyTracker } = await import('../dist/keymap.js');
  const t = new KeyTracker();
  t.down({ code: 'ControlLeft', key: 'Control' });
  t.down({ code: 'KeyA', key: 'ش' });        // Arabic layout
  assert.deepEqual(t.releaseAll().sort(), [0xffe3, 0x01000000 + 0x0634].sort());
  assert.deepEqual(t.releaseAll(), [], 'keys were released twice');
  assert.equal(t.down({ code: 'AudioVolumeUp', key: 'AudioVolumeUp' }), null);
});

test('text committed by an input method becomes Unicode keysyms, one per character', async () => {
  const { keysymsForText } = await import('../dist/keymap.js');
  assert.deepEqual(keysymsForText('你好'), [0x01000000 + 0x4f60, 0x01000000 + 0x597d]);
  assert.deepEqual(keysymsForText('日本'), [0x01000000 + 0x65e5, 0x01000000 + 0x672c]);
  assert.deepEqual(keysymsForText('سلام'), [0x01000633, 0x01000644, 0x01000627, 0x01000645]);
  assert.deepEqual(keysymsForText('é!'), [0xe9, 0x21]);
  // Astral-plane characters are one code point, not two UTF-16 halves.
  assert.deepEqual(keysymsForText('😀'), [0x01000000 + 0x1f600]);
});

test('pointer positions on a scaled canvas map to remote pixels and are clamped', async () => {
  const { framebufferPoint } = await import('../dist/keymap.js');
  const box = { left: 100, top: 50, width: 960, height: 540 };   // 1920×1080 shown at half size
  assert.deepEqual(framebufferPoint(100, 50, box, 1920, 1080), { x: 0, y: 0 });
  assert.deepEqual(framebufferPoint(580, 320, box, 1920, 1080), { x: 960, y: 540 });
  assert.deepEqual(framebufferPoint(5000, -20, box, 1920, 1080), { x: 1919, y: 0 });
});

test('a key released without a sent press is not released on the remote', async () => {
  const { KeyTracker } = await import('../dist/keymap.js');
  const t = new KeyTracker();
  // Pressed before the screen had focus, or swallowed as Ctrl+Alt+Enter.
  assert.equal(t.up({ code: 'Enter', key: 'Enter' }), null);
  assert.equal(t.down({ code: 'KeyA', key: 'a' }), 0x61);
  assert.equal(t.up({ code: 'KeyA', key: 'a' }), 0x61);
  assert.equal(t.up({ code: 'KeyA', key: 'a' }), null, 'a second release was sent');
});
