#!/usr/bin/env node
/**
 * Checks what a *built* HopDesk actually carries, rather than what the build
 * was told to carry.
 *
 * The failure this exists for is quiet: the configuration step is skipped, or
 * runs before a step that overwrites the file, or the secrets are missing from
 * the environment - and the packages come out looking exactly like the ones
 * that enforce blocking, while enforcing nothing. Nobody notices until a block
 * is tried on a real computer and does not work.
 *
 * So the question is asked of the compiled output and of the packaged
 * application, in that order, and the answer is an exit code.
 *
 *   node apps/desktop/scripts/check-build-config.mjs            # must be configured
 *   node apps/desktop/scripts/check-build-config.mjs --expect-none
 *   node apps/desktop/scripts/check-build-config.mjs --allow-loopback
 *
 * `--allow-loopback` is for verifying the whole arrangement against a server
 * on this machine, where there is no certificate and so no https. It must
 * never be used for a release: it is spelled out as a flag so that using it
 * is a decision rather than an accident.
 *
 * Give it paths to check those instead of the defaults: a directory, an .asar,
 * or an unpacked application tree.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const root = path.resolve(desktop, '../..');

const args = process.argv.slice(2);
const expectNone = args.includes('--expect-none');
const allowLoopback = args.includes('--allow-loopback');
const given = args.filter(a => !a.startsWith('--'));

/** Where a built HopDesk keeps the file, in the order they are produced. */
const candidates = given.length ? given : [
  path.join(desktop, 'dist/build-config.js'),
  path.join(root, 'dist-packages/linux-unpacked/resources/app.asar'),
  path.join(root, 'dist-packages/mac/HopDesk.app/Contents/Resources/app.asar'),
  path.join(root, 'dist-packages/mac-arm64/HopDesk.app/Contents/Resources/app.asar'),
];

/* Read as bytes and searched as text: an .asar is a concatenation with a JSON
   header, so the declarations are in it verbatim and there is no need to
   unpack it to find out what they say. */
function declarationsIn(file) {
  const text = readFileSync(file, 'latin1');
  const url = /AUTH_SERVICE_URL\s*=\s*(null|"([^"]*)"|'([^']*)')/.exec(text);
  const key = /AUTH_SERVICE_PUBLIC_KEY\s*=\s*(null|"([^"]*)"|'([^']*)')/.exec(text);
  if (!url || !key) return null;
  const value = m => (m[2] ?? m[3] ?? null);
  return { url: value(url), key: value(key) };
}

function filesUnder(target) {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
      ? filesUnder(path.join(target, entry.name))
      : [path.join(target, entry.name)]);
}

let checked = 0;
let failed = false;

for (const target of candidates) {
  for (const file of filesUnder(target)) {
    if (!/\.(js|mjs|cjs|ts|asar)$/.test(file)) continue;
    let found;
    try {
      found = declarationsIn(file);
    } catch {
      continue;
    }
    if (!found) continue;
    checked++;
    const where = path.relative(root, file);

    if (expectNone) {
      if (found.url === null && found.key === null) {
        process.stdout.write(`${where}: no authorization service, as expected\n`);
      } else {
        process.stderr.write(`${where}: expected no service, but it carries ${found.url}\n`);
        failed = true;
      }
      continue;
    }

    const problems = [];
    const loopback = allowLoopback && /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(found.url ?? '');
    if (!found.url) problems.push('AUTH_SERVICE_URL is null');
    else if (!found.url.startsWith('https://') && !loopback) {
      problems.push(`AUTH_SERVICE_URL is not https (${found.url})`);
    }
    if (!found.key) problems.push('AUTH_SERVICE_PUBLIC_KEY is null');
    else if (Buffer.from(found.key, 'base64').length !== 32) {
      problems.push('AUTH_SERVICE_PUBLIC_KEY is not 32 bytes');
    }
    /* The one thing worse than a build that cannot check is a build carrying
       the half that signs. The prefix never reaches the file, so finding it
       here means the raw value was written in unverified. */
    if (found.key?.startsWith('hdpk_')) problems.push('AUTH_SERVICE_PUBLIC_KEY still has its hdpk_ prefix');

    if (problems.length) {
      process.stderr.write(`${where}: ${problems.join('; ')}\n`);
      failed = true;
    } else {
      process.stdout.write(`${where}: verifies with ${found.url}`
        + `${loopback ? ' (loopback, for verification only — never ship this)' : ''}\n`);
    }
  }
}

if (!checked) {
  process.stderr.write(`Found nothing to check in:\n${candidates.map(c => `  ${c}`).join('\n')}\n`
    + 'Build first (npm run build, or packaging/build-appimage.sh).\n');
  process.exit(1);
}
if (failed) {
  process.stderr.write('\nThis build does not carry the configuration it was meant to.\n');
  process.exit(1);
}
process.stdout.write(`${checked} file(s) checked.\n`);
