import koffi from 'koffi';
import type { InputController, PointerButton } from '../interfaces.js';

/**
 * Input injection on X11, through the XTEST extension — the same mechanism
 * x11vnc, xdotool and every other remote desktop on X11 uses. Bound with koffi
 * so there is no compiled addon to build per distribution or per Electron ABI.
 *
 * Nothing here is clever: it is a faithful wrapper around XTestFakeMotionEvent,
 * XTestFakeButtonEvent and XTestFakeKeyEvent, plus the one genuinely awkward
 * part — a keysym that the current layout has no key for (any non-Latin
 * character, an emoji) has to be put onto a spare keycode first, pressed, and
 * taken off again.
 */

/**
 * The X11 libraries, loaded on first use rather than at import.
 *
 * This module is imported wherever `@hopdesk/platform` is, including on
 * machines that have no X11 at all — a Mac, or a Linux box without the
 * libraries installed. Loading at import time would turn that into a crash
 * before the application could say anything useful.
 */
interface X11Bindings {
  XOpenDisplay: (name: string | null) => unknown;
  XCloseDisplay: (dpy: unknown) => number;
  XFlush: (dpy: unknown) => number;
  XSync: (dpy: unknown, discard: number) => number;
  XDefaultScreen: (dpy: unknown) => number;
  XDisplayWidth: (dpy: unknown, screen: number) => number;
  XDisplayHeight: (dpy: unknown, screen: number) => number;
  XRootWindow: (dpy: unknown, screen: number) => number;
  XQueryPointer: (...args: unknown[]) => number;
  XQueryKeymap: (dpy: unknown, keys: Buffer) => number;
  XKeysymToKeycode: (dpy: unknown, keysym: number) => number;
  XDisplayKeycodes: (dpy: unknown, min: number[], max: number[]) => number;
  XGetKeyboardMapping: (dpy: unknown, first: number, count: number, per: number[]) => unknown;
  XChangeKeyboardMapping: (dpy: unknown, first: number, per: number, keysyms: number[], count: number) => number;
  XFreeRaw: (data: unknown) => number;
  XTestQueryExtension: (...args: unknown[]) => number;
  XTestFakeMotionEvent: (dpy: unknown, screen: number, x: number, y: number, delay: number) => number;
  XTestFakeButtonEvent: (dpy: unknown, button: number, isPress: number, delay: number) => number;
  XTestFakeKeyEvent: (dpy: unknown, keycode: number, isPress: number, delay: number) => number;
}

let bindings: X11Bindings | null = null;

