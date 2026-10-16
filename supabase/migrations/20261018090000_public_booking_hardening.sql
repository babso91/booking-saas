-- Public booking (PR #21): security remediation after two independent
-- audits of e28d0db. The booking engine is unchanged; this migration
-- replaces the abuse limits, the client resolution and the validation
-- errors of the public path. Additive: 20261017090000 stays as it was.
--
--   1. Network identity: the booking takes the caller's address
--      (p_client_ip inet), as the route established it from the trusted
--      ingress (src/lib/client-identity.ts), instead of a free-form key.
--      IPv4: the address; IPv6: its /64. Required by the public function.
--   2. Layered limits on new bookings: per network 5/hour and 15/24 h;
--      per network in a business 3/24 h; per email in a business 10/24 h.
--      No business-wide quota (it would let an attacker lock out real
--      customers). Rate limits raise the cost of abuse; they do not prove
--      that a customer is real (docs/PUBLIC_BOOKING_CONTRACT.md).
--   3. Pseudonymous log: identities are HMAC-SHA256 under a random key
--      generated in this database (private.abuse_hmac_keys), unreadable by
--      every API role, never derived from a constant, never sent anywhere.
--      The previous rows (unsalted SHA-256, reversible for IPv4) are
--      deleted. Keyed identifiers are pseudonymous, not anonymous.
--   4. Bounded retention: rows older than 48 h (longest window 24 h plus a
--      margin) are purged, a bounded batch per booking plus
--      private.purge_public_booking_log for scheduled cleanup. Idempotency
--      lives in appointments.creation_request_id: never touched.
--   5. Existing customers: a public booking links the record with this
--      email as it is and never completes nor changes it (no ownership of
--      the email is proven). New customers are created as before.
--   6. Validation errors name their field in HINT (firstName, lastName,
--      email, phone, startsAt) so that the API answers fieldErrors.
--   7. get_public_business also answers `today`, the business-local date
--      by the database's clock (for the booking calendar).

-- ---------------------------------------------------------------------------
-- 1. Keyed pseudonyms
-- ---------------------------------------------------------------------------

create table private.abuse_hmac_keys (
  id integer generated always as identity primary key,
  key bytea not null default extensions.gen_random_bytes(32)
    check (pg_catalog.octet_length(key) = 32),
  created_at timestamptz not null default now()
);

alter table private.abuse_hmac_keys enable row level security;
revoke all on table private.abuse_hmac_keys from public, anon, authenticated, service_role;

comment on table private.abuse_hmac_keys is
  'Random HMAC keys of the abuse identifiers (newest in use). Rotation: insert a row; counts restart with it.';

insert into private.abuse_hmac_keys default values;

-- HMAC-SHA256 (hex) of p_value under the newest key.
create function private.abuse_key(p_value text)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.hmac(pg_catalog.convert_to(p_value, 'UTF8'), k.key, 'sha256'),
    'hex'
  )
  from private.abuse_hmac_keys k
  order by k.id desc
  limit 1;
$$;

revoke all on function private.abuse_key(text) from public;

-- ---------------------------------------------------------------------------
-- 2. The log: keyed identifiers, bounded retention
-- ---------------------------------------------------------------------------

delete from private.public_booking_log;

drop index private.public_booking_log_key_idx;
drop index private.public_booking_log_email_idx;
alter table private.public_booking_log rename column client_key_hash to network_key;
alter table private.public_booking_log rename column email_hash to email_key;

create index public_booking_log_network_idx
  on private.public_booking_log (network_key, created_at)
  where network_key is not null;
create index public_booking_log_email_idx
  on private.public_booking_log (business_id, email_key, created_at);
create index public_booking_log_created_idx
  on private.public_booking_log (created_at);

comment on table private.public_booking_log is
  'One row per new public booking: HMAC pseudonyms of the network and email (private.abuse_key), kept 48 hours, for the abuse limits of create_public_booking.';

