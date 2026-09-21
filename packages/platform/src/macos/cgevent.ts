import koffi from 'koffi';
import type { InputController, PointerButton } from '../interfaces.js';
import { MAC_FLAGS, planFor } from './keycodes.js';

/**
 * Input injection on macOS, through Quartz events (CGEvent) — the same
 * mechanism every remote desktop and accessibility tool on the platform uses.
 * Bound with koffi, so there is no native module to compile or notarise
 * separately.
 *
 * Two things are specific to macOS and worth stating:
 *
 * **Permission.** Posting events requires the Accessibility permission in
 * System Settings → Privacy & Security. Without it the calls quietly do
 * nothing — no error, no event — so the Host checks first (see the desktop
 * app's permission manager) rather than looking like it is working.
 *
 * **Keyboard layout.** A virtual key code means a position on the keyboard, not
 * a character, so sending the code for "A" types whatever that position
 * produces on the Mac's own layout. Named keys go by key code; everything
 * printable is injected as text, which is layout independent.
 */

const CORE_GRAPHICS = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics';
const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation';

/** CGEventType values used here. */
const EVENT = {
  mouseMoved: 5,
  leftDown: 1, leftUp: 2, leftDragged: 6,
  rightDown: 3, rightUp: 4, rightDragged: 7,
  otherDown: 25, otherUp: 26, otherDragged: 27,
  scrollWheel: 22,
} as const;

/** kCGHIDEventTap: events enter as if they came from the hardware. */
const HID_EVENT_TAP = 0;
/** kCGScrollEventUnitLine. */
const SCROLL_UNIT_LINE = 1;

export class MacOsUnavailable extends Error {}

interface Bindings {
  CGEventCreateMouseEvent: (source: unknown, type: number, point: { x: number; y: number }, button: number) => unknown;
  CGEventCreateKeyboardEvent: (source: unknown, keyCode: number, keyDown: boolean) => unknown;
  CGEventCreateScrollWheelEvent: (...args: unknown[]) => unknown;
  CGEventCreate: (source: unknown) => unknown;
  CGEventGetLocation: (event: unknown) => { x: number; y: number };
  CGEventPost: (tap: number, event: unknown) => void;
  CGEventSetFlags: (event: unknown, flags: number) => void;
  CGEventKeyboardSetUnicodeString: (event: unknown, length: number, text: Uint16Array) => void;
  CGMainDisplayID: () => number;
  /** macOS 10.15+: is screen recording allowed? Never prompts. */
  CGPreflightScreenCaptureAccess: () => boolean;
  /** macOS 10.15+: shows Apple's own prompt, once, and lists the app in Settings. */
  CGRequestScreenCaptureAccess: () => boolean;
  CGDisplayPixelsWide: (display: number) => number;
  CGDisplayPixelsHigh: (display: number) => number;
  CFRelease: (ref: unknown) => void;
}

let cached: Bindings | null = null;

/** Loads Quartz once. Throws with a clear reason anywhere but macOS. */
export function loadQuartz(): Bindings {
  if (cached) return cached;
  if (process.platform !== 'darwin') {
    throw new MacOsUnavailable(`Quartz events are only available on macOS (this is ${process.platform})`);
  }
  let cg: ReturnType<typeof koffi.load>;
  let cf: ReturnType<typeof koffi.load>;
  try {
    cg = koffi.load(CORE_GRAPHICS);
    cf = koffi.load(CORE_FOUNDATION);
  } catch (err) {
    throw new MacOsUnavailable(`Could not load CoreGraphics: ${(err as Error).message}`);
  }

  // CGPoint is two doubles, passed and returned by value.
  const CGPoint = koffi.struct('HopDeskCGPoint', { x: 'double', y: 'double' });

  cached = {
    CGEventCreateMouseEvent: cg.func('void *CGEventCreateMouseEvent(void *source, uint32_t type, HopDeskCGPoint point, uint32_t button)') as Bindings['CGEventCreateMouseEvent'],
    CGEventCreateKeyboardEvent: cg.func('void *CGEventCreateKeyboardEvent(void *source, uint16_t keyCode, bool keyDown)') as Bindings['CGEventCreateKeyboardEvent'],
    // Variadic: the wheel deltas follow the count.
    CGEventCreateScrollWheelEvent: cg.func('void *CGEventCreateScrollWheelEvent(void *source, uint32_t units, uint32_t wheelCount, ...)') as Bindings['CGEventCreateScrollWheelEvent'],
    CGEventCreate: cg.func('void *CGEventCreate(void *source)') as Bindings['CGEventCreate'],
    CGEventGetLocation: cg.func('HopDeskCGPoint CGEventGetLocation(void *event)') as Bindings['CGEventGetLocation'],
    CGEventPost: cg.func('void CGEventPost(uint32_t tap, void *event)') as Bindings['CGEventPost'],
    CGEventSetFlags: cg.func('void CGEventSetFlags(void *event, uint64_t flags)') as Bindings['CGEventSetFlags'],
    CGEventKeyboardSetUnicodeString: cg.func('void CGEventKeyboardSetUnicodeString(void *event, uint32_t length, uint16_t *string)') as Bindings['CGEventKeyboardSetUnicodeString'],
    CGMainDisplayID: cg.func('uint32_t CGMainDisplayID()') as Bindings['CGMainDisplayID'],
    CGPreflightScreenCaptureAccess: cg.func('bool CGPreflightScreenCaptureAccess()') as Bindings['CGPreflightScreenCaptureAccess'],
    CGRequestScreenCaptureAccess: cg.func('bool CGRequestScreenCaptureAccess()') as Bindings['CGRequestScreenCaptureAccess'],
    CGDisplayPixelsWide: cg.func('size_t CGDisplayPixelsWide(uint32_t display)') as Bindings['CGDisplayPixelsWide'],
    CGDisplayPixelsHigh: cg.func('size_t CGDisplayPixelsHigh(uint32_t display)') as Bindings['CGDisplayPixelsHigh'],
    CFRelease: cf.func('void CFRelease(void *ref)') as Bindings['CFRelease'],
  };
  void CGPoint;
  return cached;
}