function x11(): X11Bindings {
  if (bindings) return bindings;
  let X11: ReturnType<typeof koffi.load>;
  let Xtst: ReturnType<typeof koffi.load>;
  try {
    X11 = koffi.load('libX11.so.6');
    Xtst = koffi.load('libXtst.so.6');
  } catch (err) {
    throw new X11Unavailable(
      `Could not load the X11 libraries (${(err as Error).message}). `
      + 'On Linux, install libx11-6 and libxtst6.');
  }
  // Registering the same opaque type twice throws; harmless if it already exists.
  try { koffi.opaque('Display'); } catch { /* already registered */ }

  bindings = {
    XOpenDisplay: X11.func('Display *XOpenDisplay(const char *name)') as X11Bindings['XOpenDisplay'],
    XCloseDisplay: X11.func('int XCloseDisplay(Display *dpy)') as X11Bindings['XCloseDisplay'],
    XFlush: X11.func('int XFlush(Display *dpy)') as X11Bindings['XFlush'],
    XSync: X11.func('int XSync(Display *dpy, int discard)') as X11Bindings['XSync'],
    XDefaultScreen: X11.func('int XDefaultScreen(Display *dpy)') as X11Bindings['XDefaultScreen'],
    XDisplayWidth: X11.func('int XDisplayWidth(Display *dpy, int screen)') as X11Bindings['XDisplayWidth'],
    XDisplayHeight: X11.func('int XDisplayHeight(Display *dpy, int screen)') as X11Bindings['XDisplayHeight'],
    XRootWindow: X11.func('unsigned long XRootWindow(Display *dpy, int screen)') as X11Bindings['XRootWindow'],
    XQueryPointer: X11.func('int XQueryPointer(Display *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rx, _Out_ int *ry, _Out_ int *wx, _Out_ int *wy, _Out_ unsigned int *mask)') as X11Bindings['XQueryPointer'],
    XQueryKeymap: X11.func('int XQueryKeymap(Display *dpy, _Out_ char *keys)') as X11Bindings['XQueryKeymap'],
    XKeysymToKeycode: X11.func('unsigned char XKeysymToKeycode(Display *dpy, unsigned long keysym)') as X11Bindings['XKeysymToKeycode'],
    XDisplayKeycodes: X11.func('int XDisplayKeycodes(Display *dpy, _Out_ int *min, _Out_ int *max)') as X11Bindings['XDisplayKeycodes'],
    XGetKeyboardMapping: X11.func('unsigned long *XGetKeyboardMapping(Display *dpy, unsigned char first, int count, _Out_ int *per)') as X11Bindings['XGetKeyboardMapping'],
    XChangeKeyboardMapping: X11.func('int XChangeKeyboardMapping(Display *dpy, int first, int per, unsigned long *keysyms, int count)') as X11Bindings['XChangeKeyboardMapping'],
    XFreeRaw: X11.func('int XFree(void *data)') as X11Bindings['XFreeRaw'],
    XTestQueryExtension: Xtst.func('int XTestQueryExtension(Display *dpy, _Out_ int *ev, _Out_ int *err, _Out_ int *major, _Out_ int *minor)') as X11Bindings['XTestQueryExtension'],
    XTestFakeMotionEvent: Xtst.func('int XTestFakeMotionEvent(Display *dpy, int screen, int x, int y, unsigned long delay)') as X11Bindings['XTestFakeMotionEvent'],
    XTestFakeButtonEvent: Xtst.func('int XTestFakeButtonEvent(Display *dpy, unsigned int button, int is_press, unsigned long delay)') as X11Bindings['XTestFakeButtonEvent'],
    XTestFakeKeyEvent: Xtst.func('int XTestFakeKeyEvent(Display *dpy, unsigned int keycode, int is_press, unsigned long delay)') as X11Bindings['XTestFakeKeyEvent'],
  };
  return bindings;
}

/* Thin wrappers, so the rest of the file reads as if the library were linked. */
const XOpenDisplay = (name: string | null) => x11().XOpenDisplay(name);
const XCloseDisplay = (dpy: unknown) => x11().XCloseDisplay(dpy);
const XFlush = (dpy: unknown) => x11().XFlush(dpy);
const XSync = (dpy: unknown, discard: number) => x11().XSync(dpy, discard);
const XDefaultScreen = (dpy: unknown) => x11().XDefaultScreen(dpy);
const XDisplayWidth = (dpy: unknown, screen: number) => x11().XDisplayWidth(dpy, screen);
const XDisplayHeight = (dpy: unknown, screen: number) => x11().XDisplayHeight(dpy, screen);
const XRootWindow = (dpy: unknown, screen: number) => x11().XRootWindow(dpy, screen);
const XQueryPointer = (...args: unknown[]) => x11().XQueryPointer(...args);
const XQueryKeymap = (dpy: unknown, keys: Buffer) => x11().XQueryKeymap(dpy, keys);
const XKeysymToKeycode = (dpy: unknown, keysym: number) => x11().XKeysymToKeycode(dpy, keysym);
const XDisplayKeycodes = (dpy: unknown, min: number[], max: number[]) => x11().XDisplayKeycodes(dpy, min, max);
const XGetKeyboardMapping = (dpy: unknown, first: number, count: number, per: number[]) => x11().XGetKeyboardMapping(dpy, first, count, per);
const XChangeKeyboardMapping = (dpy: unknown, first: number, per: number, keysyms: number[], count: number) => x11().XChangeKeyboardMapping(dpy, first, per, keysyms, count);
const XFreeRaw = (data: unknown) => x11().XFreeRaw(data);
const XTestQueryExtension = (...args: unknown[]) => x11().XTestQueryExtension(...args);
const XTestFakeMotionEvent = (dpy: unknown, screen: number, x: number, y: number, delay: number) => x11().XTestFakeMotionEvent(dpy, screen, x, y, delay);
const XTestFakeButtonEvent = (dpy: unknown, button: number, isPress: number, delay: number) => x11().XTestFakeButtonEvent(dpy, button, isPress, delay);
const XTestFakeKeyEvent = (dpy: unknown, keycode: number, isPress: number, delay: number) => x11().XTestFakeKeyEvent(dpy, keycode, isPress, delay);

