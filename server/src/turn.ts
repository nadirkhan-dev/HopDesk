import { createHmac } from 'node:crypto';
import type { TurnConfig } from './config.js';

/**
 * Time-limited TURN credentials, in the form coturn understands with
 * `use-auth-secret` (the "REST API" scheme, draft-uberti-behave-turn-rest):
 * the username is an expiry timestamp and an identifier, and the password is an
 * HMAC of that username under a secret only coturn and this server know.
 *
 * Clients never learn the secret, and the credentials they do get stop working
 * on their own — so a relay cannot be used by whoever finds an old session log.
 */

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export function turnCredentials(turn: TurnConfig, identifier: string, now = Date.now()): { iceServers: IceServer[]; expiresAt: number } {
  const expiry = Math.floor(now / 1000) + turn.credentialTtlSeconds;
  // The identifier is only for coturn's logs; it must not contain a colon.
  const username = `${expiry}:${identifier.replace(/:/g, '_')}`;
  const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
  const servers: IceServer[] = [];
  if (turn.stunUrls.length) servers.push({ urls: turn.stunUrls });
  servers.push({ urls: turn.urls, username, credential });
  return { iceServers: servers, expiresAt: expiry * 1000 };
}
