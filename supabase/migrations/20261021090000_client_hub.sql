-- Client Hub V1 (backend): passwordless customer sessions and a read-only
-- view of the customer's own appointments and loyalty, per business.
--
-- Architecture (docs/CLIENT_HUB_CONTRACT.md):
--   * Customers are NOT Supabase Auth users. Supabase Auth identifies
--     professionals: an `authenticated` JWT reaches PostgREST directly, the
--     onboarding (complete_onboarding) and every member-scoped policy. A
--     customer gets none of that. A customer session is an opaque random
--     token, stored here only as its SHA-256, carried in an HttpOnly cookie
--     and presented by the server routes (service role) to the functions
--     below, which are executable by the service role only: the same single
--     entry pattern as public booking.
--   * Email ownership is proven by an 8-digit code sent to the address:
--     single use, 10 minutes, 5 attempts, invalidated by any successful
--     login of the same address, never stored in clear (keyed HMAC). A code
--     is typed, not clicked: link scanners cannot consume it.
--   * Proving an email is NOT access to a business's records. A booking's
--     email was typed by whoever booked; a professional may have mistyped
--     one. The customer sees a business relationship (its appointments,
--     loyalty, rewards) only once a member of that business has authorized
--     Client Hub access for that CRM record, for its email at that moment
--     (public.client_hub_access), and only while the record still has that
--     email. Without it, the hub shows nothing of that business: not even
--     that a record exists.
--   * Read-only: no function here writes appointments, CRM records, the
--     ledger or redemptions. Customer-safe projections only: no internal
--     notes, no contact snapshots, no free-text written by the
--     professional (cancellation reasons, ledger reasons), no other
--     customer's data. Every list is bounded and keyset-paginated.

-- ---------------------------------------------------------------------------
-- 1. Professional authorization of a business relationship
-- ---------------------------------------------------------------------------

create table public.client_hub_access (
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_id uuid not null,
  -- The canonical email the professional vouched for.
  email extensions.citext not null,
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_by uuid references public.profiles (id) on delete set null,
  revoked_at timestamptz,
  primary key (business_id, client_id),
  foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade
);

create index client_hub_access_email_idx
  on public.client_hub_access (email)
  where revoked_at is null;

alter table public.client_hub_access enable row level security;

create policy "client_hub_access_select_member"
  on public.client_hub_access for select to authenticated
  using (public.is_business_member(business_id));

revoke all on public.client_hub_access from anon, authenticated;
grant select on public.client_hub_access to authenticated;

comment on table public.client_hub_access is
  'Client Hub access to one CRM record, authorized by a member of its business '
  'for the email the record had then. Effective only while the record keeps '
  'that email and the access is not revoked.';

