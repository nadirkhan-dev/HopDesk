import type { InputController } from './interfaces.js';
import { X11Input, X11Unavailable } from './linux/x11.js';
import { WaylandInput, PortalUnavailable, PortalRefused, type WaylandInputOptions } from './linux/portal.js';
import { MacInput, MacOsUnavailable } from './macos/cgevent.js';

/**
 * The input injector for the machine this is running on.
 *
 * Each backend loads its system libraries on first use, so importing this
 * module is safe on any platform — including one HopDesk cannot host from yet,
 * where the point is to fail with a sentence a person can act on.
 */

export class UnsupportedPlatform extends Error {}

export interface InputOptions extends WaylandInputOptions {
  /** X11 only: which display to inject into. */
  display?: string;
  /** Forces a backend; otherwise it follows the session. */
  backend?: 'x11' | 'wayland';
}

/** Which backend this session needs. */
export function linuxBackend(env = process.env): 'x11' | 'wayland' {
  /* On a Wayland session XTest reaches only Xwayland's own clients, so a viewer
     could control an X11 application and nothing else — worse than refusing.
     The portal is the way in, and it asks the person at the keyboard. */
  return env.XDG_SESSION_TYPE === 'wayland' ? 'wayland' : 'x11';
}

/**
 * The synchronous backends. Wayland is not one of them: its permission dialog
 * makes creating a controller an asynchronous act, so use `openInputController`.
 */
export function createInputController(opts: InputOptions = {}): InputController {
  switch (process.platform) {
    case 'linux':
      if ((opts.backend ?? linuxBackend()) === 'wayland' && !opts.display) {
        throw new UnsupportedPlatform(
          'This is a Wayland session, where controlling the computer needs the desktop\'s '
          + 'permission. Use openInputController(), which asks for it.');
      }
      return new X11Input(opts);
    case 'darwin':
      return new MacInput();
    case 'win32':
      throw new UnsupportedPlatform(
        'HopDesk cannot yet share this computer\'s screen on Windows. '
        + 'Connecting from it to another computer works.');
    default:
      throw new UnsupportedPlatform(`HopDesk cannot share this computer's screen on ${process.platform}.`);
  }
}

/**
 * Opens an input controller, asking the desktop for permission where that is
 * how the platform works. On Wayland this shows the compositor's own dialog and
 * resolves once the person has answered it.
 */
export async function openInputController(opts: InputOptions = {}): Promise<InputController> {
  if (process.platform === 'linux' && (opts.backend ?? linuxBackend()) === 'wayland' && !opts.display) {
    return WaylandInput.create(opts);
  }
  return createInputController(opts);
}

/** Why input injection is unavailable here, or null when it works. */
export function inputUnavailableReason(opts: InputOptions = {}): string | null {
  try {
    createInputController(opts).close();
    return null;
  } catch (err) {
    if (err instanceof X11Unavailable || err instanceof MacOsUnavailable
      || err instanceof PortalUnavailable || err instanceof PortalRefused
      || err instanceof UnsupportedPlatform) {
      return err.message;
    }
    throw err;
  }
}
