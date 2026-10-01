-- The business's date today, with the instant it ends and the database's
-- own "now", in one answer.
--
-- A screen that stays open must know how long the date PostgreSQL calls
-- today still lasts. `today` alone made the application server fetch the
-- day's bounds separately and stamp the answer with ITS clock: a date and an
-- end from PostgreSQL mixed with a "now" from somewhere else. A server clock
-- one day late then made a date that ends in ten minutes look valid for
-- twenty-four hours and ten minutes.
--
-- public.business_time now also returns, from the same instant
-- (pg_catalog.now(), the transaction's):
--   now          → that instant;
--   todayEndsAt  → the first instant of the next civil date,
--                  private.local_day_start(today + 1).
-- By definition of private.local_date_of, now < todayEndsAt always holds, so
-- `todayEndsAt − now` is the time the date still lasts, computed by the
-- calendar authority alone.
--
-- Nothing else changes: same signature, same checks (members only, bounded
-- inputs), same body. `create or replace` keeps the existing privileges;
-- they are restated below.

create or replace function public.business_time(
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
  -- One instant for the whole call: the date, its end and `now` below all
  -- describe the same moment (the transaction's).
  v_now timestamptz := pg_catalog.now();
  v_today date;
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

  v_today := private.local_date_of(v_now, v_timezone);

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
    'today', pg_catalog.to_char(v_today, 'YYYY-MM-DD'),
    'todayEndsAt', private.local_day_start(v_today + 1, v_timezone),
    'now', v_now,
    'days', v_days,
    'locals', v_locals,
    'instants', v_instants,
    'offsets', v_offsets
  );
end;
$$;

revoke all on function public.business_time(
  uuid, date[], timestamp[], timestamptz[], boolean
) from public, anon;
grant execute on function public.business_time(
  uuid, date[], timestamp[], timestamptz[], boolean
) to authenticated;
