# HopDesk

Control your Windows PC, Mac or Linux computer from Linux.

Two ways to connect:

* **HopDesk to HopDesk** — no addresses, no ports, no server software to set
  up. The other computer shows a Device ID and an access code; you type them in
  and someone there clicks Allow. On the same network this needs nothing else;
  across the internet it needs [your own HopDesk server](#run-your-own-hopdesk-server).
  Linux only so far (see [Connect two HopDesk computers](#connect-two-hopdesk-computers)).
* **Standard protocols** — Remote Desktop (Windows) and Screen Sharing/VNC
  (Mac, Linux) for computers that already have them switched on. Add a computer
  once, double-click it, and its screen is in front of you.

Either way the keyboard, mouse, clipboard and full screen work the way you
expect, and your passwords stay encrypted.

*Not affiliated with any commercial remote desktop product. Independent code,
open protocols only.*

- [Install](#install)
- [Connect two HopDesk computers](#connect-two-hopdesk-computers)
- [Run your own HopDesk server](#run-your-own-hopdesk-server)
- [Connect to Windows](#connect-to-windows)
- [Connect to a Mac](#connect-to-a-mac)
- [Connect to Linux](#connect-to-linux)
- [Using a session](#using-a-session)
- [Security](#security)
- [What HopDesk cannot do yet](#what-hopdesk-cannot-do-yet)
- [For developers](#for-developers)

## Install

### AppImage (any distribution)

Download `HopDesk-<version>.AppImage`, make it executable and open it:

```bash
chmod +x HopDesk-*.AppImage
./HopDesk-*.AppImage
```

### Debian, Ubuntu, Mint

```bash
sudo apt install ./hopdesk_<version>_amd64.deb
```

The package recommends FreeRDP (for Windows) and `libsecret-tools` (to keep
passwords in your system keyring), so `apt` installs them for you.

### Flatpak

There is no published Flatpak repository yet; build and install it for your
user (this downloads the Freedesktop 25.08 runtime):

```bash
flatpak-builder --user --install-deps-from=flathub --install build packaging/io.hopdesk.HopDesk.yml
flatpak run io.hopdesk.HopDesk
```

Remote Desktop support (FreeRDP 3.31.1) is built into the Flatpak.

### Remote Desktop support for Windows

To reach Windows computers, the AppImage and .deb need FreeRDP. HopDesk tells
you if it is missing. Install it from your software centre, or:

```bash
sudo apt install freerdp3-x11     # Ubuntu 24.04 and later
sudo apt install freerdp2-x11     # Ubuntu 22.04, Debian 12, Mint 21
sudo dnf install freerdp          # Fedora
sudo pacman -S freerdp            # Arch
```

## Connect two HopDesk computers

This needs nothing installed on either computer except HopDesk, and no network
configuration: no port forwarding, no VNC or RDP server, no account.

**On the computer you want to reach**, under *This computer* in the sidebar,
click **Turn on**. It then shows:

```
● Online
Device ID     HD-7K3M-Q9TX     [Copy]
Access code   739 421          [Copy] [New code]
```

**On the computer you are sitting at**, type that Device ID and access code
under *Connect*, and click **Connect**.

**Back on the first computer**, a prompt names the computer asking to connect
and waits for **Allow** or **Reject**. Nothing is shared until someone clicks
Allow — that is the default and cannot be switched off by the computer
connecting.

Then the screen appears, with the mouse, keyboard and clipboard working. *Send
clipboard* copies this computer's clipboard to the other one; text copied there
arrives here by itself. Ctrl+Alt+Enter toggles full screen. **Disconnect** ends
the session, and so does closing HopDesk.

A few details worth knowing:

* **The access code is temporary.** It is new each time HopDesk starts, *New
  code* replaces it, and it is replaced automatically after repeated wrong
  guesses. It is never sent over the network — both computers prove they know it
  without either revealing it (SPAKE2, RFC 9382), so it cannot be captured or
  guessed offline.
* **The Device ID is not a password.** It identifies the computer; the access
  code authorises the connection. HopDesk also remembers the identity key behind
  each Device ID and warns if it ever changes.
* **Finding the other computer.** On the same network its Device ID is enough.
  If discovery is blocked, open *More options* under Connect and type its
  address.
* **If the connection drops**, it comes back by itself without asking anyone
  again. If the person at the other computer disconnects, it does not.
* **Pair once, then one click.** When you allow a connection, the prompt offers
  *Let this computer connect again without asking*. Tick it and that computer
  appears under **Saved computers** on the other side: one click, no access
  code, and nobody has to answer anything — even with nobody sitting there.
  What is stored is the other computer's public key, which cannot be used by
  anyone who copies it, and a pairing expires after 90 days unless it is used.
  *Computers you trust*, under **This computer**, lists them and stops any of
  them; stopping one also disconnects it if it is connected at that moment.

## Run your own HopDesk server

A HopDesk server does two things: it lists your computers so you can connect to
them by name from anywhere, and it passes a connection along when two computers
cannot reach each other directly. It is not a cloud service someone else runs —
you run it, on a VPS or any machine with a domain name pointing at it.

**What it can and cannot see.** It knows which of your computers are online and
which one asked to reach which, and when. It cannot see your screen, your
keystrokes or your clipboard: the two computers agree on their keys directly,
and everything the server carries is already encrypted. That is not a promise
about good behaviour — the server has no key material to decrypt anything with.

### Setting it up

```bash
git clone <this repository> hopdesk && cd hopdesk/server/docker
cp .env.example .env
# Fill in: your domain, an email for the certificate, and three secrets:
#   openssl rand -base64 48   → HOPDESK_TOKEN_SECRET       (signs sessions)
#   openssl rand -base64 32   → HOPDESK_TURN_SECRET        (shared with coturn)
#   openssl rand -base64 24   → HOPDESK_REGISTRATION_TOKEN (who may sign up)
# and HOPDESK_PUBLIC_IP, this machine's public address.
docker compose up -d
```

That starts three containers: the HopDesk server, Caddy (which obtains and
renews a TLS certificate for your domain by itself), and coturn (the relay).
Open ports 80 and 443 for the server, and 3478 plus UDP 49160–49200 for the
relay.

**Creating accounts needs the registration token** you put in `.env`. Anyone you
give it to can make an account; anyone who merely finds your server cannot,
including in the window between starting it and signing up yourself. Guessing it
is throttled per address. If you would rather let anyone sign up, set
`HOPDESK_REGISTRATION_OPEN=true` instead.

### Using it

In HopDesk, under *Connect*, choose **Sign in to a HopDesk server**, enter your
server address, tick *Create a new account* the first time, and paste the
registration token when it asks. Do the same on
your other computers. Each one then appears under **My computers**, and one
click connects — the person at the other end is still asked to allow it, unless
the two computers have been paired.

Signing out on a computer removes it from the account, so it can no longer be
reached through the server.

Settings has *Always connect through the server's relay*: slower, and it uses
your server's bandwidth, but the two computers never learn each other's
addresses. Otherwise HopDesk connects directly when it can and falls back to the
relay when it cannot; the session bar says which is happening.

## Connect to Windows

**On the Windows PC** (Windows 10/11 Pro, Enterprise or Education — Home
editions cannot accept remote connections):

1. Open **Settings → System → Remote Desktop** and turn it **on**.
2. Find its address: **Settings → Network & internet → Properties**, the
   *IPv4 address* (for example `192.168.1.50`). The PC name also works on most
   home networks.
3. Make sure the account you will use has a password. For a Microsoft account,
   sign in with its e-mail address and password (not the PIN).

**In HopDesk:**

1. Click **Add computer**, choose **Windows**.
2. Enter the address, your username (and domain, only if the PC is joined to
   one) and password. Keep **Remember password** ticked to save it securely.
3. Double-click the computer to connect.
4. The first time, HopDesk shows the PC's **certificate fingerprint**. Windows
   PCs use their own certificates, so this is expected. To be sure you are
   reaching the right PC, run this in PowerShell (as administrator) on the PC
   and compare:

   ```powershell
   $c = Get-ChildItem 'Cert:\LocalMachine\Remote Desktop' | Select-Object -First 1
   [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)).Replace('-',':').ToLower()
   ```

   Choose **Always trust** if they match. If the certificate ever changes,
   HopDesk warns you instead of connecting.

The Windows desktop opens in its own window, titled with the computer's name.
Close that window or press **Disconnect** in HopDesk to end the session.

## Connect to a Mac

**On the Mac:**

1. Open **System Settings → General → Sharing** and turn on **Screen Sharing**.
2. Click the **ⓘ** next to it and turn on **"VNC viewers may control screen
   with password"**, then set a password. (Only the first 8 characters count
   in the VNC protocol.)
3. Note the address shown there, for example `vnc://192.168.1.20/` or
   `studio-mac.local`.

**In HopDesk:** click **Add computer**, choose **Mac**, enter the address and
the password, and double-click to connect. Macs with Screen Sharing on also
appear under **Find on network**.

## Connect to Linux

Linux computers can offer either protocol:

* **Remote Desktop (RDP)** — GNOME: *Settings → System → Remote Desktop*.
  Other desktops: install `xrdp` (`sudo apt install xrdp`). Choose **Linux** and
  **Remote Desktop (RDP)** in HopDesk, with the Linux username and password.
* **Screen Sharing (VNC)** — any VNC server, for example TigerVNC
  (`sudo apt install tigervnc-standalone-server`, then `vncpasswd` and
  `vncserver :1 -localhost no`, which listens on port 5901) or `x11vnc` to share
  an existing X11 screen. Choose **Linux** and **Screen Sharing (VNC)**, and set
  the port the server uses.

If a firewall is enabled on that computer, allow the port: 3389 for RDP, 5900
(or 5901…) for VNC, e.g. `sudo ufw allow 3389/tcp`.

## Using a session

| | |
|---|---|
| **Screen size** | *Fit to window* scales the whole screen into the window. *Actual size* shows it pixel for pixel, with − / + to zoom. *Match window size* asks the remote computer to use the window's resolution (VNC servers that support it, and Remote Desktop). The picture is never stretched. |
| **Full screen** | The *Full screen* button, or **Ctrl+Alt+Enter**. Move the pointer to the top edge to reach the toolbar. |
| **Clipboard** | Text you copy on either side is available on the other. Any language works with Remote Desktop and with VNC servers that support Unicode clipboards (TigerVNC, RealVNC); older VNC servers accept Latin text only, and HopDesk says so when characters could not be sent. |
| **Keys** | Everything you type goes to the remote computer, including Arabic, Chinese, Japanese, Korean and emoji input. *Ctrl+Alt+Del* has its own button. |
| **Reconnect** | If the network drops, HopDesk reconnects by itself. *Disconnect* or *Cancel* stops it. |
| **Monitors** | For Remote Desktop, *Edit → Display and devices → Monitors* uses one window, all monitors, or the monitors you choose. |
| **History** | Each computer lists its own sessions: when, how long, and why a connection failed. |

When something goes wrong HopDesk says what to check — *Wrong username or
password*, *Connection refused*, *Certificate changed* — and keeps the
technical details under *Technical details* and in the log (*Settings →
Diagnostics*).

### A session with another HopDesk computer

| | |
|---|---|
| **Full screen** | The *Fullscreen* button or **F11**. **Ctrl+Alt+Enter** leaves — a way out that no remote application wants, because in full screen even Cmd and Alt+Tab go to the other computer. The toolbar hides itself; touch the top edge to bring it back. |
| **Screen size** | *Fit* shows the whole screen, letterboxed rather than cropped. *Fill* fills the window and crops. *1:1* is one remote pixel per pixel here, drawn sharp, which is what to use for a Retina Mac. |
| **The pointer** | The other computer's pointer is drawn over the picture, because macOS does not include its cursor in what it shares. Every part of that screen is reachable, including the very edges, so a Mac's Dock, its menu bar and its hot corners work. |
| **Keys** | Every key is sent as a real key press, including letters, so games and shortcuts on the other computer see them. The Super (Windows) key is Cmd on a Mac. In full screen, HopDesk holds the keyboard so shortcuts reach the other computer instead of this desktop. |
| **Clipboard** | Text copied on either side is available on the other. |

## Security

* **Passwords are encrypted.** HopDesk stores them in your system keyring
  (GNOME Keyring, KWallet). Where there is no keyring, it uses a file encrypted
  with AES-256-GCM under a passphrase you choose; a wrong passphrase is always
  rejected, and *Settings → Lock saved passwords now* locks it again.
* **No plaintext anywhere.** Passwords are never written to HopDesk's files or
  logs, never passed on a command line (where other users could read them),
  and never put in a URL.
* **Certificates are checked.** Remote Desktop connections verify the
  computer's certificate. You decide explicitly whether to trust one the
  system does not know, a trusted certificate is pinned exactly, a changed one
  triggers a warning, and editing a computer's address forgets the trust.
  Certificate checking is never switched off.
* **Locked-down app.** The interface runs sandboxed without access to files or
  the network, under a strict content security policy; only HopDesk's own
  window may use its internal interface; helper programs such as FreeRDP start
  without access to HopDesk's internal resources.

## What HopDesk cannot do yet

* **Reach computers across the internet without a server of your own.** There is
  no HopDesk service to sign up to; you run the server (above), or use a VPN
  such as Tailscale or WireGuard, or connect on the same network. Standard
  Remote Desktop and VNC connect to an address as before.
* **Be a HopDesk host on Windows or macOS.** The Host — sharing *this*
  computer's screen — is implemented for Linux on X11. Wayland needs the
  desktop portal, and Windows and macOS need their own capture and input code;
  neither is written yet.
* **Show Remote Desktop inside the HopDesk window.** It opens in FreeRDP's own
  window, which HopDesk titles, sizes and closes. The reasons are in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
* **Find Windows PCs automatically.** *Find on network* lists computers that
  announce themselves (Macs with Screen Sharing, some Linux VNC and RDP servers).
  Windows does not; add Windows PCs by address.
* **Every VNC login method.** Password and no-password VNC servers work. Apple's
  own login method (without "VNC viewers may control screen with password"),
  TLS-only and VeNCrypt servers are not supported. VNC uses the Hextile, RRE and
  CopyRect encodings, not Tight or ZRLE, so it is heavier on slow links.
* **Sound and shared folders** are passed to FreeRDP for Remote Desktop and have
  not been verified. VNC has no sound.
* **Virtual machines (SPICE)** are implemented but untested, and the SPICE
  password is not passed on.
* The AppImage runs with Chromium's sandbox disabled (`--no-sandbox`), as
  AppImages built with electron-builder do, because an AppImage cannot ship the
  setuid sandbox helper. The .deb and Flatpak keep it.
* **macOS packaging is written but unbuilt.** `packaging/build-macos.sh` builds
  signed, notarised .dmg files, and needs a Mac, a Developer ID certificate and
  notarisation credentials. Nobody has run it yet.

### What has been tested, and what has not

Tested against real servers, through the HopDesk window: TigerVNC 1.13 (screen,
keyboard including Arabic, mouse, Unicode clipboard both ways, remote resizing,
reconnect, disconnect), xrdp 0.9 with stock Ubuntu FreeRDP 2.6.1 (certificate
dialog, pinned certificate, sign-in, disconnect, no leftover processes), and
FreeRDP's own server with Network Level Authentication (wrong and right
password). The .deb and AppImage packages were built and their packaged apps
connected to TigerVNC. The Flatpak was built, installed and launched as a
normal (non-root) user, and from inside it connected to TigerVNC and — through
its bundled FreeRDP 3.31.1 — to xrdp, with the certificate dialog, sign-in and
disconnect.

HopDesk-to-HopDesk was tested between two real HopDesk applications on Linux
(X11): turning remote access on, connecting by Device ID and access code, the
Allow prompt, a live WebRTC session showing the other computer's screen, mouse
movement and keystrokes arriving in an application there, the clipboard
arriving on its system clipboard, finding the computer by Device ID alone over
mDNS, resuming by itself after the network was cut, a wrong access code being
refused without prompting anyone, Reject being honoured, and turning remote
access off closing the door.

The server was tested as it ships: the image built, the container ran, accounts
and sign-in worked against it, and its own suite covers registration, sign-in
throttling, rotating refresh tokens (including detecting a replayed one), device
enrolment with proof of key, what a device token may and may not do, and the
relay refusing everything it should. Two HopDesk applications signed in to a
server running here, found each other under *My computers*, and connected
through it — with the relay forced on, the media went through a real coturn
container, which logged the traffic it carried. The bundled TURN credentials
were checked against coturn directly: ours are accepted, a wrong one is not.

The AppImage and the .deb were built and **started**, and two packaged copies
connected to each other — screen, consent and mouse control included. That test
is what caught three bundling mistakes that looked fine in development: a
missing D-Bus library, koffi's JavaScript, and koffi's native binary, which
cannot be loaded from inside an asar archive. The Flatpak's dependency list was
regenerated for the new packages with flatpak-node-generator, but **the Flatpak
itself was not rebuilt** (flatpak-builder is not installed here).

On a Wayland desktop, **controlling** the computer was tested on a real GNOME
session: the desktop's own permission dialog, then the pointer, scrolling and
typing — including Arabic — arriving in the focused window. **Seeing** that
desktop is another matter: Electron cannot capture it without its Wayland
backend, which crashes (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), so a
Wayland computer can be controlled but shows only its X11 windows. HopDesk says
so in the interface rather than quietly sharing an almost-empty screen.

**Not tested: a real deployment on a domain across the internet** (the
certificate step, and NAT traversal between two different networks), **a real
Windows PC, and a real Mac** — as a computer to connect to, or as a HopDesk
host. The steps above follow how those systems work, but no session with either
has been established during development.

## For developers

Needs Node 20+.

```bash
npm install
npm run build
npm start            # builds, then runs Electron
npm test
npm run lint
npm run typecheck
```

`npm start` clears `ELECTRON_RUN_AS_NODE`, which VS Code's terminal sets and
which otherwise turns Electron into plain Node.

### Tests and what they need

| Tests | Needs |
|---|---|
| `packages/core/test/{vnc-updates,vnc-extensions,rdp,errors,model,credentials,connections,settings,discovery,spawn}.test.mjs`, `apps/desktop/test/{keymap,ipc-guard}.test.mjs` | Nothing external. VNC uses a scripted in-process RFB server, RDP a stand-in `xfreerdp` and the real help output of FreeRDP 2.6.1 and 3.31 as fixtures, discovery a fake mDNS responder. `openssl` makes a test certificate; `spawn.test.mjs` uses the installed Electron. |
| `packages/core/test/{rfb,session}.test.mjs` | A **real VNC server on 127.0.0.1:5901**, 1024×768, password `testpass`. They fail without it. |
| `packages/core/test/engines.test.mjs`, parts of `rdp.test.mjs` | FreeRDP installed. |
| `apps/desktop/test/{electron,electron-ui}.test.mjs` | A display (`DISPLAY` or `WAYLAND_DISPLAY`); skipped without one. They launch the real app and drive it through the DevTools protocol, using the encrypted vault, never your keyring. |
| Live RDP tests in `rdp.test.mjs` | Opt-in: `HOPDESK_RDP_TEST=host:port:user:password` (xrdp) and `HOPDESK_RDP_NLA_TEST=…` (NLA). |

The servers the integration tests use:

```bash
# VNC on 5901
sudo apt install tigervnc-standalone-server tigervnc-tools
mkdir -p ~/.vnc && printf 'testpass\ntestpass\nn\n' | vncpasswd ~/.vnc/passwd
Xtigervnc :1 -geometry 1024x768 -depth 24 -rfbport 5901 -localhost \
  -PasswordFile ~/.vnc/passwd -SecurityTypes VncAuth &

# RDP (TLS, self-signed certificate)
docker build -t hopdesk-test-xrdp test-servers/xrdp
docker run -d --name hopdesk-xrdp -p 127.0.0.1:13389:3389 hopdesk-test-xrdp

# RDP with Network Level Authentication
docker build -t hopdesk-test-nla test-servers/freerdp-nla
docker run -d --name hopdesk-nla -p 127.0.0.1:13390:3389 hopdesk-test-nla

HOPDESK_RDP_TEST='127.0.0.1:13389:rdpuser:RdpPass!23' \
HOPDESK_RDP_NLA_TEST='127.0.0.1:13390:nlauser:NlaPass!45' npm test
```

### Packages

```bash
./packaging/build-appimage.sh                # AppImage and .deb → dist-packages/
flatpak-builder --user --install-deps-from=flathub --install build packaging/io.hopdesk.HopDesk.yml
```

* The build script runs a pinned electron-builder through `npx` and never
  changes `package.json`. `HOPDESK_HOMEPAGE` overrides the homepage the `.deb`
  names, for a fork publishing its own packages.
* Pushing a tag such as `v0.2.0` builds both packages, starts two of them and
  connects them, and only then attaches them to a GitHub release
  (`.github/workflows/release.yml`).
* The Flatpak builds offline on the Freedesktop 25.08 runtime, with FreeRDP
  3.31.1 compiled in (checksum from the release's published `.sha256`). npm packages and Electron come from
  `packaging/generated-sources.json`; regenerate it with `flatpak-node-generator
  npm package-lock.json --electron-node-headers -o packaging/generated-sources.json`
  whenever `package-lock.json` changes. The build host needs `flatpak-builder`,
  `elfutils`, an SVG pixbuf loader (`librsvg2-common`) and a running D-Bus
  (system and session) for the install step.

### Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the components, why VNC is
implemented here and RDP runs through FreeRDP, and the (unimplemented) design
for a HopDesk Host, NAT traversal and an end-to-end-encrypted relay.

## Licence

GPL-3.0-or-later.
