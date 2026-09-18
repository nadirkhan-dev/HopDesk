#!/usr/bin/env bash
# AppImage and .deb: for people who do not use Flatpak, and for trying the app
# quickly. Output goes to dist-packages/.
#
# electron-builder runs through npx at a pinned version rather than being added
# to package.json, so building a package never changes the project's
# dependencies. Configuration lives in packaging/electron-builder.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

ELECTRON_BUILDER_VERSION=26.0.12

npm ci
npm run build

# VS Code's integrated terminal sets this, and it breaks Electron tooling.
unset ELECTRON_RUN_AS_NODE

# Debian packages must name a homepage; electron-builder.yml sets the project's.
# HOPDESK_HOMEPAGE overrides it, for a fork that publishes its own packages.
targets=(AppImage deb)
extra=()
if [[ -n "${HOPDESK_HOMEPAGE:-}" ]]; then
  extra=(--config.extraMetadata.homepage="${HOPDESK_HOMEPAGE}")
fi

# --publish never: on a CI machine electron-builder otherwise tries to publish a
# GitHub release and fails for want of a token. Releasing is a separate, deliberate act.
npx --yes "electron-builder@${ELECTRON_BUILDER_VERSION}" --publish never \
  --config packaging/electron-builder.yml \
  --linux "${targets[@]}" "${extra[@]}"

echo "Packages are in dist-packages/"
