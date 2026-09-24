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
