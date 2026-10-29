# The authorization service as a Cloudflare Worker

The free way to run the part of HopDesk that can disable an installation: HTTPS
on `*.workers.dev` with no domain of your own, a database that survives
restarts, and nothing to keep awake.

It answers one question — may this installation run? — and administers that
answer. **The account API and the relay are not here** and cannot be: a relay
needs a socket held open and a password needs a deliberately slow hash. Those
stay on the Node server (`server/docker/`).

## What goes where

| | |
|---|---|
| `HOPDESK_AUTH_SIGNING_KEY` | **A Worker secret.** The half that signs. Never in `wrangler.jsonc`, never in the repository, never pasted into a chat or a terminal that echoes |
| `hdpk_…` public key | Compiled into the desktop build. Verifies answers, cannot produce them. Safe to publish |
| Admin token | Shown once when you create it, stored only as a SHA-256 hash |

## Setting it up

```bash
cd services/auth-worker
npm install
npx wrangler login                     # opens a browser; needs your Cloudflare account

# The tables. Local first, then the real database.
npm run schema:local
npm run schema

# The signing key. Generated and piped in, so it is never displayed.
openssl rand -base64 48 | npx wrangler secret put HOPDESK_AUTH_SIGNING_KEY
```

Then deploy and check:

```bash
npx wrangler deploy
curl https://hopdesk-auth.<your-subdomain>.workers.dev/api/health
# {"ok":true,"authorization":"ready"}   <- "no-signing-key" means the secret is missing
```

## Your first administrator

There is no route that creates administrators — an endpoint that mints them is
an endpoint somebody else can use once. Make one with database access instead,
and note that only its *hash* ever leaves your machine:

Mind the leading spaces: with `HISTCONTROL=ignorespace` (the default on most
distributions) a command beginning with a space stays out of your shell
history, which is where the token would otherwise sit in plain text.

```bash
 TOKEN="hda_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
 HASH=$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('base64'))" "$TOKEN")
 UUID=$(cat /proc/sys/kernel/random/uuid)

 npx wrangler d1 execute hopdesk-admin --remote --command \
   "insert into admins (id, email, token_hash, created_at) values ('$UUID','you@example.com','$HASH',$(date +%s)000)"

 printf '%s\n' "$TOKEN" > ~/.hopdesk-admin-token && chmod 600 ~/.hopdesk-admin-token
 unset TOKEN HASH
```

Open `~/.hopdesk-admin-token`, copy the value into your password manager, then
delete the file. Only its SHA-256 hash is in the database, so losing it means
making another administrator, not recovering this one.

## Running it

```bash
BASE=https://hopdesk-auth.<your-subdomain>.workers.dev
curl -H "Authorization: Bearer $TOKEN" $BASE/api/admin/installations
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"licence shared"}' $BASE/api/admin/installations/HD-XXXX-XXXX/block
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/api/admin/installations/HD-XXXX-XXXX/unblock
curl -H "Authorization: Bearer $TOKEN" $BASE/api/admin/installations/HD-XXXX-XXXX/history
curl -H "Authorization: Bearer $TOKEN" $BASE/api/admin/service-key
```

## Building HopDesk against it

```bash
HOPDESK_AUTH_URL=https://hopdesk-auth.<your-subdomain>.workers.dev \
HOPDESK_AUTH_PUBLIC_KEY=hdpk_… \
HOPDESK_AUTH_REQUIRED=1 \
  node apps/desktop/scripts/write-build-config.mjs
node apps/desktop/scripts/check-build-config.mjs
```

## What this does not reach

The same limits as any client-side check, written down in
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md): versions released before the
check existed, builds with it removed, and a computer kept offline until its
grace window runs out. On top of those, a Worker cannot end a session already
running — there is no relay here to cut.

Free-plan ceilings that matter: **100,000 requests a day** and **10 ms CPU per
request** (an answer costs about 2 ms of signing), **500 MB** per database.
An installation asks twice a day, so a hundred computers is a few hundred
requests a day.
