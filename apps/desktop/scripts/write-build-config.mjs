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
 * Refuses rather than guesses: a URL without a key would produce a build that
 * reports where it is but believes whatever it is told, and a key that is not
 * 32 bytes is not an Ed25519 public key.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/build-config.ts');
const url = process.env.HOPDESK_AUTH_URL?.trim();
const key = process.env.HOPDESK_AUTH_PUBLIC_KEY?.trim();

if (!url && !key) {
  process.stdout.write('No authorization service configured; this build asks nobody.\n');
  process.exit(0);
}
if (!url || !key) {
  process.stderr.write('HOPDESK_AUTH_URL and HOPDESK_AUTH_PUBLIC_KEY must be set together:\n'
    + '  a URL without a key builds something that reports where it is and believes anything it is told.\n');
  process.exit(1);
}
if (!/^https:\/\//.test(url)) {
  process.stderr.write(`HOPDESK_AUTH_URL must be https: ${url}\n`);
  process.exit(1);
}
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
