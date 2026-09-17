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

# Debian packages must name a project homepage. There is no official one, so the
# .deb is built only when you supply it; the AppImage needs none.
if [[ -n "${HOPDESK_HOMEPAGE:-}" ]]; then
  targets=(AppImage deb)
  extra=(--config.extraMetadata.homepage="${HOPDESK_HOMEPAGE}")
else
  targets=(AppImage)
  extra=()
  echo "HOPDESK_HOMEPAGE is not set: building the AppImage only (a .deb needs a homepage URL)."
fi

npx --yes "electron-builder@${ELECTRON_BUILDER_VERSION}" \
  --config packaging/electron-builder.yml \
  --linux "${targets[@]}" "${extra[@]}"

echo "Packages are in dist-packages/"
