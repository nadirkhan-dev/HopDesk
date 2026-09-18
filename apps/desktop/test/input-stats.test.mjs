import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputStats } from '../dist/input-stats.js';

function harness() {
  const lines = [];
  let clock = 1_000;
  const stats = new InputStats('S1', line => lines.push(line), () => clock, 5000);
  return { stats, lines, advance: ms => { clock += ms; } };
}

test('the first arrival is logged at once, and every reason for dropping input is named the first time', () => {
  const { stats, lines } = harness();
  stats.arrived('pointer');
  assert.deepEqual(lines, ['session S1: first input arrived from the viewer']);
  stats.delivered();
  stats.arrived('key');
  stats.drop('no input controller: This X server does not provide the XTEST extension');
  stats.arrived('key');
  stats.drop('no input controller: This X server does not provide the XTEST extension');
  assert.equal(lines.filter(l => l.includes('input dropped:')).length, 1, 'a reason was logged more than once');
  assert.match(lines[1], /input dropped: no input controller: This X server does not provide the XTEST extension/);
});

test('summaries come at most every interval, and the last one at the end says what happened', () => {
  const { stats, lines, advance } = harness();
  for (let i = 0; i < 50; i++) { stats.arrived('pointer'); stats.delivered(); advance(10); }
  assert.equal(lines.filter(l => / input: /.test(l)).length, 0, 'a summary came before the interval');
  advance(5000);
  stats.arrived('pointer'); stats.delivered();
  assert.equal(lines.filter(l => / input: /.test(l)).length, 1);
  stats.arrived('wheel'); stats.drop('invalid message (dy out of range)');
  stats.finish();
  const last = lines.at(-1);
  assert.equal(last, 'session S1 input (session ended): received 52 [pointer 51, wheel 1]; injected 51; '
    + 'dropped 1 [invalid message (dy out of range) 1]');
  assert.deepEqual(stats.summary(), { received: 52, injected: 51, dropped: 1 });
});

test('a session with no input at all still ends with a summary saying so', () => {
  const { stats, lines } = harness();
  stats.finish();
  assert.deepEqual(lines, ['session S1 input (session ended): received 0 [none]; injected 0; dropped 0 [none]']);
});

test('the counters have no way to be given a key: only a message type and a reason', () => {
  // The API is the guarantee. arrived() takes the message type, not the message.
  assert.equal(InputStats.prototype.arrived.length, 1);
  assert.equal(InputStats.prototype.delivered.length, 0);
  assert.equal(InputStats.prototype.drop.length, 1);
});
