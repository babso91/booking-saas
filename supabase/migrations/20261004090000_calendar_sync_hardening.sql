-- Calendar sync hardening (audit of PR #10 at 08a8013).
--
-- 1. Connection incarnation. calendar_connections.credential_generation
--    changes every time the credential set is replaced (connection,
--    reconnection, disconnection). Every remote operation captures it
--    first; every later write checks it atomically, so a late answer of a
--    former account (token refresh, invalid_grant, calendar list, sync) is a
--    no-op instead of mixing account A's data into account B.
-- 2. Sync claims. A worker's authority is a claim id issued when it claims
--    a calendar, not the lease time: every write of a sync (page, cursor,
--    finish, reset, release, channel) requires the current claim. The lease
--    only lets a new worker take over; once it has, the former worker can
--    no longer write anything. Reconnection, disconnection, deselection and
--    a calendar time zone change revoke claims.
-- 3. Full sync generations are never reused. A full sync resumes its own
--    attempt only when it really continues its pagination; any restart
--    from page 1 gets a new generation, so the final sweep removes what the
--    abandoned attempt imported.
-- 4. The calendar time zone is part of the synced snapshot: all-day events
--    are read in it. When the provider reports another zone (calendar list
--    or events page), the zone is updated, the cursor dropped and a full
--    sync with a new generation re-projects every all-day event.
-- 5. Cron fairness: per-calendar backoff (next_attempt_at, failure_count)
--    and round-robin order (least recently attempted first, last_attempt_at):
--    failing or slow calendars never monopolise the job.
-- 6. Calendars a provider only shares as free/busy cannot be selected (the
--    events they would expose are not readable): calendar_not_selectable.
-- 7. Reconnection is refused while the remote revocation of the previous
--    credentials may still be running (it would revoke the new grant).
-- 8. Conflicts use the appointment's occupied window (buffer included), the
--    very window availability uses.
--
-- Sync status of a blocking calendar:
--   pending     selected, never synced (no busy period known yet)
--   syncing     a worker holds the claim
--   synced      last pass complete; the cursor matches the local copy
--   stale       copy kept, but known to be behind (time zone changed, pass
--               interrupted by its time budget); a full sync is due
--   error       last pass failed (provider down, protocol error…); the
--               previous copy is kept and keeps blocking
--   incomplete  the calendar exceeds the bounded sync; the previous copy
--               plus what was read keeps blocking, never swept
-- Availability always uses the busy periods known locally, whatever the
-- status: it never empties the copy because a pass failed. It does not
-- cover events the sync could not read.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.calendar_connections
  add column credential_generation uuid not null default gen_random_uuid(),
  add column revocation_pending_until timestamptz;

alter table private.external_calendar_sync
  add column claim_id uuid,
  add column allocated_generation bigint not null default 0,
  add column next_attempt_at timestamptz,
  add column last_attempt_at timestamptz,
  add column failure_count integer not null default 0;

alter table public.external_calendars
  drop constraint external_calendars_sync_status_check;
update public.external_calendars set sync_status = 'synced' where sync_status = 'idle';
alter table public.external_calendars
  alter column sync_status set default 'pending',
  add constraint external_calendars_sync_status_check
    check (sync_status in ('pending', 'syncing', 'synced', 'stale', 'error', 'incomplete'));

-- ---------------------------------------------------------------------------
-- Functions replaced with a new signature
-- ---------------------------------------------------------------------------

drop function public.calendar_save_calendars(uuid, jsonb);
drop function public.calendar_read_secrets(uuid);
drop function public.calendar_store_access_token(uuid, text, timestamptz);
drop function public.calendar_mark_reauth_required(uuid, text);
drop function public.calendar_disconnect(uuid);
drop function public.calendar_start_full_sync(uuid);
drop function public.calendar_apply_events(uuid, bigint, jsonb, text);
drop function public.calendar_finish_full_sync(uuid, bigint, text);
drop function public.calendar_finish_incremental_sync(uuid, text);
drop function public.calendar_reset_sync(uuid);
drop function public.calendar_release_sync(uuid, text);
drop function public.calendar_record_channel(uuid, uuid, text, text, timestamptz);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Access roles whose events can be listed (a freeBusyReader cannot).
create function private.is_selectable_role(p_role text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_role, 'reader') in ('owner', 'writer', 'reader');
$$;

-- The sync row of a calendar, locked, if p_claim_id is its current claim
-- and the calendar still blocks for an active connection; null otherwise
-- (the caller is a former worker: it must write nothing).
create function private.claimed_sync(p_calendar_id uuid, p_claim_id uuid)
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

-- Drops the cursor and any full sync attempt, and revokes the claim: the
-- next pass is a full sync with a new generation.
create function private.invalidate_sync(p_calendar_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  update private.external_calendar_sync
  set sync_token = null,
      full_generation = null,
      full_page_token = null,
      full_window_start = null,
      full_window_end = null,
      full_started_at = null,
      claim_id = null,
      lease_until = null,
      next_attempt_at = null
  where calendar_id = p_calendar_id;
$$;

-- Upserts the calendar list of a connection (caller holds the schedule
-- lock). A calendar whose zone changed is re-projected: its sync is
-- invalidated and marked stale. Calendars that disappeared are removed with
-- their busy periods.
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
  v_changed uuid;
begin
  if p_calendars is null or pg_catalog.jsonb_typeof(p_calendars) <> 'array'
    or pg_catalog.jsonb_array_length(p_calendars) > 250 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'calendars';
  end if;

  for v_changed in
    select c.id
    from public.external_calendars c
    join pg_catalog.jsonb_array_elements(p_calendars) item
      on item->>'id' = c.provider_calendar_id
    where c.connection_id = p_connection_id
      and private.is_known_timezone(item->>'timezone')
      and c.timezone is distinct from item->>'timezone'
      and c.selected_for_blocking
  loop
    perform private.invalidate_sync(v_changed);
    update public.external_calendars set sync_status = 'stale' where id = v_changed;
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

  -- A calendar now only shared as free/busy stops blocking: its events
  -- cannot be listed any more.
  delete from public.external_calendar_events e
  using public.external_calendars c
  where e.external_calendar_id = c.id
    and c.connection_id = p_connection_id
    and not private.is_selectable_role(c.access_role);
  delete from private.external_calendar_sync s
  using public.external_calendars c
  where s.calendar_id = c.id
    and c.connection_id = p_connection_id
    and not private.is_selectable_role(c.access_role);
  update public.external_calendars c
  set selected_for_blocking = false, sync_status = 'pending'
  where c.connection_id = p_connection_id
    and c.selected_for_blocking
    and not private.is_selectable_role(c.access_role);

  delete from public.external_calendars c
  where c.connection_id = p_connection_id
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_calendars) item
      where item->>'id' = c.provider_calendar_id
    );
