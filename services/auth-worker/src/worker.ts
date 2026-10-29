/**
 * HopDesk's authorization service, as a Cloudflare Worker.
 *
 * It answers one question - may this installation run? - and the
 * administration of that answer. Registration, signed verdicts, blocking,
 * unblocking and the history of both. Nothing else: the account API and the
 * relay stay on the Node server, because a relay needs a socket held open and
 * a password needs a deliberately slow hash.
 *
 * Every answer about an installation is signed with a key that exists only in
 * this Worker's secrets, and checked by the client against the public half
 * compiled into the build. That is what makes pointing the check somewhere
 * friendlier useless, and it is why the signing key must never appear in
 * wrangler.jsonc, in the repository, or in a terminal that echoes.
 *
 * The bytes signed, the labels, the token shapes and the table columns are
 * deliberately identical to server/src/api.ts. Two implementations of one
 * agreement drift unless they are held to the same canonical form, which is
 * why `verdictBytes` and `VERDICT_LABEL` are imported rather than restated.
 */
import { deviceIdFromPublicKey, fromBase64, identityFromSecretKey, sign, toBase64, utf8, verify } from '@hopdesk/crypto';
import { VERDICT_LABEL, verdictBytes, type InstallationVerdict } from '@hopdesk/protocol';

export interface Env {
  DB: D1Database;
  /** Set with `wrangler secret put`; never in a file. */
  HOPDESK_AUTH_SIGNING_KEY?: string;
  /** How long an answer stands without another. Hours; a week by default. */
  HOPDESK_AUTH_GRACE_HOURS?: string;
}

const REGISTER_LABEL = 'hopdesk/installation/register/v1';
const CHALLENGE_TTL_MS = 5 * 60_000;
const DEVICE_ID = /^HD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const MAX_BODY = 64 * 1024;

/** The same hashing the Node server does, or its tokens would not be recognised. */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(token));
  return toBase64(new Uint8Array(digest));
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const randomToken = (prefix: string) => `${prefix}${toBase64(crypto.getRandomValues(new Uint8Array(32)))}`;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('body too large');
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return parsed as Record<string, unknown>;
}

/**
 * Attempts allowed per window, counted in the database.
 *
 * A Worker remembers nothing between requests, and the routes below need no
 * credential to reach, so the counter has to live somewhere that persists.
 */
async function throttled(env: Env, key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
  const row = await env.DB.prepare('select attempts, window_start from throttle where key = ?')
    .bind(key).first<{ attempts: number; window_start: number }>();
  if (!row || now - row.window_start > windowMs) {
    await env.DB.prepare(`insert into throttle (key, attempts, window_start) values (?, 1, ?)
      on conflict(key) do update set attempts = 1, window_start = excluded.window_start`)
      .bind(key, now).run();
    return false;
  }
  if (row.attempts >= limit) return true;
  await env.DB.prepare('update throttle set attempts = attempts + 1 where key = ?').bind(key).run();
  return false;
}

/** Whoever asked, as the edge reports them. */
const caller = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown';

/**
 * The service's own identity, from the secret.
 *
 * Absent, the service does not pretend: every route that would answer about an
 * installation refuses, because an unsigned "you are allowed" is worth nothing
 * and a *missing* answer must never be mistaken for a permissive one.
 */
function signer(env: Env) {
  const secret = env.HOPDESK_AUTH_SIGNING_KEY?.trim();
  if (!secret) return null;
  const raw = fromBase64(secret);
  if (raw.length < 32) return null;
  return identityFromSecretKey(raw.subarray(0, 32));
}

const graceMs = (env: Env) => {
  const hours = Number(env.HOPDESK_AUTH_GRACE_HOURS ?? 168);
  return Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 3600_000) : 168 * 3600_000;
};

/** The server's answer about one installation, signed. */
async function verdictFor(env: Env, installationId: string, now: number) {
  const identity = signer(env)!;
  const row = await env.DB.prepare('select blocked_at, blocked_reason from installations where installation_id = ?')
    .bind(installationId).first<{ blocked_at: number | null; blocked_reason: string | null }>();
  const statement: InstallationVerdict = {
    installationId,
    status: row?.blocked_at != null ? 'blocked' : 'active',
    reason: row?.blocked_reason ?? null,
    checkedAt: now,
    validUntil: now + graceMs(env),
  };
  return { ...statement, signature: toBase64(sign(identity, VERDICT_LABEL, verdictBytes(statement))) };
}

