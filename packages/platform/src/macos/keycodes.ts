/**
 * X11 keysyms to macOS virtual key codes.
 *
 * HopDesk carries keys as X11 keysyms whatever the two computers are, because
 * one number has to mean the same key on both ends. On macOS the injection API
 * wants a *virtual key code*, which is a position on an ANSI keyboard, so the
 * named keys need this table.
 *
 * Printable characters are deliberately absent: a virtual key code is
 * interpreted through whatever layout the Mac is using, so sending the code for
 * "A" on a French keyboard would type Q. Those are injected as text instead
 * (see `macos/cgevent.ts`), which is layout independent.
 *
 * Codes are the kVK_* constants from Carbon's HIToolbox Events.h.
 */

export const MAC_VIRTUAL_KEYS: Record<number, number> = {
  0xff0d: 0x24,   // Return
  0xff8d: 0x4c,   // KP_Enter
  0xff09: 0x30,   // Tab
  0x0020: 0x31,   // space
  0xff08: 0x33,   // BackSpace
  0xffff: 0x75,   // Delete (forward delete)
  0xff1b: 0x35,   // Escape
  0xffe9: 0x3a,   // Alt_L      → Option
  0xffea: 0x3d,   // Alt_R      → Right Option
  0xffe3: 0x3b,   // Control_L
  0xffe4: 0x3e,   // Control_R
  0xffe1: 0x38,   // Shift_L
  0xffe2: 0x3c,   // Shift_R
  0xffeb: 0x37,   // Super_L    → Command
  0xffec: 0x36,   // Super_R    → Right Command
  0xffe5: 0x39,   // Caps_Lock

  0xff51: 0x7b,   // Left
  0xff53: 0x7c,   // Right
  0xff54: 0x7d,   // Down
  0xff52: 0x7e,   // Up
  0xff50: 0x73,   // Home
  0xff57: 0x77,   // End
  0xff55: 0x74,   // Page_Up
  0xff56: 0x79,   // Page_Down
  0xff63: 0x72,   // Insert → Help, which is where it sits on a Mac keyboard

  0xffbe: 0x7a,   // F1
  0xffbf: 0x78,   // F2
  0xffc0: 0x63,   // F3
  0xffc1: 0x76,   // F4
  0xffc2: 0x60,   // F5
  0xffc3: 0x61,   // F6
  0xffc4: 0x62,   // F7
  0xffc5: 0x64,   // F8
  0xffc6: 0x65,   // F9
  0xffc7: 0x6d,   // F10
  0xffc8: 0x67,   // F11
  0xffc9: 0x6f,   // F12
  0xffca: 0x69,   // F13
  0xffcb: 0x6b,   // F14
  0xffcc: 0x71,   // F15
  0xffcd: 0x6a,   // F16
  0xffce: 0x40,   // F17
  0xffcf: 0x4f,   // F18
  0xffd0: 0x50,   // F19
  0xffd1: 0x5a,   // F20

  0xffaf: 0x4b,   // KP_Divide
  0xffaa: 0x43,   // KP_Multiply
  0xffad: 0x4e,   // KP_Subtract
  0xffab: 0x45,   // KP_Add
  0xffae: 0x41,   // KP_Decimal
  0xffb0: 0x52, 0xffb1: 0x53, 0xffb2: 0x54, 0xffb3: 0x55, 0xffb4: 0x56,
  0xffb5: 0x57, 0xffb6: 0x58, 0xffb7: 0x59, 0xffb8: 0x5b, 0xffb9: 0x5c,
};

/** CGEventFlags bits, for the modifiers held while a key is sent. */
export const MAC_FLAGS = {
  capsLock: 0x00010000,
  shift: 0x00020000,
  control: 0x00040000,
  option: 0x00080000,
  command: 0x00100000,
  numericPad: 0x00200000,
} as const;

/** Which modifier flag, if any, a keysym stands for. */
export function modifierFlagFor(keysym: number): number | null {
  switch (keysym) {
    case 0xffe1: case 0xffe2: return MAC_FLAGS.shift;
    case 0xffe3: case 0xffe4: return MAC_FLAGS.control;
    case 0xffe9: case 0xffea: return MAC_FLAGS.option;
    case 0xffeb: case 0xffec: return MAC_FLAGS.command;
    case 0xffe5: return MAC_FLAGS.capsLock;
    default: return null;
  }
}

