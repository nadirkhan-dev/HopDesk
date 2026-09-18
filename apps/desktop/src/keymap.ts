/**
 * Viewer-side key handling: held-key tracking, RFB button masks and canvas
 * coordinate mapping.
 *
 * The DOM-event-to-keysym table is in keysym.ts, which the Host also uses to
 * replay a viewer's keys locally — the mapping must be identical in both
 * directions. It is imported relatively because the renderer loads this file as
 * a plain browser module, which cannot resolve package names.
 */
import { keysymFor } from './keysym.js';

export { keysymFor };

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
