import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import koffi from 'koffi';
import { X11Input, X11Unavailable } from '../dist/index.js';

/**
 * Proof that injected input arrives at an application, not merely in the X
 * server's own state: `xev` reports the key presses and the mouse buttons it
 * receives, including for a keysym the layout has no key for.
 */

const display = process.env.HOPDESK_X11_DISPLAY ?? ':31';

/**
 * A suite that quietly skips proves nothing. HOPDESK_REQUIRE_DISPLAY=1 — which
 * the full-suite runs and CI set — turns "nothing to test on here" into a
 * failure instead of a silent pass.
 */
function refuseToSkip(reason) {
  if (reason && process.env.HOPDESK_REQUIRE_DISPLAY === '1') {
    throw new Error(`${reason} — and HOPDESK_REQUIRE_DISPLAY=1 says these tests must run`);
  }
  return reason;
}

let skip = false;
try { new X11Input({ display }).close(); } catch (err) {
  if (err instanceof X11Unavailable) skip = refuseToSkip(`no usable X display at ${display}`);
  else throw err;
}

/** Focus must be moved to the test window; XTest keys go to the focused window. */
const X11 = koffi.load('libX11.so.6');
// koffi type names are global, and the platform module already registered
// "Display", so the handle is just an opaque pointer here.
const XOpenDisplay = X11.func('void *XOpenDisplay(const char *name)');
const XCloseDisplay = X11.func('int XCloseDisplay(void *dpy)');
const XSetInputFocus = X11.func('int XSetInputFocus(void *dpy, unsigned long w, int revert_to, unsigned long time)');
const XSync = X11.func('int XSync(void *dpy, int discard)');

function startXev() {
  const child = spawn('xev', { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  return {
    child,
    get output() { return out; },
    async window() {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const m = /Outer window is (0x[0-9a-f]+)/.exec(out);
        if (m) return Number(m[1]);
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`xev never reported its window: ${out.slice(0, 300)}`);
    },
    async waitFor(pattern, what) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (pattern.test(out)) return true;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error(`xev never reported ${what}. Output:\n${out.slice(-1500)}`);
    },
  };
}

test('keys and buttons injected by the host arrive in a real application', { skip, timeout: 60_000 }, async () => {
  const xev = startXev();
  const dpy = XOpenDisplay(display);
  const input = new X11Input({ display });
  try {
    const window = await xev.window();
    XSetInputFocus(dpy, window, 2 /* RevertToParent */, 0 /* CurrentTime */);
    XSync(dpy, 0);

    /* A key the layout has: xev names the keysym it received. */
    input.key(0xff0d, true);                      // Return
    input.key(0xff0d, false);
    await xev.waitFor(/KeyPress[\s\S]*?keysym 0xff0d, Return/, 'the Return key');

    input.key(0x61, true);                        // "a"
    input.key(0x61, false);
    await xev.waitFor(/keysym 0x61, a/, 'the letter a');

    /* A keysym with no key on this layout: Arabic sheen, on a borrowed keycode.
       This is the case that only works if the remap reached the application. */
    input.key(0x01000634, true);
    input.key(0x01000634, false);
    // xev names Unicode keysyms U<hex>; what matters is the character it decodes to.
    await xev.waitFor(/keysym 0x1000634[\s\S]*?XLookupString gives 2 bytes: \(d8 b4\) "ش"/, 'Arabic sheen as a character');

    /* A mouse click inside the window: xev reports ButtonPress and ButtonRelease. */
    const geometry = /-geometry (\d+)x(\d+)\+(\d+)\+(\d+)/.exec(xev.output);
    const x = geometry ? Number(geometry[3]) + 20 : 30;
    const y = geometry ? Number(geometry[4]) + 20 : 30;
    input.movePointer(x, y);
    input.button(1, true);
    input.button(1, false);
    await xev.waitFor(/ButtonPress event[\s\S]*?button 1/, 'a left button press');
    await xev.waitFor(/ButtonRelease event[\s\S]*?button 1/, 'a left button release');
  } finally {
    input.close();
    XCloseDisplay(dpy);
    xev.child.kill('SIGKILL');
  }
});
