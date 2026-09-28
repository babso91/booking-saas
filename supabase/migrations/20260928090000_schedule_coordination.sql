-- Coordinates every write that changes the occupancy of a business schedule,
-- makes the booking transaction use one consistent set of values, and makes
-- availability robust to daylight-saving transitions.
--
-- Findings from the independent audit of PR #1:
--
-- 1. Bookings and professional blocks were not coordinated. A block could be
--    created over an existing appointment, and a booking and a block created
--    concurrently could both commit: the GiST exclusion constraint only
--    compares appointments with each other.
-- 2. create_public_booking read the service and the settings, then
--    available_slots read them again. Under READ COMMITTED a concurrent change
--    (e.g. duration 60 → 30 min) could validate one duration and insert another.
-- 3. A weekly range falling inside the spring-forward gap (02:30–03:00 on
--    2027-03-28 in Europe/Paris) produced an inverted range and raised 22000,
--    failing the computation of the whole day.
--
-- Design
--
-- * One schedule lock per business: a transaction-scoped advisory lock
--   (`business_schedule:<id>`). It is taken by triggers on every table whose
--   rows change occupancy (appointments, availability_exceptions,
--   business_hours) and first thing by the booking RPC. Whatever the code path
--   (RPC, PostgREST, service role, future agenda), two writes to the schedule
--   of one business are serialised, and each re-check that follows the lock
--   runs on a fresh READ COMMITTED snapshot that includes the other write.
-- * Symmetric invariant enforced by triggers, not by callers:
--   - a `closed` or `blocked` exception may not overlap [starts_at, ends_at) of
--     a non-cancelled appointment;
--   - a non-cancelled appointment may not overlap a `closed` or `blocked`
--     exception.
--   V1 business rule: a conflicting block is refused (`schedule_conflict`); an
--   existing appointment is never moved or cancelled automatically. Adjacent
--   periods are allowed (half-open ranges; the buffer is only required between
--   two appointments, as in availability).
-- * The triggers are SECURITY INVOKER on purpose: the overlap check only sees
--   rows the caller may read under RLS, so a professional of another business
--   learns nothing (the write is then refused by RLS as before).

-- ---------------------------------------------------------------------------
-- Schedule lock and cross-table invariant
-- ---------------------------------------------------------------------------

-- Callable from SECURITY DEFINER code. Triggers inline the same expression so
-- that API roles need no privilege on the private schema.
create function private.lock_business_schedule(p_business_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('business_schedule:' || p_business_id::text, 0)
  );
$$;

revoke all on function private.lock_business_schedule(uuid) from public;

create function private.guard_availability_exception()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('business_schedule:' || new.business_id::text, 0)
  );

  if new.kind in ('closed', 'blocked') and exists (
    select 1
    from public.appointments a
    where a.business_id = new.business_id
      and a.status <> 'cancelled'
      and a.starts_at < new.ends_at
      and a.ends_at > new.starts_at
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'schedule_conflict',
      detail = 'The period overlaps an existing appointment.';
  end if;

  return new;
end;
$$;

create trigger availability_exceptions_guard
  before insert or update of business_id, kind, starts_at, ends_at
  on public.availability_exceptions
  for each row execute function private.guard_availability_exception();

create function private.guard_appointment_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'cancelled' then
    return new;
  end if;

  -- Only placements that start occupying time need checking: a status change
  -- between non-cancelled states or a note edit keeps the same occupancy.
  if tg_op = 'UPDATE'
    and old.status <> 'cancelled'
    and old.business_id = new.business_id
    and old.starts_at = new.starts_at
    and old.ends_at = new.ends_at then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('business_schedule:' || new.business_id::text, 0)
  );

  if exists (
    select 1
    from public.availability_exceptions e
    where e.business_id = new.business_id
      and e.kind in ('closed', 'blocked')
      and e.starts_at < new.ends_at
      and e.ends_at > new.starts_at
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'schedule_conflict',
      detail = 'The appointment overlaps a closed or blocked period.';
  end if;

  return new;
end;
$$;

create trigger appointments_guard_schedule
  before insert or update of business_id, starts_at, ends_at, status
  on public.appointments
  for each row execute function private.guard_appointment_schedule();

-- Weekly hours do not invalidate stored rows, but changing them while a
-- booking validates against them must be serialised with it.
create function private.lock_schedule_for_hours()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'business_schedule:' || coalesce(new.business_id, old.business_id)::text,
      0
    )
  );

  return coalesce(new, old);
