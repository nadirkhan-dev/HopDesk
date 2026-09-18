import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFor, characterFor, modifierFlagFor, usLayoutKeyCode, MAC_FLAGS, MAC_VIRTUAL_KEYS } from '../dist/index.js';

/**
 * How a viewer's keys become macOS events. Pure decisions, so they can be
 * tested anywhere — what they cannot tell us is whether macOS accepts the
 * events, which only a Mac can (see scripts/verify-macos.mjs).
 */

test('named keys go by virtual key code', () => {
  assert.deepEqual(planFor(0xff0d), { kind: 'virtual', keyCode: 0x24, modifier: null });   // Return
  assert.deepEqual(planFor(0xff08), { kind: 'virtual', keyCode: 0x33, modifier: null });   // Backspace
  assert.deepEqual(planFor(0xff1b), { kind: 'virtual', keyCode: 0x35, modifier: null });   // Escape
  assert.deepEqual(planFor(0x0020), { kind: 'virtual', keyCode: 0x31, modifier: null });   // space
  assert.deepEqual(planFor(0xff52), { kind: 'virtual', keyCode: 0x7e, modifier: null });   // Up
  assert.deepEqual(planFor(0xffc2), { kind: 'virtual', keyCode: 0x60, modifier: null });   // F5
});

test('modifiers carry the flag macOS reports them with', () => {
  assert.deepEqual(planFor(0xffe1), { kind: 'virtual', keyCode: 0x38, modifier: MAC_FLAGS.shift });
  assert.deepEqual(planFor(0xffe3), { kind: 'virtual', keyCode: 0x3b, modifier: MAC_FLAGS.control });
  assert.deepEqual(planFor(0xffe9), { kind: 'virtual', keyCode: 0x3a, modifier: MAC_FLAGS.option });
  // The Super key is Command on a Mac: that is what makes Super+C copy there.
  assert.deepEqual(planFor(0xffeb), { kind: 'virtual', keyCode: 0x37, modifier: MAC_FLAGS.command });
  assert.equal(modifierFlagFor(0x61), null);
});

test('printable characters are sent as text, not as key positions', () => {
  /* A key code means a position on the keyboard, so sending the code for "A"
     types Q on a French layout. Text does not have that problem. */
  assert.deepEqual(planFor(0x61), { kind: 'text', text: 'a' });
  assert.deepEqual(planFor(0x41), { kind: 'text', text: 'A' });
  assert.deepEqual(planFor(0x40), { kind: 'text', text: '@' });
  assert.deepEqual(planFor(0xe9), { kind: 'text', text: 'é' });
  assert.deepEqual(planFor(0x01000634), { kind: 'text', text: 'ش' });     // Arabic sheen
  assert.deepEqual(planFor(0x0100597d), { kind: 'text', text: '好' });     // CJK
  assert.deepEqual(planFor(0x0101f600), { kind: 'text', text: '😀' });    // outside the BMP
});

test('nonsense and control codes are ignored rather than guessed at', () => {
  for (const keysym of [0, -1, 1.5, NaN, 0x01000000, 0x0100007f]) {
    assert.equal(planFor(keysym).kind, 'ignore', `keysym ${keysym}`);
  }
  assert.equal(characterFor(0x0020), null, 'space must be a key, so that holding it repeats');
  assert.equal(characterFor(0xff0d), null);
});

test('Command and Control shortcuts fall back to US key positions', () => {
  // macOS matches shortcuts on the key code, so Command+C needs C's position.
  assert.equal(usLayoutKeyCode('c'), 0x08);
  assert.equal(usLayoutKeyCode('C'), 0x08);
  assert.equal(usLayoutKeyCode('v'), 0x09);
  assert.equal(usLayoutKeyCode('z'), 0x06);
  assert.equal(usLayoutKeyCode('é'), null, 'characters with no US position have no fallback');
});

test('the table covers the keys a viewer can actually send', () => {
  /* Everything keysym.ts can produce for a non-printable key should land
     somewhere sensible, or the Mac would silently drop it. */
  const named = [
    0xff1b, 0xff09, 0xffe5, 0xff08, 0xff0d, 0xff8d, 0x0020,
    0xffe1, 0xffe2, 0xffe3, 0xffe4, 0xffe9, 0xffea, 0xffeb, 0xffec,
    0xff51, 0xff52, 0xff53, 0xff54, 0xff50, 0xff57, 0xff55, 0xff56, 0xff63, 0xffff,
  ];
  for (const keysym of named) {
    assert.equal(planFor(keysym).kind, 'virtual', `keysym 0x${keysym.toString(16)} has no macOS key`);
  }
  for (let i = 1; i <= 20; i++) {
    assert.equal(planFor(0xffbd + i).kind, 'virtual', `F${i} has no macOS key`);
  }
  for (let digit = 0; digit <= 9; digit++) {
    assert.equal(planFor(0xffb0 + digit).kind, 'virtual', `numpad ${digit} has no macOS key`);
  }
  // No two keysyms share a key code by accident, apart from the ones that should.
  const codes = Object.values(MAC_VIRTUAL_KEYS);
  assert.equal(new Set(codes).size, codes.length, 'two keysyms map to the same macOS key');
});
