/**
 * How HopDesk has to be started on Linux.
 *
 * Two things are decided here, and they belong together:
 *
 * **The window backend.** Electron 44 picks Wayland by itself on a Wayland
 * session, and that path crashes on some systems: on Ubuntu 24.04 with mutter
 * and Intel Iris Xe graphics it segfaults during startup, before the main
 * script runs, and a ten-line Electron app fails identically — so the
 * application cannot catch or repair it. Chromium's own advice is to use X11,
 * which every Wayland desktop provides through Xwayland.
 *
 * **The screen capture backend.** Chromium chooses that from the session
 * environment, not from the window backend: with XDG_SESSION_TYPE=wayland it
 * insists on the xdg-desktop-portal path and `desktopCapturer.getSources`
 * fails outright, even when the app is an ordinary X11 client. So when the X11
 * backend is used, the child is told it is in an X11 session, which is what it
 * then actually is.
 *
 * HOPDESK_OZONE_PLATFORM overrides the backend. `wayland` is needed to capture
 * a native Wayland desktop — that goes through the portal, which asks the user
 * what to share — and it leaves the session environment untouched.
 */

export function launchOptions(env = process.env) {
  const forced = env.HOPDESK_OZONE_PLATFORM;
  if (forced) return { args: [`--ozone-platform=${forced}`], env: {} };
  if (env.XDG_SESSION_TYPE === 'wayland' && env.DISPLAY) {
    /* undefined removes the variable, so nothing below us sees a Wayland
       display. HOPDESK_DESKTOP_SESSION keeps the truth, because the app has to
       know it is on a Wayland desktop even while it runs as an X11 client. */
    return {
      args: ['--ozone-platform=x11'],
      env: { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: undefined, HOPDESK_DESKTOP_SESSION: 'wayland' },
    };
  }
  return { args: [], env: {} };
}

/** Applies the environment part of `launchOptions` to a copy of `env`. */
export function launchEnvironment(env = process.env) {
  const out = { ...env };
  for (const [key, value] of Object.entries(launchOptions(env).env)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** Just the Chromium switches, for callers that manage the environment themselves. */
export function ozoneArgs(env = process.env) {
  return launchOptions(env).args;
}
