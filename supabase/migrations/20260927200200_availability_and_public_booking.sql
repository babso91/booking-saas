-- Availability computation, public booking RPCs and professional scheduling
-- helpers.
--
-- Availability is computed in PostgreSQL only. The public listing and the
-- booking transaction call the same function, so a slot shown to a client and
-- a slot accepted at insertion time are defined by one piece of code. The
-- exclusion constraint `appointments_no_overlap` remains the final guarantee
-- against concurrent double booking.
--
-- Public functions are SECURITY DEFINER with an empty search_path, validate
-- every argument themselves (they are reachable through PostgREST with the
-- publishable key) and return minimal DTOs. Anonymous callers still have no
-- table privilege at all.

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------

-- Returns the bookable start instants of `p_service_id` on the local calendar
-- day `p_date` of the business, evaluated at instant `p_now`.
--
-- 1. open ranges   = weekly ranges of that weekday (interpreted in the business
--                    time zone, DST-aware) + `open_override` exceptions;
-- 2. usable ranges = open ranges − `closed` and `blocked` exceptions;
-- 3. candidates    = every `slot_interval_minutes` from the start of each open
--                    range;
-- 4. a candidate is kept when [start, start + duration) fits inside one usable
--    range, [start, start + duration + buffer) does not intersect the occupied
--    window of a non-cancelled appointment, start is at least `now + minimum
--    notice`, and start falls on or before the local day `today + maximum
--    advance days` (the last bookable day is bookable as a whole).
--
-- The buffer is only required between two appointments: an appointment may end
-- exactly at closing time or at the start of a blocked period.
create function private.available_slots(
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
  v_duration interval;
  v_step interval;
  v_buffer interval;
  v_earliest timestamptz;
  v_latest timestamptz;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_open pg_catalog.tstzmultirange;
  v_unavailable pg_catalog.tstzmultirange;
  v_usable pg_catalog.tstzmultirange;
  v_occupied pg_catalog.tstzmultirange;
begin
  select
    b.timezone,
    pg_catalog.make_interval(mins => s.duration_minutes),
    pg_catalog.make_interval(mins => st.slot_interval_minutes),
    pg_catalog.make_interval(mins => st.buffer_minutes),
    p_now + pg_catalog.make_interval(mins => st.minimum_booking_notice_minutes),
    ((p_now at time zone b.timezone)::date + st.maximum_booking_advance_days + 1)::timestamp
      at time zone b.timezone
  into v_timezone, v_duration, v_step, v_buffer, v_earliest, v_latest
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  join public.services s on s.business_id = b.id
  where b.id = p_business_id
    and s.id = p_service_id
    and s.active;

  if not found or p_date is null or p_now is null then
    return;
  end if;

  v_day_start := p_date::timestamp at time zone v_timezone;
  v_day_end := (p_date + 1)::timestamp at time zone v_timezone;

  if v_day_end <= v_earliest or v_day_start >= v_latest then
    return;
  end if;

  select pg_catalog.range_agg(r)
  into v_open
  from (
    select pg_catalog.tstzrange(
      (p_date + h.starts_at) at time zone v_timezone,
      (p_date + h.ends_at) at time zone v_timezone,
      '[)'
    ) as r
    from public.business_hours h
    where h.business_id = p_business_id
      and h.weekday = extract(dow from p_date)
    union all
    select pg_catalog.tstzrange(
      greatest(e.starts_at, v_day_start),
      least(e.ends_at, v_day_end),
      '[)'
    )
    from public.availability_exceptions e
    where e.business_id = p_business_id
      and e.kind = 'open_override'
      and e.starts_at < v_day_end
      and e.ends_at > v_day_start
  ) open_ranges
  where not pg_catalog.isempty(r);

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

revoke all on function private.available_slots(uuid, uuid, date, timestamptz) from public;

-- Resolves an exact, case-insensitive slug. Explicit citext operators are
-- required: with an empty search_path, `=` would silently fall back to a
-- case-sensitive text comparison.
create function private.business_id_by_slug(p_slug text)
returns uuid
language sql
stable
set search_path = ''
as $$
  select b.id
  from public.businesses b
  where b.slug operator(extensions.=) pg_catalog.btrim(p_slug)::extensions.citext;
$$;

revoke all on function private.business_id_by_slug(text) from public;

-- ---------------------------------------------------------------------------
-- Public read RPCs
-- ---------------------------------------------------------------------------

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
  maximum_booking_advance_days integer
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
    st.maximum_booking_advance_days
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  where b.id = private.business_id_by_slug(p_slug);
$$;

create function public.get_public_services(p_slug text)
returns table (
  id uuid,
  name text,
  description text,
  duration_minutes integer,
  price_cents integer,
  currency text,
  display_order integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id,
    s.name,
    s.description,
    s.duration_minutes,
    s.price_cents,
    st.currency,
    s.display_order
  from public.services s
  join public.business_settings st on st.business_id = s.business_id
  where s.business_id = private.business_id_by_slug(p_slug)
    and s.active
  order by s.display_order, s.name, s.id;
$$;

create function public.get_available_slots(
  p_slug text,
  p_service_id uuid,
  p_date date
)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := private.business_id_by_slug(p_slug);
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

  return query
  select slot.starts_at, slot.ends_at
  from private.available_slots(v_business_id, p_service_id, p_date, pg_catalog.now()) slot;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public booking
-- ---------------------------------------------------------------------------

-- Creates a booking in one transaction:
--   business by slug → active service → slot re-validated against the same
--   availability function → client found (case-insensitive email, within this
--   business only) or created → appointment with snapshots → confirmation email
--   queued in the outbox.
--
-- The availability re-check gives precise error messages; the exclusion
-- constraint remains the authority when two transactions race for one slot.
-- An existing client record is never modified by a public booking, so nobody
-- can overwrite a client's identity by knowing an email address, and the
-- response is identical whether the client existed or not.
create function public.create_public_booking(
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
  v_business public.businesses%rowtype;
  v_settings public.business_settings%rowtype;
  v_service public.services%rowtype;
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

  select b.* into v_business
  from public.businesses b
  where b.id = private.business_id_by_slug(p_slug);

  if not found then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;

  select s.* into v_service
  from public.services s
  where s.id = p_service_id
    and s.business_id = v_business.id
    and s.active;

  if not found then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;

  select st.* into v_settings
  from public.business_settings st
  where st.business_id = v_business.id;

  if not exists (
    select 1
    from private.available_slots(
      v_business.id,
      v_service.id,
      (p_starts_at at time zone v_business.timezone)::date,
      pg_catalog.now()
    ) slot
    where slot.starts_at = p_starts_at
  ) then
    raise exception using errcode = 'P0001', message = 'slot_unavailable';
  end if;

  v_ends_at := p_starts_at + pg_catalog.make_interval(mins => v_service.duration_minutes);

  insert into public.clients (business_id, first_name, last_name, email, phone)
  values (v_business.id, v_first_name, v_last_name, v_email, v_phone)
  on conflict (business_id, email) do nothing
  returning id into v_client_id;

  if v_client_id is null then
    select c.id into v_client_id
    from public.clients c
    where c.business_id = v_business.id
      and c.email operator(extensions.=) v_email::extensions.citext;
  end if;

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
      v_business.id,
      v_client_id,
      v_service.id,
      p_starts_at,
      v_ends_at,
      'confirmed',
      v_service.name,
      v_service.duration_minutes,
      v_service.price_cents,
      v_settings.currency,
      v_settings.buffer_minutes
    )
    returning id into v_appointment_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'slot_unavailable';
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
    v_business.id,
    v_client_id,
    v_appointment_id,
    'booking_confirmation',
    v_email,
    pg_catalog.jsonb_build_object(
      'appointment_id', v_appointment_id,
      'business_slug', v_business.slug::text,
      'business_name', v_business.name,
      'timezone', v_business.timezone,
      'service_name', v_service.name,
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
    v_business.timezone,
    v_service.name,
    v_service.duration_minutes,
    v_service.price_cents,
    v_settings.currency,
    v_business.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Professional scheduling helpers (SECURITY INVOKER: RLS applies)
-- ---------------------------------------------------------------------------

-- Atomically replaces the weekly schedule of a business. Overlapping ranges are
-- rejected by `business_hours_no_overlap`, rolling the whole call back.
create function public.replace_business_hours(p_business_id uuid, p_hours jsonb)
returns setof public.business_hours
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  if p_hours is null or pg_catalog.jsonb_typeof(p_hours) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_hours';
  end if;

  delete from public.business_hours where business_id = p_business_id;

  insert into public.business_hours (business_id, weekday, starts_at, ends_at)
  select p_business_id, h.weekday, h.starts_at, h.ends_at
  from pg_catalog.jsonb_to_recordset(p_hours)
    as h(weekday smallint, starts_at time, ends_at time);

  return query
  select *
  from public.business_hours bh
  where bh.business_id = p_business_id
  order by bh.weekday, bh.starts_at;
end;
$$;

-- Applies a full ordering of the services of a business. The list must be a
-- permutation of all its services so the result is always deterministic.
create function public.reorder_services(p_business_id uuid, p_service_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  if p_service_ids is null
    or pg_catalog.cardinality(p_service_ids) <> (
      select count(distinct id) from pg_catalog.unnest(p_service_ids) as u(id)
    )
    or pg_catalog.cardinality(p_service_ids) <> (
      select count(*) from public.services where business_id = p_business_id
    )
    or exists (
      select 1
      from pg_catalog.unnest(p_service_ids) as u(id)
      where not exists (
        select 1
        from public.services s
        where s.id = u.id and s.business_id = p_business_id
      )
    ) then
    raise exception using errcode = '22023', message = 'invalid_service_order';
  end if;

  update public.services s
  set display_order = o.position - 1
  from pg_catalog.unnest(p_service_ids) with ordinality as o(id, position)
  where s.id = o.id
    and s.business_id = p_business_id
    and s.display_order <> o.position - 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (functions are denied to API roles by default since 20260927200000)
-- ---------------------------------------------------------------------------

revoke all on function public.get_public_business(text) from public;
revoke all on function public.get_public_services(text) from public;
revoke all on function public.get_available_slots(text, uuid, date) from public;
revoke all on function public.create_public_booking(
  text, uuid, timestamptz, text, text, text, text
) from public;
revoke all on function public.replace_business_hours(uuid, jsonb) from public;
revoke all on function public.reorder_services(uuid, uuid[]) from public;

grant execute on function public.get_public_business(text) to anon, authenticated;
grant execute on function public.get_public_services(text) to anon, authenticated;
grant execute on function public.get_available_slots(text, uuid, date) to anon, authenticated;
grant execute on function public.create_public_booking(
  text, uuid, timestamptz, text, text, text, text
) to anon, authenticated;

grant execute on function public.replace_business_hours(uuid, jsonb) to authenticated;
grant execute on function public.reorder_services(uuid, uuid[]) to authenticated;
