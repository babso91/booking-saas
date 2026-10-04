-- External calendars, inbound: busy periods of the calendars a professional
-- selects block public availability (docs/CALENDAR_INTEGRATION_CONTRACT.md).
--
-- Booking SaaS stays the source of truth for client appointments. A provider
-- (Google Calendar first) is the source of truth for the professional's own
-- events: the application server copies their busy periods here, and
-- availability and booking read this local copy only — never the provider.
--
-- Generic model, provider-specific code in the application adapter:
--   calendar_connections       one account of one provider per business
--   private.calendar_secrets   its credentials (ciphertext only, server key)
--   external_calendars         the provider calendars visible to the account,
--                              with the professional's blocking selection
--   private.external_calendar_sync
--                              sync cursor, window, lease, push channel
--   external_calendar_events   busy periods of the selected calendars
--   private.calendar_oauth_states
--                              single-use, short-lived OAuth states
--
-- Writes of busy periods take the business schedule lock, like bookings,
-- blocks and weekly hours: a booking either sees an applied page of events or
-- runs entirely before it. No network call is made while holding it (each
-- page is fetched first, then applied in one short transaction).
--
-- An external busy period may overlap an existing appointment (the provider
-- is not part of our transactions): it is stored anyway, never refused, and
-- the appointment is left untouched; public.calendar_conflicts reports it.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  provider text not null check (provider in ('google')),
  -- Stable account identifier at the provider (Google: the OpenID `sub`).
  provider_account_id text not null check (char_length(provider_account_id) between 1 and 255),
  account_email text check (char_length(account_email) <= 320),
  status text not null default 'active'
    check (status in ('active', 'reauth_required', 'disconnected')),
  scopes text[] not null default '{}',
  connected_by uuid references auth.users (id) on delete set null,
  last_synced_at timestamptz,
  -- Stable error code of the last failure (never a provider message).
  last_error text check (char_length(last_error) <= 64),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One connection per provider and business: a reconnection reuses it.
  unique (business_id, provider),
  unique (id, business_id)
);

create table private.calendar_secrets (
  connection_id uuid primary key
    references public.calendar_connections (id) on delete cascade,
  -- AES-256-GCM ciphertexts produced by the application server
  -- (src/lib/crypto/secret-box.ts); the key never reaches the database.
  refresh_token_ciphertext text not null,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.external_calendars (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  connection_id uuid not null,
  provider_calendar_id text not null check (char_length(provider_calendar_id) between 1 and 1024),
  name text not null check (char_length(name) <= 500),
  -- IANA zone reported by the provider; all-day events are read in it.
  timezone text check (char_length(timezone) <= 64),
  is_primary boolean not null default false,
  access_role text check (char_length(access_role) <= 32),
  selected_for_blocking boolean not null default false,
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'pending', 'error')),
  last_synced_at timestamptz,
  last_error text check (char_length(last_error) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, business_id)
    references public.calendar_connections (id, business_id) on delete cascade,
  unique (connection_id, provider_calendar_id),
  unique (id, business_id)
);

create index external_calendars_business_idx
  on public.external_calendars (business_id);

create table private.external_calendar_sync (
  calendar_id uuid primary key
    references public.external_calendars (id) on delete cascade,
  -- Committed state: rows of external_calendar_events carry `generation`.
  generation bigint not null default 0,
  sync_token text,
  window_start timestamptz,
  window_end timestamptz,
  -- Full sync in progress (resumable page by page).
  full_generation bigint,
  full_page_token text,
  full_window_start timestamptz,
  full_window_end timestamptz,
  full_started_at timestamptz,
  -- One worker at a time; requests arriving meanwhile set resync_requested.
  lease_until timestamptz,
  resync_requested boolean not null default false,
  -- Push channel (provider webhook).
  channel_id uuid unique,
  channel_resource_id text,
  channel_token_hash text,
  channel_expires_at timestamptz
);

