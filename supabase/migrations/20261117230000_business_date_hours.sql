-- An opening range for one civil date replaces that day's usual openings.
-- Occupied time, closures and blocked periods are still applied by the
-- existing availability calculation. Existing appointments are untouched.
create table public.business_date_hours (
  business_id uuid not null references public.businesses(id) on delete cascade,
  date date not null check (date between date '0001-01-01' and date '9999-12-31'),
  starts_at time not null,
  ends_at time not null,
  primary key (business_id, date),
  check (starts_at < ends_at),
  check (extract(second from starts_at) = 0 and extract(second from ends_at) = 0)
);

alter table public.business_date_hours enable row level security;
revoke all on public.business_date_hours from public, anon, authenticated;
grant select on public.business_date_hours to authenticated;
create policy business_date_hours_select_member on public.business_date_hours
  for select to authenticated using (public.is_business_member(business_id));

-- Compare the exact range read by the editor under the shared schedule
-- lock. Null bounds restore the regular schedule. A retry of the same
-- change is safe even if the original answer was lost.
create function public.set_business_date_hours(
  p_business_id uuid,
  p_date date,
  p_starts_at time default null,
  p_ends_at time default null,
  p_expected_starts_at time default null,
  p_expected_ends_at time default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_starts_at time;
  v_ends_at time;
begin
  if not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_date is null or p_date not between date '0001-01-01' and date '9999-12-31' then
    raise exception using errcode = '22023', message = 'invalid_hours', hint = 'date';
  end if;
  if (p_starts_at is null) <> (p_ends_at is null) or p_starts_at >= p_ends_at
     or extract(second from p_starts_at) <> 0 or extract(second from p_ends_at) <> 0 then
    raise exception using errcode = '22023', message = 'invalid_hours', hint = 'endsAt';
  end if;

  perform private.lock_business_schedule(p_business_id);
  select h.starts_at, h.ends_at into v_starts_at, v_ends_at
  from public.business_date_hours h
  where h.business_id = p_business_id and h.date = p_date;

  if (v_starts_at, v_ends_at) is not distinct from (p_starts_at, p_ends_at) then
    return;
  end if;
  if (v_starts_at, v_ends_at) is distinct from (p_expected_starts_at, p_expected_ends_at) then
    raise exception using errcode = 'P0001', message = 'stale_business_hours';
  end if;

  if p_starts_at is null then
    delete from public.business_date_hours
    where business_id = p_business_id and date = p_date;
  else
    insert into public.business_date_hours (business_id, date, starts_at, ends_at)
    values (p_business_id, p_date, p_starts_at, p_ends_at)
    on conflict (business_id, date)
      do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at;
  end if;
end;
$$;

revoke all on function public.set_business_date_hours(uuid, date, time, time, time, time)
  from public, anon, authenticated;
grant execute on function public.set_business_date_hours(uuid, date, time, time, time, time)
  to authenticated;

-- Keep the same wall-clock projection, including DST, as the weekly hours.
-- The date takes precedence over old exceptional openings as well.
create or replace function private.opening_ranges(
  p_business_id uuid,
  p_date date,
  p_timezone text
)
returns pg_catalog.tstzmultirange
language sql
stable
set search_path = ''
as $$
  with date_hours as (
    select h.starts_at, h.ends_at
    from public.business_date_hours h
    where h.business_id = p_business_id and h.date = p_date
  ), hours as (
    select starts_at, ends_at from date_hours
    union all
    select h.starts_at, h.ends_at
    from public.business_hours h
    where h.business_id = p_business_id
      and h.weekday = extract(dow from p_date)
      and not exists (select 1 from date_hours)
  ), day as (
    select
      private.local_day_start(p_date, p_timezone) as lo,
      private.local_day_start(p_date + 1, p_timezone) as hi
  ), piece as (
    select
      z.starts_at,
      z.starts_at at time zone p_timezone as wall_start,
      (z.starts_at at time zone p_timezone)
        + pg_catalog.make_interval(secs => extract(epoch from z.ends_at - z.starts_at))
        as wall_end
    from day
    cross join lateral private.zone_offsets(p_timezone, day.lo, day.hi) z
    where day.lo < day.hi
  ), bounds as (
    select
      p.starts_at + pg_catalog.make_interval(
        secs => extract(epoch from greatest(p.wall_start, p_date + h.starts_at) - p.wall_start)
      ) as lo,
      p.starts_at + pg_catalog.make_interval(
        secs => extract(epoch from least(p.wall_end, p_date + h.ends_at) - p.wall_start)
      ) as hi
    from piece p
    cross join hours h
    where greatest(p.wall_start, p_date + h.starts_at) < least(p.wall_end, p_date + h.ends_at)
    union all
    select greatest(e.starts_at, day.lo), least(e.ends_at, day.hi)
    from day
    join public.availability_exceptions e
      on e.business_id = p_business_id
     and e.kind = 'open_override'
     and e.starts_at < day.hi
     and e.ends_at > day.lo
    where not exists (select 1 from date_hours)
  )
  select pg_catalog.range_agg(pg_catalog.tstzrange(bounds.lo, bounds.hi, '[)'))
  from bounds
  where bounds.lo < bounds.hi;
$$;
