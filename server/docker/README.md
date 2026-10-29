# Running your own HopDesk server

This directory runs the whole thing: the rendezvous server, a web server that
gets its own TLS certificate, and a relay for connections that cannot go
direct. Three containers, one command.

You need a server only to reach computers that are **not on the same network**.
Two computers on one network find each other by themselves, with no server and
no account.

## What it is for, and what it can see

The server introduces two computers on the same account and then forwards
whatever they send each other. It **cannot read a session**: the keys are
established between the two computers, and the server holds none of them. It
does learn which of your computers are online, which one asked to reach which,
and when — that is unavoidable for anything that makes introductions.

## What you need

**A VPS.** The server itself is small; the relay is what uses resources, and
only for sessions that cannot go direct.

| | CPU | RAM | Traffic |
|---|---|---|---|
| A few computers, direct connections usual | 1 vCPU | 512 MB | a few GB/month |
| Regular relayed sessions (1–2 at a time) | 1 vCPU | 1 GB | 25–50 GB/month |
| Several relayed sessions at once | 2 vCPU | 2 GB | 100 GB+/month |

A relayed screen-sharing session carries roughly **1–3 Mbit/s each way**, so it
is bandwidth, not CPU, that decides the size. Anything that gives you 1 vCPU
and a public IPv4 address is enough to start: Hetzner CX22, DigitalOcean's
smallest droplet, a Lightsail instance. Debian 12 or Ubuntu 24.04.

**A domain name**, or a subdomain of one you have. Certificates need a name;
an IP address alone will not do.

**Docker** with the compose plugin:

```bash
curl -fsSL https://get.docker.com | sh
```

## DNS

One record, pointing at the server's public IPv4 address:

| Type | Name | Value |
|---|---|---|
| A | `hopdesk` (→ `hopdesk.example.com`) | your server's IPv4 address |

Add an `AAAA` record with the IPv6 address as well if the machine has one.
Wait until `dig +short hopdesk.example.com` answers with your address before
starting — Caddy asks Let's Encrypt for a certificate immediately, and a
failed attempt is rate-limited.

## Ports

Open these in the provider's firewall (and in `ufw`, if you use it):

| Port | Protocol | For |
|---|---|---|
| 80 | TCP | The certificate check, and redirecting to HTTPS |
| 443 | TCP | The account API and the WebSocket rendezvous |
| 3478 | TCP **and** UDP | The relay (coturn) |
| 49160–49200 | UDP | The relay's media ports |

The UDP range is what relayed sessions actually travel over; without it, a
session that cannot go direct will appear to connect and then carry nothing.
Widen it if you expect many simultaneous sessions — each needs a port.

```bash
ufw allow 80,443,3478/tcp && ufw allow 3478/udp && ufw allow 49160:49200/udp
```

## Starting it

```bash
git clone https://github.com/nadirkhan-dev/HopDesk.git
cd HopDesk/server/docker
cp .env.example .env
```

Fill in `.env` — every secret has the command that generates it beside it:

```bash
openssl rand -base64 48   # HOPDESK_TOKEN_SECRET       signs sessions
openssl rand -base64 32   # HOPDESK_TURN_SECRET        the relay's secret
openssl rand -base64 24   # HOPDESK_REGISTRATION_TOKEN who may create an account
```

Set `HOPDESK_DOMAIN`, `HOPDESK_ACME_EMAIL`, `HOPDESK_PUBLIC_IP` (the server's
own address), and point `HOPDESK_TURN_URLS` at your domain. To depend on nobody
else at all, set `HOPDESK_STUN_URLS=stun:your-domain:3478` so your own coturn
is used for finding a direct path too, instead of Google's.

```bash
docker compose up -d
curl https://hopdesk.example.com/api/health      # {"ok":true}
```

Then in HopDesk: **Sign in to a HopDesk server**, your domain, and the
registration token the first time.

**Leave `HOPDESK_REGISTRATION_OPEN=false`.** With a registration token, nobody
who merely finds your server can create an account — including in the minutes
between starting it and signing up yourself.

## After the first computer

The first computer on an account vouches for itself. Every one after it waits
until a computer already on the account approves it, showing its fingerprint.
So signing in on a new machine is two steps: sign in there, then press
**Approve** on one you already use. A computer waiting is refused the relay
entirely until then.

## Disabling an installation

The server can disable a copy of HopDesk: its credential stops working, the
socket it is holding is closed, and the sessions being relayed through it end.
Read the limits at the end of this section before relying on it — some of them
are properties of running software on somebody else's computer, and no amount
of server will fix them.

Switch the service on by setting `HOPDESK_AUTH_SIGNING_KEY` in `.env`
(`openssl rand -base64 48`), then make yourself an administrator:

