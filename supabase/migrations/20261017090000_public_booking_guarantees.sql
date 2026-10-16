-- Public booking (PR #21): the guarantees the public journey still lacked.
-- The booking engine is unchanged: one transaction under the schedule lock
-- revalidates the slot with the business's settings, resolves the customer
-- by canonical email, inserts the appointment with its snapshots (the
-- exclusion constraint stays the final guarantee) and queues the
-- confirmation email (outbox only: nothing sends it yet).
--
--   1. Idempotency: a booking carries a request id (one per booking form).
--      A retry of the same request (lost answer, double submission) is
--      answered with the appointment it created and writes nothing; the same
--      id with another command is idempotency_conflict. Stored in the
--      existing appointments.creation_request_id / _fingerprint (unique per
--      business, shared with manual creations).
--   2. Abuse limits on new bookings, enforced by PostgreSQL
--      (private.public_booking_log): 5 per hour per client key (the caller's
--      network address, given by the route), 10 per 24 hours per customer
--      email in a business. One answer for both: rate_limited.
--   3. public.create_public_booking is executable by service_role only:
--      the public route is the only entry, so the client key cannot be
--      skipped by calling the RPC with the publishable key. Reads (business,
--      services, slots) stay public.
--
-- No customer account, no CRM data in any answer: a booking answers its own
-- appointment only, the same whether the email was already known or not.

create table private.public_booking_log (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_key_hash text,
  email_hash text not null,
  created_at timestamptz not null default now()
);

create index public_booking_log_key_idx
  on private.public_booking_log (client_key_hash, created_at)
  where client_key_hash is not null;
create index public_booking_log_email_idx
  on private.public_booking_log (business_id, email_hash, created_at);

alter table private.public_booking_log enable row level security;
revoke all on table private.public_booking_log from public, anon, authenticated, service_role;

comment on table private.public_booking_log is
  'One row per new public booking (hashed client key and email), for the abuse limits of create_public_booking. No personal data in clear.';

drop function public.create_public_booking(text, uuid, timestamptz, text, text, text, text);
drop function private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text);

-- p_now: the transaction time in production (create_public_booking); tests
-- pass a fixed instant. p_request_id and p_client_key are optional here
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
  p_client_key text default null
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
  v_key_hash text;
  v_email_hash text;
begin
  if v_first_name is null or pg_catalog.char_length(v_first_name) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'invalid_first_name';
  end if;
  if v_last_name is not null and pg_catalog.char_length(v_last_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid_last_name';
  end if;
  if v_email is null
    or pg_catalog.char_length(v_email) > 254
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid_email';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ().-]{6,30}$' then
    raise exception using errcode = '22023', message = 'invalid_phone';
  end if;
  if p_starts_at is null then
    raise exception using errcode = '22023', message = 'invalid_starts_at';
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
  --     private.public_booking_log within this transaction:
  --       - per client key (the caller's network address, from the route):
  --         5 per rolling hour, all businesses;
  --       - per customer email in this business: 10 per rolling 24 hours.
  --     Same answer for both (rate_limited): nothing tells which one, nor
  --     whether the email is known.
  if p_client_key is not null then
    v_key_hash := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(p_client_key, 'UTF8')), 'hex'
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('public_booking_key:' || v_key_hash, 0)
    );
  end if;
  v_email_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_email, 'UTF8')), 'hex'
  );

  if (
    v_key_hash is not null
    and (
      select pg_catalog.count(*)
      from private.public_booking_log l
      where l.client_key_hash = v_key_hash
        and l.created_at > p_now - interval '1 hour'
    ) >= 5
  ) or (
    select pg_catalog.count(*)
    from private.public_booking_log l
    where l.business_id = v_business_id
      and l.email_hash = v_email_hash
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

  -- The customer of this business with this email: found or created in
  -- this transaction, atomically (private.resolve_client).
  v_client_id := private.resolve_client(
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

  insert into private.public_booking_log (business_id, client_key_hash, email_hash, created_at)
  values (v_business_id, v_key_hash, v_email_hash, p_now);

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

revoke all on function private.create_public_booking_at(timestamptz, text, uuid, timestamptz, text, text, text, text, uuid, text) from public;

-- The public booking: one per request id, under the abuse limits.
-- Errors: business_not_found, service_not_found (inactive or unknown),
-- slot_unavailable (taken, closed, outdated, outside the booking window),
-- idempotency_conflict, rate_limited, invalid_* (fields).
create function public.create_public_booking(
  p_slug text,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_email text,
  p_request_id uuid,
  p_client_key text,
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
  if p_client_key is null or pg_catalog.btrim(p_client_key) = '' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientKey';
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
    p_client_key
  );
end;
$$;

revoke all on function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.create_public_booking(text, uuid, timestamptz, text, text, uuid, text, text, text) to service_role;
