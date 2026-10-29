-- The authorization service's tables, as D1 holds them.
--
-- The same shape as the Node server's SQLite (server/src/store.ts), so the two
-- answer identically and a block means the same thing whichever is deployed.
-- Only the tables this service needs: there are no accounts and no devices
-- here, because a Worker does not run the account API or the relay.

create table if not exists installations (
  installation_id text primary key,
  public_key      text not null,
  os              text,
  app_version     text,
  token_hash      text not null unique,
  created_at      integer not null,
  last_seen       integer,
  blocked_at      integer,
  blocked_reason  text,
  blocked_by      text
);

create table if not exists admins (
  id          text primary key,
  email       text not null unique collate nocase,
  token_hash  text not null unique,
  created_at  integer not null,
  last_used   integer
);

-- Everything done to one installation, so a block can be accounted for.
create table if not exists admin_events (
  id       text primary key,
  at       integer not null,
  actor    text not null,
  action   text not null,
  subject  text not null,
  reason   text
);
create index if not exists admin_events_subject on admin_events(subject);
create index if not exists admin_events_at on admin_events(at);

-- A nonce an installation must sign to prove it holds its own key. Single use,
-- five minutes, and deleted the moment it is spent.
create table if not exists challenges (
  nonce      text primary key,
  expires_at integer not null
);
create index if not exists challenges_expiry on challenges(expires_at);

-- Rate limiting, kept in the database because a Worker has no memory between
-- requests and the routes below need no credential to reach.
create table if not exists throttle (
  key          text primary key,
  attempts     integer not null,
  window_start integer not null,
  locked_until  integer
);