-- Grants (p_granted true) or revokes access for one customer of the
-- business. Idempotent: the same state again changes nothing. A grant
-- vouches for the record's current email; with p_expected_email (the email
-- the professional was shown), it is refused (stale_client) if the record
-- has another one by now. The record is locked FOR SHARE until commit: its
-- email cannot change under the grant.
create function public.client_hub_set_access(
  p_business_id uuid,
  p_client_id uuid,
  p_granted boolean,
  p_expected_email text default null
)
returns table (granted boolean, email text, granted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_current public.client_hub_access%rowtype;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_granted is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'granted';
  end if;

  select private.canonical_email(c.email::text) into v_email
  from public.clients c
  where c.id = p_client_id
    and c.business_id = p_business_id
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  if p_granted and p_expected_email is not null
    and v_email is distinct from private.canonical_email(p_expected_email) then
    raise exception using errcode = 'P0001', message = 'stale_client', hint = 'clientId';
  end if;

  select a.* into v_current
  from public.client_hub_access a
  where a.business_id = p_business_id
    and a.client_id = p_client_id
  for update;

  if p_granted then
    if v_email is null then
      raise exception using errcode = 'P0001', message = 'client_hub_email_required', hint = 'clientId';
    end if;

    if v_current.client_id is not null
      and v_current.revoked_at is null
      and v_current.email::text = v_email then
      return query select true, v_email, v_current.granted_at;
      return;
    end if;

    insert into public.client_hub_access (business_id, client_id, email, granted_by, granted_at)
    values (p_business_id, p_client_id, v_email, (select auth.uid()), pg_catalog.now())
    on conflict (business_id, client_id) do update
      set email = excluded.email,
          granted_by = excluded.granted_by,
          granted_at = excluded.granted_at,
          revoked_by = null,
          revoked_at = null;

    return query select true, v_email, pg_catalog.now();
    return;
  end if;

  if v_current.client_id is not null and v_current.revoked_at is null then
    update public.client_hub_access a
    set revoked_by = (select auth.uid()),
        revoked_at = pg_catalog.now()
    where a.business_id = p_business_id
      and a.client_id = p_client_id;
  end if;

  return query select false, null::text, null::timestamptz;
end;
$$;

-- A change of the record's email revokes its access at once: the grant
-- vouched for the former address, and reverting the email does not revive
-- it (a new grant is needed). Whatever the write path.
create function private.client_hub_revoke_on_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.canonical_email(new.email::text) is distinct from private.canonical_email(old.email::text) then
    update public.client_hub_access a
    set revoked_at = pg_catalog.now(),
        revoked_by = (select auth.uid())
    where a.business_id = new.business_id
      and a.client_id = new.id
      and a.revoked_at is null;
  end if;
  return null;
end;
$$;

revoke all on function private.client_hub_revoke_on_email_change() from public;

create trigger clients_client_hub_revoke_on_email_change
  after update of email on public.clients
  for each row execute function private.client_hub_revoke_on_email_change();

-- ---------------------------------------------------------------------------
-- 2. Accounts, challenges, sessions (internal: no API role reaches them)
-- ---------------------------------------------------------------------------

-- A verified email: created at its first successful login only (requests
-- for unknown addresses leave no account).
create table private.client_hub_accounts (
  id uuid primary key default gen_random_uuid(),
  email extensions.citext not null unique,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

create table private.client_hub_challenges (
  id uuid primary key default gen_random_uuid(),
  email extensions.citext not null,
  code_hash text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  consumed_at timestamptz
);

create index client_hub_challenges_open_idx
  on private.client_hub_challenges (email)
  where consumed_at is null;

create table private.client_hub_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references private.client_hub_accounts (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null
);

create index client_hub_sessions_account_idx
  on private.client_hub_sessions (account_id)
  where revoked_at is null;

-- Abuse log (keyed HMACs, never an address or email in clear).
create table private.client_hub_log (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('code_requested', 'code_failed')),
  email_key text not null,
  network_key text,
  -- (email, network): one network's requests for an address.
  pair_key text,
  created_at timestamptz not null
);

create index client_hub_log_email_idx on private.client_hub_log (email_key, kind, created_at);
create index client_hub_log_network_idx on private.client_hub_log (network_key, kind, created_at);
create index client_hub_log_pair_idx on private.client_hub_log (pair_key, created_at);
create index client_hub_log_created_idx on private.client_hub_log (created_at);
create index client_hub_challenges_expiry_idx on private.client_hub_challenges (expires_at);
create index client_hub_sessions_expiry_idx on private.client_hub_sessions (expires_at);

revoke all on private.client_hub_accounts, private.client_hub_challenges,
  private.client_hub_sessions, private.client_hub_log
  from public, anon, authenticated;

-- One IPv4 address or one IPv6 /64, as for public booking.
create function private.client_hub_network_key(p_client_ip inet)
returns text
language sql
stable
set search_path = ''
as $$
  select private.abuse_key('client_hub_network:' || case
    when pg_catalog.family(p_client_ip) = 4 then pg_catalog.host(p_client_ip)
    else pg_catalog.network(pg_catalog.set_masklen(p_client_ip, 64))::text
  end);
$$;

revoke all on function private.client_hub_network_key(inet) from public;

-- The canonical email, if it is a plausible address (same rule as booking).
create function private.client_hub_email(p_email text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_email text := private.canonical_email(p_email);
begin
  -- ASCII only: the code is sent to exactly the address it is bound to,
  -- with no case or Unicode mapping a mail system could resolve elsewhere.
  if v_email is null
    or pg_catalog.char_length(v_email) > 254
    or v_email !~ '^[!-~]+$'
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid_email', hint = 'email';
  end if;
  return v_email;
end;
$$;

revoke all on function private.client_hub_email(text) from public;

-- ---------------------------------------------------------------------------
-- 3. Login: request a code, verify it, end the session
-- ---------------------------------------------------------------------------

-- Issues a code for `p_email` and returns it once, with the canonical
-- address to send it to (never another spelling). The answer never depends
-- on whether the email is known anywhere. Limits (rolling windows, counted
-- under advisory locks on the network and the email, so concurrent requests
-- cannot exceed them):
--   per (email, network): 3 per 15 minutes, 5 per 24 hours: one network
--     cannot use up an address's allowance;
--   per email:            10 per hour, 20 per 24 hours (all networks);
--   per network:          10 per hour, 30 per 24 hours (all addresses).
create function public.client_hub_request_code(
  p_email text,
  p_client_ip inet
)
returns table (challenge_id uuid, code text, email text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_email text := private.client_hub_email(p_email);
  v_email_key text;
  v_network_key text;
  v_pair_key text;
  v_code text;
  v_id uuid;
begin
  if p_client_ip is null then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  v_email_key := private.abuse_key('client_hub_email:' || v_email);
  v_network_key := private.client_hub_network_key(p_client_ip);
  v_pair_key := private.abuse_key('client_hub_pair:' || v_email || '|' || v_network_key);
  -- Fixed order (network, then email): no deadlock between requests.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_network:' || v_network_key, 0));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_email:' || v_email_key, 0));

  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.pair_key = v_pair_key
        and l.created_at > v_now - interval '15 minutes') >= 3
    or (select pg_catalog.count(*) from private.client_hub_log l
      where l.pair_key = v_pair_key
        and l.created_at > v_now - interval '24 hours') >= 5
    or (select pg_catalog.count(*) from private.client_hub_log l
      where l.email_key = v_email_key and l.kind = 'code_requested'
        and l.created_at > v_now - interval '1 hour') >= 10
    or (select pg_catalog.count(*) from private.client_hub_log l
      where l.email_key = v_email_key and l.kind = 'code_requested'
        and l.created_at > v_now - interval '24 hours') >= 20
    or (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_requested'
        and l.created_at > v_now - interval '1 hour') >= 10
    or (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_requested'
        and l.created_at > v_now - interval '24 hours') >= 30
  then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  -- Bounded retention (indexed): abuse log 2 days, challenges and ended
  -- sessions 1 day after their end.
  delete from private.client_hub_log l where l.created_at < v_now - interval '2 days';
  delete from private.client_hub_challenges c where c.expires_at < v_now - interval '1 day';
  delete from private.client_hub_sessions s where s.expires_at < v_now - interval '1 day';

  -- 8 digits from 56 random bits (modulo bias below 1e-8).
  v_code := pg_catalog.lpad(
    ((('x' || pg_catalog.encode(extensions.gen_random_bytes(7), 'hex'))::bit(56)::bigint)
      % 100000000)::text,
    8, '0');
  v_id := gen_random_uuid();

  insert into private.client_hub_challenges (id, email, code_hash, created_at, expires_at)
  values (
    v_id, v_email,
    private.abuse_key('client_hub_code:' || v_id::text || ':' || v_code),
    v_now, v_now + interval '10 minutes'
  );
  insert into private.client_hub_log (kind, email_key, network_key, pair_key, created_at)
  values ('code_requested', v_email_key, v_network_key, v_pair_key, v_now);

  return query select v_id, v_code, v_email, v_now + interval '10 minutes';
