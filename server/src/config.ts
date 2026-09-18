import { randomBytes } from 'node:crypto';

/**
 * Configuration, from the environment, with no unsafe defaults.
 *
 * The server is meant to be run by the person who owns it, on their own
 * machine, so the settings that decide whether it is safe — the token secret,
 * whether anyone may register, the TURN secret — must be given explicitly
 * rather than filled in with something convenient.
 */

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Signing key for access tokens. At least 32 bytes of real randomness. */
  tokenSecret: Buffer;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  /**
   * Who may create an account.
   *
   * `token` — the normal arrangement: registration needs a secret set when the
   *   server was deployed, so an account can be created deliberately at any
   *   time and by nobody else.
   * `open` — anyone who can reach the server.
   * `closed` — nobody; accounts are made by editing the database.
   */
  registration: 'token' | 'open' | 'closed';
  /** The secret for `token` registration. Never sent anywhere by the server. */
  registrationToken: string | null;
  /** Where the server sits behind a reverse proxy that sets X-Forwarded-For. */
  trustProxy: boolean;
  turn: TurnConfig | null;
}

export interface TurnConfig {
  /** coturn's static-auth-secret, shared with this server, never with clients. */
  secret: string;
  /** e.g. ["turn:relay.example.com:3478", "turns:relay.example.com:5349"] */
  urls: string[];
  /** STUN servers, for finding a direct path before falling back to the relay. */
  stunUrls: string[];
  credentialTtlSeconds: number;
}

export class ConfigError extends Error {}

const number = (value: string | undefined, fallback: number, name: string) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number`);
  return n;
};

const boolean = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

/** A TCP port; 0 means "any free port", which tests and some supervisors use. */
const port = (value: string | undefined, fallback: number) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new ConfigError('HOPDESK_PORT must be a port number');
  return n;
};

/**
 * How accounts may be created. A registration token is the default arrangement
 * because it is the one that stays safe: "the first account wins" is a race
 * anyone who finds the server before you can win, and open registration on a
 * server meant for one household is an invitation.
 */
function registrationMode(env: NodeJS.ProcessEnv): 'token' | 'open' | 'closed' {
  if (boolean(env.HOPDESK_REGISTRATION_OPEN, false)) return 'open';
  const token = env.HOPDESK_REGISTRATION_TOKEN?.trim();
  if (!token) return 'closed';
  if (token.length < 16) {
    throw new ConfigError('HOPDESK_REGISTRATION_TOKEN must be at least 16 characters; generate one with: openssl rand -base64 24');
  }
  return 'token';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const secret = env.HOPDESK_TOKEN_SECRET;
  if (!secret) {
    throw new ConfigError(
      'HOPDESK_TOKEN_SECRET is required. Generate one with:\n'
      + `  openssl rand -base64 48\n(a fresh value, kept secret; changing it signs everyone out)`);
  }
  const tokenSecret = Buffer.from(secret, 'utf8');
  if (tokenSecret.length < 32) throw new ConfigError('HOPDESK_TOKEN_SECRET must be at least 32 characters');

  const turnSecret = env.HOPDESK_TURN_SECRET;
  const turnUrls = (env.HOPDESK_TURN_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (turnSecret && !turnUrls.length) throw new ConfigError('HOPDESK_TURN_SECRET was set without HOPDESK_TURN_URLS');
  if (turnUrls.length && !turnSecret) throw new ConfigError('HOPDESK_TURN_URLS was set without HOPDESK_TURN_SECRET');
  for (const url of turnUrls) {
    if (!/^turns?:/.test(url)) throw new ConfigError(`TURN URL must start with turn: or turns: — got ${url}`);
  }

  return {
    port: port(env.HOPDESK_PORT, 8787),
    host: env.HOPDESK_HOST ?? '0.0.0.0',
    dataDir: env.HOPDESK_DATA_DIR ?? '/var/lib/hopdesk',
    tokenSecret,
    accessTokenTtlMs: number(env.HOPDESK_ACCESS_TTL_SECONDS, 900, 'HOPDESK_ACCESS_TTL_SECONDS') * 1000,
    refreshTokenTtlMs: number(env.HOPDESK_REFRESH_TTL_DAYS, 30, 'HOPDESK_REFRESH_TTL_DAYS') * 86_400_000,
    registration: registrationMode(env),
    registrationToken: env.HOPDESK_REGISTRATION_TOKEN?.trim() || null,
    trustProxy: boolean(env.HOPDESK_TRUST_PROXY, false),
    turn: turnSecret && turnUrls.length
      ? {
        secret: turnSecret,
        urls: turnUrls,
        stunUrls: (env.HOPDESK_STUN_URLS ?? 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean),
        credentialTtlSeconds: number(env.HOPDESK_TURN_TTL_SECONDS, 3600, 'HOPDESK_TURN_TTL_SECONDS'),
      }
      : null,
  };
}

/** For tests and for `hopdesk-server --print-secret`. */
export const suggestSecret = () => randomBytes(48).toString('base64');
