-- Calendar sync hardening, fourth round (audit of PR #10 at 6e2743c).
--
-- 1. Explicit trust in a calendar's zone (external_calendars.timezone_trust,
--    'trusted' | 'untrusted'). A calendar list that reports a zone
--    PostgreSQL does not know makes it untrusted: the copy keeps blocking,
--    the sync is invalidated, the calendar cannot be claimed nor written
--    (no page, no sweep, no cursor, never synced again) and no events page
--    can resolve events with the former zone, even one carrying a valid
--    zone. Only a calendar list with a known zone restores trust, and the
--    calendar is then fully synced (new generation) before it is synced.
-- 2. A refreshed access token is written only if PostgreSQL decides so
--    before the caller's budget ends, measured on PostgreSQL's own clock:
--    the caller sends its remaining duration; the function computes
--    db_deadline = clock_timestamp() + remaining - 250 ms (margin for the
--    trip from the server to the database), takes its locks in the usual
--    order (connection row, then secrets row), then checks the deadline
--    before writing. Once the locks are held, nothing else is waited for.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.external_calendars
  add column timezone_trust text not null default 'trusted'
    check (timezone_trust in ('trusted', 'untrusted'));

grant select (timezone_trust) on public.external_calendars to authenticated;

-- ---------------------------------------------------------------------------
-- Claims and writes require a trusted zone
-- ---------------------------------------------------------------------------

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
    and c.timezone_trust = 'trusted'
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
  if v_calendar.id is null or not v_calendar.selected_for_blocking
    or v_calendar.timezone_trust <> 'trusted' then
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
    and c.timezone_trust = 'trusted'
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

  -- A zone the provider reports but PostgreSQL does not know makes the
  -- calendar's zone untrusted: its copy is kept (it keeps blocking), its
  -- sync is stopped, and nothing (not an events page either) may resolve
  -- events with the former zone until a calendar list gives a known zone.
  for v_changed in
    select c.id, c.selected_for_blocking as selected
    from public.external_calendars c
    join pg_catalog.jsonb_array_elements(p_calendars) item
      on item->>'id' = c.provider_calendar_id
    where c.connection_id = p_connection_id
      and item->>'timezone' is not null
      and not private.is_known_timezone(item->>'timezone')
    order by c.id
  loop
    update public.external_calendars
    set timezone_trust = 'untrusted',
        sync_status = case when v_changed.selected then 'error' else sync_status end,
        last_error = case when v_changed.selected then 'untrusted_timezone' else last_error end
    where id = v_changed.id;
    perform private.invalidate_sync(v_changed.id);
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
           or not private.is_known_timezone(c.timezone)
           or c.timezone_trust <> 'trusted')
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


-- ---------------------------------------------------------------------------
-- Refreshed access token: written only before the caller's deadline
-- ---------------------------------------------------------------------------

drop function public.calendar_store_access_token(uuid, uuid, text, timestamptz);

-- Returns 'stored', 'stale' (another incarnation) or 'expired' (the
-- caller's budget ended before PostgreSQL could decide to write).
create function public.calendar_store_access_token(
  p_connection_id uuid,
  p_generation uuid,
  p_access_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_remaining_ms integer
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $$
declare
  -- Computed first, on the database clock: never compared with the
  -- server's clock. The margin makes it earlier than the caller's.
  v_deadline timestamptz := pg_catalog.clock_timestamp()
    + pg_catalog.make_interval(secs => greatest(p_remaining_ms, 0) / 1000.0)
    - interval '250 milliseconds';
  v_connection public.calendar_connections;
begin
  if pg_catalog.clock_timestamp() >= v_deadline then
    return 'expired';
  end if;

  -- Locks, in the global order: connection row, then secrets row.
  select c.* into v_connection
  from public.calendar_connections c
  where c.id = p_connection_id
  for share;
  if v_connection.id is null
    or v_connection.status <> 'active'
    or v_connection.credential_generation <> p_generation then
    return 'stale';
  end if;
  perform 1
  from private.calendar_secrets s
  where s.connection_id = p_connection_id
  for update;

  -- Every lock is held: the decision to write is taken now, before the
  -- deadline, or not at all.
  if pg_catalog.clock_timestamp() >= v_deadline then
    return 'expired';
  end if;

  update private.calendar_secrets s
  set access_token_ciphertext = p_access_token_ciphertext,
      access_token_expires_at = p_access_token_expires_at,
      secret_version = s.secret_version + 1,
      updated_at = pg_catalog.now()
  where s.connection_id = p_connection_id
    and s.credential_generation = p_generation
    and pg_catalog.clock_timestamp() < v_deadline;
  return case when found then 'stored' else 'stale' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function private.claimed_sync(uuid, uuid) from public;
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.calendar_claim_sync(uuid, integer)',
    'public.calendar_due_work(integer, boolean)',
    'public.calendar_store_access_token(uuid, uuid, text, timestamptz, integer)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
revoke all on function public.calendar_set_blocking(uuid, uuid[]) from public, anon;
grant execute on function public.calendar_set_blocking(uuid, uuid[]) to authenticated;
