#!/usr/bin/env bash
# A macOS build: a .dmg per architecture, signed and notarised when credentials
# are present.
#
# The release workflow runs this on GitHub's Mac runners, once per
# architecture: HOPDESK_MAC_ARCH=arm64 or x64 (default: this Mac's own).
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

ARCH="${HOPDESK_MAC_ARCH:-$(uname -m | sed 's/x86_64/x64/')}"

npm ci
# koffi's native module comes as one package per architecture, and npm installs
# only this machine's. An Intel build made on Apple Silicon (or the reverse)
# needs the other one, or input injection is missing from it.
if [[ "$ARCH" != "$(uname -m | sed 's/x86_64/x64/')" ]]; then
  KOFFI_VERSION=$(node -p "require('koffi/package.json').version")
  npm install --no-save --force "@koromix/koffi-darwin-${ARCH}@${KOFFI_VERSION}"
fi
test -f "node_modules/@koromix/koffi-darwin-${ARCH}/darwin_${ARCH}/koffi.node" \
  || { echo "koffi's native module for darwin-${ARCH} is missing" >&2; exit 1; }
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
  # Not "unsigned": Apple Silicon refuses to run a bundle with no valid
  # signature at all ("damaged"), so it is signed ad hoc — valid, but vouched
  # for by nobody, which is what Gatekeeper's "Open Anyway" is for.
  echo "No Developer ID certificate found: signing ad hoc (Gatekeeper will ask before first launch)." >&2
  extra+=(--config.mac.identity=-)
fi

npx --yes "electron-builder@${ELECTRON_BUILDER_VERSION}" --publish never \
  --mac dmg "--${ARCH}" --config packaging/electron-builder.yml "${extra[@]}"

echo
echo "Packages are in dist-packages/. Before calling this done, on the Mac:"
echo "  1. open the .dmg and drag HopDesk to Applications"
echo "  2. start it: 'This computer' lists Screen Recording and Accessibility, and"
echo "     opens the right pane of System Settings for whichever is not allowed"
echo "  3. connect to it from another computer and check the screen and the keyboard"