create table public.external_calendar_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  external_calendar_id uuid not null,
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 1024),
  -- Series of an expanded recurring instance (deleting the series removes them).
  provider_recurring_event_id text check (char_length(provider_recurring_event_id) <= 1024),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null,
  -- Opaque and not declined: only busy rows block availability.
  busy boolean not null,
  provider_etag text check (char_length(provider_etag) <= 256),
  provider_updated_at timestamptz,
  sync_generation bigint not null,
  synced_at timestamptz not null default now(),
  busy_window pg_catalog.tstzrange
    generated always as (pg_catalog.tstzrange(starts_at, ends_at, '[)')) stored,
  check (ends_at > starts_at),
  foreign key (external_calendar_id, business_id)
    references public.external_calendars (id, business_id) on delete cascade,
  unique (external_calendar_id, provider_event_id)
);

-- Availability and booking: busy periods of one business overlapping a day.
create index external_calendar_events_busy_idx
  on public.external_calendar_events using gist (business_id, busy_window)
  where busy;
create index external_calendar_events_series_idx
  on public.external_calendar_events (external_calendar_id, provider_recurring_event_id)
  where provider_recurring_event_id is not null;
create index external_calendar_events_generation_idx
  on public.external_calendar_events (external_calendar_id, sync_generation);

