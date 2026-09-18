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

## Native HopDesk protocol — implemented (phase 1)

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

## The Host and Viewer in the app — implemented (phase 2), Linux/X11

One application, two roles, and the split is a security boundary: everything
secret stays in the main process.

```
┌───────────────────── main process ─────────────────────┐
│ identity.ts   device key in safeStorage (OS keystore)  │
│ host.ts       listener, handshake, consent, grants     │
│ viewer.ts     connect by Device ID, resume on drop     │
│ rtc-bridge.ts drives a peer connection by remote call  │
│ devices.ts    pinned host keys, per Device ID          │
└───────┬──────────────────────────┬────────────────────-┘
        │ IPC (ipc-guard)          │ IPC
┌───────▼─────────────┐  ┌─────────▼───────────────────┐
│ renderer/hopdesk.js │  │ renderer/host-rtc.js        │
│ viewer: video in,   │  │ hidden window: getDisplay-  │
│ input and clipboard │  │ Media, sends screen, relays │
│ out over channels   │  │ input/clipboard to main     │
└─────────────────────┘  └─────────────────────────────┘
```

* **Why a renderer at all:** RTCPeerConnection and screen capture exist only in
  Chromium's renderer. The renderer never sees the device key, the access code
  or the session keys; the main process decides everything and only asks the
  renderer to make an offer, answer one, or add a candidate.
* **Input:** `@hopdesk/platform` injects through XTest (`libXtst` via `koffi`,
  no compiled addon). Keysyms the layout has no key for — any non-Latin
  character or emoji — are placed on a borrowed keycode, pressed, and given back
  shortly after release so the receiving application has processed the mapping
  change. Every message is validated against the protocol schema in the main
  process before it reaches the platform.
* **Capture:** `getDisplayMedia` in the hidden window, answered by
  `setDisplayMediaRequestHandler` with the primary screen, and only while remote
  access is on and only for that window. Chromium chooses its capture backend
  from `XDG_SESSION_TYPE`, not from the window backend, which is why
  `scripts/launch-args.mjs` sets both together.
* **Clipboard:** the viewer's clipboard is sent on demand and when the session
  view takes focus; the host's is polled once a second while a session is
  connected and sent when it changes. Contents are never logged.
* **Platform interfaces** for the ports still to come — `ScreenCapture`,
  `InputController`, `ClipboardProvider`, `DisplayManager`, `PermissionManager`,
  `HostService` — are in `@hopdesk/platform`. Windows (SendInput, Desktop
  Duplication) and macOS (CGEvent, ScreenCaptureKit, with the Screen Recording
  and Accessibility permissions) implement the same shapes; neither is written.
* **Discovery:** `_hopdesk._tcp` over mDNS, Device ID as the instance name and
  in TXT, answered from the app itself (no Avahi dependency). It is a hint about
  where to connect, never authentication.

### Verified vs not (phase 2)

* Verified between two real HopDesk applications on Linux/X11: handshake,
  consent, live WebRTC video, mouse and keyboard arriving in an application on
  the host, clipboard onto the host's system clipboard, discovery by Device ID,
  silent resume after the connection was cut, wrong code refused without a
  prompt, Reject honoured, remote access off closing the listener.
* **Verified since:** Wayland *input* on a real GNOME session (see below).
* **Not verified:** Wayland *capture* (blocked by the Electron crash below),
  Windows, macOS host, multi-monitor selection, and resizing the host display to
  the viewer's window.

### Wayland, and the Electron bug in the way

Input on Wayland works, and not through XTest: X11 clients cannot control a
Wayland desktop at all, which is the point of Wayland. HopDesk uses
`org.freedesktop.portal.RemoteDesktop`, so the compositor asks the person at the
keyboard before anything can move their pointer. `NotifyKeyboardKeysym` takes
keysyms, which is exactly what the protocol already carries, so no key table is
involved. Absolute pointer positions are expressed in the coordinates of a
screen the same session shares, which is why the session selects a ScreenCast
source as well.

**Verified on a real GNOME Wayland session** (2026-09-18): the portal accepted
the session, shared a 1920x1200 stream, and the pointer, scrolling and typing —
including Arabic text — all arrived. Seven checks out of seven, run by the
person at the keyboard, because the permission dialog is theirs to answer.