export interface MacInputOptions {
  /** Largest number of wheel clicks honoured per message. */
  maxWheelClicks?: number;
}

export class MacInput implements InputController {
  private readonly q: Bindings;
  private readonly heldButtons = new Set<PointerButton>();
  private readonly heldKeys = new Map<number, number>();     // keysym → key code
  private flags = 0;
  private readonly maxWheelClicks: number;
  private closed = false;
  private last = { x: 0, y: 0 };

  readonly width: number;
  readonly height: number;

  constructor(opts: MacInputOptions = {}) {
    this.q = loadQuartz();
    this.maxWheelClicks = opts.maxWheelClicks ?? 10;
    const display = this.q.CGMainDisplayID();
    this.width = Number(this.q.CGDisplayPixelsWide(display)) || 1;
    this.height = Number(this.q.CGDisplayPixelsHigh(display)) || 1;
    this.last = this.pointerPosition();
  }

  private assertOpen() {
    if (this.closed) throw new Error('This input controller is closed');
  }

  /** Posts an event and releases it: CGEvent objects are reference counted. */
  private post(event: unknown, withFlags = true) {
    if (!event) return;
    try {
      if (withFlags && this.flags) this.q.CGEventSetFlags(event, this.flags);
      this.q.CGEventPost(HID_EVENT_TAP, event);
    } finally {
      this.q.CFRelease(event);
    }
  }

  movePointer(x: number, y: number) {
    this.assertOpen();
    const point = {
      x: Math.min(this.width - 1, Math.max(0, Math.round(x))),
      y: Math.min(this.height - 1, Math.max(0, Math.round(y))),
    };
    this.last = point;
    /* A move while a button is down has to be a drag, or macOS applications do
       not see it as one and text selection and window dragging do not work. */
    const dragging = this.heldButtons.has(1) ? EVENT.leftDragged
      : this.heldButtons.has(3) ? EVENT.rightDragged
        : this.heldButtons.has(2) ? EVENT.otherDragged
          : EVENT.mouseMoved;
    const button = dragging === EVENT.rightDragged ? 1 : dragging === EVENT.otherDragged ? 2 : 0;
    this.post(this.q.CGEventCreateMouseEvent(null, dragging, point, button));
  }

  button(button: PointerButton, down: boolean) {
    this.assertOpen();
    const type = button === 1 ? (down ? EVENT.leftDown : EVENT.leftUp)
      : button === 3 ? (down ? EVENT.rightDown : EVENT.rightUp)
        : button === 2 ? (down ? EVENT.otherDown : EVENT.otherUp)
          : null;
    if (type === null) return;
    const macButton = button === 1 ? 0 : button === 3 ? 1 : 2;
    if (down) this.heldButtons.add(button); else this.heldButtons.delete(button);
    this.post(this.q.CGEventCreateMouseEvent(null, type, this.last, macButton));
  }

  wheel(dx: number, dy: number) {
    this.assertOpen();
    const clamp = (v: number) => Math.max(-this.maxWheelClicks, Math.min(this.maxWheelClicks, Math.round(v)));
    const vertical = clamp(dy);
    const horizontal = clamp(dx);
    if (!vertical && !horizontal) return;
    /* Quartz counts a positive first wheel as scrolling up, and HopDesk's
       protocol counts positive dy as scrolling down, so the sign flips. */
    const event = this.q.CGEventCreateScrollWheelEvent(
      null, SCROLL_UNIT_LINE, 2,
      'int32_t', -vertical,
      'int32_t', -horizontal,
    );
    this.post(event);
  }