/** The administrator behind a request, or null. Compared by hash, never by string. */
async function admin(request: Request, env: Env, now: number) {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const found = await env.DB.prepare('select id, email from admins where token_hash = ?')
    .bind(await hashToken(header.slice(7).trim())).first<{ id: string; email: string }>();
  if (!found) return null;
  await env.DB.prepare('update admins set last_used = ? where id = ?').bind(now, found.id).run();
  return found;
}

/** Refuses the request unless an administrator made it, slowly. */
async function requireAdmin(request: Request, env: Env, now: number) {
  /* Keyed on the caller rather than the token, so trying a thousand tokens is
     a thousand attempts rather than one each. */
  if (await throttled(env, `admin:${caller(request)}`, 20, 15 * 60_000, now)) {
    return { error: json({ error: 'rate-limited' }, 429) };
  }
  const who = await admin(request, env, now);
  if (!who) return { error: json({ error: 'unauthorised' }, 401) };
  await env.DB.prepare('delete from throttle where key = ?').bind(`admin:${caller(request)}`).run();
  return { who };
}

async function record(env: Env, actor: string, action: string, subject: string, reason: string | null, at: number) {
  await env.DB.prepare('insert into admin_events (id, at, actor, action, subject, reason) values (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), at, actor, action, subject, reason).run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const now = Date.now();

    try {
      if (route === 'GET /api/health') {
        /* Says whether this service can actually answer, rather than only that
           something is listening: without its key it can sign nothing. */
        return json({ ok: true, authorization: signer(env) ? 'ready' : 'no-signing-key' });
      }

      /* ------------------------------------------------- authorization */

      if (route === 'POST /api/installations/challenge') {
        if (!signer(env)) return json({ error: 'authorization-not-enabled' }, 501);
        if (await throttled(env, `install:${caller(request)}`, 30, 15 * 60_000, now)) {
          return json({ error: 'rate-limited' }, 429);
        }
        const nonce = toBase64(crypto.getRandomValues(new Uint8Array(24)));
        await env.DB.batch([
          env.DB.prepare('delete from challenges where expires_at <= ?').bind(now),
          env.DB.prepare('insert into challenges (nonce, expires_at) values (?, ?)')
            .bind(nonce, now + CHALLENGE_TTL_MS),
        ]);
        return json({ nonce, expiresInMs: CHALLENGE_TTL_MS });
      }

      if (route === 'POST /api/installations/register') {
        if (!signer(env)) return json({ error: 'authorization-not-enabled' }, 501);
        if (await throttled(env, `install:${caller(request)}`, 30, 15 * 60_000, now)) {
          return json({ error: 'rate-limited' }, 429);
        }
        const body = await readJson(request);
        const installationId = typeof body.installationId === 'string' ? body.installationId : '';
        if (!DEVICE_ID.test(installationId)) return json({ error: 'bad-installation-id' }, 400);

        /* Single use: deleted whether or not the rest of this succeeds, so a
           nonce cannot be tried twice with different claims. */
        const challenge = await env.DB.prepare('select expires_at from challenges where nonce = ?')
          .bind(String(body.nonce ?? '')).first<{ expires_at: number }>();
        await env.DB.prepare('delete from challenges where nonce = ?').bind(String(body.nonce ?? '')).run();
        if (!challenge || challenge.expires_at <= now) return json({ error: 'bad-challenge' }, 400);

        let publicKey: Uint8Array;
        try {
          publicKey = fromBase64(String(body.publicKey ?? ''));
        } catch {
          return json({ error: 'bad-key' }, 400);
        }
        /* The id *is* the key: one installation cannot register as another and
           inherit its standing - or its block. */
        if (deviceIdFromPublicKey(publicKey) !== installationId) return json({ error: 'key-mismatch' }, 400);

        const signed = verify(publicKey, REGISTER_LABEL,
          utf8(`${String(body.nonce)}\0${installationId}`), fromBase64(String(body.signature ?? '')));
        if (!signed) return json({ error: 'bad-signature' }, 401);

        const existing = await env.DB.prepare('select created_at, blocked_at from installations where installation_id = ?')
          .bind(installationId).first<{ created_at: number; blocked_at: number | null }>();
        const token = randomToken('hdi_');
        /* A block survives re-registration: the row stays, only the credential
           is replaced. Reinstalling over a blocked installation leaves it
           blocked, as long as it keeps its identity key. */
        await env.DB.prepare(`
          insert into installations (installation_id, public_key, os, app_version, token_hash, created_at, last_seen)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict(installation_id) do update set
            public_key = excluded.public_key, os = excluded.os,
            app_version = excluded.app_version, token_hash = excluded.token_hash,
            last_seen = excluded.last_seen
        `).bind(installationId, String(body.publicKey), body.os ? String(body.os) : null,
          body.appVersion ? String(body.appVersion) : null, await hashToken(token),
          existing?.created_at ?? now, now).run();

        return json({ token, ...(await verdictFor(env, installationId, now)) }, 201);
      }

      if (route === 'POST /api/installations/verify') {
        if (!signer(env)) return json({ error: 'authorization-not-enabled' }, 501);
        if (await throttled(env, `install:${caller(request)}`, 30, 15 * 60_000, now)) {
          return json({ error: 'rate-limited' }, 429);
        }
        const body = await readJson(request);
        const found = await env.DB.prepare('select installation_id from installations where token_hash = ?')
          .bind(await hashToken(String(body.token ?? ''))).first<{ installation_id: string }>();
        if (!found) return json({ error: 'unknown-installation' }, 401);
        await env.DB.prepare('update installations set last_seen = ?, app_version = coalesce(?, app_version) where installation_id = ?')
          .bind(now, body.appVersion ? String(body.appVersion) : null, found.installation_id).run();
        return json(await verdictFor(env, found.installation_id, now));
      }

      /* ------------------------------------------------ administration */

      if (route === 'GET /api/admin/installations') {
        const gate = await requireAdmin(request, env, now);
        if (gate.error) return gate.error;
        const { results } = await env.DB.prepare(`select installation_id, os, app_version, created_at,
          last_seen, blocked_at, blocked_reason, blocked_by from installations order by created_at desc`).all();
        return json({
          installations: (results ?? []).map(r => ({
            installationId: r.installation_id,
            os: r.os,
            appVersion: r.app_version,
            registeredAt: r.created_at,
            lastSeen: r.last_seen,
            status: r.blocked_at != null ? 'blocked' : 'active',
            blockedAt: r.blocked_at,
            blockedReason: r.blocked_reason,
            blockedBy: r.blocked_by,
          })),
        });
      }

      const blocking = /^\/api\/admin\/installations\/([^/]+)\/(un)?block$/.exec(url.pathname);
      if (request.method === 'POST' && blocking) {
        const gate = await requireAdmin(request, env, now);
        if (gate.error) return gate.error;
        const id = decodeURIComponent(blocking[1]!);
        const blocked = blocking[2] === undefined;
        const exists = await env.DB.prepare('select installation_id from installations where installation_id = ?')
          .bind(id).first();
        if (!exists) return json({ error: 'not-found' }, 404);

        const body: Record<string, unknown> = await readJson(request).catch(() => ({}));
        const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : null;
        await env.DB.prepare(blocked
          ? 'update installations set blocked_at = ?, blocked_reason = ?, blocked_by = ? where installation_id = ?'
          : 'update installations set blocked_at = null, blocked_reason = null, blocked_by = null where installation_id = ?')
          .bind(...(blocked ? [now, reason, gate.who!.email, id] : [id])).run();
        await record(env, gate.who!.email, blocked ? 'block' : 'unblock', id, reason, now);
        return json({ ok: true, installationId: id, status: blocked ? 'blocked' : 'active' });
      }

      const history = /^\/api\/admin\/installations\/([^/]+)\/history$/.exec(url.pathname);
      if (request.method === 'GET' && history) {
        const gate = await requireAdmin(request, env, now);
        if (gate.error) return gate.error;
        /* Newest first, and deterministic on a tie: two things can be done to
           one installation in the same millisecond, and the row written later
           is the later event. The Node server orders this the same way. */
        const { results } = await env.DB.prepare(
          'select id, at, actor, action, subject, reason from admin_events where subject = ?'
          + ' order by at desc, rowid desc')
          .bind(decodeURIComponent(history[1]!)).all();
        return json({ events: results ?? [] });
      }

      if (route === 'GET /api/admin/service-key') {
        const gate = await requireAdmin(request, env, now);
        if (gate.error) return gate.error;
        /* The half that verifies. Safe to publish and safe to build in - it
           checks answers and cannot produce them - but behind the
           administrator credential anyway, because which service a build
           answers to is nobody else's business. */
        return json({ publicKey: `hdpk_${toBase64(signer(env)!.publicKey)}` });
      }

      return json({ error: 'not-found' }, 404);
    } catch (err) {
      /* Never the exception itself: a message can carry a key, a token or a
         row, and this one goes to whoever asked. */
      console.error('request failed', (err as Error).message);
      return json({ error: 'bad-request' }, 400);
    }
  },
};