Two things the portal decides, not HopDesk:

* GNOME refuses `persist_mode` for a session that can control the machine
  ("Remote desktop sessions cannot persist"), so the dialog appears each time
  remote access is switched on. HopDesk asks for persistence, accepts the
  refusal, and carries on.
* Unattended access is therefore not possible on GNOME Wayland: someone has to
  allow the session at the keyboard.

**Capture on Wayland is blocked by Electron.** Chromium will only capture a
Wayland desktop from its own Wayland backend, and creating a window with that
backend segfaults: reproduced on Electron 38, 42 and 44 on this machine (GNOME
46, mutter, Intel Iris Xe), while Chrome 152 on the same machine runs on Wayland
without trouble. An Electron app with no window survives, so the crash is in
window creation. Until that is fixed upstream, HopDesk on a Wayland desktop runs
through Xwayland: the mouse and keyboard reach the real desktop through the
portal, but the picture shows X11 windows only — and the interface says so
rather than sharing an almost-empty screen silently.

## Accounts, the server and the relay — implemented (phases 3–5)

```
Viewer ── LAN direct, no server ────────────────────────────▶ Host
Viewer ── server introduces ── WebRTC direct (ICE/STUN) ────▶ Host
Viewer ── server introduces ── TURN relay (coturn) ─────────▶ Host
```

The server (`server/`) is self-hosted and optional: a local network needs
nothing but the two applications.

### What the server is

* **Accounts** — scrypt-hashed passwords, and a sign-in answered identically
  whether or not the email exists. Sign-in attempts are throttled per email, in
  the database, so a restart does not reset the limit.
* **Two kinds of credential.** Short-lived signed access tokens for a person who
  is signed in; long-lived **device tokens** for a computer that has to
  reconnect on its own. A device token can carry sessions, list the account's
  computers and ask for relay credentials, but cannot enrol another computer or
  remove one — so a stolen one cannot lock the owner out.
* **Refresh tokens rotate.** Each use issues a new one and marks the old spent;
  a second use of a spent token means it was copied, so the whole family is
  revoked and the person signs in again.
* **Device enrolment proves possession.** The server issues a nonce, the device
  signs it with its Ed25519 key, and the server checks both the signature and
  that the Device ID is the one that key produces.
* **Storage** is SQLite through Node's own `node:sqlite` — no database service,
  no native module.

### What the server cannot do

It relays frames it never looks inside. The account connection uses an
**ephemeral X25519 exchange signed by both device keys** (`crypto/exchange.ts`),
so the shared key exists only on the two computers; substituting a key, a name
or an ephemeral share breaks the signatures or the confirmation. A relay is
therefore not a party to the session, only a pipe. What it does learn: which
devices are online, and which asked to reach which, when.

The limit worth stating plainly: **the account list is the server's to define.**
A compromised server could add a device of its own to an account — it still
could not read existing sessions, and the host still asks the person present to
allow the connection unless unattended access was switched on.

### The relay

coturn with `use-auth-secret`: the server hands out a username that is an expiry
time and an HMAC of it under a secret only the server and coturn share. Clients
never see the secret and their credentials expire on their own. *Always connect
through the relay* forces that path for people who would rather not expose
addresses at all.

### Verified vs not (phases 3–5)

* Verified: the server's own suite (accounts, throttling, token rotation and
  replay detection, enrolment proofs, device-token limits, relay authorisation
  and refusals, a full handshake through the relay with only ciphertext on the
  wire); the Docker image built and the container serving real requests; TURN
  credentials accepted by a real coturn and a wrong one refused; two HopDesk
  applications signing in to a server here, listing each other and connecting
  through it; and a session **forced through coturn**, where ICE reported a
  relay path, video arrived, and coturn logged the traffic it carried.
* **Not verified:** a deployment on a real domain (certificates, ports opened on
  a VPS) and NAT traversal between two genuinely different networks.

## Discovery

Implemented for standard protocols: `_rfb._tcp` (macOS Screen Sharing and VNC
servers that announce themselves) and `_rdp._tcp`. The Host will announce
`_hopdesk._tcp` with its device id in TXT, so already-paired hosts on the LAN
connect directly without the rendezvous service. Windows does not announce
Remote Desktop over mDNS; manual entry of an address always remains available.
