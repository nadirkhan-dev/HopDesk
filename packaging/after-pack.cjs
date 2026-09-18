'use strict';
const { promises: fs } = require('node:fs');
const path = require('node:path');

/**
 * Wraps the packaged Linux binary in a small launcher.
 *
 * Electron's Wayland backend segfaults when it creates a window (Electron 38,
 * 42 and 44, while Chrome is fine on the same machine), so HopDesk has to ask
 * for X11 — and Chromium picks its screen-capture backend from the session
 * environment, so that has to agree. Neither can be set from inside the
 * application: the backend is chosen before the main script runs.
 *
 * electron-builder's `executableArgs` only reaches the desktop entry, which
 * leaves anyone starting the AppImage directly with a crash. So the real binary
 * is renamed and a launcher takes its place, applying the same rule as
 * apps/desktop/scripts/launch-args.mjs.
 */
const LAUNCHER = `#!/bin/sh
# Starts HopDesk with a display backend that works.
# HOPDESK_OZONE_PLATFORM overrides the choice; see docs/ARCHITECTURE.md.
HERE=$(dirname "$(readlink -f "$0")")

if [ -n "$HOPDESK_OZONE_PLATFORM" ]; then
  OZONE="--ozone-platform=$HOPDESK_OZONE_PLATFORM"
elif [ "$XDG_SESSION_TYPE" = "wayland" ] && [ -n "$DISPLAY" ]; then
  # Xwayland: the window backend Electron survives on, and the capture backend
  # Chromium can use, have to agree with each other.
  OZONE="--ozone-platform=x11"
  XDG_SESSION_TYPE=x11
  HOPDESK_DESKTOP_SESSION=wayland
  export XDG_SESSION_TYPE HOPDESK_DESKTOP_SESSION
  unset WAYLAND_DISPLAY
else
  OZONE=""
fi

exec "$HERE/%BIN%" $OZONE "$@"
`;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const exe = path.join(context.appOutDir, name);
  const real = `${name}-bin`;
  await fs.rename(exe, path.join(context.appOutDir, real));
  await fs.writeFile(exe, LAUNCHER.replace('%BIN%', real), { mode: 0o755 });
};
