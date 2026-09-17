# HopDesk architecture

HopDesk is moving from a client for standard protocols (VNC, RDP) to its own
zero-setup remote desktop: a Device ID and access code, or a HopDesk account,
with the Host built into the same app. This file describes what exists, the
native protocol as implemented, and what is still design only. Each section
says which it is.

## What exists

```
┌──────────────────────── HopDesk (Electron) ────────────────────────┐
│ renderer/        UI only. Sandboxed, context-isolated, strict CSP. │
│   app.js         Talks only to window.hopdesk (preload.cjs).       │
│        │ IPC — every call checked by ipc-guard.ts                  │
│ src/main.ts      Owns sockets, processes, files, secrets.          │
└────────┼───────────────────────────────────────────────────────────┘
         │
┌────────▼──────────────────── @hopdesk/core ────────────────────────┐
│ connections.ts   Computers, history (connections.json, 0600).      │
│ credentials.ts   Secret Service keyring, or AES-256-GCM vault.     │
│ settings.ts      Defaults for new computers.                       │
│ session.ts ──► protocols/rfb.ts    VNC, implemented here.          │
│ engines.ts ──► rdp.ts ──► FreeRDP  RDP, in FreeRDP's own window.   │
│ errors.ts        Failures → category, title, message, detail.      │
│ discovery.ts     mDNS/DNS-SD browsing (_rfb._tcp, _rdp._tcp).      │
│ spawn.ts         Child processes without inherited descriptors.    │
└────────────────────────────────────────────────────────────────────┘
```

### Two session kinds

* **In-process (VNC).** `Session` drives `RfbClient`: handshake, update loop
  paced by the renderer, reconnect with jittered backoff, clipboard (Extended
  Clipboard when offered), remote resizing (ExtendedDesktopSize). Frames reach
  the renderer as batched rectangles over IPC and are painted into one
  persistent canvas.
* **External (RDP, SPICE).** `ExternalEngine` launches FreeRDP or Virt Viewer,
  with the password on stdin, a pinned certificate, capability-checked flags,
  and error classification from its log. The session is in the program's own
  window.

### Why RDP is not drawn inside the HopDesk window

FreeRDP is a program, not a library HopDesk can link from Electron without a
native module per FreeRDP ABI. Its `/parent-window` option reparents the X11
window into another X11 window, but an Electron window is not a place a
foreign X11 child can be positioned in reliably (it would cover the whole
window, ignore the UI layout, and not work on Wayland at all). Doing it anyway
would be the fragile hack the project avoids. What HopDesk does instead:

* titles the FreeRDP window after the computer and gives it HopDesk's window
  class, so it groups with HopDesk in docks and task switchers;
* sizes it to most of the screen, and lets the remote desktop follow window
  resizes (`/dynamic-resolution`) or scales it (`/smart-sizing`);
* owns its lifecycle: Disconnect ends it, closing HopDesk (window, quit, or
  SIGTERM/SIGINT/SIGHUP) ends it, and a new connection ends the old one first;
* starts it without HopDesk's own file descriptors (spawn.ts).

The clean route to an embedded RDP view is a small native helper that links
FreeRDP's library and streams frames the way `Session` already does for VNC.
That is a separate project with its own packaging cost per distribution.

## Native HopDesk protocol — implemented (phase 1), not yet used by the app

Three packages, each depending only on the one before it:

```
@hopdesk/crypto     identity, SPAKE2, sealed channels, secret storage
      ▲
@hopdesk/protocol   message schemas, handshake, consent, grants, limits
      ▲
@hopdesk/transport  LAN TCP link, SDP checks, WebRTC negotiation rules
```

Cryptography comes from established libraries only: `@noble/curves` (P-256,
Ed25519), `@noble/hashes` (SHA-256, HKDF, HMAC) and `node:crypto` (scrypt,
AES-256-GCM). HopDesk code composes them; it implements no primitive.

### Identity

* Every installation has an Ed25519 key pair, created on first run and kept in
  a `SecureStorage` (`FileSecureStorage`: 0700 directory, 0600 files, atomic
  writes, optionally encrypted by an OS `Protector` such as Electron
  `safeStorage`).
* **Device ID** `HD-XXXX-XXXX`: 40 bits of SHA-256 over the public key, in
  Crockford base32. A handle for finding a device, never a credential: the
  handshake always verifies the full key, and viewers can pin it.
* **Access code**: six uniform random digits (`crypto.randomInt`).

### Handshake

```
viewer → host   hello      viewerId, viewerKey, viewerName, nonce, time, auth kind, pA
host → viewer   challenge  hostKey, hostName, nonce, pB, cB, Ed25519 signature
viewer → host   confirm    cA, Ed25519 signature
host → viewer   sealed auth-result (after consent)
```

