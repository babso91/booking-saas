-- PostgreSQL is the calendar authority of the whole system.
--
-- Every conversion with a consequence on the schedule (civil date → instant,
-- instant → civil date or wall clock, day bounds, weekly hours, exceptions,
-- availability, booking, horizon, DST occurrence) is computed here, with the
-- IANA rules of this database. Node and the browser never recompute one with
-- their own copy of the time zone database: they read the results below
-- (public.business_time, public.get_available_slots) and only do plain
-- arithmetic on the UTC offsets this database hands them. Three runtimes may
-- ship three tzdata versions (CI: Node 24 reads America/Vancouver as UTC−7 on
-- 2027-03-14 where this database has UTC−8); one authority keeps the agenda,
-- the public listing and the booking on the same instants whatever they ship.
--
-- Civil day (shared definition):
--   local_day_start(D) = first real instant whose local date is D or later
--   day D              = [local_day_start(D), local_day_start(D + 1))
-- Repeated midnight → its first occurrence; skipped midnight → the first
-- instant after the gap; a date that does not exist (Pacific/Apia,
-- 2011-12-30) → an empty day.
--
-- Weekly hours (wall-clock policy): a weekly range `from → to` on date D is
-- the set of instants of day D whose wall-clock time is in [from, to)
-- (`24:00` = the end of the day). It may therefore be several UTC intervals:
--   * repeated hour (Havana, 2026-11-01, 00:00–01:00 twice): `00:00 → 00:30`
--     opens both real 00:00–00:30 (04:00Z–04:30Z and 05:00Z–05:30Z), never
--     the first 00:30–01:00 in between;
--   * skipped hour (Paris, 2027-03-28, 02:00–03:00 missing): `02:30 → 04:00`
--     opens 03:00–04:00 (what exists of it), `01:00 → 02:30` opens
--     01:00–02:00, `02:30 → 03:00` opens nothing; never a negative interval;
--   * `00:00 → 24:00` is the whole real day (23 h, 25 h, 23.5 h…).
-- Durations, buffers and minimum notice stay real (absolute) minutes.
--
-- Unchanged: schedule lock, READ COMMITTED requirement, exclusion
-- constraint, triggers, idempotency, outbox.

-- ---------------------------------------------------------------------------
-- Civil day
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
    ((v_rule - interval '24 hours') at time zone p_timezone)
      - ((v_rule - interval '24 hours') at time zone 'UTC'),
    (v_rule at time zone p_timezone) - (v_rule at time zone 'UTC'),
    ((v_rule + interval '24 hours') at time zone p_timezone)
      - ((v_rule + interval '24 hours') at time zone 'UTC')
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

-- ---------------------------------------------------------------------------
-- UTC offsets and wall clocks
-- ---------------------------------------------------------------------------

-- Offset (local − UTC) in force at an instant, in seconds.
create function private.utc_offset_seconds(p_at timestamptz, p_timezone text)
returns integer
language sql
stable
set search_path = ''
as $$
  select extract(epoch from (p_at at time zone p_timezone) - (p_at at time zone 'UTC'))::integer;
$$;