-- Deletes up to p_limit entries older than p_before, oldest first (index
-- range only). Returns how many were deleted.
create function private.purge_public_booking_log(p_before timestamptz, p_limit integer default 1000)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from private.public_booking_log l
  where l.id in (
    select o.id
    from private.public_booking_log o
    where o.created_at < p_before
    order by o.created_at
    limit p_limit
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.purge_public_booking_log(timestamptz, integer) from public;

-- ---------------------------------------------------------------------------
-- 3. Existing customers are linked, never changed, by a public booking
-- ---------------------------------------------------------------------------

-- The customer of p_business_id with this canonical email: created with
-- the submitted contact when there is none; otherwise returned as it is.
-- Concurrent first bookings of one email converge on one record (unique
-- business_id, email).
create function private.resolve_public_client(
  p_business_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_email text := private.canonical_email(p_email);
  v_client_id uuid;
begin
  insert into public.clients (business_id, first_name, last_name, email, phone)
  values (
    p_business_id,
    p_first_name,
    nullif(pg_catalog.btrim(p_last_name), ''),
    v_email,
    nullif(pg_catalog.btrim(p_phone), '')
  )
  on conflict (business_id, email) do nothing
  returning id into v_client_id;

  if v_client_id is null then
    select c.id into v_client_id
    from public.clients c
    where c.business_id = p_business_id
      and c.email operator(extensions.=) v_email::extensions.citext;
  end if;

  return v_client_id;
end;
$$;

revoke all on function private.resolve_public_client(uuid, text, text, text, text) from public;

-- ---------------------------------------------------------------------------
-- 4. The booking functions
-- ---------------------------------------------------------------------------

drop function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, text, text, text);
drop function private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text, uuid, text);

-- p_now: the transaction time in production (create_public_booking); tests
-- pass a fixed instant. p_request_id and p_client_ip are optional here
-- (internal callers); the public function requires them.
create function private.create_public_booking_at(
  p_now timestamptz,
  p_slug text,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_email text,
  p_last_name text default null,
  p_phone text default null,
  p_request_id uuid default null,
  p_client_ip inet default null
)
returns table (
  appointment_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  service_name text,
  duration_minutes integer,
  price_cents integer,
  currency text,
  business_name text,
  status text,
  replayed boolean
)
language plpgsql
set search_path = ''
as $$
declare
  v_business_id uuid;
  v_business_slug text;
  v_business_name text;
  v_timezone text;
  v_currency text;
  v_step integer;
  v_buffer integer;
  v_notice integer;
  v_max_days integer;
  v_service_name text;
  v_duration integer;
  v_price integer;
  v_first_name text := pg_catalog.btrim(p_first_name);
  v_last_name text := nullif(pg_catalog.btrim(p_last_name), '');
  v_email text := private.canonical_email(p_email);
  v_phone text := nullif(pg_catalog.btrim(p_phone), '');
  v_ends_at timestamptz;
  v_client_id uuid;
  v_appointment_id uuid;
  v_fingerprint text;
  v_existing record;
  v_network text;
  v_network_key text;
  v_email_key text;