end;
$$;

create or replace function private.mark_synced(p_calendar_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  update public.external_calendars
  set sync_status = 'synced', last_synced_at = pg_catalog.now(), last_error = null
  where id = p_calendar_id;
  update public.calendar_connections k
  set last_synced_at = pg_catalog.now(), last_error = null
  from public.external_calendars c
  where c.id = p_calendar_id and k.id = c.connection_id and k.status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- Connection lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.calendar_save_connection(
  p_business_id uuid,
  p_user_id uuid,
  p_provider text,
  p_provider_account_id text,
  p_account_email text,
  p_scopes text[],
  p_refresh_token_ciphertext text,
  p_access_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_calendars jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing public.calendar_connections;
  v_id uuid;
  v_same_account boolean;
begin
  if not exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.user_id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_provider is distinct from 'google' or p_provider_account_id is null then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  perform private.lock_business_schedule(p_business_id);

  select c.* into v_existing
  from public.calendar_connections c
  where c.business_id = p_business_id and c.provider = p_provider
  for update;

  -- The revocation of the previous credentials may still be running at
  -- the provider: a grant obtained meanwhile could be revoked with it.
  if v_existing.revocation_pending_until > pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'calendar_disconnect_in_progress';
  end if;

  v_same_account := v_existing.id is not null
    and v_existing.status <> 'disconnected'
    and v_existing.provider_account_id = p_provider_account_id;

  if p_refresh_token_ciphertext is null and not (
    v_same_account and exists (
      select 1 from private.calendar_secrets s where s.connection_id = v_existing.id
    )
  ) then
    raise exception using errcode = 'P0001', message = 'calendar_refresh_token_missing';
  end if;

  if v_existing.id is null then
    insert into public.calendar_connections (
      business_id, provider, provider_account_id, account_email, status,
      scopes, connected_by
    )
    values (
      p_business_id, p_provider, p_provider_account_id, p_account_email,
      'active', coalesce(p_scopes, '{}'), p_user_id
    )
    returning id into v_id;
  else
    v_id := v_existing.id;

    if not v_same_account then
      delete from public.external_calendars c where c.connection_id = v_id;
    end if;

    -- New incarnation: every operation started with the former
    -- credentials becomes a no-op.
    update public.calendar_connections c
    set provider_account_id = p_provider_account_id,
        account_email = p_account_email,
        status = 'active',
        scopes = coalesce(p_scopes, '{}'),
        connected_by = p_user_id,
        last_error = null,
        credential_generation = gen_random_uuid(),
        revocation_pending_until = null
    where c.id = v_id;
  end if;

  if p_refresh_token_ciphertext is null then
    update private.calendar_secrets s
    set access_token_ciphertext = p_access_token_ciphertext,
        access_token_expires_at = p_access_token_expires_at,
        updated_at = pg_catalog.now()
    where s.connection_id = v_id;
  else
    insert into private.calendar_secrets (
      connection_id, refresh_token_ciphertext, access_token_ciphertext,
      access_token_expires_at
    )
    values (
      v_id, p_refresh_token_ciphertext, p_access_token_ciphertext,
      p_access_token_expires_at
    )
    on conflict (connection_id) do update
    set refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        access_token_ciphertext = excluded.access_token_ciphertext,
        access_token_expires_at = excluded.access_token_expires_at,
        updated_at = pg_catalog.now();
  end if;

  perform private.save_calendars(v_id, p_business_id, p_calendars);

  -- Selected calendars of a reconnected account: full sync again, claims
  -- of workers started with the former credentials revoked.
  perform private.invalidate_sync(c.id)
  from public.external_calendars c
  where c.connection_id = v_id;
  update public.external_calendars c
  set sync_status = 'pending'
  where c.connection_id = v_id and c.selected_for_blocking;

  return v_id;
end;
$$;

-- Refreshes the calendar list, only for the incarnation that read it.
-- Returns false for a late answer of former credentials (nothing written).
create function public.calendar_save_calendars(
  p_connection_id uuid,
  p_generation uuid,
  p_calendars jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_business_id uuid;
begin
  select c.business_id into v_business_id
  from public.calendar_connections c
  where c.id = p_connection_id;
  if v_business_id is null then
    return false;
  end if;

  perform private.lock_business_schedule(v_business_id);

  perform 1 from public.calendar_connections c
  where c.id = p_connection_id
    and c.status = 'active'
    and c.credential_generation = p_generation
  for update;
  if not found then
    return false;
  end if;

  perform private.save_calendars(p_connection_id, v_business_id, p_calendars);
  return true;
end;
$$;

create function public.calendar_read_secrets(p_connection_id uuid)
returns table (
  business_id uuid,
  provider text,
  status text,
  credential_generation uuid,
  refresh_token_ciphertext text,
  access_token_ciphertext text,
  access_token_expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.business_id, c.provider, c.status, c.credential_generation,
         s.refresh_token_ciphertext, s.access_token_ciphertext,
         s.access_token_expires_at
  from public.calendar_connections c
  join private.calendar_secrets s on s.connection_id = c.id
  where c.id = p_connection_id;
$$;

-- Stores a refreshed access token, only for the incarnation that refreshed.
create function public.calendar_store_access_token(
  p_connection_id uuid,
  p_generation uuid,
  p_access_token_ciphertext text,
  p_access_token_expires_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update private.calendar_secrets s
  set access_token_ciphertext = p_access_token_ciphertext,
      access_token_expires_at = p_access_token_expires_at,
      updated_at = pg_catalog.now()
  where s.connection_id = p_connection_id
    and exists (
      select 1 from public.calendar_connections c
      where c.id = p_connection_id
        and c.status = 'active'
        and c.credential_generation = p_generation
    );
  return found;
end;
$$;

-- Rewrites both secrets under the current key (lazy re-encryption after a
-- key rotation), only for the incarnation that read them.
create function public.calendar_reencrypt_secrets(
  p_connection_id uuid,
  p_generation uuid,
  p_refresh_token_ciphertext text,
  p_access_token_ciphertext text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update private.calendar_secrets s
  set refresh_token_ciphertext = p_refresh_token_ciphertext,
      access_token_ciphertext = p_access_token_ciphertext,
      updated_at = pg_catalog.now()
  where s.connection_id = p_connection_id
    and exists (
      select 1 from public.calendar_connections c
      where c.id = p_connection_id and c.credential_generation = p_generation
    );
  return found;
end;
$$;

-- invalid_grant for the incarnation that met it (never for a newer one).
create function public.calendar_mark_reauth_required(
  p_connection_id uuid,
  p_generation uuid,
  p_error text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.calendar_connections
  set status = 'reauth_required',
      last_error = pg_catalog.left(p_error, 64)
  where id = p_connection_id
    and status = 'active'
    and credential_generation = p_generation;
  if not found then
    return false;
  end if;
  update private.calendar_secrets
  set access_token_ciphertext = null, access_token_expires_at = null
  where connection_id = p_connection_id;
  return true;
end;
$$;

-- Disconnects locally (see 20261003090000), for the given incarnation, and
-- starts a new one (so every pending operation of the former credentials
-- becomes a no-op). Reconnection is refused for two minutes, the time the
-- server has to revoke the former grant (calendar_revocation_done ends it
-- earlier).
create function public.calendar_disconnect(
  p_connection_id uuid,
  p_generation uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.calendar_connections;
  v_result jsonb;
  v_generation uuid := gen_random_uuid();
begin
  select c.* into v_connection
  from public.calendar_connections c
  where c.id = p_connection_id;

  if v_connection.id is null or v_connection.status = 'disconnected' then
    return null;
  end if;

  perform private.lock_business_schedule(v_connection.business_id);

  select c.* into v_connection
  from public.calendar_connections c
  where c.id = p_connection_id
  for update;
  if v_connection.status = 'disconnected'
    or v_connection.credential_generation <> p_generation then
    return null;
  end if;

  select pg_catalog.jsonb_build_object(
    'provider', v_connection.provider,
    'generation', v_generation,
    'refreshTokenCiphertext', s.refresh_token_ciphertext,
    'accessTokenCiphertext', s.access_token_ciphertext,
    'accessTokenExpiresAt', s.access_token_expires_at,
    'channels', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'channelId', y.channel_id,
        'resourceId', y.channel_resource_id
      )), '[]'::jsonb)
      from public.external_calendars c
      join private.external_calendar_sync y on y.calendar_id = c.id
      where c.connection_id = p_connection_id
        and y.channel_id is not null
    )
  )
  into v_result
  from private.calendar_secrets s
  where s.connection_id = p_connection_id;

  delete from public.external_calendars c where c.connection_id = p_connection_id;
  delete from private.calendar_secrets s where s.connection_id = p_connection_id;

  update public.calendar_connections
  set status = 'disconnected',
      last_error = null,
      credential_generation = v_generation,
      revocation_pending_until = case
        when v_result ? 'refreshTokenCiphertext'
          then pg_catalog.now() + interval '2 minutes'
      end
  where id = p_connection_id;

  return coalesce(v_result, pg_catalog.jsonb_build_object(
    'provider', v_connection.provider, 'generation', v_generation, 'channels', '[]'::jsonb
  ));
end;
$$;

-- The server finished (or gave up) revoking the disconnected credentials.
create function public.calendar_revocation_done(
  p_connection_id uuid,
  p_generation uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.calendar_connections
  set revocation_pending_until = null
  where id = p_connection_id
    and credential_generation = p_generation
    and status = 'disconnected';
$$;

-- ---------------------------------------------------------------------------
-- Selection (signed-in professional)
-- ---------------------------------------------------------------------------

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
    where c.id = any (v_ids) and not private.is_selectable_role(c.access_role)
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

  delete from public.external_calendar_events e
  using public.external_calendars c
  where e.external_calendar_id = c.id
    and c.connection_id = v_connection.id
    and c.selected_for_blocking
    and not (c.id = any (v_ids));

  -- Deleting the sync row also revokes its claim: a worker of the former
  -- selection can no longer write, even after a reselection.
  delete from private.external_calendar_sync s
  using public.external_calendars c
  where s.calendar_id = c.id
    and c.connection_id = v_connection.id
    and c.selected_for_blocking
    and not (c.id = any (v_ids));

  update public.external_calendars c
  set selected_for_blocking = false, sync_status = 'pending', last_error = null
  where c.connection_id = v_connection.id
    and c.selected_for_blocking
    and not (c.id = any (v_ids));

  update public.external_calendars c
  set selected_for_blocking = true, sync_status = 'pending', last_error = null
  where c.connection_id = v_connection.id
    and not c.selected_for_blocking
    and c.id = any (v_ids);

  insert into private.external_calendar_sync (calendar_id)
  select c.id
  from public.external_calendars c
  where c.connection_id = v_connection.id
    and c.selected_for_blocking
  on conflict (calendar_id) do nothing;

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

-- Conflicts on the appointment's occupied window (end + buffer), the very
-- window public availability protects.
create or replace function public.calendar_conflicts(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  appointment_id uuid,
  appointment_starts_at timestamptz,
  appointment_ends_at timestamptz,
  external_calendar_id uuid,
  event_starts_at timestamptz,
  event_ends_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_agenda_access(p_business_id);

  if p_from is null or p_to is null or p_to <= p_from
    or p_to - p_from > interval '400 days' then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  return query
  select a.id, a.starts_at, a.ends_at, e.external_calendar_id, e.starts_at, e.ends_at
  from public.appointments a
  join public.external_calendar_events e
    on e.business_id = a.business_id
   and e.busy
   and e.busy_window && a.occupied_window
  where a.business_id = p_business_id
    and a.status <> 'cancelled'
    and a.starts_at < p_to
    and a.ends_at > p_from
  order by a.starts_at, e.starts_at
  limit 200;
end;
$$;

-- ---------------------------------------------------------------------------
-- Synchronisation: claims
-- ---------------------------------------------------------------------------

-- Claims a calendar: a new claim id when no live lease exists. The lease
-- only allows a takeover; the claim id is the write authority.
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

-- Starts a full sync, or resumes the claimant's own interrupted attempt
-- when it really continues its pagination (a saved page cursor, less than
-- an hour old). Any restart from page 1 gets a new, never used generation.
create function public.calendar_start_full_sync(
  p_calendar_id uuid,
  p_claim_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sync private.external_calendar_sync;
  v_generation bigint;
begin
  v_sync := private.claimed_sync(p_calendar_id, p_claim_id);
  if v_sync.calendar_id is null then
    return null;
  end if;

  if v_sync.full_generation is null
    or v_sync.full_page_token is null
    or v_sync.full_started_at < pg_catalog.now() - interval '1 hour' then
    v_generation := greatest(
      v_sync.allocated_generation, v_sync.generation, coalesce(v_sync.full_generation, 0)
    ) + 1;
    update private.external_calendar_sync s
    set allocated_generation = v_generation,
        full_generation = v_generation,
        full_page_token = null,
        full_window_start = pg_catalog.date_trunc('minute', pg_catalog.now()) - interval '1 day',
        full_window_end = pg_catalog.date_trunc('minute', pg_catalog.now()) + interval '400 days',
        full_started_at = pg_catalog.now()
    where s.calendar_id = p_calendar_id
    returning s.* into v_sync;
  end if;

  return pg_catalog.jsonb_build_object(
    'generation', v_sync.full_generation,
    'pageToken', v_sync.full_page_token,
    'windowStart', v_sync.full_window_start,
    'windowEnd', v_sync.full_window_end
  );
end;
$$;

-- Applies one page under the schedule lock, for the current claim only.
-- p_provider_timezone: the calendar zone the provider reported with the
-- page; if it differs from the stored one, nothing is applied, the zone is
-- updated and the sync invalidated (all-day events must be re-projected by
-- a full sync): `timezoneChanged`.
create function public.calendar_apply_events(
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
  v_generation bigint;
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_event jsonb;
  v_id text;
  v_zone text;
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

  if private.is_known_timezone(p_provider_timezone)
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

  select b.timezone into v_timezone
  from public.businesses b where b.id = v_calendar.business_id;
  v_timezone := coalesce(v_calendar.timezone, v_timezone);

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

    begin
      v_updated := (v_event->>'updated')::timestamptz;
      if v_event->'start' ? 'date' then
        v_all_day := true;
        v_zone := case
          when private.is_known_timezone(v_event->'start'->>'timeZone')
            then v_event->'start'->>'timeZone'
          else v_timezone
        end;
        v_starts := private.local_day_start((v_event->'start'->>'date')::date, v_zone);
        v_ends := private.local_day_start((v_event->'end'->>'date')::date, v_zone);
      else
        v_all_day := false;
        v_starts := private.provider_instant(
          v_event->'start'->>'dateTime',
          case when private.is_known_timezone(v_event->'start'->>'timeZone')
            then v_event->'start'->>'timeZone' else v_timezone end
        );
        v_ends := private.provider_instant(
          v_event->'end'->>'dateTime',
          case when private.is_known_timezone(v_event->'end'->>'timeZone')
            then v_event->'end'->>'timeZone' else v_timezone end
        );
      end if;
    exception
      when others then
        v_starts := null;
    end;

    -- An event the database cannot read is a protocol error for the whole
    -- page: never silently dropped (it may be busy).
    if v_starts is null or v_ends is null then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'events';
    end if;

    v_busy := coalesce(v_event->>'transparency', 'opaque') <> 'transparent'
      and not coalesce((v_event->>'declined')::boolean, false)
      and coalesce(v_event->>'eventType', 'default') not in ('workingLocation', 'birthday');

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
      provider_etag, provider_updated_at, sync_generation
    )
    values (
      v_calendar.business_id, p_calendar_id, v_id,
      nullif(pg_catalog.left(v_event->>'recurringEventId', 1024), ''),
      v_starts, v_ends, v_all_day, v_busy,
      pg_catalog.left(v_event->>'etag', 256), v_updated, v_generation
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

-- Ends the claimant's full sync: sweep of every older generation (including
-- abandoned attempts), new cursor and window committed. Requires a cursor.
create function public.calendar_finish_full_sync(
  p_calendar_id uuid,
  p_claim_id uuid,
  p_generation bigint,
  p_sync_token text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_calendar public.external_calendars;
  v_sync private.external_calendar_sync;
begin
  if p_sync_token is null or p_sync_token = '' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'syncToken';
  end if;

  select c.* into v_calendar from public.external_calendars c where c.id = p_calendar_id;
  if v_calendar.id is null then
    return false;
  end if;

  perform private.lock_business_schedule(v_calendar.business_id);

  v_sync := private.claimed_sync(p_calendar_id, p_claim_id);
  if v_sync.calendar_id is null or v_sync.full_generation is distinct from p_generation then
    return false;
  end if;

  delete from public.external_calendar_events e
  where e.external_calendar_id = p_calendar_id
    and e.sync_generation < p_generation;

  update private.external_calendar_sync s
  set generation = p_generation,
      sync_token = p_sync_token,
      window_start = s.full_window_start,
      window_end = s.full_window_end,
      full_generation = null,
      full_page_token = null,
      full_window_start = null,
      full_window_end = null,
      full_started_at = null
  where s.calendar_id = p_calendar_id;

  perform private.mark_synced(p_calendar_id);
  return true;
end;
$$;

-- Ends the claimant's incremental sync with the provider's new cursor.
create function public.calendar_finish_incremental_sync(
  p_calendar_id uuid,
  p_claim_id uuid,
  p_sync_token text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_calendar public.external_calendars;
  v_sync private.external_calendar_sync;
begin
  if p_sync_token is null or p_sync_token = '' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'syncToken';
  end if;

  select c.* into v_calendar from public.external_calendars c where c.id = p_calendar_id;
  if v_calendar.id is null then
    return false;
  end if;

  perform private.lock_business_schedule(v_calendar.business_id);

  v_sync := private.claimed_sync(p_calendar_id, p_claim_id);
  if v_sync.calendar_id is null or v_sync.full_generation is not null
    or v_sync.sync_token is null then
    return false;
  end if;

  update private.external_calendar_sync s
  set sync_token = p_sync_token
  where s.calendar_id = p_calendar_id;
  perform private.mark_synced(p_calendar_id);
  return true;
end;
$$;

-- Cursor rejected (410) or incremental too long: the claimant drops it;
-- its next full sync gets a new generation.
create function public.calendar_reset_sync(p_calendar_id uuid, p_claim_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sync private.external_calendar_sync;
begin
  v_sync := private.claimed_sync(p_calendar_id, p_claim_id);
  if v_sync.calendar_id is null then
    return false;
  end if;
  update private.external_calendar_sync
  set sync_token = null,
      full_generation = null,
      full_page_token = null,
      full_window_start = null,
      full_window_end = null,
      full_started_at = null
  where calendar_id = p_calendar_id;
  return true;
end;
$$;

-- Releases the claimant's claim and records the outcome:
--   synced                  (status already set by finish)
--   error / incomplete      status set, retried with exponential backoff
--   stale                   time budget exceeded: retried at the next job
--   skipped                 nothing recorded
-- A former worker (claim no longer current) releases nothing.
-- Returns true when another request arrived meanwhile (run once more).
create function public.calendar_release_sync(
  p_calendar_id uuid,
  p_claim_id uuid,
  p_outcome text,
  p_error text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sync private.external_calendar_sync;
  v_business_id uuid;
begin
  select c.business_id into v_business_id
  from public.external_calendars c where c.id = p_calendar_id;
  if v_business_id is null then
    return false;
  end if;
  perform private.lock_business_schedule(v_business_id);

  select s.* into v_sync
  from private.external_calendar_sync s
  where s.calendar_id = p_calendar_id and s.claim_id = p_claim_id
  for update;
  if v_sync.calendar_id is null then
    return false;
  end if;

  update private.external_calendar_sync s
  set lease_until = null,
      claim_id = null,
      resync_requested = false,
      failure_count = case when p_outcome in ('error', 'incomplete')
                           then s.failure_count + 1 else 0 end,
      next_attempt_at = case
        when p_outcome in ('error', 'incomplete') then pg_catalog.now()
          + least(interval '6 hours', interval '5 minutes' * pg_catalog.power(2, least(s.failure_count, 10)))
        else null
      end
  where s.calendar_id = p_calendar_id;

  if p_outcome in ('error', 'incomplete', 'stale') then
    update public.external_calendars
    set sync_status = p_outcome, last_error = pg_catalog.left(p_error, 64)
    where id = p_calendar_id;
    update public.calendar_connections k
    set last_error = pg_catalog.left(p_error, 64)
    from public.external_calendars c
    where c.id = p_calendar_id and k.id = c.connection_id and p_error is not null;
  elsif p_outcome = 'skipped' then
    update public.external_calendars
    set sync_status = case when sync_status = 'syncing' then 'stale' else sync_status end
    where id = p_calendar_id;
  end if;

  return v_sync.resync_requested and p_outcome = 'synced';
end;
$$;

-- Records the claimant's new channel; returns the previous one (to stop),
-- or the new one flagged orphan when the claim is no longer current.
create function public.calendar_record_channel(
  p_calendar_id uuid,
  p_claim_id uuid,
  p_channel_id uuid,
  p_resource_id text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sync private.external_calendar_sync;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  v_sync := private.claimed_sync(p_calendar_id, p_claim_id);
  if v_sync.calendar_id is null then
    return pg_catalog.jsonb_build_object(
      'channelId', p_channel_id, 'resourceId', p_resource_id, 'orphan', true);
  end if;

  update private.external_calendar_sync s
  set channel_id = p_channel_id,
      channel_resource_id = p_resource_id,
      channel_token_hash = p_token_hash,
      channel_expires_at = p_expires_at
  where s.calendar_id = p_calendar_id;

  if v_sync.channel_id is null then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'channelId', v_sync.channel_id, 'resourceId', v_sync.channel_resource_id);
end;
$$;

-- Due work, fair: calendars in backoff wait their turn (next_attempt_at),
-- and the least recently attempted come first (round robin), so failing or
-- slow calendars never starve healthy ones.
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

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function private.is_selectable_role(text) from public;
revoke all on function private.claimed_sync(uuid, uuid) from public;
revoke all on function private.invalidate_sync(uuid) from public;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.calendar_save_connection(uuid, uuid, text, text, text, text[], text, text, timestamptz, jsonb)',
    'public.calendar_save_calendars(uuid, uuid, jsonb)',
    'public.calendar_read_secrets(uuid)',
    'public.calendar_store_access_token(uuid, uuid, text, timestamptz)',
    'public.calendar_reencrypt_secrets(uuid, uuid, text, text)',
    'public.calendar_mark_reauth_required(uuid, uuid, text)',
    'public.calendar_disconnect(uuid, uuid)',
    'public.calendar_revocation_done(uuid, uuid)',
    'public.calendar_claim_sync(uuid, integer)',
    'public.calendar_start_full_sync(uuid, uuid)',
    'public.calendar_apply_events(uuid, uuid, bigint, text, jsonb, text)',
    'public.calendar_finish_full_sync(uuid, uuid, bigint, text)',
    'public.calendar_finish_incremental_sync(uuid, uuid, text)',
    'public.calendar_reset_sync(uuid, uuid)',
    'public.calendar_release_sync(uuid, uuid, text, text)',
    'public.calendar_record_channel(uuid, uuid, uuid, text, text, timestamptz)',
    'public.calendar_due_work(integer, boolean)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

revoke all on function public.calendar_set_blocking(uuid, uuid[]) from public, anon;
grant execute on function public.calendar_set_blocking(uuid, uuid[]) to authenticated;
revoke all on function public.calendar_conflicts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.calendar_conflicts(uuid, timestamptz, timestamptz) to authenticated;
