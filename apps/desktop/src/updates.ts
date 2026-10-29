/**
 * Telling someone a newer HopDesk exists.
 *
 * What this does, and what it does not, because an update mechanism that
 * overstates itself is worse than none:
 *
 * **It checks** a release feed - GitHub's by default, or whichever endpoint a
 * build was made with - for a newer *stable* version, on launch and every six
 * hours, and shows it. That is the whole of what runs today.
 *
 * **It does not download, and it does not install.** Pressing the offer opens
 * the release page in a browser; the person downloads and installs it
 * themselves, as they do now. A `.deb` cannot be installed without root and
 * HopDesk will not ask for root; a `.dmg` has to be mounted and dragged.
 * Installing in place needs either an apt repository (Linux) or Squirrel with
 * a Developer ID (macOS), neither of which is built here.
 *
 * **What it checks, it checks properly.** The feed address and every link that
 * comes back of it are held to https (`feedUrl`, `offerableUrl`), so a feed
 * that has been pointed somewhere else cannot put an arbitrary scheme in front
 * of `shell.openExternal`. `manifestTrusted` and `checksumMatches` are the two
 * halves of verifying a downloaded file - a signed manifest, or a published
 * SHA-256 - and they are written and tested here *ahead of* the download that
 * will use them. Nothing calls them yet, because nothing is downloaded yet,
 * and they are not to be described as protecting anything until it is.
 *
 * **It never interrupts a session.** A computer hosting someone's screen is
 * not a computer to restart, so nothing is offered while a session is live.
 */
import { createHash } from 'node:crypto';
import { fromBase64, utf8, verify } from '@hopdesk/crypto';

/** How often a running HopDesk looks for a newer one. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 3600_000;

export const MANIFEST_LABEL = 'hopdesk/update-manifest/v1';

export interface UpdateAsset {
  name: string;
  url: string;
  /** Hex SHA-256 as published beside the release. */
  sha256?: string;
  size?: number;
}

export interface AvailableUpdate {
  version: string;
  notes: string;
  publishedAt: string;
  /** The file for this platform and architecture, when the release has one. */
  asset: UpdateAsset | null;
  /** Where a person can read about it and download it themselves. */
  pageUrl: string;
}

export type UpdateState =
  | { state: 'current'; version: string }
  | { state: 'available'; update: AvailableUpdate }
  | { state: 'downloaded'; update: AvailableUpdate; file: string }
  | { state: 'unavailable'; detail: string };

/**
 * Compares two versions the way a release feed means them.
 *
 * Only `major.minor.patch` counts: a version with anything appended - `-rc.1`,
 * `-beta` - is a pre-release and is never offered, because a person who
 * installed a stable build did not ask to be moved onto a testing one.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (version: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim());
    if (!match) return null;
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]!.length > 0,
    };
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b || a.prerelease) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i]! > b.parts[i]!) return true;
    if (a.parts[i]! < b.parts[i]!) return false;
  }
  return false;
}

/** The file this computer needs out of everything a release carries. */
export function assetFor(
  names: UpdateAsset[],
  platform: NodeJS.Platform,
  arch: string,
): UpdateAsset | null {
  const wanted = platform === 'darwin'
    ? (arch === 'arm64' ? /-arm64\.dmg$/ : /-x64\.dmg$/)
    : platform === 'linux' ? /\.deb$/
      : null;
  if (!wanted) return null;
  return names.find(asset => wanted.test(asset.name)) ?? null;
}

/**
 * Whether a release may be offered at all.
 *
 * A signed manifest is the strong answer: the signature is checked against a
 * key compiled into this application, so a release feed that has been
 * tampered with - or replaced wholesale - cannot offer anything. Without a
 * signing key, a published SHA-256 is the weak answer: it catches a corrupted
 * or truncated download, and nothing else, since it travels with the file it
 * describes. Both of those beat "download whatever the feed said", which is
 * what this refuses to do.
 */
export function manifestTrusted(
  manifest: { body: string; signature?: string },
  publicKey: Uint8Array | null,
): { ok: true; signed: boolean } | { ok: false; why: string } {
  if (!publicKey) return { ok: true, signed: false };
  if (!manifest.signature) return { ok: false, why: 'the release carries no signature' };
  try {
    const good = verify(publicKey, MANIFEST_LABEL, utf8(manifest.body), fromBase64(manifest.signature));
    return good ? { ok: true, signed: true } : { ok: false, why: 'the release signature does not match' };
  } catch {
    return { ok: false, why: 'the release signature could not be read' };
  }
}

/** Whether a downloaded file is the one that was described. */
export function checksumMatches(contents: Uint8Array, expectedHex: string): boolean {
  const actual = createHash('sha256').update(contents).digest('hex');
  return actual.length === expectedHex.trim().length
    && actual.toLowerCase() === expectedHex.trim().toLowerCase();
}

/**
 * The feed address, if it is one this application may fetch.
 *
 * https only, and no credentials in the address: an update feed is read on
 * launch without anybody asking for it, and a plain-http one can be answered
 * by whoever is between this computer and the internet.
 */
export function feedUrl(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A link out of a release feed, if it is safe to hand to the desktop.
 *
 * `shell.openExternal` is not a browser: given `file:`, `smb:` or the scheme
 * of some other application it will act on it. A release page is a web page,
 * so only https gets through, and a feed that has been tampered with cannot
 * turn an update notice into a way of starting something.
 */
export function offerableUrl(candidate: string | undefined | null): string | null {
  return feedUrl(candidate);
}

/** A release as the feed describes it, before this computer's file is picked out. */
export type FeedRelease = Omit<AvailableUpdate, 'asset'> & { assets: UpdateAsset[] };

/**
 * The releases in a GitHub feed, newest usable one first.
 *
 * Draft and pre-release entries are dropped here rather than filtered later,
 * and an asset whose address is not https is dropped with them: the address is
 * what a person would be sent to, so a feed cannot smuggle one in.
 */
export function readGithubReleases(payload: unknown): FeedRelease[] {
  if (!Array.isArray(payload)) return [];
  const releases: FeedRelease[] = [];
  for (const entry of payload as Record<string, unknown>[]) {
    if (entry.draft === true || entry.prerelease === true) continue;
    const version = typeof entry.tag_name === 'string' ? entry.tag_name.replace(/^v/, '') : null;
    if (!version) continue;
    const assets = Array.isArray(entry.assets)
      ? (entry.assets as Record<string, unknown>[]).flatMap(asset => {
        const url = offerableUrl(typeof asset.browser_download_url === 'string' ? asset.browser_download_url : null);
        if (!url) return [];
        return [{
          name: String(asset.name ?? ''),
          url,
          ...(typeof asset.size === 'number' ? { size: asset.size } : {}),
        }];
      })
      : [];
    releases.push({
      version,
      notes: typeof entry.body === 'string' ? entry.body.slice(0, 4000) : '',
      publishedAt: typeof entry.published_at === 'string' ? entry.published_at : '',
      pageUrl: offerableUrl(typeof entry.html_url === 'string' ? entry.html_url : null) ?? '',
      assets,
    });
  }
  return releases;
}
