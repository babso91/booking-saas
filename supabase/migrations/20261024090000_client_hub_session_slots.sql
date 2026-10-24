-- Client Hub: one cookie per session (docs/CLIENT_HUB_CONTRACT.md,
-- "Sessions in the browser").
--
-- Why: a browser applies a response's Set-Cookie when the response arrives,
-- whatever the page does, and the last one to arrive wins. With a single
-- cookie name shared by every tab, a late sign-out erased a session signed
-- in meanwhile, and a late sign-in put back an older identity in another
-- tab. No server can know in which order its responses will arrive.
--
-- Now every session has its own cookie, named after its id
-- (client_hub_s_<session id>), and a response only ever adds the cookie of
-- the session it created or deletes cookies of sessions that are over. Those
-- writes commute: whatever order they arrive in, the browser ends up with
-- the same cookies. The browser may then present several sessions; the
-- server decides, here, under locks:
--
--   * A cookie counts only if its value is the token of the very session its
--     name designates (a token under another session's name is nothing).
--   * Live sessions of ONE account: the most recent one (created_at, then
--     id) is kept, the others are revoked. Same identity whichever wins.
--   * Live sessions of SEVERAL accounts: no identity is chosen. They are all
--     revoked and the request is refused (fail closed). This only happens
--     when two sign-ins of different accounts cross in one browser, or when
--     a cookie was planted from a sibling subdomain (cookie tossing): in
--     neither case may the server pick who the visitor is.
--   * A request can only revoke sessions whose token it presents (plus, for
--     a global sign-out, every session of the account of a live presented
--     session).
--
-- Lock order, for every function that ends or chooses sessions:
--   L1  network (advisory), address (advisory), challenge (row): the
--       verification of a code, as before (client_hub_verify_code);
--   L2  the accounts of the presented live sessions (advisory, in uuid
--       order), then those sessions' rows (FOR UPDATE, in id order).
-- L1 is always taken before L2, never after. Readers
-- (private.client_hub_session_account) lock one session row and wait for
-- nothing else; the purge of client_hub_request_code deletes only sessions
-- expired for a day, which no L2 holder locks (it locks live rows only).
-- So no wait cycle can form: no deadlock.
--
-- The previous entry points that took one token (client_hub_verify_code,
-- client_hub_end_session) stay for the history but are no longer executable
-- by the service role: sessions are opened and ended through the functions
-- below only.

-- At most this many sessions are examined per request; the server routes
-- refuse more (fail closed, every cookie deleted) before calling.
create function private.client_hub_max_presented()
returns integer
language sql
immutable
set search_path = ''
as $$ select 16 $$;

revoke all on function private.client_hub_max_presented() from public;

-- The live sessions among the presented (session id, token) pairs, locked
-- (L2): accounts first (advisory, in order), then the rows (FOR UPDATE, in
-- order). A pair counts only if the token is the session's own. Read again
-- under the locks: a session ended meanwhile is not returned. A session
-- never changes account and never comes back to life, so the accounts read
-- before the locks cover every row returned.
create function private.client_hub_lock_presented(
  p_sessions uuid[],
  p_tokens text[],
  p_now timestamptz
)
returns setof private.client_hub_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account uuid;
begin
  if p_sessions is null or p_tokens is null
    or pg_catalog.cardinality(p_sessions) <> pg_catalog.cardinality(p_tokens)
    or pg_catalog.cardinality(p_sessions) > private.client_hub_max_presented() then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  for v_account in
    select distinct s.account_id
    from rows from (pg_catalog.unnest(p_sessions), pg_catalog.unnest(p_tokens)) as p(session_id, token)
    join private.client_hub_sessions s
      on s.id = p.session_id
     and s.token_hash = pg_catalog.encode(extensions.digest(p.token, 'sha256'), 'hex')
    where p.token ~ '^[0-9a-f]{64}$'
      and s.revoked_at is null
      and s.expires_at > p_now
    order by s.account_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('client_hub_account:' || v_account::text, 0));
  end loop;

  return query
    select s.*
    from private.client_hub_sessions s
    where s.id in (
        select p.session_id
        from rows from (pg_catalog.unnest(p_sessions), pg_catalog.unnest(p_tokens)) as p(session_id, token)
        where p.token ~ '^[0-9a-f]{64}$'
          and s.token_hash = pg_catalog.encode(extensions.digest(p.token, 'sha256'), 'hex'))
      and s.revoked_at is null
      and s.expires_at > p_now
    order by s.id
    for update;
end;
$$;

revoke all on function private.client_hub_lock_presented(uuid[], text[], timestamptz) from public;

