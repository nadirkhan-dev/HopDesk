#!/usr/bin/env bash
# A macOS build: a .dmg per architecture, signed and notarised when credentials
# are present.
#
# This has never been run — no Mac has built HopDesk yet. Treat a first run as
# an experiment, not a release.
#
# What Apple requires, and what it costs if it is missing:
#
#   * A "Developer ID Application" certificate in the login keychain. Without
#     it the app is unsigned: Gatekeeper refuses to open it on another Mac, and
#     macOS forgets the Accessibility permission on every update.
#   * Notarisation credentials, as environment variables:
#       APPLE_ID                    your Apple account
#       APPLE_APP_SPECIFIC_PASSWORD an app-specific password, not your real one
#       APPLE_TEAM_ID               the ten-character team identifier
#     Without these the app is signed but not notarised, and a Mac that has
#     never seen it shows "cannot be opened because Apple cannot check it".
set -euo pipefail
cd "$(dirname "$0")/.."

ELECTRON_BUILDER_VERSION=26.0.12

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "A macOS build has to run on macOS: electron-builder needs Apple's own tools." >&2
  exit 2
fi

npm ci
npm run build
unset ELECTRON_RUN_AS_NODE

extra=()
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  echo "Signing with the Developer ID certificate in your keychain."
  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    echo "Notarising as ${APPLE_ID} (team ${APPLE_TEAM_ID})."
    extra+=(--config.mac.notarize=true)
  else
    echo "No notarisation credentials: the build will be signed but not notarised." >&2
    echo "Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to notarise." >&2
  fi
else
  echo "No Developer ID certificate found: building unsigned, for local testing only." >&2
  extra+=(--config.mac.identity=null)
fi

npx --yes "electron-builder@${ELECTRON_BUILDER_VERSION}" \
  --mac --config packaging/electron-builder.yml "${extra[@]}"

echo
echo "Packages are in dist-packages/. Before calling this done, on the Mac:"
echo "  1. open the .dmg and drag HopDesk to Applications"
echo "  2. start it, allow Screen Recording and Accessibility when asked"
echo "  3. node scripts/verify-macos.mjs   (from a checkout, to check input injection)"
echo "  4. connect to it from another computer and check the screen and the keyboard"
