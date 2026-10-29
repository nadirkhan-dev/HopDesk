#!/usr/bin/env node
/**
 * Writes the authorization service into the source, before it is compiled.
 *
 * Run by the release build, so an official package asks the service it was
 * built for and checks the answer against a key it carries. A build from source
 * with neither variable set leaves the file as the repository has it - both
 * null, no service, nothing sent anywhere.
 *
 *   HOPDESK_AUTH_URL=https://hopdesk.example.com \
 *   HOPDESK_AUTH_PUBLIC_KEY=<base64 Ed25519 public key> \
 *     node apps/desktop/scripts/write-build-config.mjs
 *
 * Refuses rather than guesses:
 *
 * - A URL without a key would produce a build that reports where it is but
 *   believes whatever it is told.
 * - A key that is not 32 bytes is not an Ed25519 public key.
 * - A key without the `hdpk_` prefix that `hopdesk-admin service-key` prints
 *   is refused outright. The signing key and the public key are both 32 bytes
 *   of base64, so without that marker the one unrecoverable mistake - pasting
 *   the server's signing key into a build, and shipping its private half to
 *   every user - would look exactly like doing it right.
 * - `HOPDESK_AUTH_REQUIRED=1` turns "no service configured" from a note into
 *   an error, so a release meant to enforce blocking cannot be built without
 *   it by accident.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The file to rewrite. Overridable only so that the refusals below can be
   tested without touching the one the build uses. */
const file = process.env.HOPDESK_BUILD_CONFIG_FILE
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/build-config.ts');
const PUBLIC_KEY_PREFIX = 'hdpk_';

const url = process.env.HOPDESK_AUTH_URL?.trim();
const raw = process.env.HOPDESK_AUTH_PUBLIC_KEY?.trim();
const required = /^(1|true|yes)$/i.test(process.env.HOPDESK_AUTH_REQUIRED?.trim() ?? '');

if (!url && !raw) {
  if (required) {
    process.stderr.write('HOPDESK_AUTH_REQUIRED is set, but HOPDESK_AUTH_URL and '
      + 'HOPDESK_AUTH_PUBLIC_KEY are not.\n'
      + 'This build is meant to enforce blocking and would enforce nothing. Refusing.\n');
    process.exit(1);
  }
  process.stdout.write('No authorization service configured; this build asks nobody.\n');
  process.exit(0);
}
if (!url || !raw) {
  process.stderr.write('HOPDESK_AUTH_URL and HOPDESK_AUTH_PUBLIC_KEY must be set together:\n'
    + '  a URL without a key builds something that reports where it is and believes anything it is told.\n');
  process.exit(1);
}
if (!/^https:\/\//.test(url)) {
  process.stderr.write(`HOPDESK_AUTH_URL must be https: ${url}\n`);
  process.exit(1);
}
if (!raw.startsWith(PUBLIC_KEY_PREFIX)) {
  process.stderr.write(`HOPDESK_AUTH_PUBLIC_KEY must be the ${PUBLIC_KEY_PREFIX}… value printed by\n`
    + '  hopdesk-admin service-key\n\n'
    + 'Refused without it on purpose: the signing key is also 32 bytes of base64, and a build\n'
    + "carrying it would hand every user the server's private half.\n");
  process.exit(1);
}
const key = raw.slice(PUBLIC_KEY_PREFIX.length);
if (Buffer.from(key, 'base64').length !== 32) {
  process.stderr.write('HOPDESK_AUTH_PUBLIC_KEY must be 32 bytes of base64 (an Ed25519 public key).\n');
  process.exit(1);
}

const original = readFileSync(file, 'utf8');
const source = original
  .replace(/export const AUTH_SERVICE_URL: string \| null = .*;/,
    `export const AUTH_SERVICE_URL: string | null = ${JSON.stringify(url.replace(/\/$/, ''))};`)
  .replace(/export const AUTH_SERVICE_PUBLIC_KEY: string \| null = .*;/,
    `export const AUTH_SERVICE_PUBLIC_KEY: string | null = ${JSON.stringify(key)};`);

/* The failure that would otherwise pass unnoticed: the file was renamed or its
   declarations reworded, nothing matched, and the build goes out looking
   configured while asking nobody. Refuse instead. */
if (!source.includes(JSON.stringify(key)) || !source.includes(JSON.stringify(url.replace(/\/$/, '')))) {
  process.stderr.write(`${file} does not contain the declarations this script replaces;\n`
    + 'the build would carry no authorization service while appearing to. Refusing.\n');
  process.exit(1);
}
writeFileSync(file, source);
process.stdout.write(`This build will verify with ${url}\n`);
