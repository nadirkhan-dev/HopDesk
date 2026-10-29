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
 *   hopdesk-admin block-account someone@example.com "not paid"
 *   hopdesk-admin unblock-account someone@example.com
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

/** Marks the half of the key that is safe to put in a build. See service-key. */
const PUBLIC_KEY_PREFIX = 'hdpk_';

function usage(): never {
  process.stderr.write(`hopdesk-admin — administer this HopDesk server

  create-admin <email>              make an administrator and print its token once
  list                              every installation and device, with status
  block <installation-id> [reason]  disable an installation
  unblock <installation-id>         let it run again
  block-account <email> [reason]    disable an account and every computer on it
  unblock-account <email>           let the account in again
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
        const account = store.accountById(d.accountId);
        const status = d.blockedAt !== null ? 'blocked'
          : account?.blockedAt != null ? 'blocked with its account'
            : (d.approved ? 'active' : 'waiting for approval');
        process.stdout.write(`  ${d.deviceId}  ${d.name.padEnd(24)} ${(account?.email ?? '?').padEnd(28)} ${status}\n`);
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
      /* Printed with a prefix, and accepted only with it by the build script.
         The signing key and the public key are both 32 bytes of base64, and
         the one mistake that must not be possible is pasting the signing key
         into a build - it would ship the server's private half to every user,
         silently and irrecoverably. A prefix only the public half is ever
         given makes that a refusal instead of a disaster. */
      const publicKey = `${PUBLIC_KEY_PREFIX}${toBase64(identityFromSecretKey(config.authSigningKey).publicKey)}`;
      process.stdout.write(`${publicKey}\n\n`
        + 'Build HopDesk against this server with:\n\n'
        + `  HOPDESK_AUTH_URL=https://your-server.example.com \\\n`
        + `  HOPDESK_AUTH_PUBLIC_KEY=${publicKey} \\\n`
        + '    node apps/desktop/scripts/write-build-config.mjs\n\n'
        + 'This key verifies answers and cannot produce them, so it is safe to copy about,\n'
        + 'to paste into a build, and to publish. HOPDESK_AUTH_SIGNING_KEY is the half that\n'
        + 'must never leave this server.\n');
      break;
    }

    /* Blocking a person rather than a computer. Decisive for anything through
       this server: every computer on the account loses the relay at once, and
       none of them can sign in again. It does not reach a session between two
       computers on one local network - that is what blocking an installation
       is for. */
    case 'block-account':
    case 'unblock-account': {
      const email = args[0];
      if (!email) usage();
      const account = store.accountByEmail(email);
      if (!account) {
        process.stderr.write(`No account with the address ${email}.\n`);
        process.exit(1);
      }
      const devices = store.devicesOfAccount(account.id);
      const reason = args.slice(1).join(' ') || null;
      if (command === 'block-account') {
        store.blockAccount(account.id, now, reason, 'cli');
        store.recordAdminEvent('cli', 'block-account', account.id, reason, now);
        for (const device of devices) store.recordEvent('cli', 'block-by-account', device.deviceId, reason, now);
        process.stdout.write(`${email} is blocked, with ${devices.length} computer(s) on it.\n\n`
          + 'None of them can sign in or reach the relay. The connections they are holding\n'
          + 'are closed by the server within half a minute, and the relayed sessions end with\n'
          + 'them. Sessions on a local network are not reached by this - block the\n'
          + 'installations for that.\n');
      } else {
        store.unblockAccount(account.id);
        store.recordAdminEvent('cli', 'unblock-account', account.id, reason, now);
        process.stdout.write(`${email} may sign in again. Its computers reconnect by themselves.\n`);
      }
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
