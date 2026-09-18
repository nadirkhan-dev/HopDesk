import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macReport, viewerNotices } from '../dist/permission-report.js';

test('both macOS permissions are always listed, whether or not they are granted', () => {
  for (const [capture, input] of [['granted', 'granted'], ['prompt', 'prompt'], ['denied', 'granted'], ['granted', 'prompt']]) {
    const report = macReport(capture, input);
    assert.deepEqual(report.items.map(i => i.id), ['screen-recording', 'accessibility']);
    assert.equal(report.items[0].granted, capture === 'granted');
    assert.equal(report.items[1].granted, input === 'granted');
  }
});

test('a missing permission says what breaks, where to switch it on, and which pane to open', () => {
  const report = macReport('denied', 'prompt');
  const [screen, access] = report.items;
  assert.match(screen.why, /blank screen/);
  assert.match(screen.how, /Privacy & Security → Screen Recording/);
  assert.match(screen.how, /quit and reopen HopDesk/);
  assert.equal(screen.action, 'open-screen-recording');
  assert.match(access.why, /mouse and keyboard do nothing/);
  assert.match(access.how, /Privacy & Security → Accessibility/);
  assert.equal(access.action, 'open-accessibility');
  assert.match(report.detail, /Screen Recording or Accessibility/);
});

test('with everything granted there is nothing to fix and nothing to tell a viewer', () => {
  const report = macReport('granted', 'granted');
  assert.equal(report.detail, undefined);
  assert.equal(report.action, undefined);
  assert.ok(report.items.every(i => i.how === ''));
  assert.deepEqual(viewerNotices(report, null), []);
});

test('the viewer is told exactly what the other Mac is missing, in its own terms', () => {
  const notices = viewerNotices(macReport('denied', 'prompt'), 'macOS Accessibility is off for HopDesk');
  assert.equal(notices.length, 2);
  assert.match(notices[0], /record its screen/);
  assert.match(notices[1], /You can watch but not control/);
  assert.match(notices[1], /Accessibility/);
  // Accessibility is reported once, not again as a generic input problem.
  assert.ok(!notices.some(n => n.includes('cannot accept mouse and keyboard input')));
});

test('an input problem on a computer with no permissions to ask for is still reported to the viewer', () => {
  const linux = { capture: 'granted', input: 'granted', items: [] };
  const notices = viewerNotices(linux, 'Cannot load libXtst.so.6');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /cannot accept mouse and keyboard input \(Cannot load libXtst\.so\.6\)/);
});

test('notices are bounded', () => {
  const long = 'x'.repeat(2000);
  const notices = viewerNotices(null, long, [long, long, long, long]);
  assert.ok(notices.length <= 4);
  assert.ok(notices.every(n => n.length <= 400));
});
