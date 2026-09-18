#!/usr/bin/env bash
# The displays and VNC servers the test suite expects.
#
#   :31  1024x768, VNC on 5901   the computer being shared, and the server the
#                                core VNC tests connect to (password: testpass)
#   :32  800x600,  VNC on 5902   the computer doing the viewing
#
# Both are TigerVNC, because an X server that also speaks VNC serves the
# application tests and the protocol tests at once. Stop them with:
#   pkill -f 'Xtigervnc :3'
set -euo pipefail
# Runs from anywhere: the password is generated with the project's own DES.
cd "$(dirname "$0")/.."

VNC_BIN=${HOPDESK_XVNC:-$(command -v Xtigervnc || command -v Xvnc || true)}
if [[ -z "$VNC_BIN" ]]; then
  echo "No Xtigervnc found. Install tigervnc-standalone-server, or set HOPDESK_XVNC." >&2
  exit 1
fi

state=${HOPDESK_TEST_STATE:-${XDG_RUNTIME_DIR:-/tmp}/hopdesk-test}
mkdir -p "$state"
passwd="$state/vncpasswd"

if [[ ! -f "$passwd" ]]; then
  # TigerVNC's password file: the password, padded to 8 bytes, DES-encrypted
  # with VNC's fixed key — bit-reversed per byte, which is the form this DES
  # implementation takes. Written with the project's own DES so no extra tool
  # is needed, and so the format stays honest to what the client speaks.
  node -e '
    const { writeFileSync, chmodSync } = require("node:fs");
    const { desEncryptEcb } = require("./packages/core/dist/index.js");
    const flip = b => { let r = 0; for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i; return r; };
    const key = Buffer.from([23, 82, 107, 6, 35, 78, 88, 7].map(flip));
    const block = Buffer.alloc(8);
    Buffer.from("testpass", "latin1").copy(block, 0, 0, 8);
    writeFileSync(process.argv[1], desEncryptEcb(block, key));
    chmodSync(process.argv[1], 0o600);
  ' "$passwd"
fi

start() {
  local display=$1 geometry=$2 port=$3
  if [[ -e "/tmp/.X11-unix/X${display#:}" ]]; then
    echo "$display already running"
    return
  fi
  "$VNC_BIN" "$display" -geometry "$geometry" -depth 24 -rfbport "$port" \
    -PasswordFile "$passwd" -SecurityTypes VncAuth -localhost \
    -desktop "hopdesk$display" > "$state/x${display#:}.log" 2>&1 &
  for _ in $(seq 1 60); do
    [[ -e "/tmp/.X11-unix/X${display#:}" ]] && break
    sleep 0.25
  done
  if [[ -e "/tmp/.X11-unix/X${display#:}" ]]; then
    echo "$display up (VNC on $port)"
  else
    echo "$display failed to start; see $state/x${display#:}.log" >&2
    exit 1
  fi
}

start :31 1024x768 5901
start :32 800x600 5902
