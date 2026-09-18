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
  # Read from the file: koffi's "exports" does not include its package.json.
  KOFFI_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('node_modules/koffi/package.json', 'utf8')).version")
  npm install --no-save --force "@koromix/koffi-darwin-${ARCH}@${KOFFI_VERSION}"
fi
test -f "node_modules/@koromix/koffi-darwin-${ARCH}/darwin_${ARCH}/koffi.node" \
  || { echo "koffi's native module for darwin-${ARCH} is missing" >&2; exit 1; }
npm run build
unset ELECTRON_RUN_AS_NODE

extra=()
adhoc=false
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
  # electron-builder cannot do this itself (it takes "-" for a certificate name
  # and skips signing), so it builds the app unsigned and it is signed here.
  echo "No Developer ID certificate found: signing ad hoc (Gatekeeper will ask before first launch)." >&2
  extra+=(--config.mac.identity=null)
  adhoc=true
fi

builder() {
  npx --yes "electron-builder@${ELECTRON_BUILDER_VERSION}" --publish never \
    --config packaging/electron-builder.yml "--${ARCH}" "${extra[@]}" "$@"
}

# 1. The app itself.
builder --mac dir
APP=$(find dist-packages -maxdepth 2 -name "*.app" -path "dist-packages/mac*" | head -1)
[[ -n "$APP" ]] || { echo "electron-builder produced no .app:" >&2; find dist-packages -maxdepth 2 >&2; exit 1; }
echo "Built $APP"

# koffi's module must be in the bundle, outside the asar archive, for this architecture.
KOFFI_NODE=$(find "$APP/Contents/Resources" -name koffi.node -path "*darwin_${ARCH}*" | head -1)
if [[ -z "$KOFFI_NODE" ]]; then
  echo "koffi's darwin_${ARCH} module is not in the bundle. What is there:" >&2
  find "$APP/Contents/Resources" -maxdepth 4 \( -name "*koffi*" -o -name "app.asar*" \) >&2 || true
  find "$APP/Contents/Resources" -name "*.node" >&2 || true
  npx --yes @electron/asar list "$APP/Contents/Resources/app.asar" 2>/dev/null | grep -i koffi | head -20 >&2 || true
  exit 1
fi
echo "koffi: $KOFFI_NODE"

# 2. Ad hoc signature, with the same entitlements a Developer ID build gets.
if $adhoc; then
  codesign --force --deep --sign - --options runtime \
    --entitlements packaging/entitlements.mac.plist "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
fi

# 3. The .dmg, from the app as it now is.
builder --mac dmg --prepackaged "$APP"

echo
echo "Packages are in dist-packages/. Before calling this done, on the Mac:"
echo "  1. open the .dmg and drag HopDesk to Applications"
echo "  2. start it: 'This computer' lists Screen Recording and Accessibility, and"
echo "     opens the right pane of System Settings for whichever is not allowed"
echo "  3. connect to it from another computer and check the screen and the keyboard"
