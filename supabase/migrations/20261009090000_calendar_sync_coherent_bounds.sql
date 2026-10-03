-- Calendar sync: coherent bounds never stop a page (audit of 4af7543).
--
-- 1. Bounds are compared once each is resolved in its own zone, never as
--    wall-clock times: an event from 10:00 America/New_York to 09:00
--    America/Los_Angeles (no offsets, which Google allows with timeZone)
--    is 14:00Z → 16:00Z, not inverted. A bound in an unknown zone is the
--    range of its possible instants (UTC+14 to UTC−12).
-- 2. No event can roll the page back because of its bounds any more: if
--    they are still inverted once resolved, the envelope of every possible
--    bound blocks (and is counted in `adjusted`, logged by the server);
--    inverted all-day dates block every day between them in every zone. An
--    empty interval occupies no time but never erases a cached busy
--    period. Only unreadable bounds (no date, no offset and no zone) fail.
-- 3. Approximate periods (widened or adjusted) are flagged on their row:
--    a calendar holding one is 'degraded', never 'synced', even with a
--    trusted zone; an exact re-projection clears the flag.
-- 4. The calendar lists to read again are stamped one by one, when the
--    job actually starts reading them (calendar_begin_calendar_list_check),
--    not all at once when listed.

alter table public.external_calendar_events
  add column approximate boolean not null default false;

update public.external_calendar_events
set approximate = true
where all_day and all_day_start_date is null;

-- ---------------------------------------------------------------------------
-- Re-projection keeps the flag right
-- ---------------------------------------------------------------------------

