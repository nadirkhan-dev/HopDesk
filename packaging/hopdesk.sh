#!/bin/sh
# Launcher. The Electron base app provides zypak, which is what lets Chromium's
# sandbox work inside Flatpak's sandbox.
# The Electron binary itself: node_modules/.bin/electron is a Node script, and
# the runtime has no Node.
# Same rule as apps/desktop/scripts/launch-args.mjs: Electron's Wayland backend
# crashes on some systems, and Xwayland is always available on a Wayland desktop.
# HOPDESK_OZONE_PLATFORM=wayland opts back in.
if [ -n "$HOPDESK_OZONE_PLATFORM" ]; then
  OZONE="--ozone-platform=$HOPDESK_OZONE_PLATFORM"
elif [ "$XDG_SESSION_TYPE" = "wayland" ] && [ -n "$DISPLAY" ]; then
  OZONE="--ozone-platform=x11"
  # Chromium picks its screen-capture backend from the session environment, so
  # it has to agree with the window backend or capture fails.
  XDG_SESSION_TYPE=x11
  unset WAYLAND_DISPLAY
  export XDG_SESSION_TYPE
else
  OZONE=""
fi

exec zypak-wrapper /app/hopdesk/node_modules/electron/dist/electron /app/hopdesk/apps/desktop/dist/main.js $OZONE "$@"