  key(keysym: number, down: boolean) {
    this.assertOpen();
    const plan = planFor(keysym);
    if (plan.kind === 'ignore') return;

    if (plan.kind === 'virtual') {
      /* A modifier changes the flags carried by everything that follows, which
         is how macOS reports Command-C rather than a bare C. */
      if (plan.modifier !== null) {
        this.flags = down ? this.flags | plan.modifier : this.flags & ~plan.modifier;
      }
      const event = this.q.CGEventCreateKeyboardEvent(null, plan.keyCode, down);
      if (down) this.heldKeys.set(keysym, plan.keyCode); else this.heldKeys.delete(keysym);
      this.post(event);
      return;
    }

    /* Printable text. The key code is 0 and the character is attached, so the
       Mac's own keyboard layout does not reinterpret it. Command and Control
       combinations still need a real key code, so those fall back to the
       character's position on a US layout. */
    if (this.flags & (MAC_FLAGS.command | MAC_FLAGS.control)) {
      const code = usLayoutKeyCode(plan.text);
      if (code !== null) {
        const event = this.q.CGEventCreateKeyboardEvent(null, code, down);
        if (down) this.heldKeys.set(keysym, code); else this.heldKeys.delete(keysym);
        this.post(event);
        return;
      }
    }
    const event = this.q.CGEventCreateKeyboardEvent(null, 0, down);
    if (!event) return;
    const utf16 = new Uint16Array(plan.text.length);
    for (let i = 0; i < plan.text.length; i++) utf16[i] = plan.text.charCodeAt(i);
    this.q.CGEventKeyboardSetUnicodeString(event, utf16.length, utf16);
    if (down) this.heldKeys.set(keysym, 0); else this.heldKeys.delete(keysym);
    this.post(event);
  }

  releaseAll() {
    if (this.closed) return;
    for (const [keysym, keyCode] of [...this.heldKeys]) {
      this.heldKeys.delete(keysym);
      this.post(this.q.CGEventCreateKeyboardEvent(null, keyCode, false), false);
    }
    for (const button of [...this.heldButtons]) this.button(button, false);
    this.flags = 0;
  }

  pointerPosition(): { x: number; y: number } {
    this.assertOpen();
    const event = this.q.CGEventCreate(null);
    if (!event) return this.last;
    try {
      const point = this.q.CGEventGetLocation(event);
      return { x: Math.round(point.x), y: Math.round(point.y) };
    } finally {
      this.q.CFRelease(event);
    }
  }

  /** The modifier flags currently held, for tests and diagnostics. */
  heldFlags(): number { return this.flags; }

  close() {
    if (this.closed) return;
    this.releaseAll();
    this.closed = true;
  }
}

/**
 * Key codes for a US layout, used only for Command and Control shortcuts, where
 * macOS matches on the key code rather than the character.
 */
const US_LAYOUT: Record<string, number> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09,
  b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10, t: 0x11,
  '1': 0x12, '2': 0x13, '3': 0x14, '4': 0x15, '6': 0x16, '5': 0x17, '=': 0x18, '9': 0x19,
  '7': 0x1a, '-': 0x1b, '8': 0x1c, '0': 0x1d, ']': 0x1e, o: 0x1f, u: 0x20, '[': 0x21,
  i: 0x22, p: 0x23, l: 0x25, j: 0x26, "'": 0x27, k: 0x28, ';': 0x29, '\\': 0x2a,
  ',': 0x2b, '/': 0x2c, n: 0x2d, m: 0x2e, '.': 0x2f, '`': 0x32,
};

/**
 * Asks macOS for Screen Recording, which Electron cannot do (its
 * `askForMediaAccess` covers only the microphone and camera).
 *
 * macOS shows this prompt **once per app**. After that the call returns false
 * immediately without showing anything, and the only way left is System
 * Settings — which is why the caller must always offer that path too. Either
 * way the app is added to the list, so nobody has to find it with the + button.
 */
export function requestScreenRecording(): { granted: boolean; prompted: boolean } {
  const q = loadQuartz();
  if (q.CGPreflightScreenCaptureAccess()) return { granted: true, prompted: false };
  const granted = q.CGRequestScreenCaptureAccess();
  return { granted, prompted: true };
}

/** Whether screen recording is allowed, without showing anything. */
export function screenRecordingAllowed(): boolean {
  return loadQuartz().CGPreflightScreenCaptureAccess();
}

export function usLayoutKeyCode(text: string): number | null {
  const code = US_LAYOUT[text.toLowerCase()];
  return code === undefined ? null : code;
}
