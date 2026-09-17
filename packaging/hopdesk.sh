#!/bin/sh
# Launcher. The Electron base app provides zypak, which is what lets Chromium's
# sandbox work inside Flatpak's sandbox.
# The Electron binary itself: node_modules/.bin/electron is a Node script, and
# the runtime has no Node.
exec zypak-wrapper /app/hopdesk/node_modules/electron/dist/electron /app/hopdesk/apps/desktop/dist/main.js "$@"
