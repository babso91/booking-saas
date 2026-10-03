-- Calendar sync hardening, second round (audit of PR #10 at 19b2191).
--
-- 1. Time zone change without under-blocking. All-day events keep their
--    civil dates (and their own zone, when the provider gave one). When the
--    calendar zone changes, every all-day period that followed the calendar
--    zone is re-projected in the new zone in the same transaction that
--    records the change, under the schedule lock: there is no moment where
--    a booking can see the former projection only. The full sync that
--    follows confirms the copy. Timed events carry an instant (offset or
--    their own zone) and never move.
-- 2. Credential writes are compare-and-set on the secrets row itself
--    (calendar_secrets.credential_generation, secret_version), after a
--    shared lock on the connection row: a writer of a former incarnation
--    waiting on a lock re-checks the committed row and writes nothing.
--    A re-encryption of stale ciphertexts loses against a token refresh
--    (secret_version), never the reverse.
-- 3. Remote revocation is authorised by the disconnection itself:
--    revocation_authorized_until is fixed when the disconnection commits
--    (one minute), reconnection stays refused one more minute
--    (revocation_pending_until), and calendar_begin_revocation re-checks
--    atomically, right before the provider call, that the disconnection is
--    still the current incarnation and the window still open.
-- 4. A provider event whose interval is empty or inverted, or whose bounds
--    disagree, rejects the whole page (never deleted, never non-busy). An
--    all-day civil date that does not exist locally (Apia 2011-12-30) keeps
--    its policy: it occupies no time.
-- 5. A calendar counts as protecting only after its first complete sync
--    (last_synced_at is reset when it is deselected).
--
-- Lock order:
--   1. schedule lock of the business (advisory, business_schedule:<id>)
--   2. calendar_connections row
--   3. private.calendar_secrets row
--   4.–6. external_calendars, private.external_calendar_sync,
--         external_calendar_events rows
-- Rules: 1 always comes first; 2 always precedes 3. A transaction without
-- the schedule lock takes 2 then 3 only (token refresh, re-encryption,
-- invalid_grant) or one sync row only (claim-checked start/reset/channel
-- writes), and waits for nothing after that. Rows 4–6, and the updates of a
-- connection row at the end of a pass (last_synced_at, last_error), are only
-- written under the schedule lock, which serialises those transactions per
-- business. Hence no two transactions can wait on each other in a cycle.

-- Full sync attempt vs claim: the generation identifies the logical
-- attempt (its window and page cursor are persisted); any worker holding
-- the current claim may resume it while it is younger than an hour. The
-- claim only protects the writes of the current pass.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.calendar_connections
  add column revocation_authorized_until timestamptz;

alter table private.calendar_secrets
  add column credential_generation uuid,
  add column secret_version bigint not null default 1;

update private.calendar_secrets s
set credential_generation = c.credential_generation
from public.calendar_connections c
where c.id = s.connection_id;

alter table private.calendar_secrets
  alter column credential_generation set not null;

alter table public.external_calendar_events
  add column all_day_start_date date,
  add column all_day_end_date date,
  add column all_day_zone text;

-- Existing all-day rows: their UTC busy window is the only certain data;
-- the civil dates and the zone they were projected in were not stored and
-- cannot be reconstructed reliably (an event may have had its own zone).
-- They are kept exactly as they are, with unknown civil dates (null), and
-- every calendar holding one is invalidated: its next full sync replaces
-- them with canonical rows (civil dates from Google). Nothing is deleted.
-- (Corrected before merge: an earlier version of this migration rebuilt
-- the dates in the calendar zone and could delete valid busy periods. It
-- only ever ran locally and on ephemeral CI databases; a development
-- database that applied it must be reset. That version is not supported.)
do $$
declare
  v_calendar uuid;
begin
  for v_calendar in
    select distinct e.external_calendar_id
    from public.external_calendar_events e
    where e.all_day
    order by 1
  loop
    update public.external_calendars set sync_status = 'stale' where id = v_calendar;
    perform private.invalidate_sync(v_calendar);
  end loop;
end;
$$;

alter table public.external_calendar_events
  add constraint external_calendar_events_all_day_dates check (
    not all_day
    or (all_day_start_date is null and all_day_end_date is null)
    or (all_day_start_date is not null
        and all_day_end_date is not null
        and all_day_end_date > all_day_start_date)
  );

-- ---------------------------------------------------------------------------
-- Functions replaced with a new signature
-- ---------------------------------------------------------------------------

drop function public.calendar_read_secrets(uuid);
drop function public.calendar_reencrypt_secrets(uuid, uuid, text, text);

-- ---------------------------------------------------------------------------
-- Time zone re-projection
-- ---------------------------------------------------------------------------

-- Re-projects the calendar's all-day periods that follow the calendar zone
-- (not those with their own zone) into p_zone. Caller holds the schedule
-- lock. A civil day that does not exist in p_zone occupies no time.
create function private.reproject_all_day(p_calendar_id uuid, p_zone text)
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
end;
$$;

-- Calendar list upsert (caller holds the schedule lock). A selected
-- calendar whose zone changed is re-projected at once, then invalidated:
-- the busy periods it exposes are always those of the new zone.
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
  v_generation uuid := gen_random_uuid();
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

  -- 1. schedule lock, 2. connection row.
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
      scopes, connected_by, credential_generation
    )
    values (
      p_business_id, p_provider, p_provider_account_id, p_account_email,
      'active', coalesce(p_scopes, '{}'), p_user_id, v_generation
    )
    returning id into v_id;
  else
    v_id := v_existing.id;
    -- New incarnation: every operation started with the former
    -- credentials becomes a no-op.
    update public.calendar_connections c
    set provider_account_id = p_provider_account_id,
        account_email = p_account_email,
        status = 'active',
        scopes = coalesce(p_scopes, '{}'),
        connected_by = p_user_id,
        last_error = null,
        credential_generation = v_generation,
        revocation_pending_until = null,
        revocation_authorized_until = null
    where c.id = v_id;
  end if;

  -- 3. secrets, stamped with the new incarnation.
  if p_refresh_token_ciphertext is null then
    update private.calendar_secrets s
    set access_token_ciphertext = p_access_token_ciphertext,
        access_token_expires_at = p_access_token_expires_at,
        credential_generation = v_generation,
        secret_version = s.secret_version + 1,
        updated_at = pg_catalog.now()
    where s.connection_id = v_id;
  else
    insert into private.calendar_secrets (
      connection_id, refresh_token_ciphertext, access_token_ciphertext,
      access_token_expires_at, credential_generation
    )
    values (
      v_id, p_refresh_token_ciphertext, p_access_token_ciphertext,
      p_access_token_expires_at, v_generation
    )
    on conflict (connection_id) do update
    set refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        access_token_ciphertext = excluded.access_token_ciphertext,
        access_token_expires_at = excluded.access_token_expires_at,
        credential_generation = excluded.credential_generation,
        secret_version = private.calendar_secrets.secret_version + 1,
        updated_at = pg_catalog.now();
  end if;

  -- 4.–6. calendars, sync rows, events.
  if v_existing.id is not null and not v_same_account then
    delete from public.external_calendars c where c.connection_id = v_id;
  end if;

  perform private.save_calendars(v_id, p_business_id, p_calendars);

  update public.external_calendars c
  set sync_status = 'pending'
  where c.connection_id = v_id and c.selected_for_blocking;
  perform private.invalidate_sync(c.id)
  from public.external_calendars c
  where c.connection_id = v_id
  order by c.id;

  return v_id;
