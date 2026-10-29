import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * What a build is allowed to be made with.
 *
 * These two scripts are the only thing standing between "a release that can
 * disable a copy of HopDesk" and three different silent failures: a build
 * that carries no service while looking like it does, a build whose
 * configuration was written and then undone, and - the one that cannot be
 * taken back - a build carrying the half of the key that signs. Each has to
 * end in a non-zero exit, which is what these check.
 */

const root = path.resolve(import.meta.dirname, '../../..');
const writer = path.join(root, 'apps/desktop/scripts/write-build-config.mjs');
const checker = path.join(root, 'apps/desktop/scripts/check-build-config.mjs');

/** A 32-byte key, as the service prints it. */
const PUBLIC = `hdpk_${Buffer.alloc(32, 7).toString('base64')}`;

function freshConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-build-config-'));
  const file = path.join(dir, 'build-config.ts');
  writeFileSync(file, 'export const AUTH_SERVICE_URL: string | null = null;\n\n'
    + 'export const AUTH_SERVICE_PUBLIC_KEY: string | null = null;\n');
  return file;
}

/** Runs a script and reports how it went, without throwing. */
function run(script, env, args = []) {
  try {
    const stdout = execFileSync('node', [script, ...args], {
      env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a build is configured from the url and the public key', () => {
  const file = freshConfig();
  const result = run(writer, {
    HOPDESK_BUILD_CONFIG_FILE: file,
    HOPDESK_AUTH_URL: 'https://auth.example.com/',
    HOPDESK_AUTH_PUBLIC_KEY: PUBLIC,
  });
  assert.equal(result.code, 0, result.out);
  const written = readFileSync(file, 'utf8');
  // The trailing slash is dropped, since every route is appended to this.
  assert.match(written, /AUTH_SERVICE_URL: string \| null = "https:\/\/auth\.example\.com";/);
  // The prefix marks the key in transit; it is not part of the key.
  assert.match(written, new RegExp(`= "${PUBLIC.slice(5).replace(/[+/=]/g, c => `\\${c}`)}"`));
  assert.ok(!written.includes('hdpk_'), 'the prefix was written into the build');
});

test('the signing half of the key cannot be built in by mistake', () => {
  /* The failure that must be impossible. Both halves are 32 bytes of base64,
     so without the prefix this would look exactly like doing it right - and
     the private half would be in every package, published, unrecoverable. */
  const file = freshConfig();
  const signingKey = Buffer.alloc(48, 3).toString('base64');
  const result = run(writer, {
    HOPDESK_BUILD_CONFIG_FILE: file,
    HOPDESK_AUTH_URL: 'https://auth.example.com',
    HOPDESK_AUTH_PUBLIC_KEY: signingKey,
  });
  assert.equal(result.code, 1);
  assert.match(result.out, /hdpk_/);
  assert.equal(readFileSync(file, 'utf8').includes(signingKey), false,
    'the signing key reached the file');
});

test('half a configuration is refused, and so is one that is not https', () => {
  for (const env of [
    { HOPDESK_AUTH_URL: 'https://auth.example.com' },
    { HOPDESK_AUTH_PUBLIC_KEY: PUBLIC },
    { HOPDESK_AUTH_URL: 'http://auth.example.com', HOPDESK_AUTH_PUBLIC_KEY: PUBLIC },
    { HOPDESK_AUTH_URL: 'https://auth.example.com', HOPDESK_AUTH_PUBLIC_KEY: 'hdpk_tooshort' },
  ]) {
    const file = freshConfig();
    const result = run(writer, { HOPDESK_BUILD_CONFIG_FILE: file, ...env });
    assert.equal(result.code, 1, `accepted ${JSON.stringify(env)}: ${result.out}`);
    assert.match(readFileSync(file, 'utf8'), /= null;/);
  }
});

test('a release meant to enforce blocking will not build without its configuration', () => {
  const file = freshConfig();
  // Without the flag, no configuration is an ordinary build from source.
  assert.equal(run(writer, { HOPDESK_BUILD_CONFIG_FILE: file }).code, 0);
  // With it, it is a mistake, and the build stops here rather than shipping.
  const required = run(writer, { HOPDESK_BUILD_CONFIG_FILE: file, HOPDESK_AUTH_REQUIRED: '1' });
  assert.equal(required.code, 1);
  assert.match(required.out, /would enforce nothing/);
});

test('what a build carries is checked, not assumed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hopdesk-built-'));
  const built = path.join(dir, 'build-config.js');

  writeFileSync(built, 'export const AUTH_SERVICE_URL = null;\n'
    + 'export const AUTH_SERVICE_PUBLIC_KEY = null;\n');
  assert.equal(run(checker, {}, ['--expect-none', built]).code, 0);
  // The failure this exists for: it looks built, and it checks nothing.
  const unconfigured = run(checker, {}, [built]);
  assert.equal(unconfigured.code, 1);
  assert.match(unconfigured.out, /AUTH_SERVICE_URL is null/);

  writeFileSync(built, `export const AUTH_SERVICE_URL = "https://auth.example.com";\n`
    + `export const AUTH_SERVICE_PUBLIC_KEY = "${PUBLIC.slice(5)}";\n`);
  assert.equal(run(checker, {}, [built]).code, 0);
  assert.equal(run(checker, {}, ['--expect-none', built]).code, 1);

  // A key that still has its prefix was written in without being checked.
  writeFileSync(built, `export const AUTH_SERVICE_URL = "https://auth.example.com";\n`
    + `export const AUTH_SERVICE_PUBLIC_KEY = "${PUBLIC}";\n`);
  const prefixed = run(checker, {}, [built]);
  assert.equal(prefixed.code, 1);
  assert.match(prefixed.out, /hdpk_ prefix/);

  // And plain http is refused unless loopback is asked for by name.
  writeFileSync(built, 'export const AUTH_SERVICE_URL = "http://127.0.0.1:47897";\n'
    + `export const AUTH_SERVICE_PUBLIC_KEY = "${PUBLIC.slice(5)}";\n`);
  assert.equal(run(checker, {}, [built]).code, 1);
  assert.equal(run(checker, {}, ['--allow-loopback', built]).code, 0);
});
