import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

/* The leak happens in the runtime HopDesk ships with: Electron's bundled Node
   (libuv without close-on-spawn). Newer standalone Node closes inherited
   descriptors itself, so the parent must be Electron running as Node. */
function electronBinary() {
  try {
    return createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/desktop/package.json'))('electron');
  } catch {
    return null;
  }
}
const ELECTRON = electronBinary();
const skip = ELECTRON ? false : 'the electron package is not installed';

/**
 * Runs a probe inside Electron's Node runtime — whose own internal descriptors
 * are not close-on-exec — and reports which descriptors the grandchild program
 * could see.
 */
function descriptorsSeenByChild(useClean) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-spawn-'));
  const script = path.join(dir, 'parent.mjs');
  writeFileSync(script, `
    import { spawn } from 'node:child_process';
    import { spawnClean } from ${JSON.stringify(dist)};
    const start = ${useClean} ? spawnClean : spawn;
    // The program lists the descriptors of its own shell process.
    const child = start('/bin/sh', ['-c', 'ls /proc/$$/fd'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => { process.stdout.write(out); });
  `);
  return new Promise(resolve => {
    const parent = spawn(ELECTRON, [script],
      { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let out = '';
    parent.stdout.on('data', d => { out += d; });
    parent.on('close', () => resolve(out.split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b)));
  });
}

test('without the launcher, a child inherits the parent’s extra descriptors (the problem)', { skip }, async () => {
  const fds = await descriptorsSeenByChild(false);
  assert.ok(fds.includes(0), `the Electron probe did not run (Electron failed to start?): ${fds}`);
  // Observed: Electron 33 hands its own descriptors (e.g. 12, 21, 22) to children.
  assert.ok(fds.some(fd => fd > 3), `expected leaked descriptors above 3, saw ${fds}`);
});

test('spawnClean starts programs with only stdin, stdout and stderr', { skip }, async () => {
  const fds = await descriptorsSeenByChild(true);
  // An empty list would pass the check below vacuously.
  assert.ok(fds.includes(0), `the Electron probe did not run (Electron failed to start?): ${fds}`);
  // ls itself may briefly use fd 3 for the directory it lists; nothing above.
  assert.ok(fds.every(fd => fd <= 3), `unexpected descriptors: ${fds}`);
});

test('spawnClean keeps the program’s own PID, arguments and stdin', async () => {
  const { spawnClean, runClean } = await import(dist);
  const child = spawnClean('/bin/sh', ['-c', 'read line; echo "$$:$line:$1"', 'sh', 'arg with spaces; $(not run)'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stdin.end('secret-on-stdin\n');
  await new Promise(r => child.on('close', r));
  assert.equal(out.trim(), `${child.pid}:secret-on-stdin:arg with spaces; $(not run)`,
    'the PID changed, stdin was lost, or an argument was re-interpreted by the shell');

  const r = await runClean('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3']);
  assert.deepEqual([r.stdout.trim(), r.stderr.trim(), r.code], ['out', 'err', 3]);
  const slow = await runClean('/bin/sh', ['-c', 'sleep 30'], 300);
  assert.equal(slow.code, null, 'the timeout did not stop a hung program');
});