-- [p_from, p_to) cut into pieces of constant UTC offset, in order. The
-- offset is sampled every hour and each change is located to the second by
-- bisection (zone transitions fall on whole seconds). Two transitions less
-- than an hour apart would be missed: the IANA database has none. The offset
-- expression is inlined (hot path: once per availability computation).
create function private.zone_offsets(
  p_timezone text,
  p_from timestamptz,
  p_to timestamptz
)
returns table (starts_at timestamptz, ends_at timestamptz, utc_offset_seconds integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_start timestamptz := p_from;
  v_offset integer;
  v_probe timestamptz;
  v_next timestamptz;
  v_check timestamptz;
  v_low timestamptz;
  v_high timestamptz;
  v_seconds bigint;
  v_middle timestamptz;
begin
  if p_timezone is null or p_from is null or p_to is null or p_from >= p_to then
    return;
  end if;

  -- Whole seconds, so a located transition is exact.
  v_probe := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from p_from)));
  v_offset := extract(epoch from (p_from at time zone p_timezone) - (p_from at time zone 'UTC'))::integer;

  while v_probe < p_to loop
    v_next := least(v_probe + interval '1 hour', p_to);
    v_check := case
      when v_next < p_to then v_next
      else pg_catalog.to_timestamp(pg_catalog.ceil(extract(epoch from p_to)) - 1)
    end;

    if v_check > v_probe
      and extract(epoch from (v_check at time zone p_timezone) - (v_check at time zone 'UTC'))::integer <> v_offset then
      v_low := v_probe;
      v_high := v_check;

      loop
        v_seconds := extract(epoch from v_high - v_low)::bigint;
        exit when v_seconds <= 1;
        v_middle := v_low + pg_catalog.make_interval(secs => v_seconds / 2);

        if extract(epoch from (v_middle at time zone p_timezone) - (v_middle at time zone 'UTC'))::integer = v_offset then
          v_low := v_middle;
        else
          v_high := v_middle;
        end if;
      end loop;

      starts_at := v_start;
      ends_at := v_high;
      utc_offset_seconds := v_offset;
      return next;

      v_start := v_high;
      v_offset := extract(epoch from (v_high at time zone p_timezone) - (v_high at time zone 'UTC'))::integer;
      v_probe := v_high;
    else
      v_probe := v_next;
    end if;
  end loop;

  starts_at := v_start;
  ends_at := p_to;
  utc_offset_seconds := v_offset;
  return next;
end;
$$;

-- Wall clock `YYYY-MM-DDTHH:MM` of an instant (minute precision).
create function private.wall_clock(p_at timestamptz, p_timezone text)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.to_char(p_at at time zone p_timezone, 'YYYY-MM-DD"T"HH24:MI');
$$;