* **SPAKE2**, RFC 9382, suite P256-SHA256-HKDF-HMAC, checked against all four
  RFC test vectors. `w` comes from scrypt over the code and the host's
  Device ID (or HKDF over a 256-bit grant secret). The code never crosses the
  network and cannot be tested offline.
* SPAKE2's associated data is a hash **binding every handshake field**: both
  device keys, both nonces, both names, version, time, auth kind, grant id.
  Altering any of them in transit fails key confirmation.
* Each side **signs** the binding, both SPAKE2 shares and its confirmation
  with its device key, under a role-specific label, so reflection is impossible
  and the session is tied to device identities. The viewer also checks that the
  host key hashes to the Device ID it dialled, and against a pinned key.
* **Session root key** = HKDF(Ke, SHA-256(binding, pA, pB, cA, cB)). Nothing
  is sent under it before both confirmations verify.
* **Guessing limits** (host): a guess is spent when the challenge is sent, so
  abandoned handshakes count as failures. At most 3 concurrent code
  handshakes; after 3 consecutive failures an exponential lockout (2 s doubling,
  capped at 5 min); after 10 failures the code is replaced.
* **Replay**: the host rejects a repeated hello nonce, and a hello whose
  timestamp is more than 10 minutes from its clock.
* **Consent**: a code connection waits for Allow/Reject from the person at the
  host (timeout = reject; the prompt is cancelled if the viewer leaves).
  Unattended access (a stored scrypt verifier, never the password) is refused
  unless the host enabled it.
* **Grants**: an allowed viewer receives, sealed, a random 256-bit grant bound
  to its device key with an expiry, so a dropped connection resumes without a
  second prompt. Grants are in memory, revocable, and wiped on revoke.

### After the handshake

* `SealedChannel`: AES-256-GCM, separate keys per channel label and direction,
  64-bit counter as nonce, receiver accepts only increasing counters (replay
  and reorder rejected, loss tolerated). Any failure closes the session.
* The control channel carries WebRTC offer/answer/ICE, ping, bye. Media and
  data channels are DTLS/SRTP; their certificate fingerprints travel only in
  sealed SDP, so a signaling server or TURN relay cannot insert itself.
  `assertSecureSdp` refuses SDP without strong fingerprints or with
  non-DTLS transports; `certificateMatchesSdp` checks the live DTLS peer.
* Every message is validated against a schema with size limits
  (`protocol/schema.ts`) before use; unknown fields are dropped.
* LAN link: 4-byte length-prefixed JSON frames over TCP (default port 47631),
  frame size checked before buffering, capped unauthenticated connections.

### Verified vs not

* Verified on Linux (unit and loopback-TCP tests, `npm run test:packages`):
  RFC vectors, handshake success and every failure path listed above, sealed
  control traffic between two endpoints over real sockets.
* **Not verified yet:** anything WebRTC. `PeerAdapter` negotiation rules are
  tested with a scripted adapter only; a real RTCPeerConnection, screen
  capture and input injection arrive with the Linux Host in phase 2.

## Design only: the Host in the app (phase 2)

* One app, two roles. The Host part runs in the Electron main process (keys,
  handshake, consent, input injection) with capture and WebRTC in a hidden
  renderer.
* Capture and encoding: Chromium desktop capture plus WebRTC video (hardware
  encoders where available). Input: XTest on X11 through `koffi`;
  Wayland only through the xdg-desktop-portal RemoteDesktop portal, which
  asks the user. macOS (ScreenCaptureKit/CGEvent, Screen Recording and
  Accessibility permissions) and Windows (SendInput) follow the same
  interfaces: `ScreenCapture`, `InputController`, `ClipboardProvider`,
  `DisplayManager`, `PermissionManager`, `SecureStorage`, `HostService`.
* LAN discovery: `_hopdesk._tcp` with the Device ID in TXT.

## Design only: accounts and the internet (phases 3–5)

```
Viewer ── LAN direct (no server) ───────────────────────────▶ Host
Viewer ── signaling ── WebRTC direct (ICE/STUN) ────────────▶ Host
Viewer ── signaling ── TURN (coturn, ciphertext only) ──────▶ Host
```

* Self-hostable server (Docker Compose): account API (scrypt-hashed passwords,
  short-lived access tokens, rotating refresh tokens stored hashed), device
  enrollment and removal, presence, WebSocket signaling, time-limited TURN
  credentials for coturn. LAN use never requires it.
* The signaling server relays the same handshake and sealed frames as the LAN
  link. It learns which devices talk and when, never codes, keys, screens,
  keystrokes or clipboard contents.

## Discovery

Implemented for standard protocols: `_rfb._tcp` (macOS Screen Sharing and VNC
servers that announce themselves) and `_rdp._tcp`. The Host will announce
`_hopdesk._tcp` with its device id in TXT, so already-paired hosts on the LAN
connect directly without the rendezvous service. Windows does not announce
Remote Desktop over mDNS; manual entry of an address always remains available.
