import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateIdentity, toBase64, utf8, sign } from '@hopdesk/crypto';
import {
  isNewer, assetFor, manifestTrusted, checksumMatches, readGithubReleases, MANIFEST_LABEL,
  feedUrl, offerableUrl,
} from '../dist/updates.js';

/**
 * Deciding whether there is a newer HopDesk, and whether to believe the thing
 * that said so.
 *
 * The interesting cases are the refusals: a pre-release offered to someone on
 * a stable build, a release feed pointed somewhere else, a file that does not
 * match what was published. Each has to end in "no".
 *
 * Two of these - `manifestTrusted` and `checksumMatches` - are tested ahead of
 * the download that will use them. Nothing downloads anything today, and
 * these tests are not evidence that a download is verified; they are evidence
 * that the two checks behave when one is.
 */

test('only a newer stable version counts', () => {
  assert.equal(isNewer('0.2.8', '0.2.7'), true);
  assert.equal(isNewer('0.3.0', '0.2.9'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('v0.2.8', '0.2.7'), true, 'a leading v is how tags are written');

  // Same or older is not an update.
  assert.equal(isNewer('0.2.7', '0.2.7'), false);
  assert.equal(isNewer('0.2.6', '0.2.7'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);

  /* A pre-release is never offered: somebody who installed a stable build did
     not ask to be moved onto a testing one. */
  assert.equal(isNewer('0.3.0-rc.1', '0.2.7'), false);
  assert.equal(isNewer('0.2.8-beta', '0.2.7'), false);

  // Nonsense is not an update either.
  assert.equal(isNewer('latest', '0.2.7'), false);
  assert.equal(isNewer('', '0.2.7'), false);
});

test('each computer is offered the file it can actually use', () => {
  const assets = [
    { name: 'HopDesk-0.2.8-arm64.dmg', url: 'https://example.com/arm64.dmg' },
    { name: 'HopDesk-0.2.8-x64.dmg', url: 'https://example.com/x64.dmg' },
    { name: 'HopDesk-0.2.8.AppImage', url: 'https://example.com/app.AppImage' },
    { name: 'hopdesk_0.2.8_amd64.deb', url: 'https://example.com/deb' },
  ];
  assert.equal(assetFor(assets, 'darwin', 'arm64').name, 'HopDesk-0.2.8-arm64.dmg');
  assert.equal(assetFor(assets, 'darwin', 'x64').name, 'HopDesk-0.2.8-x64.dmg');
  // The .deb and not the AppImage: the .deb is the package that keeps the sandbox.
  assert.equal(assetFor(assets, 'linux', 'x64').name, 'hopdesk_0.2.8_amd64.deb');
  // Nothing is built for Windows, so nothing is offered there.
  assert.equal(assetFor(assets, 'win32', 'x64'), null);
  assert.equal(assetFor([], 'linux', 'x64'), null);
});

test('a manifest signed by anyone else is not trusted', () => {
  const signer = generateIdentity();
  const body = JSON.stringify({ version: '0.2.8', sha256: 'abc' });
  const signature = toBase64(sign(signer, MANIFEST_LABEL, utf8(body)));

  // Signed by the key this build carries: offered.
  assert.deepEqual(manifestTrusted({ body, signature }, signer.publicKey), { ok: true, signed: true });

  // Signed by somebody else: refused, however well-formed.
  const impostor = generateIdentity();
  const wrong = manifestTrusted({ body, signature: toBase64(sign(impostor, MANIFEST_LABEL, utf8(body))) }, signer.publicKey);
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /does not match/);

  // Unsigned, where a key is expected: refused.
  const unsigned = manifestTrusted({ body }, signer.publicKey);
  assert.equal(unsigned.ok, false);
  assert.match(unsigned.why, /no signature/);

  // Tampered body with a signature for the old body: refused.
  const tampered = manifestTrusted({ body: body.replace('0.2.8', '9.9.9'), signature }, signer.publicKey);
  assert.equal(tampered.ok, false);

  /* With no key configured - a build from source - a release can still be
     offered, but it is marked unsigned so nothing claims more than it knows. */
  assert.deepEqual(manifestTrusted({ body }, null), { ok: true, signed: false });
});

test('a file that does not match its published checksum is rejected', () => {
  const file = Buffer.from('a pretend .deb');
  const right = createHash('sha256').update(file).digest('hex');
  assert.equal(checksumMatches(file, right), true);
  assert.equal(checksumMatches(file, right.toUpperCase()), true, 'case is not meaningful in hex');
  assert.equal(checksumMatches(Buffer.from('a different file'), right), false);
  // A truncated or empty checksum must never pass.
  assert.equal(checksumMatches(file, right.slice(0, 32)), false);
  assert.equal(checksumMatches(file, ''), false);
});

test('draft and pre-release entries are passed over', () => {
  const releases = readGithubReleases([
    { tag_name: 'v0.3.0-rc.1', prerelease: true, html_url: 'https://example.com/rc', assets: [] },
    { tag_name: 'v0.2.9', draft: true, html_url: 'https://example.com/draft', assets: [] },
    {
      tag_name: 'v0.2.8', body: 'notes', published_at: '2026-01-01T00:00:00Z',
      html_url: 'https://example.com/0.2.8',
      assets: [{ name: 'hopdesk_0.2.8_amd64.deb', browser_download_url: 'https://example.com/deb', size: 90 }],
    },
  ]);
  assert.deepEqual(releases.map(r => r.version), ['0.2.8']);
  assert.equal(releases[0].pageUrl, 'https://example.com/0.2.8');
  assert.equal(releases[0].assets[0].name, 'hopdesk_0.2.8_amd64.deb');
  // Nonsense in the feed is skipped rather than throwing.
  assert.deepEqual(readGithubReleases([{ no_tag: true }, 'not an object']), []);
  assert.deepEqual(readGithubReleases(null), []);
});

test('only an https address is fetched, or opened', () => {
  /* The feed address can be overridden, and whatever it answers ends up in
     front of the person as a version to install - with its link handed to
     `shell.openExternal`, which is not a browser and will act on a scheme
     that is not a web page at all. */
  assert.equal(feedUrl('https://api.github.com/repos/x/y/releases'),
    'https://api.github.com/repos/x/y/releases');
  for (const bad of [
    'http://api.github.com/repos/x/y/releases',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'smb://attacker/share',
    'https://user:pw@api.github.com/repos/x/y/releases',
    'not a url',
    '',
    undefined,
    null,
  ]) {
    assert.equal(feedUrl(bad), null, `${bad} must not be fetched`);
    assert.equal(offerableUrl(bad), null, `${bad} must not be opened`);
  }
});

test('a release whose links are not https is read without them', () => {
  const [release] = readGithubReleases([{
    tag_name: 'v9.9.9',
    html_url: 'file:///tmp/evil.html',
    assets: [
      { name: 'HopDesk-9.9.9-x64.dmg', browser_download_url: 'http://attacker.example/HopDesk.dmg' },
      { name: 'hopdesk_9.9.9_amd64.deb', browser_download_url: 'https://github.com/x/y/hopdesk.deb' },
    ],
  }]);
  assert.equal(release.version, '9.9.9');
  // The page link is dropped rather than carried as something to open.
  assert.equal(release.pageUrl, '');
  // The plain-http asset is gone; the https one stayed.
  assert.deepEqual(release.assets.map(a => a.name), ['hopdesk_9.9.9_amd64.deb']);
  assert.equal(assetFor(release.assets, 'darwin', 'x64'), null);
  assert.equal(assetFor(release.assets, 'linux', 'x64').url, 'https://github.com/x/y/hopdesk.deb');
});