end;
$$;

-- Verifies a code. Never raises for a wrong code (the failed attempt must
-- be recorded): returns status 'invalid' for an unknown, expired, consumed,
-- exhausted or mismatched challenge alike (no oracle), 'rate_limited' when
-- the network made too many failed attempts (counted under its advisory
-- lock), or 'ok' with a new session token (returned once; only its SHA-256
-- is stored). The challenge row is locked: concurrent verifications of one
-- code yield one session.
create function public.client_hub_verify_code(
  p_challenge_id uuid,
  p_email text,
  p_code text,
  p_client_ip inet
)
returns table (
  status text,
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
  v_email text;
  v_network_key text;
  v_challenge private.client_hub_challenges%rowtype;
  v_account uuid;
  v_token text;
  v_consumed integer;
begin
  if p_client_ip is null then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  v_email := private.client_hub_email(p_email);
  v_network_key := private.client_hub_network_key(p_client_ip);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client_hub_network:' || v_network_key, 0));

  if (select pg_catalog.count(*) from private.client_hub_log l
      where l.network_key = v_network_key and l.kind = 'code_failed'
        and l.created_at > v_now - interval '1 hour') >= 20 then
    return query select 'rate_limited'::text, null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select c.* into v_challenge
  from private.client_hub_challenges c
  where c.id = p_challenge_id
  for update;

  if not found
    or v_challenge.email::text <> v_email
    or v_challenge.consumed_at is not null
    or v_challenge.expires_at <= v_now
    or v_challenge.attempts >= 5
    or p_code is null
    or p_code !~ '^[0-9]{8}$'
    or v_challenge.code_hash <> private.abuse_key(
         'client_hub_code:' || v_challenge.id::text || ':' || p_code)
  then
    if found and v_challenge.consumed_at is null then
      update private.client_hub_challenges c
      set attempts = c.attempts + 1
      where c.id = v_challenge.id;
    end if;
    insert into private.client_hub_log (kind, email_key, network_key, created_at)
    values ('code_failed', private.abuse_key('client_hub_email:' || v_email), v_network_key, v_now);
    return query select 'invalid'::text, null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  -- Consumed, with every other open code of this address. Under the row
  -- lock this cannot be lost to a concurrent verification; checked anyway.
  update private.client_hub_challenges c
  set consumed_at = v_now
  where c.email = v_challenge.email
    and c.consumed_at is null;

  update private.client_hub_challenges c
  set consumed_at = v_now
  where c.id = v_challenge.id
    and c.consumed_at = v_now;
  get diagnostics v_consumed = row_count;
  if v_consumed <> 1 then
    return query select 'invalid'::text, null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  insert into private.client_hub_accounts (email, created_at, last_login_at)
  values (v_email, v_now, v_now)
  on conflict on constraint client_hub_accounts_email_key
    do update set last_login_at = excluded.last_login_at
  returning id into v_account;

  v_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.client_hub_sessions (account_id, token_hash, created_at, expires_at, last_seen_at)
  values (
    v_account,
    pg_catalog.encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_now, v_now + interval '7 days', v_now
  );

  return query select 'ok'::text, v_token, v_account, v_email, v_now + interval '7 days';
end;
$$;

-- The account of a live session, or `client_hub_unauthenticated`.
create function private.client_hub_session_account(
  p_session_token text,
  p_now timestamptz
)
returns private.client_hub_accounts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session private.client_hub_sessions%rowtype;
  v_account private.client_hub_accounts%rowtype;
begin
  if p_session_token is null or p_session_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'client_hub_unauthenticated';
  end if;

  select s.* into v_session
  from private.client_hub_sessions s
  where s.token_hash = pg_catalog.encode(extensions.digest(p_session_token, 'sha256'), 'hex');

  if not found or v_session.revoked_at is not null or v_session.expires_at <= p_now then
    raise exception using errcode = '42501', message = 'client_hub_unauthenticated';
  end if;

  select a.* into v_account
  from private.client_hub_accounts a
  where a.id = v_session.account_id;

  if v_session.last_seen_at < p_now - interval '5 minutes' then
    update private.client_hub_sessions s set last_seen_at = p_now where s.id = v_session.id;
  end if;

  return v_account;
end;
$$;

revoke all on function private.client_hub_session_account(text, timestamptz) from public;

-- Ends the session (p_all: every session of the account). Idempotent: an
-- unknown or ended session is a success.
create function public.client_hub_end_session(
  p_session_token text,
  p_all boolean default false
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session private.client_hub_sessions%rowtype;
begin
  if p_session_token is null or p_session_token !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select s.* into v_session
  from private.client_hub_sessions s
  where s.token_hash = pg_catalog.encode(extensions.digest(p_session_token, 'sha256'), 'hex');

  if not found then
    return;
  end if;

  update private.client_hub_sessions s
  set revoked_at = pg_catalog.now()
  where s.revoked_at is null
    and (s.id = v_session.id or (coalesce(p_all, false) and s.account_id = v_session.account_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Authorization of a business relationship
-- ---------------------------------------------------------------------------

-- The CRM record of `p_business_id` the account may see: an authorized,
-- unrevoked access whose vouched email is the account's and still the
-- record's. Otherwise `client_hub_not_found` (whether the business, the
-- record or the access is missing: nothing is revealed).
create function private.client_hub_client(
  p_account private.client_hub_accounts,
  p_business_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.client_id
  from public.client_hub_access a
  join public.clients c
    on c.id = a.client_id and c.business_id = a.business_id
  where a.business_id = p_business_id
    and a.revoked_at is null
    and a.email = p_account.email
    and private.canonical_email(c.email::text) = p_account.email::text;
$$;

revoke all on function private.client_hub_client(private.client_hub_accounts, uuid) from public;

create function private.client_hub_require_client(
  p_account private.client_hub_accounts,
  p_business_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client uuid;
begin
  if p_business_id is not null then
    v_client := private.client_hub_client(p_account, p_business_id);
  end if;
  if v_client is null then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;
  return v_client;
end;
$$;

revoke all on function private.client_hub_require_client(private.client_hub_accounts, uuid) from public;

-- ---------------------------------------------------------------------------
-- 5. Read models (customer-safe projections)
-- ---------------------------------------------------------------------------

-- The signed-in customer and the businesses they may see.
create function public.client_hub_profile(
  p_session_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
begin
  return pg_catalog.jsonb_build_object(
    'email', v_account.email::text,
    'businesses', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'businessId', b.id,
          'name', b.name,
          'slug', b.slug::text,
          'timezone', b.timezone,
          'location', b.location,
          'customer', pg_catalog.jsonb_build_object(
            'firstName', c.first_name,
            'lastName', c.last_name
          )
        )
        order by b.name, b.id
      )
      from public.client_hub_access a
      join public.clients c on c.id = a.client_id and c.business_id = a.business_id
      join public.businesses b on b.id = a.business_id
      where a.revoked_at is null
        and a.email = v_account.email
        and private.canonical_email(c.email::text) = v_account.email::text
    ), '[]'::jsonb)
  );
end;
$$;

-- One appointment as the customer sees it.
create function private.client_hub_appointment_json(p_appointment public.appointments)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_appointment.id,
    'status', p_appointment.status,
    'startsAt', p_appointment.starts_at,
    'endsAt', p_appointment.ends_at,
    'serviceName', p_appointment.service_name_snapshot,
    'durationMinutes', p_appointment.duration_minutes_snapshot,
    'priceCents', p_appointment.price_cents_snapshot,
    'currency', p_appointment.currency
  );
$$;

revoke all on function private.client_hub_appointment_json(public.appointments) from public;

-- Upcoming (starts at or after now, soonest first) or past (before now,
-- latest first) appointments of the customer in one business. Keyset:
-- the (startsAt, id) of the last item of the previous page. At most 50.
create function public.client_hub_appointments(
  p_session_token text,
  p_business_id uuid,
  p_scope text,
  p_after_starts_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.client_hub_require_client(v_account, p_business_id);
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
begin
  if p_scope is null or p_scope not in ('upcoming', 'past') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'scope';
  end if;
  if (p_after_starts_at is null) <> (p_after_id is null) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'cursor';
  end if;

  if p_scope = 'upcoming' then
    select coalesce(pg_catalog.jsonb_agg(private.client_hub_appointment_json(x) order by x.starts_at, x.id), '[]'::jsonb)
    into v_rows
    from (
      select a.* from public.appointments a
      where a.business_id = p_business_id
        and a.client_id = v_client
        and a.starts_at >= pg_catalog.now()
        and (p_after_starts_at is null or (a.starts_at, a.id) > (p_after_starts_at, p_after_id))
      order by a.starts_at, a.id
      limit v_limit + 1
    ) x;
  else
    select coalesce(pg_catalog.jsonb_agg(private.client_hub_appointment_json(x) order by x.starts_at desc, x.id desc), '[]'::jsonb)
    into v_rows
    from (
      select a.* from public.appointments a
      where a.business_id = p_business_id
        and a.client_id = v_client
        and a.starts_at < pg_catalog.now()
        and (p_after_starts_at is null or (a.starts_at, a.id) < (p_after_starts_at, p_after_id))
      order by a.starts_at desc, a.id desc
      limit v_limit + 1
    ) x;
  end if;

  return pg_catalog.jsonb_build_object(
    'items', (select coalesce(pg_catalog.jsonb_agg(e order by o), '[]'::jsonb)
              from pg_catalog.jsonb_array_elements(v_rows) with ordinality as t(e, o)
              where o <= v_limit),
    'hasMore', pg_catalog.jsonb_array_length(v_rows) > v_limit
  );
end;
$$;

-- One appointment of the customer, with the business's public details.
create function public.client_hub_appointment(
  p_session_token text,
  p_business_id uuid,
  p_appointment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.client_hub_require_client(v_account, p_business_id);
  v_appointment public.appointments%rowtype;
  v_business public.businesses%rowtype;
begin
  select a.* into v_appointment
  from public.appointments a
  where a.id = p_appointment_id
    and a.business_id = p_business_id
    and a.client_id = v_client;

  if not found then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;

  select b.* into v_business from public.businesses b where b.id = p_business_id;

  return private.client_hub_appointment_json(v_appointment)
    || pg_catalog.jsonb_build_object(
      'business', pg_catalog.jsonb_build_object(
        'name', v_business.name,
        'slug', v_business.slug::text,
        'timezone', v_business.timezone,
        'location', v_business.location,
        'cancellationPolicy', v_business.cancellation_policy
      )
    );
end;
$$;

-- Loyalty in one business: program state, balance, the active rewards with
-- the customer's eligibility, and the rewards issued to them (newest first,
-- at most 50).
create function public.client_hub_loyalty(
  p_session_token text,
  p_business_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.client_hub_require_client(v_account, p_business_id);
  v_balance bigint := private.loyalty_balance(p_business_id, v_client);
  v_active boolean;
begin
  select coalesce(
    (select p.active from public.loyalty_programs p where p.business_id = p_business_id),
    false
  ) into v_active;

  return pg_catalog.jsonb_build_object(
    'programActive', v_active,
    'balance', v_balance,
    'rewards', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', w.id,
          'name', w.name,
          'description', w.description,
          'pointsRequired', w.points_required,
          'rewardType', w.reward_type,
          'rewardValue', w.reward_value,
          'currency', w.currency,
          'serviceName', s.name,
          'eligible', v_active and v_balance >= w.points_required
                      and not (w.reward_type = 'free_service' and w.service_id is null)
                      and not (w.reward_type = 'fixed_discount' and w.currency is null),
          'missingPoints', greatest(w.points_required - v_balance, 0)
        )
        order by w.points_required, w.name, w.id
      )
      from public.rewards w
      left join public.services s
        on s.id = w.service_id and s.business_id = w.business_id
      where w.business_id = p_business_id
        and w.active
    ), '[]'::jsonb),
    'issuedRewards', coalesce((
      select pg_catalog.jsonb_agg(r.item order by r.redeemed_at desc, r.id desc)
      from (
        select d.id, d.redeemed_at,
          pg_catalog.jsonb_build_object(
            'id', d.id,
            'status', d.status,
            'name', d.reward_name_snapshot,
            'rewardType', d.reward_type_snapshot,
            'rewardValue', d.reward_value_snapshot,
            'currency', d.reward_currency_snapshot,
            'serviceName', d.reward_service_name_snapshot,
            'pointsSpent', d.points_spent,
            'issuedAt', d.redeemed_at,
            'fulfilledAt', d.fulfilled_at,
            'cancelledAt', d.cancelled_at
          ) as item
        from public.reward_redemptions d
        where d.business_id = p_business_id
          and d.client_id = v_client
        order by d.redeemed_at desc, d.id desc
        limit 50
      ) r
    ), '[]'::jsonb)
  );