/**
 * Keysyms come back as 64-bit values, which koffi decodes into a BigUint64Array.
 * Keysyms themselves never exceed 32 bits, so they are converted to numbers —
 * comparing a bigint against a number silently never matches, which is worth
 * one line of conversion to avoid.
 */
function decodeKeysyms(pointer: unknown, count: number): number[] {
  const raw = koffi.decode(pointer, koffi.array('unsigned long', count)) as ArrayLike<bigint | number>;
  return Array.from(raw, v => Number(v));
}

/** How many keycodes may be borrowed at once for keysyms the layout lacks. */
const POOL_SIZE = 4;

/** X11 wheel buttons: 4 up, 5 down, 6 left, 7 right. */
const WHEEL = { up: 4, down: 5, left: 6, right: 7 } as const;

export class X11Unavailable extends Error {}

export interface X11InputOptions {
  /** Display name, e.g. ":0" or ":31". Defaults to $DISPLAY. */
  display?: string;
  /** Largest number of wheel clicks honoured per message, so a hostile or
   *  broken viewer cannot make the host spin for minutes. */
  maxWheelClicks?: number;
}

export class X11Input implements InputController {
  private readonly dpy: unknown;
  private readonly screen: number;
  private readonly root: number;
  private readonly heldKeys = new Set<number>();          // keycodes
  private readonly heldButtons = new Set<number>();
  private readonly maxWheelClicks: number;
  /**
   * Keycodes borrowed for keysyms the layout has no key for. A pool rather
   * than one, so two such keys can be held at the same time.
   */
  private readonly pool: { keycode: number; keysym: number; held: boolean; release?: NodeJS.Timeout }[] = [];
  private poolReady = false;
  private keysymsPerKeycode = 0;
  private closed = false;

  readonly width: number;
  readonly height: number;

  constructor(opts: X11InputOptions = {}) {
    const name = opts.display ?? process.env.DISPLAY ?? null;
    this.maxWheelClicks = opts.maxWheelClicks ?? 10;
    const dpy = XOpenDisplay(name);
    if (!dpy) throw new X11Unavailable(`Cannot open the X display ${name ?? '(unset $DISPLAY)'}`);
    this.dpy = dpy;

    const probe = [0, 0, 0, 0] as number[];
    if (!XTestQueryExtension(dpy, probe, probe, probe, probe)) {
      XCloseDisplay(dpy);
      throw new X11Unavailable('This X server does not provide the XTEST extension, so input cannot be injected');
    }
    this.screen = XDefaultScreen(dpy);
    this.root = XRootWindow(dpy, this.screen);
    this.width = XDisplayWidth(dpy, this.screen);
    this.height = XDisplayHeight(dpy, this.screen);
  }

  private assertOpen() {
    if (this.closed) throw new Error('This input controller is closed');
  }

