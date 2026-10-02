-- Calendar sync hardening, third round (audit of PR #10 at d560094).
--
-- 1. No business-zone fallback. Google documents calendarList.timeZone as
--    optional; a calendar whose zone is absent or unknown to PostgreSQL
--    cannot be selected (calendar_not_selectable), and an all-day event
--    without its own zone is placed in its calendar's zone only. Nothing in
--    the copy depends on businesses.timezone any more, so a business zone
--    change cannot leave a stale projection behind.
-- 2. Zones are strict. A zone the provider names (event bound, events page,
--    calendar list) must be one PostgreSQL knows; a present but unknown
--    zone ("Europe/Pariss", "Mars/Olympus", "") fails the page, even next
--    to an explicit offset (the answer is malformed), instead of silently
--    falling back to another zone. An absent zone keeps the documented
--    rules: offset required for a date-time, calendar zone for an all-day
--    date. A civil date that does not exist in a known zone (Apia) is not a
--    protocol error: it occupies no time.
-- 3. Legacy all-day rows (civil dates unknown, see 20261005090000) keep
--    their UTC busy window until a full sync replaces them; if the calendar
--    zone changes before that, they are widened by 26 hours on each side
--    (the largest offset difference between two zones): over-blocking
--    instead of under-blocking.
-- 4. Every calendar that was synced is synced again in full (see below).
-- 5. Credential writes give up after 3 seconds waiting for a lock
--    (lock_timeout): a token refresh never outlives its budget behind a
--    blocked row, and an abandoned write never lands later.

-- ---------------------------------------------------------------------------
-- Every synced calendar is fully synced again
-- ---------------------------------------------------------------------------

-- A database that applied an earlier version of 20261005090000 may have
-- lost all-day busy periods; no migration can recreate them (nothing of
-- them remains), but Google still has them: a full sync of every calendar
-- re-imports them, canonical. On a fresh database this changes nothing.
do $$
declare
  v_calendar uuid;
begin
  for v_calendar in
    select s.calendar_id
    from private.external_calendar_sync s
    where s.sync_token is not null or s.full_generation is not null
    order by 1
  loop
    update public.external_calendars set sync_status = 'stale' where id = v_calendar;
    perform private.invalidate_sync(v_calendar);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Strict instants
-- ---------------------------------------------------------------------------

-- The instant of a provider date-time: its own offset, or else its zone
-- (which must be known). No other fallback.
create function private.strict_instant(p_value text, p_zone text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null then
    return null;
  end if;
  if p_value ~ '(Z|z|[+-][0-9]{2}:?[0-9]{2})$' then
    return p_value::timestamptz;
  end if;
  if not private.is_known_timezone(p_zone) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'timeZone';
  end if;
  return p_value::timestamp at time zone p_zone;
end;
$$;

-- ---------------------------------------------------------------------------
-- Re-projection: legacy rows widened, never lost
-- ---------------------------------------------------------------------------

create or replace function private.reproject_all_day(p_calendar_id uuid, p_zone text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if not private.is_known_timezone(p_zone) then
    return;
  end if;

  delete from public.external_calendar_events e
  where e.external_calendar_id = p_calendar_id
    and e.all_day
    and e.all_day_zone is null
    and e.all_day_start_date is not null
    and private.local_day_start(e.all_day_end_date, p_zone)
        <= private.local_day_start(e.all_day_start_date, p_zone);

  update public.external_calendar_events e
  set starts_at = private.local_day_start(e.all_day_start_date, p_zone),
      ends_at = private.local_day_start(e.all_day_end_date, p_zone)
  where e.external_calendar_id = p_calendar_id
    and e.all_day
    and e.all_day_zone is null
    and e.all_day_start_date is not null;

  -- Legacy rows: their civil days are unknown; whatever zone they were
  -- read in, the new projection lies within 26 hours of the old one.
  update public.external_calendar_events e
  set starts_at = e.starts_at - interval '26 hours',
      ends_at = e.ends_at + interval '26 hours'
  where e.external_calendar_id = p_calendar_id
    and e.all_day
    and e.all_day_start_date is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Calendar list, selection, page application
-- ---------------------------------------------------------------------------

create or replace function private.save_calendars(
  p_connection_id uuid,
  p_business_id uuid,
  p_calendars jsonb
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_changed record;
begin
  if p_calendars is null or pg_catalog.jsonb_typeof(p_calendars) <> 'array'
    or pg_catalog.jsonb_array_length(p_calendars) > 250 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'calendars';
  end if;

  -- A selected calendar whose zone the provider reports but PostgreSQL does
  -- not know: its copy is kept (it keeps blocking) and its sync is stopped
  -- in error until a known zone comes back.
  for v_changed in
    select c.id
    from public.external_calendars c
    join pg_catalog.jsonb_array_elements(p_calendars) item
      on item->>'id' = c.provider_calendar_id
    where c.connection_id = p_connection_id
      and item->>'timezone' is not null
      and not private.is_known_timezone(item->>'timezone')
      and c.selected_for_blocking
    order by c.id
  loop
    update public.external_calendars
    set sync_status = 'error', last_error = 'unknown_timezone'
    where id = v_changed.id;
    perform private.invalidate_sync(v_changed.id);
  end loop;

  for v_changed in
    select c.id, item->>'timezone' as timezone
    from public.external_calendars c
    join pg_catalog.jsonb_array_elements(p_calendars) item
      on item->>'id' = c.provider_calendar_id
    where c.connection_id = p_connection_id
      and private.is_known_timezone(item->>'timezone')
      and c.timezone is distinct from item->>'timezone'
      and c.selected_for_blocking
    order by c.id
  loop
    update public.external_calendars
    set timezone = v_changed.timezone, sync_status = 'stale'
    where id = v_changed.id;
    perform private.invalidate_sync(v_changed.id);
    perform private.reproject_all_day(v_changed.id, v_changed.timezone);
  end loop;

  insert into public.external_calendars (
    business_id, connection_id, provider_calendar_id, name, timezone,
    is_primary, access_role
  )
  select
    p_business_id,
    p_connection_id,
    item->>'id',
    pg_catalog.left(coalesce(nullif(item->>'name', ''), item->>'id'), 500),
    case when private.is_known_timezone(item->>'timezone') then item->>'timezone' end,
    coalesce((item->>'primary')::boolean, false),
    pg_catalog.left(item->>'accessRole', 32)
  from pg_catalog.jsonb_array_elements(p_calendars) item
  where coalesce(item->>'id', '') <> ''
  on conflict (connection_id, provider_calendar_id) do update
  set name = excluded.name,
      timezone = coalesce(excluded.timezone, public.external_calendars.timezone),
      is_primary = excluded.is_primary,
      access_role = excluded.access_role;

  -- A calendar now only shared as free/busy stops blocking.
  update public.external_calendars c
  set selected_for_blocking = false, sync_status = 'pending', last_synced_at = null
  where c.connection_id = p_connection_id
    and c.selected_for_blocking
    and not private.is_selectable_role(c.access_role);
  delete from private.external_calendar_sync s
  using public.external_calendars c
  where s.calendar_id = c.id
    and c.connection_id = p_connection_id
    and not private.is_selectable_role(c.access_role);
  delete from public.external_calendar_events e
  using public.external_calendars c
  where e.external_calendar_id = c.id
    and c.connection_id = p_connection_id
    and not private.is_selectable_role(c.access_role);

  delete from public.external_calendars c
  where c.connection_id = p_connection_id
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_calendars) item
      where item->>'id' = c.provider_calendar_id
    );
end;
$$;


create or replace function public.calendar_set_blocking(
  p_business_id uuid,
  p_calendar_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.calendar_connections;
  v_ids uuid[] := coalesce(p_calendar_ids, '{}'::uuid[]);
  v_to_sync jsonb;
  v_to_stop jsonb;
begin
  perform private.assert_agenda_access(p_business_id);

  if pg_catalog.cardinality(v_ids) > 50 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'calendarIds';
  end if;

  perform private.lock_business_schedule(p_business_id);

  select c.* into v_connection
  from public.calendar_connections c
  where c.business_id = p_business_id
    and c.provider = 'google'
  for update;

  if v_connection.id is null or v_connection.status = 'disconnected' then
    raise exception using errcode = 'P0001', message = 'calendar_not_connected';
  end if;

  if exists (
    select 1 from pg_catalog.unnest(v_ids) requested(id)
    where not exists (
      select 1 from public.external_calendars c
      where c.id = requested.id
        and c.connection_id = v_connection.id
        and c.business_id = p_business_id
    )
  ) then
    raise exception using errcode = 'P0002', message = 'calendar_not_found';
  end if;

  if exists (
    select 1 from public.external_calendars c
    where c.id = any (v_ids)
      and not c.selected_for_blocking
      and (not private.is_selectable_role(c.access_role)
           -- Without a known zone of its own, a calendar's all-day events
           -- could only be placed in the business zone: refused.
           or not private.is_known_timezone(c.timezone))
  ) then
    raise exception using errcode = 'P0001', message = 'calendar_not_selectable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'calendarId', c.id,
    'channelId', s.channel_id,
    'resourceId', s.channel_resource_id
  )), '[]'::jsonb)
  into v_to_stop
  from public.external_calendars c
  join private.external_calendar_sync s on s.calendar_id = c.id
  where c.connection_id = v_connection.id
    and c.selected_for_blocking
    and not (c.id = any (v_ids))
    and s.channel_id is not null;

  -- 4. calendars, 5. sync rows (their claims revoked), 6. events.
  update public.external_calendars c
  set selected_for_blocking = false, sync_status = 'pending', last_error = null,
      last_synced_at = null
  where c.connection_id = v_connection.id
    and c.selected_for_blocking
    and not (c.id = any (v_ids));

  update public.external_calendars c
  set selected_for_blocking = true, sync_status = 'pending', last_error = null,
      last_synced_at = null
  where c.connection_id = v_connection.id
    and not c.selected_for_blocking
    and c.id = any (v_ids);

  delete from private.external_calendar_sync s
  using public.external_calendars c
  where s.calendar_id = c.id
    and c.connection_id = v_connection.id
    and not c.selected_for_blocking;

  insert into private.external_calendar_sync (calendar_id)
  select c.id
  from public.external_calendars c
  where c.connection_id = v_connection.id
    and c.selected_for_blocking
  on conflict (calendar_id) do nothing;

  delete from public.external_calendar_events e
  using public.external_calendars c
  where e.external_calendar_id = c.id
    and c.connection_id = v_connection.id
    and not c.selected_for_blocking;

  select coalesce(pg_catalog.jsonb_agg(c.id order by c.name), '[]'::jsonb)
  into v_to_sync
  from public.external_calendars c
  where c.connection_id = v_connection.id
    and c.selected_for_blocking;

  return pg_catalog.jsonb_build_object(
    'connectionId', v_connection.id,
    'toSync', v_to_sync,
    'channelsToStop', v_to_stop
  );
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

  -- A zone the provider names but PostgreSQL does not know is a protocol
  -- error, never ignored.
  if p_provider_timezone is not null
    and not private.is_known_timezone(p_provider_timezone) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'timeZone';
  end if;

  if p_provider_timezone is not null
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
    when private.is_known_timezone(v_calendar.timezone) then v_calendar.timezone
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

    -- Bound zones: absent, or a zone PostgreSQL knows. A zone present but
    -- unknown (typo, empty) fails the page, even next to an explicit offset:
    -- never a silent fallback.
    v_start_zone := v_event->'start'->>'timeZone';
    v_end_zone := v_event->'end'->>'timeZone';
    if (v_start_zone is not null and not private.is_known_timezone(v_start_zone))
      or (v_end_zone is not null and not private.is_known_timezone(v_end_zone)) then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'timeZone';
    end if;

    begin
      v_updated := (v_event->>'updated')::timestamptz;
      if (v_event->'start' ? 'date') is distinct from (v_event->'end' ? 'date') then
        -- Bounds of different kinds (or a missing bound).
        v_starts := null;
      elsif v_event->'start' ? 'date' then
        v_all_day := true;
        v_start_date := (v_event->'start'->>'date')::date;
        v_end_date := (v_event->'end'->>'date')::date;
        v_event_zone := v_start_zone;
        v_zone := coalesce(v_event_zone, v_timezone);
        if v_zone is not null then
          v_starts := private.local_day_start(v_start_date, v_zone);
          v_ends := private.local_day_start(v_end_date, v_zone);
        end if;
      else
        v_all_day := false;
        v_starts := private.strict_instant(v_event->'start'->>'dateTime', v_start_zone);
        v_ends := private.strict_instant(v_event->'end'->>'dateTime', v_end_zone);
      end if;
    exception
      when others then
        v_starts := null;
    end;

    -- Unreadable, inverted or empty intervals are protocol errors for the
    -- whole page: never deleted, never treated as free.
    if v_starts is null or v_ends is null
      or (v_all_day and v_end_date <= v_start_date)
      or (not v_all_day and v_ends <= v_starts) then
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
      all_day_start_date, all_day_end_date, all_day_zone
    )
    values (
      v_calendar.business_id, p_calendar_id, v_id,
      nullif(pg_catalog.left(v_event->>'recurringEventId', 1024), ''),
      v_starts, v_ends, v_all_day, v_busy,
      pg_catalog.left(v_event->>'etag', 256), v_updated, v_generation,
      v_start_date, v_end_date, v_event_zone
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
    'skipped', v_skipped
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Credential writes: bounded lock waits
-- ---------------------------------------------------------------------------

alter function public.calendar_store_access_token(uuid, uuid, text, timestamptz)
  set lock_timeout = '3s';
alter function public.calendar_reencrypt_secrets(uuid, uuid, bigint, text, text)
  set lock_timeout = '3s';
alter function public.calendar_mark_reauth_required(uuid, uuid, text)
  set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function private.strict_instant(text, text) from public;

revoke all on function public.calendar_apply_events(uuid, uuid, bigint, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.calendar_apply_events(uuid, uuid, bigint, text, jsonb, text)
  to service_role;
revoke all on function public.calendar_set_blocking(uuid, uuid[]) from public, anon;
grant execute on function public.calendar_set_blocking(uuid, uuid[]) to authenticated;
