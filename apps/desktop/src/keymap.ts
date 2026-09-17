/**
 * Browser key events to X11 keysyms.
 *
 * This is the part of a remote desktop client that is quietly hardest to get
 * right, and the part users notice first when it is wrong.
 *
 * Two rules:
 *
 * **Use `code`, not `key`, for anything positional.** `key` is what the
 * character *would* be after the local layout is applied — so on a French
 * AZERTY keyboard, pressing the physical Q key gives `key === 'a'`. Sending
 * that keysym means the remote machine, which applies its own layout, receives
 * the wrong letter. `code` is the physical position and is layout-independent.
 *
 * **Except for printable characters**, where `key` is exactly right: the user
 * has already composed the character they want (including with dead keys and
 * AltGr), and the remote should receive that character regardless of how it was
 * typed.
 */

/** Non-printable keys, by `event.code`. */
const BY_CODE: Record<string, number> = {
  Escape: 0xff1b, Tab: 0xff09, CapsLock: 0xffe5,
  Backspace: 0xff08, Enter: 0xff0d, NumpadEnter: 0xff8d,
  Space: 0x0020,

  ShiftLeft: 0xffe1, ShiftRight: 0xffe2,
  ControlLeft: 0xffe3, ControlRight: 0xffe4,
  AltLeft: 0xffe9, AltRight: 0xffea,          // AltRight is AltGr on many layouts
  // The Super/Windows key. Sent through rather than swallowed, so the remote
  // Start menu or Activities overview opens as the user expects.
  MetaLeft: 0xffeb, MetaRight: 0xffec,
  ContextMenu: 0xff67,

  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  Insert: 0xff63, Delete: 0xffff,

  PrintScreen: 0xff61, ScrollLock: 0xff14, Pause: 0xff13, NumLock: 0xff7f,

  NumpadDivide: 0xffaf, NumpadMultiply: 0xffaa,
  NumpadSubtract: 0xffad, NumpadAdd: 0xffab, NumpadDecimal: 0xffae,
  Numpad0: 0xffb0, Numpad1: 0xffb1, Numpad2: 0xffb2, Numpad3: 0xffb3,
  Numpad4: 0xffb4, Numpad5: 0xffb5, Numpad6: 0xffb6, Numpad7: 0xffb7,
  Numpad8: 0xffb8, Numpad9: 0xffb9,
};

// F1–F24. XK_F1 is 0xffbe and they run consecutively.
for (let i = 1; i <= 24; i++) BY_CODE[`F${i}`] = 0xffbd + i;

/**
 * Resolves a keyboard event to a keysym, or null if it should be ignored.
 */
export function keysymFor(e: { code: string; key: string }): number | null {
  const positional = BY_CODE[e.code];
  if (positional !== undefined) return positional;

  // A single printable character: use what the user actually composed.
  // Counted in code points: an emoji is one character but two UTF-16 units.
  if (e.key.length === 1 || (e.key.length === 2 && e.key.codePointAt(0)! > 0xffff)) {
    const cp = e.key.codePointAt(0)!;

    // Latin-1 maps directly onto keysyms, which is the common case.
    if (cp >= 0x20 && cp <= 0xff) return cp;

    // Everything else uses the Unicode keysym range (RFC: 0x01000000 + code
    // point). This is how anything outside Latin-1 — Urdu, Arabic, CJK, emoji
    // — reaches the remote machine at all.
    return 0x01000000 + cp;
  }

  // Unknown named key. Dropping it is better than sending a wrong keysym.
  return null;
}

/** Mouse buttons to an RFB button mask. */
export function buttonMask(buttons: number): number {
  let mask = 0;
  if (buttons & 1) mask |= 1;        // left
  if (buttons & 4) mask |= 2;        // middle
  if (buttons & 2) mask |= 4;        // right
  return mask;
}

/** Wheel events are transient button presses in RFB: 8 up, 16 down. */
export function wheelMask(deltaY: number, deltaX = 0): number {
  let mask = 0;
  if (deltaY < 0) mask |= 8;
  if (deltaY > 0) mask |= 16;
  if (deltaX < 0) mask |= 32;
  if (deltaX > 0) mask |= 64;
  return mask;
}

/**
 * Shortcuts the local desktop would otherwise steal.
 *
 * Ctrl+Alt+Delete never reaches a web context, and on most Linux desktops
 * Super and Alt+Tab are grabbed by the compositor before any application sees
 * them. The UI offers these as explicit buttons; this list is what they send.
 */
export const SPECIAL_COMBOS: Record<string, number[]> = {
  'ctrl-alt-del': [0xffe3, 0xffe9, 0xffff],
  'alt-tab': [0xffe9, 0xff09],
  'super': [0xffeb],
  'ctrl-alt-f1': [0xffe3, 0xffe9, 0xffbe],
  'print-screen': [0xff61],
};

/**
 * Remembers what each held key sent, so its release sends the same keysym.
 *
 * Needed because `key` can change between press and release: press Shift+A,
 * release Shift first, then A, and the keyup reports 'a' while the remote is
 * holding 'A'. Releasing a different keysym leaves 'A' stuck down remotely.
 * Also lets every held key be released when the session loses focus, since
 * the matching keyup then goes to another window and never arrives.
 */
export class KeyTracker {
  private held = new Map<string, number>();

  private static id(e: { code: string; key: string }) {
    return e.code || `key:${e.key}`;
  }

  /** Keysym to send as pressed, or null to ignore the event. */
  down(e: { code: string; key: string }): number | null {
    const keysym = keysymFor(e);
    if (keysym === null) return null;
    this.held.set(KeyTracker.id(e), keysym);
    return keysym;
  }

  /**
   * Keysym to send as released: the one sent on press. A key whose press was
   * never sent — held before the screen had focus, or consumed as a HopDesk
   * shortcut — is not released on the remote either.
   */
  up(e: { code: string; key: string }): number | null {
    const id = KeyTracker.id(e);
    const sent = this.held.get(id);
    if (sent === undefined) return null;
    this.held.delete(id);
    return sent;
  }

  /** Every held keysym, to release them all; the tracker is cleared. */
  releaseAll(): number[] {
    const all = [...this.held.values()];
    this.held.clear();
    return all;
  }
}

/**
 * Keysyms for text committed by an input method.
 *
 * Chinese, Japanese and Korean input (and emoji pickers) produce text through
 * composition events, not per-character key events — keydown only reports
 * "Process". Each committed character is sent as its own Unicode keysym.
 */
export function keysymsForText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const keysym = keysymFor({ code: '', key: ch });
    if (keysym !== null) out.push(keysym);
  }
  return out;
}

/**
 * A pointer position on the displayed canvas, which may be scaled to fit the
 * window, mapped to remote framebuffer pixels and clamped to the screen.
 */
export function framebufferPoint(
  clientX: number, clientY: number,
  box: { left: number; top: number; width: number; height: number },
  fbWidth: number, fbHeight: number,
): { x: number; y: number } {
  const scaleX = box.width > 0 ? fbWidth / box.width : 1;
  const scaleY = box.height > 0 ? fbHeight / box.height : 1;
  const x = Math.floor((clientX - box.left) * scaleX);
  const y = Math.floor((clientY - box.top) * scaleY);
  return {
    x: Math.max(0, Math.min(fbWidth - 1, x)),
    y: Math.max(0, Math.min(fbHeight - 1, y)),
  };
}