end;
$$;

create function public.calendar_read_secrets(p_connection_id uuid)
returns table (
  business_id uuid,
  provider text,
  status text,
  credential_generation uuid,
  secret_version bigint,
  refresh_token_ciphertext text,
  access_token_ciphertext text,
  access_token_expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.business_id, c.provider, c.status, s.credential_generation,
         s.secret_version, s.refresh_token_ciphertext,
         s.access_token_ciphertext, s.access_token_expires_at
  from public.calendar_connections c
  join private.calendar_secrets s
    on s.connection_id = c.id
   and s.credential_generation = c.credential_generation
  where c.id = p_connection_id;
$$;

-- Stores a refreshed access token for the incarnation that refreshed it:
-- shared lock on the connection (re-read after any wait), then
-- compare-and-set on the secrets row itself.
create or replace function public.calendar_store_access_token(
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
declare
  v_connection public.calendar_connections;
begin
  select c.* into v_connection
  from public.calendar_connections c
  where c.id = p_connection_id
  for share;
  if v_connection.id is null
    or v_connection.status <> 'active'
    or v_connection.credential_generation <> p_generation then
    return false;
  end if;

  update private.calendar_secrets s
  set access_token_ciphertext = p_access_token_ciphertext,
      access_token_expires_at = p_access_token_expires_at,
      secret_version = s.secret_version + 1,
      updated_at = pg_catalog.now()
  where s.connection_id = p_connection_id
    and s.credential_generation = p_generation;
  return found;
end;
$$;

-- Lazy re-encryption under the current key, only if the secrets are still
-- exactly those that were read (incarnation and version): a token refreshed
-- meanwhile is never replaced by the former one.
create function public.calendar_reencrypt_secrets(
  p_connection_id uuid,
  p_generation uuid,
  p_secret_version bigint,
  p_refresh_token_ciphertext text,
  p_access_token_ciphertext text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.calendar_connections;
begin
  select c.* into v_connection
  from public.calendar_connections c
  where c.id = p_connection_id
  for share;
  if v_connection.id is null
    or v_connection.credential_generation <> p_generation then
    return false;
  end if;

  update private.calendar_secrets s
  set refresh_token_ciphertext = p_refresh_token_ciphertext,
      access_token_ciphertext = p_access_token_ciphertext,
      secret_version = s.secret_version + 1,
      updated_at = pg_catalog.now()
  where s.connection_id = p_connection_id
    and s.credential_generation = p_generation
    and s.secret_version = p_secret_version;
  return found;
end;
$$;

-- invalid_grant for the incarnation that met it (never for a newer one).
create or replace function public.calendar_mark_reauth_required(
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
  update private.calendar_secrets s
  set access_token_ciphertext = null,
      access_token_expires_at = null,
      secret_version = s.secret_version + 1
  where s.connection_id = p_connection_id
    and s.credential_generation = p_generation;
  return true;
end;
$$;

-- Disconnects locally for the given incarnation and starts a new one. The
-- remote revocation is authorised for one minute from this commit
-- (revocation_authorized_until), and reconnection refused for two
-- (revocation_pending_until), whatever time the caller resumes at.
create or replace function public.calendar_disconnect(
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
  v_authorized_until timestamptz := pg_catalog.now() + interval '1 minute';
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
    'revocationAuthorizedUntil', v_authorized_until,
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

  -- 3. secrets, then 4.–6. calendars (sync rows and events cascade).
  delete from private.calendar_secrets s where s.connection_id = p_connection_id;
  delete from public.external_calendars c where c.connection_id = p_connection_id;

  update public.calendar_connections
  set status = 'disconnected',
      last_error = null,
      credential_generation = v_generation,
      revocation_authorized_until = case
        when v_result is not null then v_authorized_until
      end,
      revocation_pending_until = case
        when v_result is not null then v_authorized_until + interval '1 minute'
      end
  where id = p_connection_id;

  return coalesce(v_result, pg_catalog.jsonb_build_object(
    'provider', v_connection.provider, 'generation', v_generation, 'channels', '[]'::jsonb
  ));
end;
$$;

-- Milliseconds left to revoke the credentials of disconnection
-- p_generation, or null: the remote revocation must not start (window
-- closed, or the connection was reconnected since).
create function public.calendar_begin_revocation(
  p_connection_id uuid,
  p_generation uuid
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.floor(pg_catalog.date_part(
    'epoch', c.revocation_authorized_until - pg_catalog.now()) * 1000)::integer
  from public.calendar_connections c
  where c.id = p_connection_id
    and c.status = 'disconnected'
    and c.credential_generation = p_generation
    and c.revocation_authorized_until > pg_catalog.now();
$$;

create or replace function public.calendar_revocation_done(
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
  set revocation_pending_until = null,
      revocation_authorized_until = null
  where id = p_connection_id
    and credential_generation = p_generation
    and status = 'disconnected';
$$;

-- ---------------------------------------------------------------------------
-- Selection: a calendar protects only after its first complete sync
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
-- Applying a page
-- ---------------------------------------------------------------------------

-- As in 20261004090000, plus:
-- - a zone change re-projects the all-day periods in the same transaction;
-- - all-day rows keep their civil dates and their own zone, if any;
-- - an empty or inverted interval (timed), inverted civil dates or bounds
--   of different kinds reject the whole page; an all-day civil day that
--   does not exist in its zone keeps occupying no time.
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

    v_start_date := null;
    v_end_date := null;
    v_event_zone := null;
    begin
      v_updated := (v_event->>'updated')::timestamptz;
      if (v_event->'start' ? 'date') <> (v_event->'end' ? 'date') then
        -- Bounds of different kinds.
        v_starts := null;
      elsif v_event->'start' ? 'date' then
        v_all_day := true;
        v_start_date := (v_event->'start'->>'date')::date;
        v_end_date := (v_event->'end'->>'date')::date;
        v_event_zone := case
          when private.is_known_timezone(v_event->'start'->>'timeZone')
            then v_event->'start'->>'timeZone'
        end;
        v_zone := coalesce(v_event_zone, v_timezone);
        v_starts := private.local_day_start(v_start_date, v_zone);
        v_ends := private.local_day_start(v_end_date, v_zone);
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

revoke all on function private.reproject_all_day(uuid, text) from public;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.calendar_save_connection(uuid, uuid, text, text, text, text[], text, text, timestamptz, jsonb)',
    'public.calendar_read_secrets(uuid)',
    'public.calendar_store_access_token(uuid, uuid, text, timestamptz)',
    'public.calendar_reencrypt_secrets(uuid, uuid, bigint, text, text)',
    'public.calendar_mark_reauth_required(uuid, uuid, text)',
    'public.calendar_disconnect(uuid, uuid)',
    'public.calendar_begin_revocation(uuid, uuid)',
    'public.calendar_revocation_done(uuid, uuid)',
    'public.calendar_apply_events(uuid, uuid, bigint, text, jsonb, text)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

revoke all on function public.calendar_set_blocking(uuid, uuid[]) from public, anon;
grant execute on function public.calendar_set_blocking(uuid, uuid[]) to authenticated;
