-- Calendar sync hardening, fifth round: untrusted calendars keep syncing.
--
-- A calendar whose zone PostgreSQL does not know (most likely an IANA zone
-- newer than the database's tzdata, e.g. America/Ciudad_Juarez) must not
-- freeze: new events at Google would never block. It keeps syncing:
-- - an event with an explicit offset gets its exact instant;
-- - a date-time without offset in an unknown zone, and an all-day event in
--   an unknown own zone or an untrusted calendar zone, are widened to cover
--   every possible zone (UTC+14 to UTC−12): over-blocking, never
--   under-blocking; nothing is rejected nor ignored silently;
-- - the calendar is never 'synced' but 'degraded' (synced with a margin);
-- - the periodic job reads the calendar list again, at most every 6 hours
--   per connection; only a calendar list with a known zone restores trust:
--   exact re-projection, full sync, then 'synced'.
-- Recurring events need no zone of ours: Google expands series itself
-- (singleEvents=true), each instance carrying its own bounds.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.external_calendars
  drop constraint external_calendars_sync_status_check;
alter table public.external_calendars
  add constraint external_calendars_sync_status_check
    check (sync_status in ('pending', 'syncing', 'synced', 'degraded', 'stale', 'error', 'incomplete'));

alter table public.calendar_connections
  add column calendar_list_checked_at timestamptz;

-- ---------------------------------------------------------------------------
-- Widened projections
-- ---------------------------------------------------------------------------

-- Earliest start of a civil day in any zone (midnight at UTC+14).
create function private.wide_day_start(p_date date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select (p_date::timestamp at time zone 'UTC') - interval '14 hours';
$$;

-- Latest end of a civil day ending at p_date (midnight at UTC−12).
create function private.wide_day_end(p_date date)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select (p_date::timestamp at time zone 'UTC') + interval '12 hours';
$$;

-- The instant of a provider date-time: its own offset; else its zone if
-- known; else, if a zone is named but unknown, the widest instant for that
-- wall-clock time (start: earliest, end: latest). No offset and no zone:
-- malformed (Google requires one).
create function private.bound_instant(p_value text, p_zone text, p_side text)
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
  if private.is_known_timezone(p_zone) then
    return p_value::timestamp at time zone p_zone;
  end if;
  if p_zone is not null then
    return (p_value::timestamp at time zone 'UTC')
      + case when p_side = 'start' then interval '-14 hours' else interval '12 hours' end;
  end if;
  raise exception using errcode = '22023', message = 'invalid_input', hint = 'timeZone';
end;
$$;

-- Re-projects a calendar's all-day periods that follow the calendar zone.
-- Known zone: exactly. Unknown or absent zone: widened to every zone.
-- Legacy rows (civil dates unknown) are widened by 26 hours each side.
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
        ends_at = private.local_day_start(e.all_day_end_date, p_zone)
    where e.external_calendar_id = p_calendar_id
      and e.all_day
      and e.all_day_zone is null
      and e.all_day_start_date is not null;
  else
    update public.external_calendar_events e
    set starts_at = private.wide_day_start(e.all_day_start_date),
        ends_at = private.wide_day_end(e.all_day_end_date)
    where e.external_calendar_id = p_calendar_id
      and e.all_day
      and e.all_day_zone is null
      and e.all_day_start_date is not null;
  end if;

  update public.external_calendar_events e
  set starts_at = e.starts_at - interval '26 hours',
      ends_at = e.ends_at + interval '26 hours'
  where e.external_calendar_id = p_calendar_id
    and e.all_day
    and e.all_day_start_date is null;
end;
$$;

-- A finished pass: 'synced' only with a trusted zone; otherwise 'degraded'
-- (complete, but with widened periods), never mistaken for synced.
create or replace function private.mark_synced(p_calendar_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  update public.external_calendars
  set sync_status = case when timezone_trust = 'trusted' then 'synced' else 'degraded' end,
      last_synced_at = pg_catalog.now(),
      last_error = case when timezone_trust = 'trusted' then null else 'untrusted_timezone' end
  where id = p_calendar_id;
  update public.calendar_connections k
  set last_synced_at = pg_catalog.now(), last_error = null
  from public.external_calendars c
  where c.id = p_calendar_id and k.id = c.connection_id and k.status = 'active';
$$;

-- Untrusted calendars are claimed and written like the others.
create or replace function private.claimed_sync(p_calendar_id uuid, p_claim_id uuid)
returns private.external_calendar_sync
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_sync private.external_calendar_sync;
begin
  select s.* into v_sync
  from private.external_calendar_sync s
  join public.external_calendars c on c.id = s.calendar_id
  join public.calendar_connections k on k.id = c.connection_id
  where s.calendar_id = p_calendar_id
    and s.claim_id = p_claim_id
    and c.selected_for_blocking
    and k.status = 'active'
  for update of s;
  return v_sync;
end;
$$;

create or replace function public.calendar_claim_sync(
  p_calendar_id uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_calendar public.external_calendars;
  v_connection public.calendar_connections;
  v_sync private.external_calendar_sync;
  v_business_timezone text;
begin
  select c.* into v_calendar
  from public.external_calendars c
  where c.id = p_calendar_id;
  if v_calendar.id is null or not v_calendar.selected_for_blocking then
    return null;
  end if;

  -- Same lock order as every other writer (schedule lock, then rows):
  -- reconnection, selection and claims never deadlock.
  perform private.lock_business_schedule(v_calendar.business_id);

  select c.* into v_calendar
  from public.external_calendars c
  where c.id = p_calendar_id;
  if v_calendar.id is null or not v_calendar.selected_for_blocking then
    return null;
  end if;

  select c.* into v_connection
  from public.calendar_connections c
  where c.id = v_calendar.connection_id;
  if v_connection.status <> 'active' then
    return null;
  end if;

  update private.external_calendar_sync s
  set claim_id = gen_random_uuid(),
      lease_until = pg_catalog.now()
        + pg_catalog.make_interval(secs => least(greatest(p_lease_seconds, 10), 600)),
      resync_requested = false,
      last_attempt_at = pg_catalog.now()
  where s.calendar_id = p_calendar_id
    and (s.lease_until is null or s.lease_until < pg_catalog.now())
  returning s.* into v_sync;

  if v_sync.calendar_id is null then
    update private.external_calendar_sync s
    set resync_requested = true
    where s.calendar_id = p_calendar_id;
    return pg_catalog.jsonb_build_object('claimed', false);
  end if;

  update public.external_calendars set sync_status = 'syncing' where id = p_calendar_id;

  select b.timezone into v_business_timezone
  from public.businesses b where b.id = v_calendar.business_id;

  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'claimId', v_sync.claim_id,
    'calendarId', v_calendar.id,
    'businessId', v_calendar.business_id,
    'connectionId', v_connection.id,
    'connectionGeneration', v_connection.credential_generation,
    'provider', v_connection.provider,
    'providerCalendarId', v_calendar.provider_calendar_id,
    'timezone', coalesce(v_calendar.timezone, v_business_timezone),
    'syncToken', v_sync.sync_token,
    'windowEnd', v_sync.window_end,
    'fullInProgress', v_sync.full_generation is not null,
    'channelId', v_sync.channel_id,
    'channelExpiresAt', v_sync.channel_expires_at
  );
end;
$$;


create or replace function public.calendar_due_work(
  p_limit integer default 50,
  p_with_channels boolean default true
)
returns table (calendar_id uuid, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id,
    case
      when s.sync_token is null or s.full_generation is not null then 'full_sync'
      when s.window_end < pg_catalog.now() + interval '380 days' then 'window'
      when p_with_channels and (s.channel_id is null
             or s.channel_expires_at < pg_catalog.now() + interval '1 day') then 'channel'
      when c.sync_status in ('pending', 'error', 'stale', 'incomplete', 'syncing') then 'retry'
      else 'catch_up'
    end
  from public.external_calendars c
  join public.calendar_connections k on k.id = c.connection_id
  join private.external_calendar_sync s on s.calendar_id = c.id
  where c.selected_for_blocking
    and k.status = 'active'
    and (s.lease_until is null or s.lease_until < pg_catalog.now())
    and (s.next_attempt_at is null or s.next_attempt_at <= pg_catalog.now())
    and (
      s.sync_token is null
      or s.full_generation is not null
      or s.window_end < pg_catalog.now() + interval '380 days'
      or (p_with_channels and (s.channel_id is null
            or s.channel_expires_at < pg_catalog.now() + interval '1 day'))
      or c.sync_status in ('pending', 'error', 'stale', 'incomplete', 'syncing')
      or c.last_synced_at is null
      or c.last_synced_at < pg_catalog.now() - interval '6 hours'
    )
  order by s.last_attempt_at nulls first, c.id
  limit least(greatest(p_limit, 1), 500);
$$;


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

  -- When the list was last read (the periodic job reads it again for
  -- connections holding untrusted calendars). The connection row is
  -- already locked by every caller.
  update public.calendar_connections
  set calendar_list_checked_at = pg_catalog.now()
  where id = p_connection_id;

  -- A zone the provider reports but PostgreSQL does not know makes the
  -- calendar's zone untrusted. The calendar keeps syncing: events with an
  -- offset stay exact, the others (all-day events above all) are widened
  -- to cover every possible zone, at once for the existing copy, then by a
  -- full sync. It is never synced as healthy ('degraded') until a calendar
  -- list gives a known zone again.
  for v_changed in
    select c.id
    from public.external_calendars c
    join pg_catalog.jsonb_array_elements(p_calendars) item
      on item->>'id' = c.provider_calendar_id
    where c.connection_id = p_connection_id
      and item->>'timezone' is not null
      and not private.is_known_timezone(item->>'timezone')
      and c.timezone_trust = 'trusted'
    order by c.id
  loop
    update public.external_calendars c
    set timezone_trust = 'untrusted',
        sync_status = case when c.selected_for_blocking then 'stale' else c.sync_status end,
        last_error = case when c.selected_for_blocking then 'untrusted_timezone' else c.last_error end
    where c.id = v_changed.id;
    perform private.invalidate_sync(v_changed.id);
    perform private.reproject_all_day(v_changed.id, null);
  end loop;

  -- A known zone that differs from the stored one, or that restores an
  -- untrusted calendar: re-projected at once, then a full sync (new
  -- generation) before the calendar can be synced again.
  for v_changed in
    select c.id, item->>'timezone' as timezone
    from public.external_calendars c
    join pg_catalog.jsonb_array_elements(p_calendars) item
      on item->>'id' = c.provider_calendar_id
    where c.connection_id = p_connection_id
      and private.is_known_timezone(item->>'timezone')
      and (c.timezone is distinct from item->>'timezone'
           or c.timezone_trust <> 'trusted')
    order by c.id
  loop
    update public.external_calendars c
    set timezone = v_changed.timezone,
        timezone_trust = 'trusted',
        sync_status = case when c.selected_for_blocking then 'stale' else c.sync_status end,
        last_error = case when c.selected_for_blocking then null else c.last_error end
    where c.id = v_changed.id;
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


-- Connections whose calendar list must be read again: an active connection
-- holding a selected untrusted calendar, not read for 6 hours. Returned
-- connections are stamped at once (attempt-based backoff: a failing read
-- does not make the job call the provider at every run).
create function public.calendar_due_calendar_lists(p_limit integer default 20)
returns table (connection_id uuid)
language sql
volatile
security definer
set search_path = ''
as $$
  update public.calendar_connections k
  set calendar_list_checked_at = pg_catalog.now()
  where k.id in (
    select k2.id
    from public.calendar_connections k2
    where k2.status = 'active'
      and (k2.calendar_list_checked_at is null
           or k2.calendar_list_checked_at < pg_catalog.now() - interval '6 hours')
      and exists (
        select 1 from public.external_calendars c
        where c.connection_id = k2.id
          and c.selected_for_blocking
          and c.timezone_trust = 'untrusted'
      )
    order by k2.calendar_list_checked_at nulls first, k2.id
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  )
  returning k.id;
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

    -- Bound zones. A zone the provider names but PostgreSQL does not know
    -- (a recent IANA zone, a typo) is never ignored nor replaced by
    -- another zone: an explicit offset still gives the exact instant;
    -- otherwise the period is widened to cover every possible zone.
    v_start_zone := v_event->'start'->>'timeZone';
    v_end_zone := v_event->'end'->>'timeZone';

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
        if private.is_known_timezone(v_zone) then
          v_starts := private.local_day_start(v_start_date, v_zone);
          v_ends := private.local_day_start(v_end_date, v_zone);
        else
          -- Own zone unknown, or calendar zone unknown or untrusted.
          v_starts := private.wide_day_start(v_start_date);
          v_ends := private.wide_day_end(v_end_date);
        end if;
      else
        v_all_day := false;
        if v_event->'start'->>'dateTime' !~ '(Z|z|[+-][0-9]{2}:?[0-9]{2})$'
          and v_event->'end'->>'dateTime' !~ '(Z|z|[+-][0-9]{2}:?[0-9]{2})$'
          and (v_event->'end'->>'dateTime')::timestamp
              <= (v_event->'start'->>'dateTime')::timestamp then
          -- Inverted wall-clock bounds (whatever their zone).
          v_starts := null;
        else
          v_starts := private.bound_instant(v_event->'start'->>'dateTime', v_start_zone, 'start');
          v_ends := private.bound_instant(v_event->'end'->>'dateTime', v_end_zone, 'end');
        end if;
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
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function private.wide_day_start(date) from public;
revoke all on function private.wide_day_end(date) from public;
revoke all on function private.bound_instant(text, text, text) from public;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.calendar_claim_sync(uuid, integer)',
    'public.calendar_due_work(integer, boolean)',
    'public.calendar_due_calendar_lists(integer)',
    'public.calendar_apply_events(uuid, uuid, bigint, text, jsonb, text)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
