/**
 * Checks HopDesk's Wayland input backend on a real Wayland session.
 *
 *     npm run build
 *     node scripts/verify-wayland.mjs
 *
 * Wayland does not let any program control the machine without the
 * compositor's permission, so this shows the desktop's own dialog and waits for
 * you to allow it — nothing here can, or should, click it for you.
 *
 * It then moves the pointer, scrolls, and types into whatever window has focus.
 * Open an empty text editor and click into it first, or pass --no-typing.
 * Nothing is simulated: every step reports what the portal actually did.
 */
import { setTimeout as delay } from 'node:timers/promises';

const typing = !process.argv.includes('--no-typing');
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  process.stdout.write(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

if (process.platform !== 'linux') {
  process.stdout.write(`This script is for a Linux Wayland session; this is ${process.platform}.\n`);
  process.exit(2);
}

const { probePortal, WaylandInput, linuxBackend } = await import('../packages/platform/dist/index.js');

record(`this is a ${process.env.XDG_SESSION_TYPE ?? 'unknown'} session`,
  process.env.XDG_SESSION_TYPE === 'wayland',
  process.env.XDG_SESSION_TYPE === 'wayland' ? `backend: ${linuxBackend()}` : 'log in to a Wayland session to check this');

/* 1. Everything the portal allows without asking anyone. */
const probe = await probePortal();
record('the desktop portal accepts a remote control session', probe.available === true,
  probe.available ? `RemoteDesktop v${probe.version}, sessions ${probe.persistSupported ? 'can' : 'cannot'} be remembered` : probe.reason);
if (!probe.available) process.exit(1);

/* 2. The dialog. This is the permission itself. */
process.stdout.write('\n→ Your desktop will now ask whether to allow remote control, and which screen to share.\n'
  + '  Choose a screen and allow it. Waiting up to two minutes…\n\n');

let input;
try {
  input = await WaylandInput.create({ promptTimeoutMs: 120_000 });
  record('you allowed the session', true, `sharing a ${input.width}x${input.height} stream (node ${input.streamNode})`);
} catch (err) {
  record('you allowed the session', false, err.message);
  process.stdout.write('\nIf you clicked Cancel, that is the correct behaviour: HopDesk cannot control\n'
    + 'a Wayland desktop without it. Run it again and allow the session to check the rest.\n');
  process.exit(1);
}

/* 3. The pointer. Wayland lets nothing read the pointer position, so watch it. */
try {
  for (const [x, y] of [[0.2, 0.2], [0.8, 0.5], [0.5, 0.8]]) {
    input.movePointer(input.width * x, input.height * y);
    await delay(400);
  }
  record('move the pointer', true, 'watch the screen: it should have moved three times');
} catch (err) {
  record('move the pointer', false, err.message);
}

/* 4. Scrolling, and a click that lands where nothing happens. */
try {
  input.wheel(0, 3);
  await delay(200);
  input.wheel(0, -3);
  record('scroll', true, 'a scrollable window under the pointer should have moved');
} catch (err) {
  record('scroll', false, err.message);
}

/* 5. Typing. The portal takes keysyms directly, so no layout table is involved. */
if (typing) {
  try {
    const text = 'HopDesk wayland ok 123 é ش';
    for (const character of text) {
      const point = character.codePointAt(0);
      const keysym = character === ' ' ? 0x0020 : point <= 0xff ? point : 0x01000000 + point;
      input.key(keysym, true);
      await delay(25);
      input.key(keysym, false);
      await delay(25);
    }
    record('type into the focused window', true, `sent "${text}" — check it appeared`);
  } catch (err) {
    record('type into the focused window', false, err.message);
  }
} else {
  record('type into the focused window', 'skip', '--no-typing');
}

/* 6. Nothing left held, and the session handed back. */
input.releaseAll();
input.close();
record('release everything and hand the session back', true, 'the desktop should stop showing "screen is being shared"');

const failed = results.filter(r => r.ok === false);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.stdout.write('What this cannot check by itself: whether the pointer and the text really appeared.\n'
  + 'Say what you saw — that is the part of the test only you can run.\n');
process.exit(failed.length ? 1 : 0);
