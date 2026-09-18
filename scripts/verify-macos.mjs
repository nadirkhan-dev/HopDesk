/**
 * Checks HopDesk's macOS backend on a real Mac.
 *
 * Run it there:
 *
 *     npm install && npm run build
 *     node scripts/verify-macos.mjs
 *
 * It exercises the parts that only a Mac can answer for: loading Quartz,
 * reading the display, moving the pointer and reading the position back,
 * clicking, scrolling, and typing — plus what the system currently permits.
 *
 * It moves your pointer and types into whatever window has focus, so give it an
 * empty TextEdit document (or pass --no-typing) and do not touch the mouse
 * while it runs. Nothing here is simulated: every check reports what macOS
 * actually did, and says FAIL rather than guessing.
 */
import { setTimeout as delay } from 'node:timers/promises';

const typing = !process.argv.includes('--no-typing');
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const mark = ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL';
  process.stdout.write(`${mark}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

if (process.platform !== 'darwin') {
  process.stdout.write(`This script only means anything on macOS; this is ${process.platform}.\n`);
  process.exit(2);
}

let platform;
try {
  platform = await import('../packages/platform/dist/index.js');
} catch (err) {
  record('build the platform package (npm run build)', false, err.message);
  process.exit(1);
}
const { MacInput, planFor } = platform;

/* 1. Quartz loads, and the display size is plausible. */
let input;
try {
  input = new MacInput();
  const plausible = input.width >= 640 && input.height >= 480;
  record('load Quartz and read the main display', plausible, `${input.width}x${input.height}`);
} catch (err) {
  record('load Quartz and read the main display', false, err.message);
  process.exit(1);
}

/* 2. Accessibility permission. Without it every event below is swallowed, so
      this is reported before the tests that would silently "pass". */
let accessibility = 'unknown';
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('/usr/bin/sqlite3', [
    `${process.env.HOME}/Library/Application Support/com.apple.TCC/TCC.db`,
    "select client, auth_value from access where service='kTCCServiceAccessibility'",
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  accessibility = out.trim() ? 'listed' : 'not listed';
} catch {
  // Reading TCC needs Full Disk Access; not being able to read it is normal.
  accessibility = 'unreadable (normal)';
}

/* 3. The pointer moves where it is told, and macOS agrees. */
const before = input.pointerPosition();
const targets = [
  { x: Math.round(input.width * 0.25), y: Math.round(input.height * 0.25) },
  { x: Math.round(input.width * 0.75), y: Math.round(input.height * 0.6) },
  { x: 10, y: 10 },
];
let moveOk = true;
let moveDetail = '';
for (const target of targets) {
  input.movePointer(target.x, target.y);
  await delay(120);
  const now = input.pointerPosition();
  const close = Math.abs(now.x - target.x) <= 2 && Math.abs(now.y - target.y) <= 2;
  if (!close) {
    moveOk = false;
    moveDetail = `asked for ${target.x},${target.y} and macOS reports ${now.x},${now.y}`;
    break;
  }
}
record('move the pointer (this is also the Accessibility check)', moveOk,
  moveOk ? `pointer followed all ${targets.length} positions` : `${moveDetail}; Accessibility permission: ${accessibility}`);

/* 4. Clamping, so a viewer with a bigger screen cannot push the pointer off. */
input.movePointer(-500, -500);
await delay(100);
const clamped = input.pointerPosition();
record('clamp a position outside the screen', clamped.x <= 2 && clamped.y <= 2, `${clamped.x},${clamped.y}`);

/* 5. Buttons and scrolling: these cannot be read back, so they are reported as
      "posted without error" — watch the screen to see them. */
try {
  input.movePointer(Math.round(input.width / 2), Math.round(input.height / 2));
  input.button(1, true);
  await delay(60);
  input.button(1, false);
  input.wheel(0, 2);
  input.wheel(0, -2);
  record('post a click and a scroll', true, 'no error; watch the screen to confirm they landed');
} catch (err) {
  record('post a click and a scroll', false, err.message);
}

/* 6. Typing, which needs a focused text field to be visible. */
if (typing) {
  try {
    const text = 'HopDesk ok 123 é ش';
    for (const character of text) {
      const keysym = character.codePointAt(0) <= 0xff ? character.codePointAt(0) : 0x01000000 + character.codePointAt(0);
      const plan = planFor(character === ' ' ? 0x0020 : keysym);
      if (plan.kind === 'ignore') continue;
      input.key(character === ' ' ? 0x0020 : keysym, true);
      await delay(20);
      input.key(character === ' ' ? 0x0020 : keysym, false);
      await delay(20);
    }
    input.key(0xff0d, true); input.key(0xff0d, false);          // Return
    record('type text into the focused window', true, `sent "${text}" — check it appeared`);
  } catch (err) {
    record('type text into the focused window', false, err.message);
  }

  /* 7. A shortcut: Command+A selects all in that same window. */
  try {
    input.key(0xffeb, true);        // Super_L → Command
    input.key(0x61, true);          // a
    await delay(40);
    input.key(0x61, false);
    input.key(0xffeb, false);
    record('send Command+A', true, 'check the text became selected');
  } catch (err) {
    record('send Command+A', false, err.message);
  }
} else {
  record('type text into the focused window', 'skip', '--no-typing');
  record('send Command+A', 'skip', '--no-typing');
}

/* 8. Nothing is left held down. */
input.releaseAll();
record('release everything held', input.heldFlags() === 0, `flags ${input.heldFlags()}`);
input.movePointer(before.x, before.y);
input.close();

const failed = results.filter(r => r.ok === false);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.stdout.write('\nIf the pointer did not move, macOS has not granted Accessibility to the program\n'
    + 'running this script (Terminal, or HopDesk itself): System Settings → Privacy & Security →\n'
    + 'Accessibility. Events are dropped silently without it.\n');
}
process.exit(failed.length ? 1 : 0);
