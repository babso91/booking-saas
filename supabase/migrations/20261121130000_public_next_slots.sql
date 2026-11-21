-- The next bookable slot of each service of a business, in one read (Higani
-- point 2: « Prochaine disponibilité », on the mini-site's cover and on each
-- service). Contract agreed with Claude UI on 21/11.
--
-- One row per service bookable online (active, in a visible category or
-- none), with its first slot from now up to the booking horizon, or null
-- bounds when there is none. The slots are the ones the booking page offers,
-- from the same engine (private.available_slots): opening hours, hours by
-- date, closures, blocks, appointments, buffer, minimum notice, horizon. A
-- service with required options is quoted with the answers the booking page
-- preselects (the first choice of each required group, optional groups
-- unanswered), so the announced slot is the one she finds when she opens it.
-- The general « next availability » is the earliest row.
--
-- Read-only and public, behind the same slug guard as get_public_business.
-- Only service ids and public slot times leave the function.
create function public.get_public_next_slots(p_slug text)
returns table (
  service_id uuid,
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
  v_max_days integer;
  v_now timestamptz := pg_catalog.now();
  v_today date;
  v_day date;
  v_service record;
  v_choices uuid[];
  v_slot record;
  v_all uuid[] := '{}';
  v_pending uuid[] := '{}';
  v_defaults jsonb := '{}';
  v_found jsonb := '{}';
  v_id uuid;
  v_usable pg_catalog.tstzmultirange;
  v_longest interval;
  v_minutes jsonb := '{}';
  v_duration integer;
begin
  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;

  select b.timezone, st.maximum_booking_advance_days
  into v_timezone, v_max_days
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  where b.id = v_business_id;
  v_today := (v_now at time zone v_timezone)::date;

  -- Every service bookable online, and the answers its page preselects.
  for v_service in
    select s.id
    from public.services s
    left join public.service_categories c on c.id = s.category_id
    where s.business_id = v_business_id
      and s.active
      and (s.category_id is null or c.visible)
  loop
    v_all := v_all || v_service.id;
    select coalesce(pg_catalog.array_agg(first_choice.id), '{}')
    into v_choices
    from public.service_options o
    cross join lateral (
      select ch.id
      from public.service_option_choices ch
      where ch.option_id = o.id
      order by ch.display_order, ch.id
      limit 1
    ) first_choice
    where o.service_id = v_service.id
      and o.business_id = v_business_id
      and o.required;
    -- A quote the booking page could not make either (a required group
    -- without any choice, a total over 12 hours): never bookable, no slot.
    begin
      select s.duration_minutes + q.duration_delta_minutes
      into v_duration
      from public.services s
      cross join private.quote_options(v_business_id, v_service.id, v_choices) q
      where s.id = v_service.id;
      if v_duration is null or v_duration > 720 then
        continue;
      end if;
    exception when others then
      continue;
    end;
    v_minutes := v_minutes || pg_catalog.jsonb_build_object(v_service.id::text, v_duration);
    v_defaults := v_defaults || pg_catalog.jsonb_build_object(
      v_service.id::text, pg_catalog.to_jsonb(v_choices)
    );
    v_pending := v_pending || v_service.id;
  end loop;

  -- Day by day from today, each service until its first slot: the first
  -- day that has one holds its earliest.
  v_day := v_today;
  while pg_catalog.cardinality(v_pending) > 0 and v_day <= v_today + v_max_days loop
    -- A day without any usable time (closed, blocked, no hours) has no
    -- slot for any service: skipped at once, as the engine would find.
    select private.opening_ranges(v_business_id, v_day, v_timezone) - coalesce(
      (
        select pg_catalog.range_agg(pg_catalog.tstzrange(e.starts_at, e.ends_at, '[)'))
        from public.availability_exceptions e
        where e.business_id = v_business_id
          and e.kind in ('closed', 'blocked')
          and e.starts_at < private.local_day_start(v_day + 1, v_timezone)
          and e.ends_at > private.local_day_start(v_day, v_timezone)
      ),
      '{}'::pg_catalog.tstzmultirange
    )
    into v_usable;
    if v_usable is null or pg_catalog.isempty(v_usable) then
      v_day := v_day + 1;
      continue;
    end if;

    -- Nor for a service longer than the day's longest usable range.
    select max(pg_catalog.upper(r) - pg_catalog.lower(r))
    into v_longest
    from pg_catalog.unnest(v_usable) as r;

    foreach v_id in array v_pending loop
      if pg_catalog.make_interval(mins => (v_minutes ->> v_id::text)::integer) > v_longest then
        continue;
      end if;
      select slot.starts_at, slot.ends_at
      into v_slot
      from private.available_slots(
        v_business_id,
        v_id,
        v_day,
        v_now,
        array(
          select pg_catalog.jsonb_array_elements_text(v_defaults -> v_id::text)::uuid
        )
      ) slot
      order by slot.starts_at
      limit 1;
      if found then
        v_found := v_found || pg_catalog.jsonb_build_object(
          v_id::text,
          pg_catalog.jsonb_build_object('starts_at', v_slot.starts_at, 'ends_at', v_slot.ends_at)
        );
        v_pending := pg_catalog.array_remove(v_pending, v_id);
      end if;
    end loop;
    v_day := v_day + 1;
  end loop;

  return query
  select
    ids.id,
    (v_found -> ids.id::text ->> 'starts_at')::timestamptz,
    (v_found -> ids.id::text ->> 'ends_at')::timestamptz,
    private.wall_clock((v_found -> ids.id::text ->> 'starts_at')::timestamptz, v_timezone),
    private.wall_clock((v_found -> ids.id::text ->> 'ends_at')::timestamptz, v_timezone)
  from pg_catalog.unnest(v_all) as ids(id)
  order by (v_found -> ids.id::text ->> 'starts_at')::timestamptz nulls last, ids.id;
end;
$$;

revoke all on function public.get_public_next_slots(text) from public;
grant execute on function public.get_public_next_slots(text) to anon, authenticated, service_role;