-- Every instant whose wall clock reads p_local, without choosing:
--   exact       → first_at;
--   ambiguous   → first_at (before the clocks go back), second_at (after);
--   nonexistent → both null (skipped by a forward change).
create function private.resolve_local(
  p_local timestamp,
  p_timezone text,
  out status text,
  out first_at timestamptz,
  out second_at timestamptz
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_guess timestamptz := p_local at time zone 'UTC';
  v_before timestamptz;
  v_after timestamptz;
begin
  if p_local is null or p_timezone is null then
    return;
  end if;

  -- The two offsets around the target cover both sides of a transition.
  v_before := (p_local - pg_catalog.make_interval(
    secs => private.utc_offset_seconds(v_guess - interval '24 hours', p_timezone)
  )) at time zone 'UTC';
  v_after := (p_local - pg_catalog.make_interval(
    secs => private.utc_offset_seconds(v_guess + interval '24 hours', p_timezone)
  )) at time zone 'UTC';

  if (v_before at time zone p_timezone) <> p_local then
    v_before := null;
  end if;
  if (v_after at time zone p_timezone) <> p_local then
    v_after := null;
  end if;

  if v_before is null and v_after is null then
    status := 'nonexistent';
  elsif v_before is null or v_after is null or v_before = v_after then
    status := 'exact';
    first_at := coalesce(v_before, v_after);
  else
    status := 'ambiguous';
    first_at := least(v_before, v_after);
    second_at := greatest(v_before, v_after);
  end if;
end;
$$;

-- `first` / `second` when the wall clock of p_at (minute precision) is a
-- repeated local time, null otherwise.
create function private.wall_occurrence(p_at timestamptz, p_timezone text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_resolved record;
begin
  if p_at is null or p_timezone is null then
    return null;
  end if;

  v_resolved := private.resolve_local(
    pg_catalog.date_trunc('minute', p_at at time zone p_timezone),
    p_timezone
  );

  if v_resolved.status <> 'ambiguous' then
    return null;
  end if;

  return case
    when pg_catalog.floor(extract(epoch from p_at) / 60)
      = pg_catalog.floor(extract(epoch from v_resolved.first_at) / 60)
    then 'first'
    else 'second'
  end;
end;
$$;

-- UTC instant of a period bound typed by a professional (blocks, closures,
-- exceptional openings): midnight is where the day begins
-- (local_day_start); any other time follows `AT TIME ZONE` (a repeated time
-- is its later occurrence, a skipped one is read with the offset in force
-- before the change).
create function private.local_bound(p_local timestamp, p_timezone text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when p_local::time = time '00:00'
      then private.local_day_start(p_local::date, p_timezone)
    else p_local at time zone p_timezone
  end;
$$;

-- ---------------------------------------------------------------------------
-- Opening ranges of a civil day
-- ---------------------------------------------------------------------------

-- Real opening of business p_business_id on civil date p_date: weekly ranges
-- (wall-clock policy above, one piece of constant offset at a time) and
-- exceptional openings, clipped to the real day and merged. The only
-- definition of "open": public availability and the agenda both read it.
create function private.opening_ranges(
  p_business_id uuid,
  p_date date,
  p_timezone text
)
returns pg_catalog.tstzmultirange
language sql
stable
set search_path = ''
as $$
  with day as (
    select
      private.local_day_start(p_date, p_timezone) as lo,
      private.local_day_start(p_date + 1, p_timezone) as hi
  ),
  piece as (
    select
      z.starts_at,
      z.ends_at,
      z.starts_at at time zone p_timezone as wall_start,
      (z.starts_at at time zone p_timezone)
        + pg_catalog.make_interval(secs => extract(epoch from z.ends_at - z.starts_at))
        as wall_end
    from day
    cross join lateral private.zone_offsets(p_timezone, day.lo, day.hi) z
    where day.lo < day.hi
  ),
  bounds as (
    -- Within a piece, wall clock = instant + constant offset: the wall-clock
    -- interval [D + from, D + to) maps back to one UTC interval.
    select
      p.starts_at + pg_catalog.make_interval(
        secs => extract(epoch from greatest(p.wall_start, p_date + h.starts_at) - p.wall_start)
      ) as lo,
      p.starts_at + pg_catalog.make_interval(
        secs => extract(epoch from least(p.wall_end, p_date + h.ends_at) - p.wall_start)
      ) as hi
    from piece p
    join public.business_hours h
      on h.business_id = p_business_id
     and h.weekday = extract(dow from p_date)
    where greatest(p.wall_start, p_date + h.starts_at) < least(p.wall_end, p_date + h.ends_at)
    union all
    select greatest(e.starts_at, day.lo), least(e.ends_at, day.hi)
    from day
    join public.availability_exceptions e
      on e.business_id = p_business_id
     and e.kind = 'open_override'
     and e.starts_at < day.hi
     and e.ends_at > day.lo
  )
  select pg_catalog.range_agg(pg_catalog.tstzrange(bounds.lo, bounds.hi, '[)'))
  from bounds
  where bounds.lo < bounds.hi;
$$;

-- ---------------------------------------------------------------------------
-- Availability
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
  v_day_start := private.local_day_start(p_date, p_timezone);
  v_day_end := private.local_day_start(p_date + 1, p_timezone);

  -- A date skipped by the zone has no instant at all.
  if v_day_start >= v_day_end
    or v_day_end <= v_earliest
    or v_day_start >= v_latest then
    return;
  end if;

  v_open := private.opening_ranges(p_business_id, p_date, p_timezone);

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
      v_day_start - interval '24 hours',
      v_day_end + interval '24 hours',
      '[)'
    );

  -- Slots start at each opening range's start, every slot interval; a slot
  -- lies entirely inside one usable range (never across a closed piece).
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

-- Public listing: slots with their wall clock read here, so no client
-- formats a booked time with its own time zone database.
drop function public.get_available_slots(text, uuid, date);

create function public.get_available_slots(
  p_slug text,
  p_service_id uuid,
  p_date date
)
returns table (
  starts_at timestamptz,
  ends_at timestamptz,
  local_starts_at text,
  local_ends_at text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := private.business_id_by_slug(p_slug);
  v_timezone text;
begin
  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;

  if not exists (
    select 1
    from public.services s
    where s.id = p_service_id
      and s.business_id = v_business_id
      and s.active
  ) then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;

  select b.timezone into v_timezone
  from public.businesses b
  where b.id = v_business_id;

  return query
  select
    slot.starts_at,
    slot.ends_at,
    private.wall_clock(slot.starts_at, v_timezone),
    private.wall_clock(slot.ends_at, v_timezone)
  from private.available_slots(v_business_id, p_service_id, p_date, pg_catalog.now()) slot;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public booking
-- ---------------------------------------------------------------------------

-- The booking transaction, with the current instant as an explicit
-- argument: public.create_public_booking passes now(); tests pass a fixed
-- instant so date-dependent rules (notice, horizon, DST days) are exercised
-- on the production path whatever the date of the run. Private: never
-- executable by anon or authenticated, so no client chooses its "now".
--
-- Identical to 20260928090000 except: p_now instead of now() (step 3), the
-- slot's date is the real civil day containing it (private.local_date_of),
-- and the outbox payload carries the wall clocks read here.
create function private.create_public_booking_at(
  p_now timestamptz,
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
      'local_starts_at', private.wall_clock(p_starts_at, v_timezone),
      'local_ends_at', private.wall_clock(v_ends_at, v_timezone),
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
language sql
volatile
security definer
set search_path = ''
as $$
  select *
  from private.create_public_booking_at(
    pg_catalog.now(),
    p_slug,
    p_service_id,
    p_starts_at,
    p_first_name,
    p_email,
    p_last_name,
    p_phone
  );
$$;

-- ---------------------------------------------------------------------------
-- Calendar facts for the application server and the agenda UI
-- ---------------------------------------------------------------------------

-- Everything Node and the browser need to show and edit a business's
-- schedule, read with this database's time zone rules, in one call:
--   days     → for each requested civil date: real bounds and, with
--              p_open_ranges, the real opening ranges (the very ranges public
--              availability uses), with their wall clocks;
--   locals   → for each wall-clock time typed by a professional: every
--              instant it denotes (status, first, second) and its period
--              bound (private.local_bound);
--   instants → for each instant to display: wall clock and DST occurrence;
--   offsets  → the UTC offset pieces covering the requested days, so the UI
--              can place instants on its grid with plain arithmetic;
--   today    → the business's civil date now.
-- Members only (private.assert_agenda_access). Bounded inputs.
create function public.business_time(
  p_business_id uuid,
  p_dates date[] default '{}',
  p_locals timestamp[] default '{}',
  p_instants timestamptz[] default '{}',
  p_open_ranges boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_days jsonb;
  v_spans pg_catalog.tstzmultirange;
  v_locals jsonb;
  v_instants jsonb;
  v_offsets jsonb;
begin
  perform private.assert_agenda_access(p_business_id);

  if coalesce(pg_catalog.cardinality(p_dates), 0) > 62 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'dates';
  end if;
  if coalesce(pg_catalog.cardinality(p_locals), 0) > 16 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'locals';
  end if;
  if coalesce(pg_catalog.cardinality(p_instants), 0) > 4000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'instants';
  end if;

  select b.timezone into v_timezone
  from public.businesses b
  where b.id = p_business_id;

  with requested as (
    select distinct d
    from pg_catalog.unnest(coalesce(p_dates, '{}'::date[])) d
    where d is not null
  ),
  bounds as (
    select
      r.d,
      private.local_day_start(r.d, v_timezone) as lo,
      private.local_day_start(r.d + 1, v_timezone) as hi
    from requested r
  )
  select
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'date', pg_catalog.to_char(b.d, 'YYYY-MM-DD'),
      'weekday', extract(dow from b.d)::integer,
      'startsAt', b.lo,
      'endsAt', b.hi,
      'openRanges', case when p_open_ranges then (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'startsAt', pg_catalog.lower(o),
          'endsAt', pg_catalog.upper(o),
          'localStartsAt', private.wall_clock(pg_catalog.lower(o), v_timezone),
          'localEndsAt', private.wall_clock(pg_catalog.upper(o), v_timezone)
        ) order by pg_catalog.lower(o)), '[]'::jsonb)
        from pg_catalog.unnest(
          coalesce(
            private.opening_ranges(p_business_id, b.d, v_timezone),
            '{}'::pg_catalog.tstzmultirange
          )
        ) o
      ) end
    ) order by b.d), '[]'::jsonb),
    pg_catalog.range_agg(pg_catalog.tstzrange(b.lo, b.hi, '[)')) filter (where b.lo < b.hi)
  into v_days, v_spans
  from bounds b;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'local', pg_catalog.to_char(l.v, 'YYYY-MM-DD"T"HH24:MI'),
    'status', r.status,
    'first', r.first_at,
    'second', r.second_at,
    'bound', private.local_bound(l.v, v_timezone)
  )), '[]'::jsonb)
  into v_locals
  from (
    select distinct v
    from pg_catalog.unnest(coalesce(p_locals, '{}'::timestamp[])) v
    where v is not null
  ) l
  cross join lateral private.resolve_local(l.v, v_timezone) r;

  -- A wall clock can only repeat near a change of offset: when the offsets a
  -- day before and a day after are equal (almost every instant), the
  -- occurrence is null without resolving anything (same ±24 h window as
  -- private.resolve_local).
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'at', i.v,
    'local', pg_catalog.to_char(i.v at time zone v_timezone, 'YYYY-MM-DD"T"HH24:MI'),
    'occurrence', case
      when ((i.v - interval '24 hours') at time zone v_timezone)
             - ((i.v - interval '24 hours') at time zone 'UTC')
         = ((i.v + interval '24 hours') at time zone v_timezone)
             - ((i.v + interval '24 hours') at time zone 'UTC')
      then null
      else private.wall_occurrence(i.v, v_timezone)
    end
  )), '[]'::jsonb)
  into v_instants
  from (
    select distinct v
    from pg_catalog.unnest(coalesce(p_instants, '{}'::timestamptz[])) v
    where v is not null
  ) i;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'startsAt', z.starts_at,
    'endsAt', z.ends_at,
    'offsetSeconds', z.utc_offset_seconds
  ) order by z.starts_at), '[]'::jsonb)
  into v_offsets
  from pg_catalog.unnest(coalesce(v_spans, '{}'::pg_catalog.tstzmultirange)) s
  cross join lateral private.zone_offsets(
    v_timezone,
    pg_catalog.lower(s),
    pg_catalog.upper(s)
  ) z;

  return pg_catalog.jsonb_build_object(
    'timezone', v_timezone,
    'today', pg_catalog.to_char(
      private.local_date_of(pg_catalog.now(), v_timezone),
      'YYYY-MM-DD'
    ),
    'days', v_days,
    'locals', v_locals,
    'instants', v_instants,
    'offsets', v_offsets
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function private.local_day_start(date, text) from public;
revoke all on function private.local_date_of(timestamptz, text) from public;
revoke all on function private.utc_offset_seconds(timestamptz, text) from public;
revoke all on function private.zone_offsets(text, timestamptz, timestamptz) from public;
revoke all on function private.wall_clock(timestamptz, text) from public;
revoke all on function private.resolve_local(timestamp, text) from public;
revoke all on function private.wall_occurrence(timestamptz, text) from public;
revoke all on function private.local_bound(timestamp, text) from public;
revoke all on function private.opening_ranges(uuid, date, text) from public;
revoke all on function private.compute_available_slots(
  uuid, date, timestamptz, text, integer, integer, integer, integer, integer
) from public;
revoke all on function private.create_public_booking_at(
  timestamptz, text, uuid, timestamptz, text, text, text, text
) from public;

revoke all on function public.get_available_slots(text, uuid, date) from public;
grant execute on function public.get_available_slots(text, uuid, date) to anon, authenticated;

-- `create or replace` keeps existing grants; restated for readability.
revoke all on function public.create_public_booking(
  text, uuid, timestamptz, text, text, text, text
) from public;
grant execute on function public.create_public_booking(
  text, uuid, timestamptz, text, text, text, text
) to anon, authenticated;

revoke all on function public.business_time(
  uuid, date[], timestamp[], timestamptz[], boolean
) from public, anon;
grant execute on function public.business_time(
  uuid, date[], timestamp[], timestamptz[], boolean
) to authenticated;