begin
  if v_first_name is null or pg_catalog.char_length(v_first_name) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'invalid_first_name', hint = 'firstName';
  end if;
  if v_last_name is not null and pg_catalog.char_length(v_last_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid_last_name', hint = 'lastName';
  end if;
  if v_email is null
    or pg_catalog.char_length(v_email) > 254
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid_email', hint = 'email';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ().-]{6,30}$' then
    raise exception using errcode = '22023', message = 'invalid_phone', hint = 'phone';
  end if;
  if p_starts_at is null then
    raise exception using errcode = '22023', message = 'invalid_starts_at', hint = 'startsAt';
  end if;

  v_business_id := private.business_id_by_slug(p_slug);

  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;

  -- 1. Serialise with every other write to this schedule (bookings, blocks,
  --    weekly hours). Statements below run on snapshots taken after the lock.
  perform private.lock_business_schedule(v_business_id);

  -- 2a. A request already processed (a retry after a lost answer, a double
  --     submission): answered from its appointment, nothing is written,
  --     whatever the availability now. Under the schedule lock, so a
  --     concurrent identical request waits for the first and lands here.
  if p_request_id is not null then
    v_fingerprint := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'kind', 'public_booking',
          'service_id', p_service_id,
          'starts_at', extract(epoch from p_starts_at),
          'first_name', v_first_name,
          'last_name', v_last_name,
          'email', v_email,
          'phone', v_phone
        )::text,
        'UTF8'
      )),
      'hex'
    );

    select a.id, a.creation_request_fingerprint, a.starts_at, a.ends_at,
           a.status::text as status, a.service_name_snapshot,
           a.duration_minutes_snapshot, a.price_cents_snapshot, a.currency,
           b.name as business_name, b.timezone
    into v_existing
    from public.appointments a
    join public.businesses b on b.id = a.business_id
    where a.business_id = v_business_id
      and a.creation_request_id = p_request_id;

    if found then
      if v_existing.creation_request_fingerprint is distinct from v_fingerprint then
        raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
      end if;
      return query
      select
        v_existing.id, v_existing.starts_at, v_existing.ends_at,
        v_existing.timezone, v_existing.service_name_snapshot,
        v_existing.duration_minutes_snapshot, v_existing.price_cents_snapshot,
        v_existing.currency, v_existing.business_name,
        v_existing.status, true;
      return;
    end if;
  end if;

  -- 2b. Abuse limits on new bookings (never on replays), counted in
  --     private.public_booking_log within this transaction. The network
  --     identity is the caller's address as the trusted ingress gave it to
  --     the route: one IPv4 address, or one IPv6 /64 (what a single
  --     subscriber usually holds). Identities are stored as keyed HMACs
  --     (private.abuse_key), never in clear:
  --       - per network: 5 per rolling hour and 15 per 24 hours, all
  --         businesses;
  --       - per network in this business: 3 per 24 hours;
  --       - per customer email in this business: 10 per 24 hours (an email
  --         is cheap to vary: a secondary limit only).
  --     One answer for all of them (rate_limited): nothing tells which one,
  --     nor whether the email is known.
  if p_client_ip is not null then
    v_network := case
      when pg_catalog.family(p_client_ip) = 4
        then pg_catalog.host(p_client_ip)
      else pg_catalog.network(pg_catalog.set_masklen(p_client_ip, 64))::text
    end;
    v_network_key := private.abuse_key('network:' || v_network);
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('public_booking_network:' || v_network_key, 0)
    );
  end if;
  v_email_key := private.abuse_key('email:' || v_email);

  if (
    v_network_key is not null
    and (
      (
        select pg_catalog.count(*)
        from private.public_booking_log l
        where l.network_key = v_network_key
          and l.created_at > p_now - interval '1 hour'
      ) >= 5
      or (
        select pg_catalog.count(*)
        from private.public_booking_log l
        where l.network_key = v_network_key
          and l.created_at > p_now - interval '24 hours'
      ) >= 15
      or (
        select pg_catalog.count(*)
        from private.public_booking_log l
        where l.network_key = v_network_key
          and l.business_id = v_business_id
          and l.created_at > p_now - interval '24 hours'
      ) >= 3
    )
  ) or (
    select pg_catalog.count(*)
    from private.public_booking_log l
    where l.business_id = v_business_id
      and l.email_key = v_email_key
      and l.created_at > p_now - interval '24 hours'
  ) >= 10 then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  -- 2. Read business, settings and service once and lock them in share mode
  --    until commit: a concurrent change either commits before (and is read
  --    here) or waits for this transaction. These values are the only ones
  --    used for validation, occupied window and insertion.
  select
    b.slug::text, b.name, b.timezone,
    st.currency, st.slot_interval_minutes, st.buffer_minutes,
    st.minimum_booking_notice_minutes, st.maximum_booking_advance_days,
    s.name, s.duration_minutes, s.price_cents
  into
    v_business_slug, v_business_name, v_timezone,
    v_currency, v_step, v_buffer, v_notice, v_max_days,
    v_service_name, v_duration, v_price
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  join public.services s on s.business_id = b.id
  where b.id = v_business_id
    and s.id = p_service_id
    and s.active
  for share of b, st, s;

  if not found then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;

  -- 3. Validate the requested start with exactly those values, on the real
  --    civil day that contains it (the day the listing attributed it to).
  if not exists (
    select 1
    from private.compute_available_slots(
      v_business_id,
      private.local_date_of(p_starts_at, v_timezone),
      p_now,
      v_timezone,
      v_duration,
      v_step,
      v_buffer,
      v_notice,
      v_max_days
    ) slot
    where slot.starts_at = p_starts_at
  ) then
    raise exception using errcode = 'P0001', message = 'slot_unavailable';
  end if;

  v_ends_at := p_starts_at + pg_catalog.make_interval(mins => v_duration);

  -- The customer of this business with this email: an existing record is
  -- linked as it is, never completed nor changed by an unverified visitor
  -- (private.resolve_public_client); a new one is created.
  v_client_id := private.resolve_public_client(
    v_business_id, v_first_name, v_last_name, v_email, v_phone
  );

  -- 4. Insert with the same values. The exclusion constraint and the schedule
  --    triggers remain the final guarantees.
  begin
    insert into public.appointments (
      business_id,
      client_id,
      service_id,
      starts_at,
      ends_at,
      status,
      service_name_snapshot,
      duration_minutes_snapshot,
      price_cents_snapshot,
      currency,
      buffer_minutes_snapshot,
      client_first_name_snapshot,
      client_last_name_snapshot,
      client_email_snapshot,
      client_phone_snapshot,
      creation_request_id,
      creation_request_fingerprint
    )
    values (
      v_business_id,
      v_client_id,
      p_service_id,
      p_starts_at,
      v_ends_at,
      'confirmed',
      v_service_name,
      v_duration,
      v_price,
      v_currency,
      v_buffer,
      v_first_name,
      v_last_name,
      v_email,
      v_phone,
      p_request_id,
      v_fingerprint
    )
    returning id into v_appointment_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'slot_unavailable';
    when raise_exception then
      if sqlerrm = 'schedule_conflict' then
        raise exception using errcode = 'P0001', message = 'slot_unavailable';
      end if;
      raise;
  end;

  insert into public.email_events (
    business_id,
    client_id,
    appointment_id,
    type,
    recipient_email,
    payload,
    dedupe_key
  )
  values (
    v_business_id,
    v_client_id,
    v_appointment_id,
    'booking_confirmation',
    v_email,
    pg_catalog.jsonb_build_object(
      'appointment_id', v_appointment_id,
      'business_slug', v_business_slug,
      'business_name', v_business_name,
      'timezone', v_timezone,
      'service_name', v_service_name,
      'starts_at', p_starts_at,
      'ends_at', v_ends_at,
      'local_starts_at', private.wall_clock(p_starts_at, v_timezone),
      'local_ends_at', private.wall_clock(v_ends_at, v_timezone),
      'client_first_name', v_first_name
    ),
    'booking_confirmation:' || v_appointment_id::text
  );

  insert into private.public_booking_log (business_id, network_key, email_key, created_at)
  values (v_business_id, v_network_key, v_email_key, p_now);

  -- Retention: entries older than the longest window (24 h) plus a margin
  -- are useless; a bounded batch goes with each booking (index on
  -- created_at), and private.purge_public_booking_log does the rest.
  perform private.purge_public_booking_log(p_now - interval '48 hours', 100);

  return query
  select
    v_appointment_id,
    p_starts_at,
    v_ends_at,
    v_timezone,
    v_service_name,
    v_duration,
    v_price,
    v_currency,
    v_business_name,
    'confirmed'::text,
    false;