  movePointer(x: number, y: number) {
    this.assertOpen();
    // Clamped rather than rejected: a viewer at a different size should not be
    // able to move the pointer off screen, and rounding must not throw.
    const cx = Math.min(this.width - 1, Math.max(0, Math.round(x)));
    const cy = Math.min(this.height - 1, Math.max(0, Math.round(y)));
    XTestFakeMotionEvent(this.dpy, this.screen, cx, cy, 0);
    XFlush(this.dpy);
  }

  button(button: PointerButton, down: boolean) {
    this.assertOpen();
    if (button !== 1 && button !== 2 && button !== 3) return;
    XTestFakeButtonEvent(this.dpy, button, down ? 1 : 0, 0);
    if (down) this.heldButtons.add(button); else this.heldButtons.delete(button);
    XFlush(this.dpy);
  }

  wheel(dx: number, dy: number) {
    this.assertOpen();
    const clicks = (v: number) => Math.min(this.maxWheelClicks, Math.abs(Math.round(v)));
    for (let i = 0; i < clicks(dy); i++) this.clickWheel(dy > 0 ? WHEEL.down : WHEEL.up);
    for (let i = 0; i < clicks(dx); i++) this.clickWheel(dx > 0 ? WHEEL.right : WHEEL.left);
    XFlush(this.dpy);
  }

  private clickWheel(button: number) {
    XTestFakeButtonEvent(this.dpy, button, 1, 0);
    XTestFakeButtonEvent(this.dpy, button, 0, 0);
  }

  key(keysym: number, down: boolean) {
    this.assertOpen();
    if (!Number.isInteger(keysym) || keysym <= 0 || keysym > 0x1fffffff) return;

    /* A keysym already on a borrowed keycode is checked first. Once a keycode
       has been remapped, Xlib's own lookup starts reporting it, and taking
       that path on the release would leave the keycode borrowed forever. */
    this.fillPool();
    const borrowed = this.pool.find(slot => slot.keysym === keysym);
    if (borrowed) { this.pressBorrowed(borrowed, down); return; }

    const existing = XKeysymToKeycode(this.dpy, keysym) as number;
    if (existing) { this.pressKeycode(existing, down); return; }

    // Nothing on this layout produces it: any non-Latin character or emoji.
    if (!down) return;                        // a release of a key never pressed
    const free = this.pool.find(slot => !slot.held && slot.keysym === 0) ?? this.freeLeastRecent();
    if (!free) return;                        // every borrowed keycode is in use
    clearTimeout(free.release);
    this.mapKeycode(free.keycode, keysym);
    free.keysym = keysym;
    this.pressBorrowed(free, true);
  }

  /** The longest-idle borrowed keycode, reclaimed when the pool is full. */
  private freeLeastRecent() {
    this.fillPool();
    const idle = this.pool.filter(slot => !slot.held);
    return idle.length ? idle[0]! : undefined;
  }

  private pressBorrowed(slot: { keycode: number; keysym: number; held: boolean; release?: NodeJS.Timeout }, down: boolean) {
    this.pressKeycode(slot.keycode, down);
    slot.held = down;
    clearTimeout(slot.release);
    if (down) return;
    /* The mapping is kept for a moment after the release: applications learn of
       a new mapping from a MappingNotify event, and one that has not processed
       it yet would read a stale keysym from the key event. It also avoids
       remapping on every keystroke while someone types in one script. */
    slot.release = setTimeout(() => {
      if (this.closed || slot.held) return;
      this.mapKeycode(slot.keycode, 0);
      slot.keysym = 0;
    }, 250);
    slot.release.unref?.();
  }

  private pressKeycode(keycode: number, down: boolean) {
    XTestFakeKeyEvent(this.dpy, keycode, down ? 1 : 0, 0);
    if (down) this.heldKeys.add(keycode); else this.heldKeys.delete(keycode);
    XFlush(this.dpy);
  }

