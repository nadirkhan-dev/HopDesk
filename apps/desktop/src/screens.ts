/**
 * Which screen this computer shares, when it has more than one.
 *
 * Two facts about capture on a multi-monitor computer, both learned the hard
 * way on a laptop with an external monitor:
 *
 * **The whole desktop is not on offer.** Chromium lists one source per
 * monitor, and asking for the X screen as a whole ("screen:0:0") fails. So
 * something has to be chosen, and whoever is sharing has to be able to say
 * which — otherwise the windows on the other monitor simply are not there.
 *
 * **A source cannot be matched to a monitor by its id.** `display_id` is only
 * filled in on some platforms; on X11 it carries XRandR's own numbering
 * ("66"), which has nothing to do with the id Electron reports for the same
 * monitor. Chromium and Electron do enumerate monitors in the same order,
 * though, so position in the list is what is left to match on.
 *
 * Kept apart from Electron so it can be tested on any machine, with any number
 * of screens, rather than only on one that happens to have two.
 */

/** A screen, as Electron's `screen` module describes it. */
export interface DisplayLike {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  size: { width: number; height: number };
  scaleFactor: number;
}

/** A capture source, as `desktopCapturer` describes it. */
export interface SourceLike {
  id: string;
  name: string;
  display_id: string;
}

/** A screen offered to the person sharing, in the words the interface uses. */
export interface ScreenChoice {
  id: number;
  /** "Screen 1 — 1920 × 1080", and the main one says so. */
  label: string;
  width: number;
  height: number;
  primary: boolean;
}

/** The screen being shared: the one chosen, or the main one. */
export function sharedDisplay<T extends DisplayLike>(displays: T[], primaryId: number, chosen: number | null): T {
  return displays.find(d => d.id === chosen) ?? displays.find(d => d.id === primaryId) ?? displays[0]!;
}

/**
 * The capture source for a screen: by id where the platform fills one in, and
 * by position in the list where it does not.
 */
export function sourceForDisplay(
  sources: SourceLike[], displays: DisplayLike[], display: DisplayLike,
): SourceLike | null {
  if (!sources.length) return null;
  const byId = sources.find(s => s.display_id && s.display_id === String(display.id));
  if (byId) return byId;
  const index = displays.findIndex(d => d.id === display.id);
  return (index >= 0 ? sources[index] : null) ?? sources[0]!;
}

/** Every screen this computer could share, for the list in the interface. */
export function screenChoices(displays: DisplayLike[], primaryId: number): ScreenChoice[] {
  return displays.map((display, index) => ({
    id: display.id,
    label: `Screen ${index + 1} — ${display.size.width} × ${display.size.height}`
      + (display.id === primaryId ? ' (main)' : ''),
    width: display.size.width,
    height: display.size.height,
    primary: display.id === primaryId,
  }));
}

/**
 * Whether what was captured looks like the screen that was asked for, so a
 * mismatch is said out loud instead of leaving someone wondering why they are
 * looking at the wrong monitor. Sizes are in pixels, as captured.
 */
export function capturedTheWrongScreen(
  display: DisplayLike, captured: { width: number; height: number },
): boolean {
  if (!captured.width || !captured.height) return false;
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);
  return captured.width !== width || captured.height !== height;
}