end;
$$;

revoke all on function private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text, uuid, inet) from public;

create function public.create_public_booking(
  p_slug text,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_email text,
  p_request_id uuid,
  p_client_ip inet,
  p_last_name text default null,
  p_phone text default null
)
returns table (
  appointment_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  service_name text,
  duration_minutes integer,
  price_cents integer,
  currency text,
  business_name text,
  status text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  -- The trusted ingress identity is required: no booking without it (the
  -- route refuses first; this is the database's own check).
  if p_client_ip is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientIp';
  end if;

  return query
  select *
  from private.create_public_booking_at(
    pg_catalog.now(),
    p_slug,
    p_service_id,
    p_starts_at,
    p_first_name,
    p_email,
    p_last_name,
    p_phone,
    p_request_id,
    p_client_ip
  );
end;
$$;

revoke all on function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, inet, text, text) from public, anon, authenticated;
grant execute on function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, inet, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. The business-local date, from the database's clock
-- ---------------------------------------------------------------------------

drop function public.get_public_business(text);

create function public.get_public_business(p_slug text)
returns table (
  slug text,
  name text,
  description text,
  location text,
  logo_path text,
  timezone text,
  cancellation_policy text,
  currency text,
  slot_interval_minutes integer,
  minimum_booking_notice_minutes integer,
  maximum_booking_advance_days integer,
  today date
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.slug::text,
    b.name,
    b.description,
    b.location,
    b.logo_path,
    b.timezone,
    b.cancellation_policy,
    st.currency,
    st.slot_interval_minutes,
    st.minimum_booking_notice_minutes,
    st.maximum_booking_advance_days,
    private.local_date_of(pg_catalog.now(), b.timezone)
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  where b.id = private.business_id_by_slug(p_slug);
$$;

revoke all on function public.get_public_business(text) from public;
grant execute on function public.get_public_business(text) to anon, authenticated, service_role;