-- The session a request acts as, among those its browser presents:
--   'ok'       with the session, its token (the presented value that is
--              its own) and its account (other live sessions of that
--              account presented with it are revoked);
--   'none'     no live session among them;
--   'conflict' live sessions of several accounts: all revoked, none chosen.
create function public.client_hub_resolve_session(
  p_sessions uuid[],
  p_tokens text[]
)
returns table (status text, session_id uuid, session_token text, account_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_live private.client_hub_sessions[];
  v_winner private.client_hub_sessions;
begin
  select coalesce(pg_catalog.array_agg(l order by l.created_at desc, l.id desc), '{}')
  into v_live
  from private.client_hub_lock_presented(p_sessions, p_tokens, v_now) l;

  if pg_catalog.cardinality(v_live) = 0 then
    return query select 'none'::text, null::uuid, null::text, null::uuid;
    return;
  end if;

  if (select pg_catalog.count(distinct l.account_id) from pg_catalog.unnest(v_live) l) > 1 then
    update private.client_hub_sessions s
    set revoked_at = v_now
    where s.id in (select l.id from pg_catalog.unnest(v_live) l);
    return query select 'conflict'::text, null::uuid, null::text, null::uuid;
    return;
  end if;

  v_winner := v_live[1];
  update private.client_hub_sessions s
  set revoked_at = v_now
  where s.id in (select l.id from pg_catalog.unnest(v_live) l)
    and s.id <> v_winner.id;

  return query
    select 'ok'::text, v_winner.id, p.token, v_winner.account_id
    from rows from (pg_catalog.unnest(p_sessions), pg_catalog.unnest(p_tokens)) as p(session_id, token)
    where p.session_id = v_winner.id
      and p.token ~ '^[0-9a-f]{64}$'
      and pg_catalog.encode(extensions.digest(p.token, 'sha256'), 'hex') = v_winner.token_hash
    limit 1;
end;
$$;

-- Ends the presented live sessions (p_all: and every live session of their
-- accounts). Idempotent: unknown, ended or forged pairs end nothing; only a
-- live session has authority.
create function public.client_hub_sign_out(
  p_sessions uuid[],
  p_tokens text[],
  p_all boolean default false
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_live private.client_hub_sessions[];
begin
  select coalesce(pg_catalog.array_agg(l), '{}')
  into v_live
  from private.client_hub_lock_presented(p_sessions, p_tokens, v_now) l;

  if pg_catalog.cardinality(v_live) = 0 then
    return;
  end if;

  -- Under the accounts' locks (L2): the other sessions of these accounts
  -- are locked by this update, in no particular order, but nobody else can
  -- hold one of them while waiting for a lock this transaction holds.
  update private.client_hub_sessions s
  set revoked_at = v_now
  where s.revoked_at is null
    and s.expires_at > v_now
    and (s.id in (select l.id from pg_catalog.unnest(v_live) l)
      or (coalesce(p_all, false)
          and s.account_id in (select l.account_id from pg_catalog.unnest(v_live) l)));
end;
$$;

-- Verifies a code (client_hub_verify_code, L1) and, if it opens a session,
-- ends the sessions the browser presented (L2): signing in replaces who the
-- browser is. Returns the new session's id, which names its cookie. A
-- refused code ends nothing.
create function public.client_hub_sign_in(
  p_challenge_id uuid,
  p_email text,
  p_code text,
  p_client_ip inet,
  p_sessions uuid[],
  p_tokens text[]
)
returns table (
  status text,
  session_id uuid,
  session_token text,
  account_id uuid,
  email text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_verified record;
  v_session uuid;
  v_replaced uuid[];
begin
  if p_sessions is null or p_tokens is null
    or pg_catalog.cardinality(p_sessions) <> pg_catalog.cardinality(p_tokens)
    or pg_catalog.cardinality(p_sessions) > private.client_hub_max_presented() then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  select v.* into v_verified
  from public.client_hub_verify_code(p_challenge_id, p_email, p_code, p_client_ip) v;

  if v_verified.status <> 'ok' then
    return query select v_verified.status, null::uuid, null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select s.id into v_session
  from private.client_hub_sessions s
  where s.token_hash = pg_catalog.encode(extensions.digest(v_verified.session_token, 'sha256'), 'hex');

  select coalesce(pg_catalog.array_agg(l.id), '{}')
  into v_replaced
  from private.client_hub_lock_presented(p_sessions, p_tokens, v_now) l;

  update private.client_hub_sessions s
  set revoked_at = v_now
  where s.id = any(v_replaced)
    and s.id <> v_session;

  return query select 'ok'::text, v_session, v_verified.session_token,
    v_verified.account_id, v_verified.email, v_verified.expires_at;
end;
$$;

revoke all on function public.client_hub_resolve_session(uuid[], text[]) from public, anon, authenticated;
revoke all on function public.client_hub_sign_out(uuid[], text[], boolean) from public, anon, authenticated;
revoke all on function public.client_hub_sign_in(uuid, text, text, inet, uuid[], text[]) from public, anon, authenticated;
grant execute on function public.client_hub_resolve_session(uuid[], text[]) to service_role;
grant execute on function public.client_hub_sign_out(uuid[], text[], boolean) to service_role;
grant execute on function public.client_hub_sign_in(uuid, text, text, inet, uuid[], text[]) to service_role;

-- Superseded single-token entry points: a session opened or ended without
-- the browser's other sessions would bring back the shared-cookie races.
revoke execute on function public.client_hub_verify_code(uuid, text, text, inet) from service_role;
revoke execute on function public.client_hub_end_session(text, boolean) from service_role;
