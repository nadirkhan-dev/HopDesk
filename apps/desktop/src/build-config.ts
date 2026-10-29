/**
 * What a particular build of HopDesk was made to talk to.
 *
 * These are literals on purpose, written into the source before it is compiled
 * (scripts/write-build-config.mjs, run by the release build). Not read from the
 * environment at run time: a value a person can set is not an authorization
 * check, because a blocked installation would set it to something that says
 * yes.
 *
 * What actually makes redirection pointless is the public key below. An answer
 * that is not signed by that key is no answer, wherever it came from, so
 * pointing the address elsewhere gets a blocked installation nothing. The
 * address is here so the build is honest about where it reports.
 *
 * Both null - the state of this file in the repository - means this build has
 * no service to ask. It says so, hosting behaves exactly as it always has, and
 * nothing is sent anywhere. That is what a build from source does unless
 * whoever builds it configures their own:
 *
 *   HOPDESK_AUTH_URL=https://hopdesk.example.com \
 *   HOPDESK_AUTH_PUBLIC_KEY=<base64 Ed25519 public key> \
 *     node apps/desktop/scripts/write-build-config.mjs
 */

export const AUTH_SERVICE_URL: string | null = null;

export const AUTH_SERVICE_PUBLIC_KEY: string | null = null;