end;
$$;

create trigger business_hours_lock_schedule
  before insert or update or delete on public.business_hours
  for each row execute function private.lock_schedule_for_hours();

revoke all on function private.guard_availability_exception() from public;
revoke all on function private.guard_appointment_schedule() from public;
revoke all on function private.lock_schedule_for_hours() from public;

-- ---------------------------------------------------------------------------
-- Availability computed from explicit values
-- ---------------------------------------------------------------------------

-- Same algorithm as before, but every service/settings value is a parameter:
-- the booking transaction passes the values it has locked, so validation,
-- occupied window and inserted row can never disagree.
--
-- DST rule (deterministic, same as PostgreSQL `timestamp AT TIME ZONE` and
-- src/lib/time/zoned.ts):
-- * a local time inside a spring-forward gap is read with the offset in force
--   before the transition, i.e. shifted forward by the gap (02:30 → 03:30 in
--   Europe/Paris);
-- * an ambiguous local time of an autumn overlap resolves to the later instant
--   (standard time);
-- * a weekly range whose converted bounds are empty or inverted on that day
--   (entirely inside the gap, e.g. 02:30–03:00) is ignored for that day only;
--   the other ranges of the day are computed normally.
create function private.compute_available_slots(
  p_business_id uuid,
  p_date date,
  p_now timestamptz,
  p_timezone text,
  p_duration_minutes integer,
  p_slot_interval_minutes integer,
  p_buffer_minutes integer,
  p_minimum_notice_minutes integer,
  p_maximum_advance_days integer
)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_duration interval := pg_catalog.make_interval(mins => p_duration_minutes);
  v_step interval := pg_catalog.make_interval(mins => p_slot_interval_minutes);
  v_buffer interval := pg_catalog.make_interval(mins => p_buffer_minutes);
  v_earliest timestamptz;
  v_latest timestamptz;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_open pg_catalog.tstzmultirange;
  v_unavailable pg_catalog.tstzmultirange;
  v_usable pg_catalog.tstzmultirange;
  v_occupied pg_catalog.tstzmultirange;
begin
  if p_date is null or p_now is null or p_timezone is null then
    return;
  end if;

  v_earliest := p_now + pg_catalog.make_interval(mins => p_minimum_notice_minutes);
  v_latest := ((p_now at time zone p_timezone)::date + p_maximum_advance_days + 1)::timestamp
    at time zone p_timezone;
  v_day_start := p_date::timestamp at time zone p_timezone;
  v_day_end := (p_date + 1)::timestamp at time zone p_timezone;

  if v_day_end <= v_earliest or v_day_start >= v_latest then
    return;
  end if;

  select pg_catalog.range_agg(pg_catalog.tstzrange(bounds.lo, bounds.hi, '[)'))
  into v_open
  from (
    select
      (p_date + h.starts_at) at time zone p_timezone as lo,
      (p_date + h.ends_at) at time zone p_timezone as hi
    from public.business_hours h
    where h.business_id = p_business_id
      and h.weekday = extract(dow from p_date)
    union all
    select greatest(e.starts_at, v_day_start), least(e.ends_at, v_day_end)
    from public.availability_exceptions e
    where e.business_id = p_business_id
      and e.kind = 'open_override'
      and e.starts_at < v_day_end
      and e.ends_at > v_day_start
  ) bounds
  -- Drops ranges emptied or inverted by a DST gap instead of raising 22000.
  where bounds.lo < bounds.hi;

  if v_open is null then
    return;
  end if;

  select coalesce(
    pg_catalog.range_agg(pg_catalog.tstzrange(e.starts_at, e.ends_at, '[)')),
    '{}'::pg_catalog.tstzmultirange
  )
  into v_unavailable
  from public.availability_exceptions e
  where e.business_id = p_business_id
    and e.kind in ('closed', 'blocked')
    and e.starts_at < v_day_end
    and e.ends_at > v_day_start;

  v_usable := v_open - v_unavailable;

  select coalesce(
    pg_catalog.range_agg(a.occupied_window),
    '{}'::pg_catalog.tstzmultirange
  )
  into v_occupied
  from public.appointments a
  where a.business_id = p_business_id
    and a.status <> 'cancelled'
    and a.occupied_window && pg_catalog.tstzrange(
      v_day_start - interval '1 day',
      v_day_end + interval '1 day',
      '[)'
    );

  return query
  select candidate.slot_start, candidate.slot_start + v_duration
  from pg_catalog.unnest(v_open) as open_range
  cross join lateral pg_catalog.generate_series(
    pg_catalog.lower(open_range),
    pg_catalog.upper(open_range) - v_duration,
    v_step
  ) as candidate(slot_start)
  where candidate.slot_start >= v_earliest
    and candidate.slot_start < v_latest
    and v_usable @> pg_catalog.tstzrange(
      candidate.slot_start,
      candidate.slot_start + v_duration,
      '[)'
    )
    and not v_occupied && pg_catalog.tstzrange(
      candidate.slot_start,
      candidate.slot_start + v_duration + v_buffer,
      '[)'
    )
  order by candidate.slot_start;