/**
 * The character a keysym produces, or null if it is not a printable one.
 *
 * Latin-1 keysyms are their own code points, and everything else arrives in the
 * Unicode keysym range (0x01000000 + code point), which is how HopDesk carries
 * anything outside Latin-1.
 */
export function characterFor(keysym: number): string | null {
  // Space is handled as a key, so that holding it repeats like a key.
  if (keysym === 0x0020) return null;
  if (keysym >= 0x21 && keysym <= 0xff) return String.fromCodePoint(keysym);
  if (keysym >= 0x01000000 && keysym <= 0x0110ffff) {
    const codePoint = keysym - 0x01000000;
    // Control characters are not text; refuse rather than inject something odd.
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return null;
    return String.fromCodePoint(codePoint);
  }
  return null;
}

/**
 * Key codes for a US layout: the position each character sits at on an ANSI
 * keyboard.
 *
 * Used for every printable key, not only for shortcuts. A character injected
 * with no key code is delivered as *text*, which a text field accepts and a
 * game does not: games read the key code, so a letter with none simply never
 * arrives. That is why W, A, S and D did nothing in a game on a Mac while the
 * arrow keys, which have key codes, worked.
 */
const US_LAYOUT: Record<string, number> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09,
  b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10, t: 0x11,
  '1': 0x12, '2': 0x13, '3': 0x14, '4': 0x15, '6': 0x16, '5': 0x17, '=': 0x18, '9': 0x19,
  '7': 0x1a, '-': 0x1b, '8': 0x1c, '0': 0x1d, ']': 0x1e, o: 0x1f, u: 0x20, '[': 0x21,
  i: 0x22, p: 0x23, l: 0x25, j: 0x26, "'": 0x27, k: 0x28, ';': 0x29, '\\': 0x2a,
  ',': 0x2b, '/': 0x2c, n: 0x2d, m: 0x2e, '.': 0x2f, '`': 0x32,
};

export function usLayoutKeyCode(text: string): number | null {
  const code = US_LAYOUT[text.toLowerCase()];
  return code === undefined ? null : code;
}

/**
 * The modifier flags currently held down, and which keys are holding them.
 *
 * Counted rather than kept as a bare bitmask, because two people can play on
 * one keyboard: one holds the left Shift, the other the right, and both are
 * the same flag to macOS. Clearing the flag when either was released took
 * Shift away from the player still holding it - so a flag stays down while any
 * key still holds it.
 *
 * Pure, so it can be tested without a Mac.
 */
export class HeldModifiers {
  private readonly holders = new Map<number, Set<number>>();

  /** Holds or releases `flag` on behalf of one key, and returns every flag now held. */
  set(flag: number, keysym: number, down: boolean): number {
    const holders = this.holders.get(flag) ?? new Set<number>();
    if (down) holders.add(keysym); else holders.delete(keysym);
    if (holders.size) this.holders.set(flag, holders); else this.holders.delete(flag);
    return this.flags;
  }

  /** Everything held, as the bitmask CGEventSetFlags wants. */
  get flags(): number {
    let flags = 0;
    for (const flag of this.holders.keys()) flags |= flag;
    return flags;
  }

  clear(): void { this.holders.clear(); }
}

/** How a keysym should be injected on macOS. */
export type MacKeyPlan =
  /** A named key or a modifier: a position, and the flag it sets while held. */
  | { kind: 'virtual'; keyCode: number; modifier: number | null }
  /**
   * A printable character that has a position on an ANSI keyboard: sent as
   * both, the position so that games and shortcuts see a real key, and the
   * character so that the Mac's own layout still types the right thing.
   */
  | { kind: 'key'; keyCode: number; text: string }
  /** A character with no position to send it from — accented, CJK, emoji. */
  | { kind: 'text'; text: string }
  | { kind: 'ignore' };

export function planFor(keysym: number): MacKeyPlan {
  if (!Number.isInteger(keysym) || keysym <= 0) return { kind: 'ignore' };
  const keyCode = MAC_VIRTUAL_KEYS[keysym];
  if (keyCode !== undefined) return { kind: 'virtual', keyCode, modifier: modifierFlagFor(keysym) };
  const text = characterFor(keysym);
  if (text === null) return { kind: 'ignore' };
  const position = usLayoutKeyCode(text);
  return position === null ? { kind: 'text', text } : { kind: 'key', keyCode: position, text };
}
