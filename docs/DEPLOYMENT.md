# Running HopDesk's authorization service

This is the guide for whoever runs HopDesk, rather than for whoever uses it.
It covers the server, its secrets, the one key that has two halves, making
yourself an administrator, building packages that answer to you, and the
day-to-day of disabling a copy and letting it back in.

If you only want two computers on one network to reach each other, you need
none of this. HopDesk does that with no server and no account.

## What this buys, and what it cannot

Blocking reaches a computer in two different ways, and they are worth keeping
apart in your head.

**Through the server.** Any connection that needs the server — an account,
the relay — is refused by the server itself. This works on *every* version of
HopDesk, including ones installed before any of this existed, because the
client is not being asked to cooperate. A connection already open is closed
within half a minute.

**On a local network.** Two computers on one network never touch the server,
so only the computer itself can refuse. A build made with your service asks
it every six hours and stops hosting when the answer is no — or when it
cannot get an answer for longer than the grace window. This cannot reach a
version released before the check existed, or a build somebody made with the
check removed, because HopDesk's source is public.

Both of those are honest limits, not gaps waiting to be closed.

## 1. The server

Follow [server/docker/README.md](../server/docker/README.md) first: a VPS, a
domain name, three ports and `docker compose up -d`. Come back here once
`curl https://your-server/api/health` answers `{"ok":true}`.

## 2. The signing key, and its two halves

The server signs every answer it gives about an installation. One key, two
halves, and the difference matters more than anything else in this document:

| | |
|---|---|
| **`HOPDESK_AUTH_SIGNING_KEY`** | The half that signs. Lives in `.env` on the server and **nowhere else, ever.** Not in a build, not in the repository, not in a GitHub secret used by a build |
| **The `hdpk_…` public key** | The half that verifies. Compiled into every package. Safe to copy, paste and publish — it cannot produce an answer, only check one |

Generate the signing half and restart:

```bash
cd HopDesk/server/docker
openssl rand -base64 48        # put this in .env as HOPDESK_AUTH_SIGNING_KEY
docker compose up -d
```

Then ask the server for the public half:

```bash
docker compose exec server npm run admin -- service-key
```

It prints something like `hdpk_6SYa0E7VA…` and the command to build with it.
The `hdpk_` prefix is not decoration: both halves are 32 bytes of base64, and
the build script refuses anything without that prefix, so the one
unrecoverable mistake — shipping the signing half to every user — cannot be
made by pasting the wrong variable.

Also in `.env`:

```bash
HOPDESK_AUTH_GRACE_HOURS=168   # how long a computer may go unanswered: 7 days
```

Lower is stricter and breaks offline use sooner. `0` means HopDesk cannot host
at all without reaching your server. Whatever you set, a client will not honour
an answer for more than thirty days.

## 3. Make yourself an administrator

```bash
docker compose exec server npm run admin -- create-admin you@example.com
```

That prints a token **once** and stores only its hash. Keep it in a password
manager. Losing it means making another administrator, not recovering this one.

There is deliberately no HTTP route that creates administrators: an endpoint
that mints them is an endpoint somebody else can use once. What protects this
command is that running it needs your server's environment and database.

## 4. Build packages that answer to you

Two repository secrets and one variable, set once:

| Kind | Name | Value |
|---|---|---|
| Secret | `HOPDESK_AUTH_URL` | `https://your-server.example.com` |
| Secret | `HOPDESK_AUTH_PUBLIC_KEY` | the whole `hdpk_…` string |
| Variable | `HOPDESK_ENFORCE_AUTHORIZATION` | `1` |

```bash
gh secret set HOPDESK_AUTH_URL
gh secret set HOPDESK_AUTH_PUBLIC_KEY
gh variable set HOPDESK_ENFORCE_AUTHORIZATION --body 1
```

(`gh secret set` with no value reads from standard input, so the value need
not appear in your shell history.)

With the variable set, a build that cannot check **fails** rather than going
out looking like one that can, and the release notes say that these packages
answer to your service. With it unset, packages are built with no service and
the notes say *that* — which is the right default until the server exists, and
is never silent either way.

To build one by hand:

```bash
HOPDESK_AUTH_URL=https://your-server.example.com \
HOPDESK_AUTH_PUBLIC_KEY=hdpk_… \
HOPDESK_AUTH_REQUIRED=1 \
  node apps/desktop/scripts/write-build-config.mjs
bash packaging/build-appimage.sh
node apps/desktop/scripts/check-build-config.mjs      # what did it actually carry?
```

`build-config.ts` is rewritten in place by that script. `git checkout` it when
you are done, or your next build keeps the same configuration.

## 5. Running it

Everything below works over HTTP with the administrator token as well; the
command line is the same thing with the database to hand.

```bash
cd HopDesk/server/docker
A="docker compose exec server npm run admin --"

$A list                                   # every installation and computer, with status
$A block HD-XXXX-XXXX "licence shared"    # disable one computer
$A unblock HD-XXXX-XXXX
$A history HD-XXXX-XXXX                   # everything ever done to it, and by whom
$A block-account someone@example.com "not paid"
$A unblock-account someone@example.com
$A service-key                            # the public half, again
```

Over HTTP:

```bash
T="Authorization: Bearer hda_…"
curl -H "$T" https://your-server/api/admin/installations
curl -X POST -H "$T" -H 'content-type: application/json' \
  -d '{"reason":"licence shared"}' \
  https://your-server/api/admin/installations/HD-XXXX-XXXX/block
curl -X POST -H "$T" https://your-server/api/admin/installations/HD-XXXX-XXXX/unblock
curl -H "$T" https://your-server/api/admin/installations/HD-XXXX-XXXX/history
```

**Which to block.** Blocking an *installation* stops that one copy, on the
network and through the server, and survives a reinstall as long as it keeps
its identity key. Blocking an *account* stops the person: every computer on it
loses the relay within half a minute, and none of them can sign in again. Use
the account when you mean the person, because a computer can be re-registered
with a new identity key and an account cannot be re-made.

**What a person sees.** A blocked copy says so in a banner, with your reason
if you gave one, and refuses to accept *or* make HopDesk connections. A
blocked account is told it has been disabled when it tries to sign in, rather
than being signed in to something where nothing works.

## 6. Looking after the key

- `.env` is a backup-worthy secret. Changing `HOPDESK_AUTH_SIGNING_KEY` makes
  every build that carries the old public half unable to verify anything — they
  fall back to the grace window and then stop hosting. Treat it as permanent.
- Back up `hopdesk-data` (accounts, devices, installations, history).
- The administrator token is a bearer credential with no expiry. Make one per
  person, not one shared.

## 7. Updates

HopDesk tells people when a newer version exists and opens the download page.
It does **not** install anything: a `.deb` needs root, which HopDesk will not
ask for, and a `.dmg` has to be dragged. Installing in place would need an apt
repository (Linux) or Squirrel with an Apple Developer ID (macOS); neither is
built here, and neither should be described as working until it has been seen
to work on a real machine.