create or replace function private.reproject_all_day(p_calendar_id uuid, p_zone text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if private.is_known_timezone(p_zone) then
    delete from public.external_calendar_events e
    where e.external_calendar_id = p_calendar_id
      and e.all_day
      and e.all_day_zone is null
      and e.all_day_start_date is not null
      and private.local_day_start(e.all_day_end_date, p_zone)
          <= private.local_day_start(e.all_day_start_date, p_zone);

    update public.external_calendar_events e
    set starts_at = private.local_day_start(e.all_day_start_date, p_zone),
        ends_at = private.local_day_start(e.all_day_end_date, p_zone),
        approximate = false
    where e.external_calendar_id = p_calendar_id
      and e.all_day
      and e.all_day_zone is null
      and e.all_day_start_date is not null;
  else
    update public.external_calendar_events e
    set starts_at = private.wide_day_start(e.all_day_start_date),
        ends_at = private.wide_day_end(e.all_day_end_date),
        approximate = true
    where e.external_calendar_id = p_calendar_id
      and e.all_day
      and e.all_day_zone is null
      and e.all_day_start_date is not null;
  end if;

  update public.external_calendar_events e
  set starts_at = e.starts_at - interval '26 hours',
      ends_at = e.ends_at + interval '26 hours',
      approximate = true
  where e.external_calendar_id = p_calendar_id
    and e.all_day
    and e.all_day_start_date is null;
end;
$$;

-- 'synced' only with a trusted zone and no approximate period.
create or replace function private.mark_synced(p_calendar_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_reason text;
begin
  select case
    when c.timezone_trust <> 'trusted' then 'untrusted_timezone'
    when exists (
      select 1 from public.external_calendar_events e
      where e.external_calendar_id = c.id and e.approximate
    ) then 'approximate_events'
  end
  into v_reason
  from public.external_calendars c
  where c.id = p_calendar_id;

  update public.external_calendars
  set sync_status = case when v_reason is null then 'synced' else 'degraded' end,
      last_synced_at = pg_catalog.now(),
      last_error = v_reason
  where id = p_calendar_id;
  update public.calendar_connections k
  set last_synced_at = pg_catalog.now(), last_error = null
  from public.external_calendars c
  where c.id = p_calendar_id and k.id = c.connection_id and k.status = 'active';
end;
$$;

-- ---------------------------------------------------------------------------
-- Calendar lists to read again: listed, then stamped one by one
-- ---------------------------------------------------------------------------

create or replace function public.calendar_due_calendar_lists(p_limit integer default 20)
returns table (connection_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select k.id
  from public.calendar_connections k
  where k.status = 'active'
    and (k.calendar_list_checked_at is null
         or k.calendar_list_checked_at < pg_catalog.now() - interval '6 hours')
    and exists (
      select 1 from public.external_calendars c
      where c.connection_id = k.id
        and c.selected_for_blocking
        and c.timezone_trust = 'untrusted'
    )
  order by k.calendar_list_checked_at nulls first, k.id
  limit least(greatest(p_limit, 1), 100);
$$;

-- Stamps a connection when the job starts reading its list (whatever the
-- outcome: a failing read waits 6 hours too). False: another run took it.
create function public.calendar_begin_calendar_list_check(p_connection_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.calendar_connections k
  set calendar_list_checked_at = pg_catalog.now()
  where k.id = p_connection_id
    and (k.calendar_list_checked_at is null
         or k.calendar_list_checked_at < pg_catalog.now() - interval '6 hours');
  return found;
end;
$$;

create or replace function public.calendar_apply_events(
  p_calendar_id uuid,
  p_claim_id uuid,
  p_generation bigint,
  p_provider_timezone text,
  p_events jsonb,
  p_next_page_token text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_calendar public.external_calendars;
  v_sync private.external_calendar_sync;
  v_timezone text;
  v_start_zone text;
  v_end_zone text;
  v_generation bigint;
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_event jsonb;
  v_id text;
  v_zone text;
  v_event_zone text;
  v_start_date date;
  v_end_date date;
  v_starts timestamptz;
  v_ends timestamptz;
  v_all_day boolean;
  v_busy boolean;
  v_updated timestamptz;
  v_upserted integer := 0;
  v_deleted integer := 0;
  v_skipped integer := 0;
  v_count integer;
  v_start_lo timestamptz;
  v_start_hi timestamptz;
  v_end_lo timestamptz;
  v_end_hi timestamptz;
  v_empty boolean;
  v_approximate boolean;
  v_adjusted integer := 0;
begin
  if p_events is null or pg_catalog.jsonb_typeof(p_events) <> 'array'
    or pg_catalog.jsonb_array_length(p_events) > 2500 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'events';
  end if;

  select c.* into v_calendar from public.external_calendars c where c.id = p_calendar_id;
  if v_calendar.id is null then
    return pg_catalog.jsonb_build_object('applied', false, 'reason', 'stale_claim');
  end if;

  perform private.lock_business_schedule(v_calendar.business_id);

  v_sync := private.claimed_sync(p_calendar_id, p_claim_id);
  if v_sync.calendar_id is null then
    return pg_catalog.jsonb_build_object('applied', false, 'reason', 'stale_claim');
  end if;
  select c.* into v_calendar from public.external_calendars c where c.id = p_calendar_id;

  -- The page names the calendar's zone. Unknown to PostgreSQL: the
  -- calendar's zone becomes untrusted (its all-day periods are widened at
  -- once) and the sync restarts in full, with widened projections. An
  -- untrusted calendar ignores the page's zone (only a calendar list
  -- restores trust).
  if p_provider_timezone is not null
    and not private.is_known_timezone(p_provider_timezone)
    and v_calendar.timezone_trust = 'trusted' then
    update public.external_calendars
    set timezone_trust = 'untrusted', sync_status = 'stale',
        last_error = 'untrusted_timezone'
    where id = p_calendar_id;
    update private.external_calendar_sync s
    set sync_token = null,
        full_generation = null,
        full_page_token = null,
        full_window_start = null,
        full_window_end = null,
        full_started_at = null
    where s.calendar_id = p_calendar_id;
    perform private.reproject_all_day(p_calendar_id, null);
    return pg_catalog.jsonb_build_object('applied', false, 'reason', 'timezone_changed');
  end if;

  if p_provider_timezone is not null
    and private.is_known_timezone(p_provider_timezone)
    and v_calendar.timezone_trust = 'trusted'
    and v_calendar.timezone is distinct from p_provider_timezone then
    update public.external_calendars
    set timezone = p_provider_timezone, sync_status = 'stale'
    where id = p_calendar_id;
    update private.external_calendar_sync s
    set sync_token = null,
        full_generation = null,
        full_page_token = null,
        full_window_start = null,
        full_window_end = null,
        full_started_at = null
    where s.calendar_id = p_calendar_id;
    perform private.reproject_all_day(p_calendar_id, p_provider_timezone);
    return pg_catalog.jsonb_build_object('applied', false, 'reason', 'timezone_changed');
  end if;

  if p_generation is not null then
    if v_sync.full_generation is distinct from p_generation then
      return pg_catalog.jsonb_build_object('applied', false, 'reason', 'stale_generation');
    end if;
    v_generation := p_generation;
    v_window_start := v_sync.full_window_start;
    v_window_end := v_sync.full_window_end;
  else
    if v_sync.sync_token is null then
      return pg_catalog.jsonb_build_object('applied', false, 'reason', 'stale_generation');
    end if;
    v_generation := v_sync.generation;
    v_window_start := v_sync.window_start;
    v_window_end := v_sync.window_end;
  end if;

  if v_window_start is null or v_window_end is null then
    raise exception using errcode = 'P0001', message = 'calendar_sync_state_invalid';
  end if;

  -- The calendar's own zone only: never the business zone, whose changes
  -- are not tracked by the copy. Null: all-day events without their own
  -- zone cannot be placed (protocol error).
  v_timezone := case
    when v_calendar.timezone_trust = 'trusted'
      and private.is_known_timezone(v_calendar.timezone) then v_calendar.timezone
  end;

  for v_event in select * from pg_catalog.jsonb_array_elements(p_events)
  loop
    v_id := v_event->>'id';
    if v_id is null or v_id = '' or pg_catalog.char_length(v_id) > 1024 then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'events';
    end if;

    if v_event->>'status' = 'cancelled' then
      delete from public.external_calendar_events e
      where e.external_calendar_id = p_calendar_id
        and (e.provider_event_id = v_id or e.provider_recurring_event_id = v_id);
      get diagnostics v_count = row_count;
      v_deleted := v_deleted + v_count;
      continue;
    end if;

    v_start_date := null;
    v_end_date := null;
    v_event_zone := null;
    v_starts := null;
    v_ends := null;
    v_empty := false;
    v_approximate := false;

    -- Bound zones. A zone the provider names but PostgreSQL does not know
    -- (a recent IANA zone, a typo) is never ignored nor replaced by
    -- another zone: an explicit offset still gives the exact instant;
    -- otherwise the bound may lie anywhere between UTC+14 and UTC−12.
    v_start_zone := v_event->'start'->>'timeZone';
    v_end_zone := v_event->'end'->>'timeZone';

    begin
      v_updated := (v_event->>'updated')::timestamptz;
      if (v_event->'start' ? 'date') is distinct from (v_event->'end' ? 'date') then
        -- Bounds of different kinds (or a missing bound): unreadable.
        v_starts := null;
      elsif v_event->'start' ? 'date' then
        v_all_day := true;
        v_start_date := (v_event->'start'->>'date')::date;
        v_end_date := (v_event->'end'->>'date')::date;
        v_event_zone := v_start_zone;
        v_zone := coalesce(v_event_zone, v_timezone);
        if v_end_date = v_start_date then
          v_empty := true;
        elsif v_end_date < v_start_date then
          -- Inverted dates: every day between them, in every zone.
          v_starts := private.wide_day_start(v_end_date);
          v_ends := private.wide_day_end(v_start_date);
          v_start_date := null;
          v_end_date := null;
          v_approximate := true;
          v_adjusted := v_adjusted + 1;
        elsif private.is_known_timezone(v_zone) then
          v_starts := private.local_day_start(v_start_date, v_zone);
          v_ends := private.local_day_start(v_end_date, v_zone);
        else
          -- Own zone unknown, or calendar zone unknown or untrusted.
          v_starts := private.wide_day_start(v_start_date);
          v_ends := private.wide_day_end(v_end_date);
          v_approximate := true;
        end if;
      else
        v_all_day := false;
        -- Each bound resolved in its own zone first (never compared as
        -- wall-clock times: 10:00 New York ends after 09:00 Los Angeles);
        -- a bound in an unknown zone is the range of its possible instants.
        v_start_lo := private.bound_instant(v_event->'start'->>'dateTime', v_start_zone, 'start');
        v_start_hi := private.bound_instant(v_event->'start'->>'dateTime', v_start_zone, 'end');
        v_end_lo := private.bound_instant(v_event->'end'->>'dateTime', v_end_zone, 'start');
        v_end_hi := private.bound_instant(v_event->'end'->>'dateTime', v_end_zone, 'end');
        v_approximate := v_start_lo <> v_start_hi or v_end_lo <> v_end_hi;
        -- The envelope of every possible bound: for coherent bounds, the
        -- event itself (widened if a zone is unknown); for inverted ones,
        -- the whole span between them (never a rollback of the page).
        v_starts := least(v_start_lo, v_end_lo);
        v_ends := greatest(v_start_hi, v_end_hi);
        if v_ends <= v_starts then
          v_empty := true;
        elsif v_end_hi <= v_start_lo then
          -- Inverted once resolved.
          v_approximate := true;
          v_adjusted := v_adjusted + 1;
        elsif v_start_zone is not distinct from v_end_zone
          and v_event->'start'->>'dateTime' !~ '(Z|z|[+-][0-9]{2}:?[0-9]{2})$'
          and v_event->'end'->>'dateTime' !~ '(Z|z|[+-][0-9]{2}:?[0-9]{2})$' then
          -- Same (unknown) zone on both sides: the wall clock decides.
          if (v_event->'end'->>'dateTime')::timestamp
             = (v_event->'start'->>'dateTime')::timestamp then
            v_empty := true;
          elsif (v_event->'end'->>'dateTime')::timestamp
                < (v_event->'start'->>'dateTime')::timestamp then
            v_approximate := true;
            v_adjusted := v_adjusted + 1;
          end if;
        end if;
      end if;
    exception
      when others then
        v_starts := null;
        v_empty := false;
    end;

    -- An empty interval occupies no time, but never erases a known busy
    -- period: the cached row, if any, is kept.
    if v_empty then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Unreadable bounds (no readable date, no offset and no zone) cannot
    -- be placed at all: protocol error for the page.
    if v_starts is null or v_ends is null then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'events';
    end if;

    v_busy := coalesce(v_event->>'transparency', 'opaque') <> 'transparent'
      and not coalesce((v_event->>'declined')::boolean, false)
      and coalesce(v_event->>'eventType', 'default') not in ('workingLocation', 'birthday');

    -- An all-day civil day that does not exist in its zone (empty
    -- projection) occupies no time; a period outside the window is not kept.
    if v_ends <= v_starts or v_ends <= v_window_start or v_starts >= v_window_end then
      delete from public.external_calendar_events e
      where e.external_calendar_id = p_calendar_id and e.provider_event_id = v_id;
      get diagnostics v_count = row_count;
      v_deleted := v_deleted + v_count;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.external_calendar_events as e (
      business_id, external_calendar_id, provider_event_id,
      provider_recurring_event_id, starts_at, ends_at, all_day, busy,
      provider_etag, provider_updated_at, sync_generation,
      all_day_start_date, all_day_end_date, all_day_zone, approximate
    )
    values (
      v_calendar.business_id, p_calendar_id, v_id,
      nullif(pg_catalog.left(v_event->>'recurringEventId', 1024), ''),
      v_starts, v_ends, v_all_day, v_busy,
      pg_catalog.left(v_event->>'etag', 256), v_updated, v_generation,
      v_start_date, v_end_date, v_event_zone, v_approximate
    )
    on conflict (external_calendar_id, provider_event_id) do update
    set sync_generation = excluded.sync_generation,
        synced_at = pg_catalog.now(),
        starts_at = case when e.provider_updated_at is null or excluded.provider_updated_at is null
                           or excluded.provider_updated_at >= e.provider_updated_at
                         then excluded.starts_at else e.starts_at end,
        ends_at = case when e.provider_updated_at is null or excluded.provider_updated_at is null
                         or excluded.provider_updated_at >= e.provider_updated_at
                       then excluded.ends_at else e.ends_at end,
        all_day = case when e.provider_updated_at is null or excluded.provider_updated_at is null
                         or excluded.provider_updated_at >= e.provider_updated_at
                       then excluded.all_day else e.all_day end,
        all_day_start_date = case when e.provider_updated_at is null or excluded.provider_updated_at is null
                                    or excluded.provider_updated_at >= e.provider_updated_at
                                  then excluded.all_day_start_date else e.all_day_start_date end,
        all_day_end_date = case when e.provider_updated_at is null or excluded.provider_updated_at is null
                                  or excluded.provider_updated_at >= e.provider_updated_at
                                then excluded.all_day_end_date else e.all_day_end_date end,
        all_day_zone = case when e.provider_updated_at is null or excluded.provider_updated_at is null
                              or excluded.provider_updated_at >= e.provider_updated_at
                            then excluded.all_day_zone else e.all_day_zone end,
        approximate = case when e.provider_updated_at is null or excluded.provider_updated_at is null
                             or excluded.provider_updated_at >= e.provider_updated_at
                           then excluded.approximate else e.approximate end,
        busy = case when e.provider_updated_at is null or excluded.provider_updated_at is null
                      or excluded.provider_updated_at >= e.provider_updated_at
                    then excluded.busy else e.busy end,
        provider_recurring_event_id = excluded.provider_recurring_event_id,
        provider_etag = case when e.provider_updated_at is null or excluded.provider_updated_at is null
                               or excluded.provider_updated_at >= e.provider_updated_at
                             then excluded.provider_etag else e.provider_etag end,
        provider_updated_at = greatest(e.provider_updated_at, excluded.provider_updated_at);
    v_upserted := v_upserted + 1;
  end loop;

  if p_generation is not null then
    update private.external_calendar_sync s
    set full_page_token = p_next_page_token
    where s.calendar_id = p_calendar_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'applied', true,
    'upserted', v_upserted,
    'deleted', v_deleted,
    'skipped', v_skipped,
    'adjusted', v_adjusted
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.calendar_due_calendar_lists(integer)',
    'public.calendar_begin_calendar_list_check(uuid)',
    'public.calendar_apply_events(uuid, uuid, bigint, text, jsonb, text)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