end;
$$;

-- The customer's ledger in one business, newest first, at most 50 per
-- page. The cursor is the entry's position in this customer's own ledger
-- (1, 2, 3…; p_before_position: the last position of the previous page),
-- never the global ledger_seq, which would reveal the activity of every
-- business. Positions are stable: the ledger is append-only. No free text written by the professional: each entry carries
-- its type and, where the entry was generated, its service or reward.
create function public.client_hub_loyalty_ledger(
  p_session_token text,
  p_business_id uuid,
  p_before_position bigint default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.client_hub_require_client(v_account, p_business_id);
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
begin
  with ledger as (
    select e.*,
      sum(e.points_delta) over (order by e.ledger_seq)::bigint as running,
      pg_catalog.row_number() over (order by e.ledger_seq) as position
    from public.loyalty_events e
    where e.business_id = p_business_id
      and e.client_id = v_client
  ), page as (
    select l.* from ledger l
    where p_before_position is null or l.position < p_before_position
    order by l.ledger_seq desc
    limit v_limit + 1
  )
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', p.id,
      'position', p.position,
      'type', p.type,
      'pointsDelta', p.points_delta,
      'balanceAfter', p.running,
      'createdAt', p.created_at,
      'appointmentId', p.appointment_id,
      'serviceName', case when p.type = 'appointment_completed'
                          then p.details ->> 'serviceName' end,
      'rewardName', (
        select d.reward_name_snapshot
        from public.reward_redemptions d
        where d.business_id = p_business_id
          and (d.loyalty_event_id = p.id or d.refund_event_id = p.id)
      ),
      'isReversal', p.reverses_event_id is not null,
      'reversed', exists (
        select 1 from public.loyalty_events r where r.reverses_event_id = p.id
      )
    )
    order by p.ledger_seq desc
  ), '[]'::jsonb)
  into v_rows
  from page p;

  return pg_catalog.jsonb_build_object(
    'items', (select coalesce(pg_catalog.jsonb_agg(e order by o), '[]'::jsonb)
              from pg_catalog.jsonb_array_elements(v_rows) with ordinality as t(e, o)
              where o <= v_limit),
    'hasMore', pg_catalog.jsonb_array_length(v_rows) > v_limit
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.client_hub_set_access(uuid, uuid, boolean, text) from public, anon;
grant execute on function public.client_hub_set_access(uuid, uuid, boolean, text) to authenticated;

-- Customer functions: the server routes only (service role).
revoke all on function public.client_hub_request_code(text, inet) from public, anon, authenticated;
revoke all on function public.client_hub_verify_code(uuid, text, text, inet) from public, anon, authenticated;
revoke all on function public.client_hub_end_session(text, boolean) from public, anon, authenticated;
revoke all on function public.client_hub_profile(text) from public, anon, authenticated;
revoke all on function public.client_hub_appointments(text, uuid, text, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function public.client_hub_appointment(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.client_hub_loyalty(text, uuid) from public, anon, authenticated;
revoke all on function public.client_hub_loyalty_ledger(text, uuid, bigint, integer) from public, anon, authenticated;

grant execute on function public.client_hub_request_code(text, inet) to service_role;
grant execute on function public.client_hub_verify_code(uuid, text, text, inet) to service_role;
grant execute on function public.client_hub_end_session(text, boolean) to service_role;
grant execute on function public.client_hub_profile(text) to service_role;
grant execute on function public.client_hub_appointments(text, uuid, text, timestamptz, uuid, integer) to service_role;
grant execute on function public.client_hub_appointment(text, uuid, uuid) to service_role;
grant execute on function public.client_hub_loyalty(text, uuid) to service_role;
grant execute on function public.client_hub_loyalty_ledger(text, uuid, bigint, integer) to service_role;
