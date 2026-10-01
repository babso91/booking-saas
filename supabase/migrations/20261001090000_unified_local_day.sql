-- One definition of a civil day for the whole system.
--
-- Public availability built its days with `timestamp AT TIME ZONE`, which
-- reads a repeated wall-clock time as its LATER occurrence. Where midnight
-- itself repeats (America/Havana, 2026-11-01: 00:00 at 04:00Z and again at
-- 05:00Z), day D started at its second midnight and the first real hour of D
-- was computed as part of D − 1 (weekly ranges ending at 24:00 also ran to
-- the second midnight). Since #7 the agenda and whole-day blocks use the real
-- day, so a slot could be listed under 31 October and then refused by
-- create_public_booking, which validates against the slot's real date.
--
-- Definition, shared with src/lib/time/zoned.ts (startOfLocalDate) and the
-- agenda UI (localDayStart):
--   local_day_start(D) = first real instant whose local date is D or later
--   day D              = [local_day_start(D), local_day_start(D + 1))
-- Repeated midnight → its first occurrence; skipped midnight → the first
-- instant after the gap; a date that does not exist (Pacific/Apia,
-- 2011-12-30) → an empty day.
--
-- Changed:
--   * compute_available_slots: day bounds, horizon end, weekly bounds at
--     00:00 / 24:00, and every open range clipped to the real day;
--   * create_public_booking: the slot's date is the real day containing it
--     (private.local_date_of) instead of a bare `::date` cast.
-- Unchanged on purpose:
--   * a weekly bound strictly inside the day keeps PostgreSQL's rule (a
--     repeated time is its later occurrence, a skipped one is read with the
--     offset before the change); slots themselves are UTC instants, so both
--     occurrences of a repeated hour are listed as distinct slots;
--   * minimum notice, durations and buffers are real (absolute) minutes;
--   * schedule lock, READ COMMITTED requirement, exclusion constraint,
--     triggers, outbox: the transaction model is untouched.

-- ---------------------------------------------------------------------------
-- Civil day helpers
-- ---------------------------------------------------------------------------

create function private.local_day_start(p_date date, p_timezone text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_midnight timestamp := p_date::timestamp;
  v_rule timestamptz;
  v_offset interval;
  v_candidate timestamptz;
  v_first timestamptz;
  v_low timestamptz;
  v_high timestamptz;
  v_minutes bigint;
  v_middle timestamptz;
begin
  if p_date is null or p_timezone is null then
    return null;
  end if;

  v_rule := v_midnight at time zone p_timezone;

  -- Fast path. Every instant whose wall clock reads `D 00:00` is midnight
  -- minus one of the UTC offsets in force around it; a day on each side of
  -- the PostgreSQL answer covers both sides of a transition. The earliest
  -- valid one is midnight itself, or the first of a repeated midnight.
  foreach v_offset in array array[
    ((v_rule - interval '1 day') at time zone p_timezone)
      - ((v_rule - interval '1 day') at time zone 'UTC'),
    (v_rule at time zone p_timezone) - (v_rule at time zone 'UTC'),
    ((v_rule + interval '1 day') at time zone p_timezone)
      - ((v_rule + interval '1 day') at time zone 'UTC')
  ]
  loop
    v_candidate := (v_midnight - v_offset) at time zone 'UTC';

    if (v_candidate at time zone p_timezone) = v_midnight
      and (v_first is null or v_candidate < v_first) then
      v_first := v_candidate;
    end if;
  end loop;

  if v_first is not null then
    return v_first;
  end if;

  -- Midnight skipped: the first minute whose local date is D or later. UTC
  -- offsets stay within ±14 h, so ±26 h around UTC midnight brackets it, and
  -- the local date only moves forward across a gap. ~12 iterations, only on
  -- the (rare) days whose midnight does not exist.
  v_low := (v_midnight - interval '26 hours') at time zone 'UTC';
  v_high := (v_midnight + interval '26 hours') at time zone 'UTC';

  loop
    v_minutes := (extract(epoch from v_high - v_low) / 60)::bigint;
    exit when v_minutes <= 1;
    v_middle := v_low + pg_catalog.make_interval(mins => (v_minutes / 2)::integer);

    if (v_middle at time zone p_timezone)::date >= p_date then
      v_high := v_middle;
    else
      v_low := v_middle;
    end if;
  end loop;

  return v_high;
end;
$$;

comment on function private.local_day_start(date, text) is
  'First real instant whose local date in the zone is the given date or later.';

-- The civil date D such that p_at lies in [local_day_start(D), local_day_start(D + 1)).
-- Equal to the local date of the instant, except after a backward change that
-- crosses midnight, where the repeated end of D − 1 already belongs to D.
create function private.local_date_of(p_at timestamptz, p_timezone text)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_date date := (p_at at time zone p_timezone)::date;
begin
  if p_at >= private.local_day_start(v_date + 1, p_timezone) then
    return v_date + 1;
  end if;

  return v_date;
end;
$$;

revoke all on function private.local_day_start(date, text) from public;
revoke all on function private.local_date_of(timestamptz, text) from public;

-- ---------------------------------------------------------------------------
-- Availability on real days
-- ---------------------------------------------------------------------------

create or replace function private.compute_available_slots(
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

  -- Minimum notice: real minutes from now.
  v_earliest := p_now + pg_catalog.make_interval(mins => p_minimum_notice_minutes);
  -- Horizon: every day up to today + N (local) is bookable as a whole, so
  -- it ends where day today + N + 1 really begins.
  v_latest := private.local_day_start(
    private.local_date_of(p_now, p_timezone) + p_maximum_advance_days + 1,
    p_timezone
  );
  -- Day D = [first real instant of D, first real instant of D + 1). Computed
  -- once per call (hot path): a few AT TIME ZONE evaluations per bound.
  v_day_start := private.local_day_start(p_date, p_timezone);
  v_day_end := private.local_day_start(p_date + 1, p_timezone);

  -- A date skipped by the zone has no instant at all.
  if v_day_start >= v_day_end
    or v_day_end <= v_earliest
    or v_day_start >= v_latest then
    return;
  end if;

  select pg_catalog.range_agg(pg_catalog.tstzrange(bounds.lo, bounds.hi, '[)'))
  into v_open
  from (
    -- Weekly ranges: 00:00 is the real start of the day, 24:00 its real end;
    -- other bounds use PostgreSQL's rule. Clipped to the real day so no range
    -- can leak into a neighbouring date.
    select
      greatest(
        case
          when h.starts_at = time '00:00' then v_day_start
          else (p_date + h.starts_at) at time zone p_timezone
        end,
        v_day_start
      ) as lo,
      least(
        case
          when h.ends_at = time '24:00' then v_day_end
          else (p_date + h.ends_at) at time zone p_timezone
        end,
        v_day_end
      ) as hi
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

-- ---------------------------------------------------------------------------
-- Booking validates against the real day of the requested instant
-- ---------------------------------------------------------------------------

-- Identical to 20260928090000 except step 3: the date passed to
-- compute_available_slots is the real day containing p_starts_at.
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

  -- 3. Validate the requested start with exactly those values, on the real
  --    civil day that contains it (the day the listing attributed it to).
  if not exists (
    select 1
    from private.compute_available_slots(
      v_business_id,
      private.local_date_of(p_starts_at, v_timezone),
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
