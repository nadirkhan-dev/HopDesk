#!/usr/bin/env node
/**
 * Administering a HopDesk server from the machine it runs on.
 *
 * Creating the first administrator is the one thing that cannot be done over
 * the network: an endpoint that mints administrators is an endpoint that
 * anybody can use once, and "only before the first one exists" is a race, not
 * a rule. So it happens here instead.
 *
 * What makes that safe is not a password typed into this command - it is that
 * running it at all requires the server's own environment and its database.
 * `loadConfig` refuses to start without `HOPDESK_TOKEN_SECRET`, the secret the
 * deployment was built with, so anyone able to run this is already inside the
 * server. An extra secret of its own would look like a second lock on the same
 * door, and reading like security is worse than not claiming it.
 *
 *   hopdesk-admin create-admin you@example.com
 *   hopdesk-admin list
 *   hopdesk-admin block HD-XXXX-XXXX "sharing the licence"
 *   hopdesk-admin unblock HD-XXXX-XXXX
 *   hopdesk-admin history HD-XXXX-XXXX
 *   hopdesk-admin service-key
 *
 * The token it prints is shown once and stored only as a hash. Losing it means
 * creating another administrator, not recovering this one.
 */
import { randomBytes, createHash } from 'node:crypto';
import { identityFromSecretKey, toBase64 } from '@hopdesk/crypto';
import { loadConfig } from './config.js';
import { Store } from './store.js';

/* The same hashing the server does, or the token it prints would never be
   recognised. */
const hash = (token: string) => createHash('sha256').update(token).digest('base64');

function usage(): never {
  process.stderr.write(`hopdesk-admin — administer this HopDesk server

  create-admin <email>              make an administrator and print its token once
  list                              every installation and device, with status
  block <installation-id> [reason]  disable an installation
  unblock <installation-id>         let it run again
  history <installation-id>         what was done to it, and by whom
  service-key                      the public key a build must be made with

Run this on the server, with the server's environment: it reads the same
configuration the server does and writes to the same database, which is the
reason it can be trusted to make an administrator and an HTTP route cannot.
`);
  process.exit(2);
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  const config = loadConfig();
  const store = new Store(config.dataDir);
  const now = Date.now();

  switch (command) {
    case 'create-admin': {
      const email = args[0];
      if (!email || !email.includes('@')) usage();
      const token = `hda_${randomBytes(32).toString('base64url')}`;
      const admin = store.createAdmin(email, hash(token), now);
      store.recordAdminEvent(email, 'create-admin', admin.id, null, now);
      process.stdout.write(`Administrator ${email} created.\n\n  ${token}\n\n`
        + 'That token is shown once and stored only as a hash. Keep it somewhere safe;\n'
        + 'it is the credential for every administrative request.\n');
      break;
    }

    case 'list': {
      const installations = store.allInstallations();
      const devices = store.allDevices();
      process.stdout.write(`${installations.length} installation(s):\n`);
      for (const i of installations) {
        const status = i.blockedAt !== null ? `blocked (${i.blockedReason ?? 'no reason given'})` : 'active';
        process.stdout.write(`  ${i.installationId}  ${(i.os ?? '?').padEnd(8)} ${String(i.appVersion ?? '?').padEnd(8)} ${status}\n`);
      }
      process.stdout.write(`\n${devices.length} account device(s):\n`);
      for (const d of devices) {
        const status = d.blockedAt !== null ? 'blocked' : (d.approved ? 'active' : 'waiting for approval');
        process.stdout.write(`  ${d.deviceId}  ${d.name.padEnd(24)} ${status}\n`);
      }
      break;
    }

    case 'block':
    case 'unblock': {
      const id = args[0];
      if (!id) usage();
      const known = store.installationById(id) || store.deviceById(id);
      if (!known) {
        process.stderr.write(`No installation or device with id ${id}.\n`);
        process.exit(1);
      }
      const reason = args.slice(1).join(' ') || null;
      if (command === 'block') {
        store.blockInstallation(id, now, reason, 'cli');
        store.blockDevice(id, now, reason, 'cli');
        store.recordAdminEvent('cli', 'block', id, reason, now);
        process.stdout.write(`${id} is blocked.\n\n`
          + 'Its credential is dead now: it cannot sign in, reach the relay, or be\n'
          + 'introduced to anything. A connection it is holding open is closed by the\n'
          + 'server within half a minute, and the relayed session it was carrying ends\n'
          + 'with it. A session between two computers on the same network ends when that\n'
          + 'computer next checks - within the grace window - and not at all on a version\n'
          + 'of HopDesk released before the check existed.\n');
      } else {
        store.unblockInstallation(id);
        store.unblockDevice(id);
        store.recordAdminEvent('cli', 'unblock', id, reason, now);
        process.stdout.write(`${id} may run again.\n`);
      }
      break;
    }

    /* The other half of HOPDESK_AUTH_SIGNING_KEY. The server signs its
       answers with the secret; a build has to carry the public half or it has
       nothing to check them against, and there would otherwise be no way to
       find out what it is. Public by nature: it verifies, it cannot sign. */
    case 'service-key': {
      if (!config.authSigningKey) {
        process.stderr.write('No authorization service: HOPDESK_AUTH_SIGNING_KEY is not set.\n'
          + 'Set it in .env (openssl rand -base64 48) and restart the server first.\n');
        process.exit(1);
      }
      const publicKey = toBase64(identityFromSecretKey(config.authSigningKey).publicKey);
      process.stdout.write(`${publicKey}\n\n`
        + 'Build HopDesk against this server with:\n\n'
        + `  HOPDESK_AUTH_URL=https://your-server.example.com \\\n`
        + `  HOPDESK_AUTH_PUBLIC_KEY=${publicKey} \\\n`
        + '    node apps/desktop/scripts/write-build-config.mjs\n\n'
        + 'It verifies answers and cannot produce them, so it is safe to copy about.\n');
      break;
    }

    case 'history': {
      const id = args[0];
      if (!id) usage();
      const events = store.adminEventsFor(id);
      if (!events.length) process.stdout.write(`Nothing has been done to ${id}.\n`);
      for (const event of events) {
        process.stdout.write(`  ${new Date(event.at).toISOString()}  ${event.action.padEnd(16)}`
          + ` by ${event.actor}${event.reason ? ` — ${event.reason}` : ''}\n`);
      }
      break;
    }

    default:
      usage();
  }

  store.close();
}

main();