```bash
docker compose exec server npm run admin -- create-admin you@example.com
```

That prints a token once. It is stored only as a hash, so keep it; losing it
means making another administrator, not recovering this one.

What makes that command safe is not a password it asks for — it asks for none.
It is that running it needs this server's own environment and database, which
is also why there is no HTTP route that creates administrators.

```bash
docker compose exec server npm run admin -- list
docker compose exec server npm run admin -- block HD-XXXX-XXXX "licence shared"
docker compose exec server npm run admin -- unblock HD-XXXX-XXXX
docker compose exec server npm run admin -- history HD-XXXX-XXXX
```

To make a build that asks *this* server, it needs the public half of the
signing key — the server has the secret half, and a build cannot check a
signature without the other one:

```bash
docker compose exec server npm run admin -- service-key
```

That prints the key and the command to build with it. It verifies answers and
cannot produce them, so it is not a secret.

The same things over HTTP, with the token:

```bash
curl -H "Authorization: Bearer hda_…" https://hopdesk.example.com/api/admin/installations
curl -X POST -H "Authorization: Bearer hda_…" -H 'content-type: application/json' \
  -d '{"reason":"licence shared"}' \
  https://hopdesk.example.com/api/admin/installations/HD-XXXX-XXXX/block
```

`history` is the life of one computer, newest first: when it joined the
account and under what name, which computer approved it, when it was removed,
and every block or unblock with the reason and who did it. Kept for two years
and then forgotten, because a record of who connected what to what, kept for
ever, is its own kind of problem.

### What blocking reaches, and what it does not

| | |
|---|---|
| New connections through this server (account/relay) | **Stopped at once**, on any version of HopDesk, including ones installed before this existed — the server refuses rather than asking the client to |
| A connection it is already holding | Closed **within half a minute**: the server checks every connected computer against the register of blocks, so a block takes effect however it was applied. The HTTP route closes it immediately; `hopdesk-admin` runs in another process and cannot, so it waits for that sweep |
| The relayed session that connection was carrying | Ends when the connection does. A current HopDesk tears the session down when it loses the relay; media that has already found its way through coturn is between the two computers and coturn, so a **modified** client could keep it flowing until its relay credentials expire — `HOPDESK_TURN_TTL_SECONDS`, one hour by default |
| Connections on a local network, on a build that asks this server | Stopped when that computer next checks — within `HOPDESK_AUTH_GRACE_HOURS`, or within six hours if it is running and online |
| Connections on a local network, on an **older** build | **Not reachable.** Those versions ask nothing and cannot be told anything. Only installing a build that checks changes that |
| A build someone made themselves with the check removed | **Not reachable.** HopDesk's source is public |
| A computer kept offline | Unreachable until its grace window runs out, then it stops hosting. Its clock is its own, so moving it backwards extends that window — the same class of thing as editing the check out, and bounded by a ceiling of thirty days whatever the server said |

A block is per *installation*, identified by its identity key. Wiping
`~/.local/share/hopdesk` produces a new installation. To stop a person rather
than a computer, block their account — which, for anything going through this
server, is decisive:

```bash
curl -X POST -H "Authorization: Bearer hda_…" \
  https://hopdesk.example.com/api/admin/accounts/<account-id>/block
```

## Looking after it

```bash
docker compose logs -f server     # what it is doing
docker compose pull && docker compose up -d --build   # update
```

**Back up `hopdesk-data`.** It holds the accounts, the device registry and the
approvals — losing it means everyone signs in and approves again:

```bash
docker run --rm -v hopdesk_hopdesk-data:/data -v "$PWD:/backup" \
  alpine tar czf /backup/hopdesk-data.tar.gz -C /data .
```

Keep `.env` with it, somewhere private: it holds the token secret, and
changing that signs everyone out.

## When something does not work

**The certificate never arrives.** `docker compose logs caddy`. Almost always
DNS: the name has to resolve to this machine before Caddy asks, and port 80
has to be reachable.

**Computers sign in but sessions do not connect.** That is the relay, and
almost always the UDP range. Check `docker compose logs coturn`, confirm
`HOPDESK_PUBLIC_IP` is the address the internet sees (`curl ifconfig.me`), and
that 49160–49200/udp is open in the provider's firewall as well as the
server's.

**A computer says it is waiting to be approved.** It is. Approve it from a
computer already on the account; it connects by itself within half a minute.

## Before you invite anyone else

- A registration token, not open registration.
- The UDP range open, and tested with two computers on different networks.
- `hopdesk-data` backed up somewhere other than this server.
- Enough bandwidth allowance for the relayed sessions you expect: the table
  above, times the number of people.