  /** Finds keycodes the current layout leaves completely unused. */
  private fillPool() {
    if (this.poolReady) return;
    this.poolReady = true;
    const min = [0], max = [0], per = [0];
    XDisplayKeycodes(this.dpy, min, max);
    const first = min[0]!, count = max[0]! - min[0]! + 1;
    if (count <= 0) return;
    const mapping = XGetKeyboardMapping(this.dpy, first, count, per);
    if (!mapping) return;
    this.keysymsPerKeycode = per[0]!;
    try {
      const syms = decodeKeysyms(mapping, count * this.keysymsPerKeycode);
      for (let i = 0; i < count && this.pool.length < POOL_SIZE; i++) {
        const row = syms.slice(i * this.keysymsPerKeycode, (i + 1) * this.keysymsPerKeycode);
        if (row.every(sym => sym === 0)) this.pool.push({ keycode: first + i, keysym: 0, held: false });
      }
    } finally {
      XFreeRaw(mapping);
    }
  }

  private mapKeycode(keycode: number, keysym: number) {
    const row = new Array<number>(Math.max(1, this.keysymsPerKeycode)).fill(keysym);
    XChangeKeyboardMapping(this.dpy, keycode, row.length, row, 1);
    // The server must have the new mapping before the key is pressed.
    XSync(this.dpy, 0);
  }

  /**
   * The keysyms the X server currently has on a keycode. Read from the server
   * rather than Xlib's cache, which only refreshes when a client processes the
   * MappingNotify event — the reason `keycodeFor` cannot see a fresh mapping.
   */
  serverKeysyms(keycode: number): number[] {
    this.assertOpen();
    const per = [0];
    const mapping = XGetKeyboardMapping(this.dpy, keycode, 1, per);
    if (!mapping) return [];
    try {
      return decodeKeysyms(mapping, per[0]!);
    } finally {
      XFreeRaw(mapping);
    }
  }

  /** Keycodes currently lent to keysyms the layout lacks. For tests. */
  borrowedKeycodes(): { keycode: number; keysym: number; held: boolean }[] {
    return this.pool.filter(s => s.keysym !== 0).map(({ keycode, keysym, held }) => ({ keycode, keysym, held }));
  }

  releaseAll() {
    if (this.closed) return;
    for (const keycode of [...this.heldKeys]) this.pressKeycode(keycode, false);
    for (const button of [...this.heldButtons]) {
      XTestFakeButtonEvent(this.dpy, button, 0, 0);
      this.heldButtons.delete(button);
    }
    for (const slot of this.pool) {
      clearTimeout(slot.release);
      slot.held = false;
      if (slot.keysym !== 0) { this.mapKeycode(slot.keycode, 0); slot.keysym = 0; }
    }
    XFlush(this.dpy);
  }

  pointerPosition(): { x: number; y: number } {
    this.assertOpen();
    const root = [0], child = [0], rx = [0], ry = [0], wx = [0], wy = [0], mask = [0];
    XQueryPointer(this.dpy, this.root, root, child, rx, ry, wx, wy, mask);
    return { x: rx[0]!, y: ry[0]! };
  }

  /** Button mask as X11 reports it (bit 8 = button 1). For tests and diagnostics. */
  pointerButtons(): number {
    this.assertOpen();
    const root = [0], child = [0], rx = [0], ry = [0], wx = [0], wy = [0], mask = [0];
    XQueryPointer(this.dpy, this.root, root, child, rx, ry, wx, wy, mask);
    return mask[0]!;
  }

  /** Whether the X server currently sees this keycode held down. */
  keycodeHeld(keycode: number): boolean {
    this.assertOpen();
    const keys = Buffer.alloc(32);
    XQueryKeymap(this.dpy, keys);
    return (keys[keycode >> 3]! & (1 << (keycode & 7))) !== 0;
  }

  keycodeFor(keysym: number): number {
    this.assertOpen();
    return XKeysymToKeycode(this.dpy, keysym) as number;
  }

  close() {
    if (this.closed) return;
    // A session must never leave keys or buttons stuck on the host.
    this.releaseAll();
    this.closed = true;
    XCloseDisplay(this.dpy);
  }
}