end;
$$;

revoke all on function private.compute_available_slots(
  uuid, date, timestamptz, text, integer, integer, integer, integer, integer
) from public;

-- Public listing path: reads the current values once and delegates.
create or replace function private.available_slots(
  p_business_id uuid,
  p_service_id uuid,
  p_date date,
  p_now timestamptz
)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_timezone text;
  v_duration integer;
  v_step integer;
  v_buffer integer;
  v_notice integer;
  v_max_days integer;
begin
  select
    b.timezone,
    s.duration_minutes,
    st.slot_interval_minutes,
    st.buffer_minutes,
    st.minimum_booking_notice_minutes,
    st.maximum_booking_advance_days
  into v_timezone, v_duration, v_step, v_buffer, v_notice, v_max_days
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  join public.services s on s.business_id = b.id
  where b.id = p_business_id
    and s.id = p_service_id
    and s.active;

  if not found then
    return;
  end if;

  return query
  select slot.starts_at, slot.ends_at
  from private.compute_available_slots(
    p_business_id, p_date, p_now, v_timezone,
    v_duration, v_step, v_buffer, v_notice, v_max_days
  ) slot;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public booking: one lock, one read, one set of values
-- ---------------------------------------------------------------------------

create or replace function public.create_public_booking(
  p_slug text,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_email text,
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
  business_name text
)
language plpgsql
volatile
security definer
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
  v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_phone text := nullif(pg_catalog.btrim(p_phone), '');
  v_ends_at timestamptz;
  v_client_id uuid;
  v_appointment_id uuid;
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

  -- 3. Validate the requested start with exactly those values.
  if not exists (
    select 1
    from private.compute_available_slots(
      v_business_id,
      (p_starts_at at time zone v_timezone)::date,
      pg_catalog.now(),
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

  insert into public.clients (business_id, first_name, last_name, email, phone)
  values (v_business_id, v_first_name, v_last_name, v_email, v_phone)
  on conflict (business_id, email) do nothing
  returning id into v_client_id;

  if v_client_id is null then
    select c.id into v_client_id
    from public.clients c
    where c.business_id = v_business_id
      and c.email operator(extensions.=) v_email::extensions.citext;
  end if;

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
      buffer_minutes_snapshot
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
      v_buffer
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
      'client_first_name', v_first_name
    ),
    'booking_confirmation:' || v_appointment_id::text
  );

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
    v_business_name;
end;
$$;

-- `create or replace` keeps existing grants; restated for readability.
revoke all on function public.create_public_booking(
  text, uuid, timestamptz, text, text, text, text
) from public;
grant execute on function public.create_public_booking(
  text, uuid, timestamptz, text, text, text, text
) to anon, authenticated;
