import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sharedDisplay, sourceForDisplay, screenChoices, capturedTheWrongScreen,
} from '../dist/screens.js';

/** The laptop and the external monitor this was written against. */
const LAPTOP = { id: 1881264395124802, bounds: { x: 1920, y: 120, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 };
const EXTERNAL = { id: 9586237423398980, bounds: { x: 0, y: 0, width: 1920, height: 1200 }, size: { width: 1920, height: 1200 }, scaleFactor: 1 };
const DISPLAYS = [LAPTOP, EXTERNAL];
/* What desktopCapturer really answers on X11: display_id is XRandR's numbering
   and matches no Electron display id. */
const SOURCES = [
  { id: 'screen:406:0', name: 'Screen 1', display_id: '66' },
  { id: 'screen:407:0', name: 'Screen 2', display_id: '3562713155' },
];

test('nothing chosen shares the main screen', () => {
  assert.equal(sharedDisplay(DISPLAYS, LAPTOP.id, null).id, LAPTOP.id);
  // A screen that has since been unplugged falls back rather than sharing nothing.
  assert.equal(sharedDisplay(DISPLAYS, LAPTOP.id, 12345).id, LAPTOP.id);
});

test('the chosen screen is the one shared', () => {
  assert.equal(sharedDisplay(DISPLAYS, LAPTOP.id, EXTERNAL.id).id, EXTERNAL.id);
});

test('a source is matched by position when its id means nothing', () => {
  /* The bug this is here for: matching on display_id alone found nothing and
     fell back to the first source, so choosing the external monitor still
     shared the laptop. */
  assert.equal(sourceForDisplay(SOURCES, DISPLAYS, EXTERNAL).id, 'screen:407:0');
  assert.equal(sourceForDisplay(SOURCES, DISPLAYS, LAPTOP).id, 'screen:406:0');
});

test('an id that does match is used, whatever the order', () => {
  const sources = [
    { id: 'screen:1:0', name: 'Screen 1', display_id: String(EXTERNAL.id) },
    { id: 'screen:2:0', name: 'Screen 2', display_id: String(LAPTOP.id) },
  ];
  assert.equal(sourceForDisplay(sources, DISPLAYS, LAPTOP).id, 'screen:2:0');
});

test('one screen, or none offered, still answers with something usable', () => {
  assert.equal(sourceForDisplay(SOURCES, [LAPTOP], LAPTOP).id, 'screen:406:0');
  assert.equal(sourceForDisplay([], DISPLAYS, LAPTOP), null);
});

test('screens are listed with their size, and the main one says so', () => {
  const choices = screenChoices(DISPLAYS, LAPTOP.id);
  assert.deepEqual(choices.map(c => c.label),
    ['Screen 1 — 1920 × 1080 (main)', 'Screen 2 — 1920 × 1200']);
  assert.equal(choices[1].primary, false);
});

test('capturing the wrong monitor is noticed, and a Retina scale is not', () => {
  assert.equal(capturedTheWrongScreen(LAPTOP, { width: 1920, height: 1080 }), false);
  assert.equal(capturedTheWrongScreen(LAPTOP, { width: 1920, height: 1200 }), true);
  // A 2x screen captures at twice its size in points, which is right, not wrong.
  const retina = { ...LAPTOP, scaleFactor: 2 };
  assert.equal(capturedTheWrongScreen(retina, { width: 3840, height: 2160 }), false);
  // Nothing measured yet: nothing to complain about.
  assert.equal(capturedTheWrongScreen(LAPTOP, { width: 0, height: 0 }), false);
});