create table private.calendar_oauth_states (
  -- SHA-256 of the state sent to the provider (the state itself is not kept).
  state_hash text primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google')),
  -- PKCE code verifier, encrypted by the application server.
  code_verifier_ciphertext text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index calendar_oauth_states_user_idx
  on private.calendar_oauth_states (user_id, created_at);

create trigger calendar_connections_set_updated_at
  before update on public.calendar_connections
  for each row execute function public.set_updated_at();
create trigger calendar_connections_bump_version
  before update on public.calendar_connections
  for each row execute function private.bump_version();
create trigger external_calendars_set_updated_at
  before update on public.external_calendars
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Access: members read metadata; every write goes through the functions below
-- ---------------------------------------------------------------------------

alter table public.calendar_connections enable row level security;
alter table public.external_calendars enable row level security;
alter table public.external_calendar_events enable row level security;

revoke all on public.calendar_connections from anon, authenticated;
revoke all on public.external_calendars from anon, authenticated;
revoke all on public.external_calendar_events from anon, authenticated;

grant select (
  id, business_id, provider, account_email, status, scopes,
  last_synced_at, last_error, version, created_at, updated_at
) on public.calendar_connections to authenticated;
grant select (
  id, business_id, connection_id, provider_calendar_id, name, timezone,
  is_primary, access_role, selected_for_blocking, sync_status,
  last_synced_at, last_error, created_at, updated_at
) on public.external_calendars to authenticated;
grant select (
  id, business_id, external_calendar_id, starts_at, ends_at, all_day, busy
) on public.external_calendar_events to authenticated;

create policy "calendar_connections_select_member"
  on public.calendar_connections for select to authenticated
  using (public.is_business_member(business_id));
create policy "external_calendars_select_member"
  on public.external_calendars for select to authenticated
  using (public.is_business_member(business_id));
create policy "external_calendar_events_select_member"
  on public.external_calendar_events for select to authenticated
  using (public.is_business_member(business_id));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- True when PostgreSQL knows the IANA zone (cheap: no catalogue scan).
create function private.is_known_timezone(p_timezone text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_timezone is null or p_timezone = '' then
    return false;
  end if;
  perform pg_catalog.now() at time zone p_timezone;
  return true;
exception
  when invalid_parameter_value then
    return false;
end;
$$;

-- Instant of a provider date-time. An explicit offset or `Z` is kept exactly
-- (never rebuilt from the wall clock); a bare local date-time is read in its
-- zone by PostgreSQL, the calendar authority.
create function private.provider_instant(p_value text, p_timezone text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when p_value ~ '(Z|z|[+-][0-9]{2}:?[0-9]{2})$' then p_value::timestamptz
    else p_value::timestamp at time zone p_timezone
  end;
$$;

-- Busy periods of a business overlapping a range (selected calendars only:
-- deselected calendars have no rows).
create function private.external_busy(
  p_business_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns pg_catalog.tstzmultirange
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.range_agg(e.busy_window),
    '{}'::pg_catalog.tstzmultirange
  )
  from public.external_calendar_events e
  where e.business_id = p_business_id
    and e.busy
    and e.busy_window && pg_catalog.tstzrange(p_from, p_to, '[)');
$$;

-- ---------------------------------------------------------------------------
-- Availability: external busy periods occupy the schedule like appointments
-- ---------------------------------------------------------------------------

-- Identical to 20261001090000 except that v_occupied also contains the busy
-- periods of the selected external calendars: a slot is offered only if
-- [start, start + duration + buffer) overlaps neither an occupying
-- appointment nor an external busy period. create_public_booking_at
-- re-validates through this function under the schedule lock, so the
-- booking transaction refuses an overlap the listing would have hidden.
create or replace function private.compute_available_slots(
  p_business_id uuid,
  p_date date,
  p_now timestamptz,
  p_timezone text,
  p_duration_minutes integer,
  p_slot_interval_minutes integer,
  p_buffer_minutes integer,
  p_minimum_notice_minutes integer,
  p_maximum_advance_days integer
)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_duration interval := pg_catalog.make_interval(mins => p_duration_minutes);
  v_step interval := pg_catalog.make_interval(mins => p_slot_interval_minutes);
  v_buffer interval := pg_catalog.make_interval(mins => p_buffer_minutes);
  v_earliest timestamptz;
  v_latest timestamptz;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_open pg_catalog.tstzmultirange;
  v_unavailable pg_catalog.tstzmultirange;
  v_usable pg_catalog.tstzmultirange;
  v_occupied pg_catalog.tstzmultirange;
begin
  if p_date is null or p_now is null or p_timezone is null then
    return;
  end if;

  -- Minimum notice: real minutes from now.
  v_earliest := p_now + pg_catalog.make_interval(mins => p_minimum_notice_minutes);
  -- Horizon: every day up to today + N (local) is bookable as a whole, so
  -- it ends where day today + N + 1 really begins.
  v_latest := private.local_day_start(
    private.local_date_of(p_now, p_timezone) + p_maximum_advance_days + 1,
    p_timezone
  );
  v_day_start := private.local_day_start(p_date, p_timezone);
  v_day_end := private.local_day_start(p_date + 1, p_timezone);

  -- A date skipped by the zone has no instant at all.
  if v_day_start >= v_day_end
    or v_day_end <= v_earliest
    or v_day_start >= v_latest then
    return;
  end if;

  v_open := private.opening_ranges(p_business_id, p_date, p_timezone);

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
      v_day_start - interval '24 hours',
      v_day_end + interval '24 hours',
      '[)'
    );

  -- External busy periods (local copy, indexed; never a provider call).
  v_occupied := v_occupied + private.external_busy(
    p_business_id,
    v_day_start - interval '24 hours',
    v_day_end + interval '24 hours'
  );

  -- Slots start at each opening range's start, every slot interval; a slot
  -- lies entirely inside one usable range (never across a closed piece).
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

-- ---------------------------------------------------------------------------
-- OAuth states (signed-in professional)
-- ---------------------------------------------------------------------------

-- Records the state of a connection attempt, bound to the caller and the
-- business; valid 10 minutes, consumed once.
create function public.calendar_begin_oauth(
  p_business_id uuid,
  p_provider text,
  p_state_hash text,
  p_code_verifier_ciphertext text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_agenda_access(p_business_id);

  if p_provider is distinct from 'google'
    or p_state_hash !~ '^[0-9a-f]{64}$'
    or coalesce(pg_catalog.char_length(p_code_verifier_ciphertext), 0) not between 1 and 2048 then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  -- Expired states, and all but the 10 most recent of this user.
  delete from private.calendar_oauth_states s
  where s.expires_at < pg_catalog.now()
     or (s.user_id = (select auth.uid()) and s.state_hash in (
       select o.state_hash from private.calendar_oauth_states o
       where o.user_id = (select auth.uid())
       order by o.created_at desc
       offset 9
     ));

  insert into private.calendar_oauth_states (
    state_hash, business_id, user_id, provider, code_verifier_ciphertext, expires_at
  )
  values (
    p_state_hash, p_business_id, (select auth.uid()), p_provider,
    p_code_verifier_ciphertext, pg_catalog.now() + interval '10 minutes'
  );
end;
$$;

-- Consumes a state: only by the user who created it, once, before expiry.
-- The row is deleted whatever the outcome (a replay finds nothing).
create function public.calendar_consume_oauth_state(p_state_hash text)
returns table (business_id uuid, provider text, code_verifier_ciphertext text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_state private.calendar_oauth_states;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;

  delete from private.calendar_oauth_states s
  where s.state_hash = p_state_hash
    and s.user_id = (select auth.uid())
  returning s.* into v_state;

  if v_state.state_hash is null then
    raise exception using errcode = 'P0001', message = 'oauth_state_invalid';
  end if;
  if v_state.expires_at < pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'oauth_state_expired';
  end if;

  perform private.assert_agenda_access(v_state.business_id);

  return query
  select v_state.business_id, v_state.provider, v_state.code_verifier_ciphertext;
end;
$$;

-- ---------------------------------------------------------------------------
-- Blocking selection (signed-in professional)
-- ---------------------------------------------------------------------------

-- Replaces the set of blocking calendars of the business's connection, in
-- one transaction under the schedule lock. Deselected calendars lose their
-- events at once (they stop blocking) and their push channels are returned
-- so the server can stop them; newly selected ones are marked pending a full
-- sync. Returns the calendars to sync and the channels to stop.
create function public.calendar_set_blocking(
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
  v_unknown integer;
  v_to_sync jsonb;
  v_to_stop jsonb;
begin
  perform private.assert_agenda_access(p_business_id);

  if coalesce(pg_catalog.cardinality(p_calendar_ids), 0) > 50 then
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

  select count(*) into v_unknown
  from pg_catalog.unnest(coalesce(p_calendar_ids, '{}'::uuid[])) requested(id)
  where not exists (
    select 1 from public.external_calendars c
    where c.id = requested.id
      and c.connection_id = v_connection.id
      and c.business_id = p_business_id
  );

  if v_unknown > 0 then
    raise exception using errcode = 'P0002', message = 'calendar_not_found';
  end if;

  -- Channels of calendars leaving the selection (stopped by the server).
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
    and not (c.id = any (coalesce(p_calendar_ids, '{}'::uuid[])))
    and s.channel_id is not null;

  -- Leaving: no more blocking, no more local copy, no more cursor.
  delete from public.external_calendar_events e
  using public.external_calendars c
  where e.external_calendar_id = c.id
    and c.connection_id = v_connection.id
    and c.selected_for_blocking
    and not (c.id = any (coalesce(p_calendar_ids, '{}'::uuid[])));

  delete from private.external_calendar_sync s
  using public.external_calendars c
  where s.calendar_id = c.id
    and c.connection_id = v_connection.id
    and c.selected_for_blocking
    and not (c.id = any (coalesce(p_calendar_ids, '{}'::uuid[])));

  update public.external_calendars c
  set selected_for_blocking = false,
      sync_status = 'idle',
      last_error = null
  where c.connection_id = v_connection.id
    and c.selected_for_blocking
    and not (c.id = any (coalesce(p_calendar_ids, '{}'::uuid[])));

  -- Joining: pending a full sync.
  update public.external_calendars c
  set selected_for_blocking = true,
      sync_status = 'pending',
      last_error = null
  where c.connection_id = v_connection.id
    and not c.selected_for_blocking
    and c.id = any (coalesce(p_calendar_ids, '{}'::uuid[]));

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

-- External busy periods overlapping a non-cancelled appointment (conflicts
-- created at the provider after the booking). Reported, never resolved.
create function public.calendar_conflicts(
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
   and e.busy_window && pg_catalog.tstzrange(a.starts_at, a.ends_at, '[)')
  where a.business_id = p_business_id
    and a.status <> 'cancelled'
    and a.starts_at < p_to
    and a.ends_at > p_from
  order by a.starts_at, e.starts_at
  limit 200;
end;
$$;

-- ---------------------------------------------------------------------------
-- Connection lifecycle (application server, service role only)
-- ---------------------------------------------------------------------------

-- Saves a connection after a successful OAuth exchange, with its calendars,
-- in one transaction. The user must still be a member of the business.
-- Reconnecting the same account keeps the selection and the local copy
-- (tokens rotated, calendars refreshed); another account replaces it all.
-- A missing refresh token keeps the stored one for the same account, and is
-- refused otherwise (`calendar_refresh_token_missing`).
create function public.calendar_save_connection(
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
      -- Another account (or after a disconnection): nothing of the previous
      -- one survives. Its calendars and busy periods go now.
      delete from public.external_calendars c where c.connection_id = v_id;
    end if;

    update public.calendar_connections c
    set provider_account_id = p_provider_account_id,
        account_email = p_account_email,
        status = 'active',
        scopes = coalesce(p_scopes, '{}'),
        connected_by = p_user_id,
        last_error = null
    where c.id = v_id;
  end if;

  if p_refresh_token_ciphertext is null then
    -- Same account, no new refresh token: keep the stored one.
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

  -- Selected calendars of a reconnected account: full sync again.
  update private.external_calendar_sync s
  set sync_token = null
  from public.external_calendars c
  where s.calendar_id = c.id and c.connection_id = v_id;
  update public.external_calendars c
  set sync_status = 'pending'
  where c.connection_id = v_id and c.selected_for_blocking;

  return v_id;
end;
$$;

-- Upserts the calendar list of a connection; calendars that disappeared at
-- the provider are removed with their busy periods. Caller holds the lock.
create function private.save_calendars(
  p_connection_id uuid,
  p_business_id uuid,
  p_calendars jsonb
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_calendars is null or pg_catalog.jsonb_typeof(p_calendars) <> 'array'
    or pg_catalog.jsonb_array_length(p_calendars) > 250 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'calendars';
  end if;

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
      timezone = excluded.timezone,
      is_primary = excluded.is_primary,
      access_role = excluded.access_role;

  delete from public.external_calendars c
  where c.connection_id = p_connection_id
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_calendars) item
      where item->>'id' = c.provider_calendar_id
    );
end;
$$;

-- Refreshes the calendar list of an active connection.
create function public.calendar_save_calendars(
  p_connection_id uuid,
  p_calendars jsonb
)
returns void
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
  where c.id = p_connection_id and c.status = 'active';

  if v_business_id is null then
    raise exception using errcode = 'P0001', message = 'calendar_not_connected';
  end if;

  perform private.lock_business_schedule(v_business_id);
  perform private.save_calendars(p_connection_id, v_business_id, p_calendars);
end;
$$;

-- Credentials of a connection, for the server's token helper.
create function public.calendar_read_secrets(p_connection_id uuid)
returns table (
  business_id uuid,
  provider text,
  status text,
  refresh_token_ciphertext text,
  access_token_ciphertext text,
  access_token_expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.business_id, c.provider, c.status, s.refresh_token_ciphertext,
         s.access_token_ciphertext, s.access_token_expires_at
  from public.calendar_connections c
  join private.calendar_secrets s on s.connection_id = c.id
  where c.id = p_connection_id;
$$;

create function public.calendar_store_access_token(
  p_connection_id uuid,
  p_access_token_ciphertext text,
  p_access_token_expires_at timestamptz
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.calendar_secrets
  set access_token_ciphertext = p_access_token_ciphertext,
      access_token_expires_at = p_access_token_expires_at,
      updated_at = pg_catalog.now()
  where connection_id = p_connection_id;
$$;

-- Credentials revoked or expired at the provider: the connection needs the
-- professional again. Busy periods already copied keep blocking (last known
-- state) until reconnection or disconnection.
create function public.calendar_mark_reauth_required(
  p_connection_id uuid,
  p_error text
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.calendar_connections
  set status = 'reauth_required',
      last_error = pg_catalog.left(p_error, 64)
  where id = p_connection_id and status = 'active';
  update private.calendar_secrets
  set access_token_ciphertext = null, access_token_expires_at = null
  where connection_id = p_connection_id;
$$;

-- Disconnects locally, at once and idempotently: busy periods, calendars,
-- cursors and credentials are deleted (availability is no longer blocked),
-- appointments are untouched. Returns what the server still needs to clean
-- up at the provider (credentials and channels), or null when already done.
create function public.calendar_disconnect(p_connection_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.calendar_connections;
  v_result jsonb;
begin
  select c.* into v_connection
  from public.calendar_connections c
  where c.id = p_connection_id;

  if v_connection.id is null or v_connection.status = 'disconnected' then
    return null;
  end if;

  perform private.lock_business_schedule(v_connection.business_id);

  select pg_catalog.jsonb_build_object(
    'provider', v_connection.provider,
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
  set status = 'disconnected', last_error = null
  where id = p_connection_id and status <> 'disconnected';

  return coalesce(v_result, pg_catalog.jsonb_build_object(
    'provider', v_connection.provider, 'channels', '[]'::jsonb
  ));
end;
$$;

-- ---------------------------------------------------------------------------
-- Synchronisation (application server, service role only)
-- ---------------------------------------------------------------------------

-- Claims a selected calendar of an active connection for one worker. Returns
-- null when it cannot be synced; `claimed: false` when another worker holds
-- it (that worker will run once more: resync_requested).
create function public.calendar_claim_sync(
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

  select c.* into v_connection
  from public.calendar_connections c
  where c.id = v_calendar.connection_id;
  if v_connection.status <> 'active' then
    return null;
  end if;

  update private.external_calendar_sync s
  set lease_until = pg_catalog.now()
        + pg_catalog.make_interval(secs => least(greatest(p_lease_seconds, 10), 600)),
      resync_requested = false
  where s.calendar_id = p_calendar_id
    and (s.lease_until is null or s.lease_until < pg_catalog.now())
  returning s.* into v_sync;

  if v_sync.calendar_id is null then
    update private.external_calendar_sync s
    set resync_requested = true
    where s.calendar_id = p_calendar_id;
    return pg_catalog.jsonb_build_object('claimed', false);
  end if;

  select b.timezone into v_business_timezone
  from public.businesses b where b.id = v_calendar.business_id;

  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'calendarId', v_calendar.id,
    'businessId', v_calendar.business_id,
    'connectionId', v_connection.id,
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

-- Starts (or resumes, when interrupted less than an hour ago) a full sync:
-- a new generation over the window [now − 1 day, now + 400 days). The window
-- covers the longest booking horizon (365 days + the current day) with a
-- margin, and bounds what is copied whatever the calendar's history.
create function public.calendar_start_full_sync(p_calendar_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sync private.external_calendar_sync;
begin
  select s.* into v_sync
  from private.external_calendar_sync s
  where s.calendar_id = p_calendar_id
  for update;

  if v_sync.calendar_id is null then
    raise exception using errcode = 'P0002', message = 'calendar_not_found';
  end if;

  if v_sync.full_generation is null
    or v_sync.full_started_at < pg_catalog.now() - interval '1 hour' then
    update private.external_calendar_sync s
    set full_generation = s.generation + 1,
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

-- Applies one page of provider events, under the schedule lock, and records
-- the page cursor in the same transaction (a full sync resumes after the
-- last applied page). Idempotent: an event is identified by its provider id;
-- an older version never overwrites a newer one.
--
-- p_generation: the full sync's generation, or null for an incremental page
-- (rows then keep the committed generation).
create function public.calendar_apply_events(
  p_calendar_id uuid,
  p_generation bigint,
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

  select c.* into v_calendar
  from public.external_calendars c
  where c.id = p_calendar_id;
  if v_calendar.id is null then
    raise exception using errcode = 'P0002', message = 'calendar_not_found';
  end if;

  perform private.lock_business_schedule(v_calendar.business_id);

  -- Re-read under the lock: a disconnection or deselection committed
  -- meanwhile wins, and nothing is resurrected.
  select c.* into v_calendar
  from public.external_calendars c
  where c.id = p_calendar_id;
  if v_calendar.id is null or not v_calendar.selected_for_blocking or not exists (
    select 1 from public.calendar_connections k
    where k.id = v_calendar.connection_id and k.status = 'active'
  ) then
    return pg_catalog.jsonb_build_object('applied', false);
  end if;

  select s.* into v_sync
  from private.external_calendar_sync s
  where s.calendar_id = p_calendar_id
  for update;

  if p_generation is not null then
    if v_sync.full_generation is distinct from p_generation then
      return pg_catalog.jsonb_build_object('applied', false);
    end if;
    v_generation := p_generation;
    v_window_start := v_sync.full_window_start;
    v_window_end := v_sync.full_window_end;
  else
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
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Cancelled (deleted) event, or a whole recurring series.
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
        -- All-day: [date, end date) are civil dates of the event's or the
        -- calendar's zone; their real bounds come from local_day_start.
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

    v_busy := coalesce(v_event->>'transparency', 'opaque') <> 'transparent'
      and not coalesce((v_event->>'declined')::boolean, false)
      and coalesce(v_event->>'eventType', 'default') not in ('workingLocation', 'birthday');

    -- Unreadable, empty, or outside the window: not kept.
    if v_starts is null or v_ends is null or v_ends <= v_starts
      or v_ends <= v_window_start or v_starts >= v_window_end then
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
        -- Out of order: an older version never replaces a newer one.
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

-- Ends a full sync: rows not seen in this generation are deleted (events
-- removed at the provider, or after an expired cursor), and the new cursor
-- and window become the committed state.
create function public.calendar_finish_full_sync(
  p_calendar_id uuid,
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
  select c.* into v_calendar from public.external_calendars c where c.id = p_calendar_id;
  if v_calendar.id is null then
    return false;
  end if;

  perform private.lock_business_schedule(v_calendar.business_id);

  select s.* into v_sync
  from private.external_calendar_sync s
  where s.calendar_id = p_calendar_id
  for update;

  if v_sync.full_generation is distinct from p_generation then
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

create function private.mark_synced(p_calendar_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  update public.external_calendars
  set sync_status = 'idle', last_synced_at = pg_catalog.now(), last_error = null
  where id = p_calendar_id;
  update public.calendar_connections k
  set last_synced_at = pg_catalog.now(), last_error = null
  from public.external_calendars c
  where c.id = p_calendar_id and k.id = c.connection_id and k.status = 'active';
$$;

-- Ends an incremental sync: the cursor advances only now, after every page
-- was applied.
create function public.calendar_finish_incremental_sync(
  p_calendar_id uuid,
  p_sync_token text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update private.external_calendar_sync s
  set sync_token = p_sync_token
  where s.calendar_id = p_calendar_id and s.full_generation is null;
  perform private.mark_synced(p_calendar_id);
end;
$$;

-- Cursor rejected by the provider (410 Gone): forget it; the next pass is a
-- full sync whose final sweep replaces the local copy (no window without
-- blocking in between).
create function public.calendar_reset_sync(p_calendar_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.external_calendar_sync
  set sync_token = null,
      full_generation = null,
      full_page_token = null,
      full_window_start = null,
      full_window_end = null,
      full_started_at = null
  where calendar_id = p_calendar_id;
$$;

-- Releases the lease. Returns true when another request arrived meanwhile
-- (the worker runs once more).
create function public.calendar_release_sync(
  p_calendar_id uuid,
  p_error text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_again boolean;
begin
  select s.resync_requested into v_again
  from private.external_calendar_sync s
  where s.calendar_id = p_calendar_id
  for update;

  update private.external_calendar_sync s
  set lease_until = null,
      resync_requested = false
  where s.calendar_id = p_calendar_id;

  if p_error is not null then
    update public.external_calendars
    set sync_status = 'error', last_error = pg_catalog.left(p_error, 64)
    where id = p_calendar_id;
    update public.calendar_connections k
    set last_error = pg_catalog.left(p_error, 64)
    from public.external_calendars c
    where c.id = p_calendar_id and k.id = c.connection_id;
  end if;

  return coalesce(v_again, false) and p_error is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Push channels (application server, service role only)
-- ---------------------------------------------------------------------------

-- Records the channel just created for a calendar; returns the previous one
-- (to stop) if any.
create function public.calendar_record_channel(
  p_calendar_id uuid,
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
  v_previous jsonb;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  select case when s.channel_id is null then null else pg_catalog.jsonb_build_object(
    'channelId', s.channel_id, 'resourceId', s.channel_resource_id) end
  into v_previous
  from private.external_calendar_sync s
  where s.calendar_id = p_calendar_id
  for update;

  update private.external_calendar_sync s
  set channel_id = p_channel_id,
      channel_resource_id = p_resource_id,
      channel_token_hash = p_token_hash,
      channel_expires_at = p_expires_at
  where s.calendar_id = p_calendar_id
    and exists (
      select 1 from public.external_calendars c
      join public.calendar_connections k on k.id = c.connection_id
      where c.id = p_calendar_id and c.selected_for_blocking and k.status = 'active'
    );

  if not found then
    -- Calendar deselected or disconnected meanwhile: stop the new channel.
    return pg_catalog.jsonb_build_object(
      'channelId', p_channel_id, 'resourceId', p_resource_id, 'orphan', true);
  end if;

  return v_previous;
end;
$$;

-- Verifies a push notification: the channel must be the current one of a
-- selected calendar of an active connection, with the same resource and
-- token, and not expired. Returns the calendar to sync, or null (ignored).
create function public.calendar_verify_notification(
  p_channel_id uuid,
  p_resource_id text,
  p_token_hash text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from private.external_calendar_sync s
  join public.external_calendars c on c.id = s.calendar_id
  join public.calendar_connections k on k.id = c.connection_id
  where s.channel_id = p_channel_id
    and s.channel_resource_id = p_resource_id
    and s.channel_token_hash = p_token_hash
    and s.channel_expires_at > pg_catalog.now()
    and c.selected_for_blocking
    and k.status = 'active';
$$;

-- Work due for the periodic job: calendars whose channel must be (re)created
-- within a day, whose window must slide, that were never synced, failed, or
-- were not synced for 6 hours (push notifications are not guaranteed).
create function public.calendar_due_work(
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
      when c.sync_status in ('pending', 'error') then 'retry'
      else 'catch_up'
    end
  from public.external_calendars c
  join public.calendar_connections k on k.id = c.connection_id
  join private.external_calendar_sync s on s.calendar_id = c.id
  where c.selected_for_blocking
    and k.status = 'active'
    and (s.lease_until is null or s.lease_until < pg_catalog.now())
    and (
      s.sync_token is null
      or s.full_generation is not null
      or s.window_end < pg_catalog.now() + interval '380 days'
      or (p_with_channels and (s.channel_id is null
            or s.channel_expires_at < pg_catalog.now() + interval '1 day'))
      or c.sync_status in ('pending', 'error')
      or c.last_synced_at is null
      or c.last_synced_at < pg_catalog.now() - interval '6 hours'
    )
  order by c.last_synced_at nulls first
  limit least(greatest(p_limit, 1), 500);
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on table private.calendar_secrets from public;
revoke all on table private.external_calendar_sync from public;
revoke all on table private.calendar_oauth_states from public;

revoke all on function private.is_known_timezone(text) from public;
revoke all on function private.provider_instant(text, text) from public;
revoke all on function private.external_busy(uuid, timestamptz, timestamptz) from public;
revoke all on function private.save_calendars(uuid, uuid, jsonb) from public;
revoke all on function private.mark_synced(uuid) from public;
revoke all on function private.compute_available_slots(
  uuid, date, timestamptz, text, integer, integer, integer, integer, integer
) from public;

-- Signed-in professional (each checks membership itself).
revoke all on function public.calendar_begin_oauth(uuid, text, text, text) from public, anon;
revoke all on function public.calendar_consume_oauth_state(text) from public, anon;
revoke all on function public.calendar_set_blocking(uuid, uuid[]) from public, anon;
revoke all on function public.calendar_conflicts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.calendar_begin_oauth(uuid, text, text, text) to authenticated;
grant execute on function public.calendar_consume_oauth_state(text) to authenticated;
grant execute on function public.calendar_set_blocking(uuid, uuid[]) to authenticated;
grant execute on function public.calendar_conflicts(uuid, timestamptz, timestamptz) to authenticated;

-- Application server only (service role): credentials and synchronisation.
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.calendar_save_connection(uuid, uuid, text, text, text, text[], text, text, timestamptz, jsonb)',
    'public.calendar_save_calendars(uuid, jsonb)',
    'public.calendar_read_secrets(uuid)',
    'public.calendar_store_access_token(uuid, text, timestamptz)',
    'public.calendar_mark_reauth_required(uuid, text)',
    'public.calendar_disconnect(uuid)',
    'public.calendar_claim_sync(uuid, integer)',
    'public.calendar_start_full_sync(uuid)',
    'public.calendar_apply_events(uuid, bigint, jsonb, text)',
    'public.calendar_finish_full_sync(uuid, bigint, text)',
    'public.calendar_finish_incremental_sync(uuid, text)',
    'public.calendar_reset_sync(uuid)',
    'public.calendar_release_sync(uuid, text)',
    'public.calendar_record_channel(uuid, uuid, text, text, timestamptz)',
    'public.calendar_verify_notification(uuid, text, text)',
    'public.calendar_due_work(integer, boolean)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

comment on table public.external_calendar_events is
  'Local copy of the busy periods of selected external calendars; read by availability, never fetched from the provider during a request.';
