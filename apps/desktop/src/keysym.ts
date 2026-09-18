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

