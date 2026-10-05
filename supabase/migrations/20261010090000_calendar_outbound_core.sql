-- Calendar outbound core: Booking appointments mirrored to a dedicated
-- Google calendar that the app itself creates (scope calendar.app.created).
--
-- Booking stays the only source of truth. An appointment transaction only
-- records a desired state (an outbox row, a revision counter) through a
-- trigger covering every path that writes appointments; workers apply it to
-- Google after commit, never inside a Booking transaction or under the
-- schedule lock. The database never contacts Google.
--
-- Authority. The outbound configuration of a business has a generation,
-- replaced whenever its authority changes (enabled again, disabled, action
-- required, connection disconnected, other Google account). A worker
-- captures it with its claim, together with the connection's credential
-- generation and the desired revision; every local write that follows a
-- provider answer re-checks all of them here: a stale worker writes
-- nothing. Every guard of authority is strictly true or false, never null.
--
-- Lock order (on top of the inbound one): schedule lock, connection row,
-- secrets, outbound row, calendar attribution, mirror rows. A worker
-- transition decided from a provider answer holds the connection row (share)
-- and the outbound row from its check to its write: a reconnection either
-- committed before (the worker is stale) or waits. Appointment transactions
-- lock the appointment then its mirror and only read the outbound row.

-- ---------------------------------------------------------------------------
-- OAuth: a state is issued for a connection or for the write authorization
-- ---------------------------------------------------------------------------

alter table private.calendar_oauth_states
  add column purpose text not null default 'connect'
    check (purpose in ('connect', 'write'));

drop function public.calendar_begin_oauth(uuid, text, text, text);

create function public.calendar_begin_oauth(
  p_business_id uuid,
  p_provider text,
  p_state_hash text,
  p_code_verifier_ciphertext text,
  p_purpose text default 'connect'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_provider is distinct from 'google'
    or p_state_hash !~ '^[0-9a-f]{64}$'
    or coalesce(pg_catalog.char_length(p_code_verifier_ciphertext), 0) not between 1 and 2048
    or p_purpose is null or p_purpose not in ('connect', 'write') then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  -- The write authorization is added to an existing, active connection.
  if p_purpose = 'write' then
    select c.status into v_status
    from public.calendar_connections c
    where c.business_id = p_business_id and c.provider = p_provider;
    if v_status is null or v_status = 'disconnected' then
      raise exception using errcode = 'P0001', message = 'calendar_not_connected';
    end if;
    if v_status <> 'active' then
      raise exception using errcode = 'P0001', message = 'calendar_reauth_required';
    end if;
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
    state_hash, business_id, user_id, provider, code_verifier_ciphertext,
    expires_at, purpose
  )
  values (
    p_state_hash, p_business_id, (select auth.uid()), p_provider,
    p_code_verifier_ciphertext, pg_catalog.now() + interval '10 minutes',
    p_purpose
  );
end;
$$;

drop function public.calendar_consume_oauth_state(text);

create function public.calendar_consume_oauth_state(p_state_hash text)
returns table (
  business_id uuid,
  provider text,
  code_verifier_ciphertext text,
  purpose text
)
language plpgsql
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
  select v_state.business_id, v_state.provider, v_state.code_verifier_ciphertext,
         v_state.purpose;
end;
$$;

-- The write scope, granted to the connection when present in its scopes.
-- A guard of authority: strictly true or false, never null (an array
-- holding a null element included).
create function private.has_write_scope(p_scopes text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    'https://www.googleapis.com/auth/calendar.app.created' = any (p_scopes),
    false
  );
$$;

-- Adds the write authorization to the existing connection, for the same
-- Google account only. Nothing is written for another account: neither its
-- credentials nor its scopes ever reach this connection. The incarnation
-- (credential_generation) is kept: inbound calendars, their selection and
-- their sync state are untouched. Without a new refresh token (Google sends
-- one only on a new consent), the stored one is kept.
create function public.calendar_add_write_authorization(
  p_business_id uuid,
  p_user_id uuid,
  p_provider_account_id text,
  p_scopes text[],
  p_refresh_token_ciphertext text,
  p_access_token_ciphertext text,
  p_access_token_expires_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.calendar_connections;
begin
  if not exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.user_id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_provider_account_id is null or p_access_token_ciphertext is null
    or not private.has_write_scope(p_scopes) then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  -- 1. schedule lock, 2. connection row, 3. secrets.
  perform private.lock_business_schedule(p_business_id);

  select c.* into v_connection
  from public.calendar_connections c
  where c.business_id = p_business_id and c.provider = 'google'
  for update;

  if v_connection.id is null or v_connection.status <> 'active' then
    return 'not_connected';
  end if;
  if v_connection.provider_account_id <> p_provider_account_id then
    return 'account_mismatch';
  end if;

  update public.calendar_connections c
  set scopes = (
        select coalesce(pg_catalog.array_agg(distinct scope order by scope), '{}')
        from pg_catalog.unnest(c.scopes || p_scopes) scope
      ),
      last_error = null
  where c.id = v_connection.id;

  update private.calendar_secrets s
  set refresh_token_ciphertext = coalesce(p_refresh_token_ciphertext, s.refresh_token_ciphertext),
      access_token_ciphertext = p_access_token_ciphertext,
      access_token_expires_at = p_access_token_expires_at,
      secret_version = s.secret_version + 1,
      updated_at = pg_catalog.now()
  where s.connection_id = v_connection.id
    and s.credential_generation = v_connection.credential_generation;
  if not found then
    return 'not_connected';
  end if;
  return 'stored';
end;
$$;

-- ---------------------------------------------------------------------------
-- Outbound configuration, calendars created by the app, mirrors (outbox)
-- ---------------------------------------------------------------------------

-- One per business (V1: Google, one dedicated calendar).
--   creating         the dedicated calendar is being created or recovered
--   active           mirrors are applied to provider_calendar_id
--   action_required  blocked until the professional acts (action_code);
--                    desired states keep being recorded, no provider call
--   disabled         stopped by the professional or by a disconnection;
--                    no new appointment is enrolled
create table private.calendar_outbound (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  connection_id uuid not null references public.calendar_connections (id) on delete cascade,
  provider text not null default 'google' check (provider = 'google'),
  -- The Google account the dedicated calendar belongs to.
  provider_account_id text not null,
  status text not null
    check (status in ('creating', 'active', 'action_required', 'disabled')),
  generation uuid not null default gen_random_uuid(),
  -- Marker written in the dedicated calendar's description, with the
  -- creation attempt's nonce (booking-saas:<marker>:<nonce>). Discovery
  -- only: it lists candidates after a lost creation answer, never proves
  -- ownership (a description can be copied); a candidate is adopted only
  -- once our write permission on it is proven at the provider.
  calendar_marker uuid not null default gen_random_uuid(),
  creation_nonce uuid not null default gen_random_uuid(),
  provider_calendar_id text check (pg_catalog.char_length(provider_calendar_id) <= 1024),
  action_code text check (action_code in (
    'calendar_deleted', 'write_authorization_required', 'account_changed',
    'calendar_creation_uncertain'
  )),
  creation_claim_id uuid,
  creation_lease_until timestamptz,
  -- Set before calendars.insert is sent, cleared only when its failure is
  -- certain (the request was refused). Set: the outcome may be a calendar
  -- Google created (lost answer); no other insert is ever sent for this
  -- attempt, only searches (bounded, then calendar_creation_uncertain).
  creation_requested_at timestamptz,
  creation_attempts integer not null default 0,
  creation_recovery_attempts integer not null default 0,
  creation_next_attempt_at timestamptz,
  last_error text check (pg_catalog.char_length(last_error) <= 64),
  enabled_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  check ((status = 'active') = (provider_calendar_id is not null)),
  check ((status = 'action_required') = (action_code is not null and action_code <> 'account_changed')
         or (status = 'disabled' and action_code = 'account_changed'))
);

create index calendar_outbound_connection_idx on private.calendar_outbound (connection_id);

create trigger calendar_outbound_set_updated_at
  before update on private.calendar_outbound
  for each row execute function public.set_updated_at();

-- Every dedicated calendar the app created or adopted, and the business it
-- belongs to: never an inbound blocking source of that business, even once
-- it is no longer the target.
--
-- Invariant: a provider calendar belongs to one business only. The primary
-- key (provider, provider_calendar_id) admits one business per calendar id,
-- whatever else holds: the same Google account, the same OAuth application,
-- a copied marker or a successful sentinel never give a calendar attributed
-- to business A to business B. The attribution is decided by this key,
-- atomically, when calendar_outbound_adopt_calendar inserts the row: of two
-- concurrent adoptions of one id, the first to commit owns it and the other
-- is refused. Rows are never deleted (a former target stays attributed, and
-- filtered from its business's inbound); they only go with their business
-- (reattribution after a business deletion: out of scope V1).
create table private.calendar_outbound_calendars (
  provider text not null default 'google' check (provider = 'google'),
  provider_calendar_id text not null
    check (pg_catalog.char_length(provider_calendar_id) between 1 and 1024),
  business_id uuid not null references public.businesses (id) on delete cascade,
  provider_account_id text not null,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (provider, provider_calendar_id)
);

create index calendar_outbound_calendars_business_idx
  on private.calendar_outbound_calendars (business_id, provider_calendar_id);

-- One mirror per appointment: the durable desired state. The desired event
-- is derived from the appointment itself when a worker runs (latest state
-- wins, intermediate states are never sent); desired_revision counts the
-- relevant changes, applied_revision the last one applied at the provider.
create table private.appointment_calendar_mirrors (
  -- No foreign key: a deleted appointment keeps its mirror until its event
  -- is removed.
  appointment_id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  provider text not null default 'google' check (provider = 'google'),
  -- Deterministic Google event id (base32hex), derived from the appointment.
  event_id text not null,
  -- Calendar the event may exist in: recorded before any provider write.
  provider_calendar_id text,
  desired_revision bigint not null default 1,
  applied_revision bigint not null default 0,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default pg_catalog.now(),
  claim_id uuid,
  lease_until timestamptz,
  -- Authority captured with the claim (re-checked before any local write).
  claim_generation uuid,
  claim_credential_generation uuid,
  last_error text check (pg_catalog.char_length(last_error) <= 64),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create index appointment_calendar_mirrors_due_idx
  on private.appointment_calendar_mirrors (next_attempt_at)
  where desired_revision > applied_revision;
create index appointment_calendar_mirrors_business_idx
  on private.appointment_calendar_mirrors (business_id);

create trigger appointment_calendar_mirrors_set_updated_at
  before update on private.appointment_calendar_mirrors
  for each row execute function public.set_updated_at();

-- 'bk' + the appointment uuid in hex: base32hex characters only, 34 long,
-- stable, independent of anything the professional can edit.
create function private.mirror_event_id(p_appointment_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'bk' || pg_catalog.replace(p_appointment_id::text, '-', '');
$$;

-- ---------------------------------------------------------------------------
-- Desired states: recorded by every write of an appointment
-- ---------------------------------------------------------------------------

-- Runs in the appointment's own transaction: a local insert or counter bump,
-- nothing else. A new mirror is created only while outbound is enrolled
-- (creating, active, action_required); an existing mirror always follows
-- its appointment, so that it converges once outbound runs again.
create function private.record_appointment_mirror()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update private.appointment_calendar_mirrors m
    set desired_revision = m.desired_revision + 1,
        next_attempt_at = pg_catalog.now(),
        attempts = 0,
        last_error = null
    where m.appointment_id = old.id;
    return old;
  end if;

  if tg_op = 'UPDATE'
    and new.starts_at is not distinct from old.starts_at
    and new.ends_at is not distinct from old.ends_at
    and new.status is not distinct from old.status
    and new.service_name_snapshot is not distinct from old.service_name_snapshot
    and new.client_id is not distinct from old.client_id then
    return new;
  end if;

  insert into private.appointment_calendar_mirrors as m (
    appointment_id, business_id, event_id
  )
  select new.id, new.business_id, private.mirror_event_id(new.id)
  where exists (
    select 1 from private.calendar_outbound o
    where o.business_id = new.business_id
      and o.status in ('creating', 'active', 'action_required')
  )
  on conflict (appointment_id) do update
  set desired_revision = m.desired_revision + 1,
      next_attempt_at = pg_catalog.now(),
      attempts = 0,
      last_error = null;
  if not found then
    update private.appointment_calendar_mirrors m
    set desired_revision = m.desired_revision + 1,
        next_attempt_at = pg_catalog.now(),
        attempts = 0,
        last_error = null
    where m.appointment_id = new.id;
  end if;
  return new;
end;
$$;

create trigger appointments_record_calendar_mirror
  after insert or update or delete on public.appointments
  for each row execute function private.record_appointment_mirror();

-- The event title shows the client's first name: a rename is a change of
-- the existing mirrors (never creates one).
create function private.record_client_mirrors()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.appointment_calendar_mirrors m
  set desired_revision = m.desired_revision + 1,
      next_attempt_at = pg_catalog.now(),
      attempts = 0,
      last_error = null
  from public.appointments a
  where a.client_id = new.id
    and m.appointment_id = a.id;
  return new;
end;
$$;

create trigger clients_record_calendar_mirrors
  after update of first_name on public.clients
  for each row
  when (old.first_name is distinct from new.first_name)
  execute function private.record_client_mirrors();

-- ---------------------------------------------------------------------------
-- The connection decides the outbound authority
-- ---------------------------------------------------------------------------

-- Disconnected: outbound stops (no new enrollment, workers stale). Another
-- Google account: the dedicated calendar belongs to the former one and is
-- never written with the new credentials; a new explicit activation is
-- needed. Runs in the disconnection or reconnection transaction.
create function private.outbound_follow_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'disconnected' and old.status <> 'disconnected' then
    update private.calendar_outbound o
    set status = 'disabled',
        generation = gen_random_uuid(),
        provider_calendar_id = null,
        action_code = null,
        creation_claim_id = null,
        creation_lease_until = null,
        creation_requested_at = null,
        creation_next_attempt_at = null
    where o.connection_id = new.id
      and o.status <> 'disabled';
  end if;
  if new.provider_account_id is distinct from old.provider_account_id then
    update private.calendar_outbound o
    set status = 'disabled',
        generation = gen_random_uuid(),
        provider_calendar_id = null,
        action_code = 'account_changed',
        creation_claim_id = null,
        creation_lease_until = null,
        creation_requested_at = null,
        creation_next_attempt_at = null
    where o.connection_id = new.id
      and o.provider_account_id <> new.provider_account_id;
  end if;
  return new;
end;
$$;

create trigger calendar_connections_outbound
  after update of status, provider_account_id on public.calendar_connections
  for each row execute function private.outbound_follow_connection();

-- ---------------------------------------------------------------------------
-- Inbound exclusion: a calendar created by the app never blocks
-- ---------------------------------------------------------------------------

alter table public.external_calendars
  add column booking_outbound boolean not null default false;
grant select (booking_outbound) on public.external_calendars to authenticated;

-- `booking_outbound` is exactly the local, established knowledge: the
-- calendar's id is in this business's history of calendars the app created
-- and adopted (after proof at the provider). Never a description, a name
-- or any text the professional can edit or copy. Such a calendar can never
-- be selected as a blocking source. A calendar attributed to another
-- business (same Google account) is not this one's: here it stays an
-- ordinary calendar, selectable and blocking when selected.
create function private.guard_outbound_calendar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.booking_outbound := exists (
    select 1 from private.calendar_outbound_calendars h
    where h.business_id = new.business_id
      and h.provider_calendar_id = new.provider_calendar_id
  );
  if new.booking_outbound and new.selected_for_blocking then
    if tg_op = 'UPDATE' and not old.selected_for_blocking then
      raise exception using errcode = 'P0001', message = 'calendar_not_selectable';
    end if;
    new.selected_for_blocking := false;
    new.sync_status := 'pending';
    new.last_synced_at := null;
  end if;
  return new;
end;
$$;

create trigger external_calendars_guard_outbound
  before insert or update on public.external_calendars
  for each row execute function private.guard_outbound_calendar();

-- Removes the sync state and the copied events of app-created calendars.
create function private.exclude_outbound_calendars(p_business_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from private.external_calendar_sync s
  using public.external_calendars c
  where s.calendar_id = c.id
    and c.business_id = p_business_id
    and c.booking_outbound;
  delete from public.external_calendar_events e
  using public.external_calendars c
  where e.external_calendar_id = c.id
    and c.business_id = p_business_id
    and c.booking_outbound;
end;
$$;

-- Same as 20261008 (calendar lists), plus: a calendar whose id the app
-- created and adopted for this business is flagged `booking_outbound`
-- (trigger above) and never blocks. A description is never trusted.
create or replace function private.save_calendars(p_connection_id uuid, p_business_id uuid, p_calendars jsonb)
returns void
language plpgsql
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

  perform private.exclude_outbound_calendars(p_business_id);

  delete from public.external_calendars c
  where c.connection_id = p_connection_id
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_calendars) item
      where item->>'id' = c.provider_calendar_id
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Professional's interface (session, membership checked here)
-- ---------------------------------------------------------------------------

create function private.outbound_status(p_business_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'connectionStatus', c.status,
    'writeAuthorized', coalesce(c.status <> 'disconnected' and private.has_write_scope(c.scopes), false),
    'status', coalesce(o.status, 'disabled'),
    'actionCode', o.action_code,
    'calendarCreated', o.provider_calendar_id is not null,
    'enabledAt', o.enabled_at,
    'lastError', o.last_error,
    'pendingCount', (
      select pg_catalog.count(*) from private.appointment_calendar_mirrors m
      where m.business_id = p_business_id and m.desired_revision > m.applied_revision
    ),
    'errorCount', (
      select pg_catalog.count(*) from private.appointment_calendar_mirrors m
      where m.business_id = p_business_id and m.desired_revision > m.applied_revision
        and m.attempts > 0
    )
  )
  from (select p_business_id as business_id) b
  left join public.calendar_connections c
    on c.business_id = b.business_id and c.provider = 'google'
  left join private.calendar_outbound o on o.business_id = b.business_id;
$$;

create function public.calendar_outbound_status(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_agenda_access(p_business_id);
  return private.outbound_status(p_business_id);
end;
$$;

-- Enables outbound (first time, after a disable, or to reactivate after an
-- action required): a new generation, and the dedicated calendar is created
-- or recovered by the next worker. Idempotent while creating or active.
create function public.calendar_outbound_enable(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.calendar_connections;
  v_outbound private.calendar_outbound;
begin
  perform private.assert_agenda_access(p_business_id);

  -- Lock order: connection row (share), then the outbound row. Everything
  -- below uses the connection as read under the lock: a reconnection to
  -- another account either committed before (its values are used here) or
  -- waits for this transaction (and then disables this activation itself,
  -- outbound_follow_connection). A value read before the lock is never the
  -- authority.
  select c.* into v_connection
  from public.calendar_connections c
  where c.business_id = p_business_id and c.provider = 'google'
  for share;
  if v_connection.id is null or v_connection.status = 'disconnected' then
    raise exception using errcode = 'P0001', message = 'calendar_not_connected';
  end if;
  if v_connection.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'calendar_reauth_required';
  end if;
  if not private.has_write_scope(v_connection.scopes) then
    raise exception using errcode = 'P0001', message = 'calendar_write_authorization_required';
  end if;

  insert into private.calendar_outbound (
    business_id, connection_id, provider_account_id, status, enabled_at
  )
  values (
    p_business_id, v_connection.id, v_connection.provider_account_id,
    'disabled', null
  )
  on conflict (business_id) do nothing;

  select o.* into v_outbound
  from private.calendar_outbound o
  where o.business_id = p_business_id
  for update;

  if v_outbound.status in ('disabled', 'action_required') then
    update private.calendar_outbound o
    set status = 'creating',
        generation = gen_random_uuid(),
        connection_id = v_connection.id,
        -- Another account: a new marker (the former calendar is never
        -- looked for with these credentials).
        calendar_marker = case
          when o.provider_account_id = v_connection.provider_account_id then o.calendar_marker
          else gen_random_uuid()
        end,
        provider_account_id = v_connection.provider_account_id,
        provider_calendar_id = null,
        action_code = null,
        -- A new, explicit creation attempt: its own nonce. It still starts
        -- by looking for a calendar a former attempt may have created.
        creation_nonce = gen_random_uuid(),
        creation_claim_id = null,
        creation_lease_until = null,
        creation_requested_at = null,
        creation_attempts = 0,
        creation_recovery_attempts = 0,
        creation_next_attempt_at = null,
        last_error = null,
        enabled_at = pg_catalog.now()
    where o.business_id = p_business_id;
  end if;

  return private.outbound_status(p_business_id);
end;
$$;

-- Disables outbound: workers lose their authority at once, no appointment
-- is enrolled any more. Events already in Google stay (no remote cleanup).
create function public.calendar_outbound_disable(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_agenda_access(p_business_id);

  update private.calendar_outbound o
  set status = 'disabled',
      generation = gen_random_uuid(),
      provider_calendar_id = null,
      action_code = case when o.action_code = 'account_changed' then o.action_code end,
      creation_claim_id = null,
      creation_lease_until = null,
      creation_requested_at = null,
      creation_next_attempt_at = null
  where o.business_id = p_business_id
    and o.status <> 'disabled';

  return private.outbound_status(p_business_id);
end;
$$;

-- Retries now what is waiting for a backoff (mirrors, calendar creation).
create function public.calendar_outbound_retry(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_agenda_access(p_business_id);

  update private.calendar_outbound o
  set creation_next_attempt_at = null,
      creation_attempts = 0
  where o.business_id = p_business_id
    and o.status = 'creating';

  update private.appointment_calendar_mirrors m
  set next_attempt_at = pg_catalog.now(),
      attempts = 0
  where m.business_id = p_business_id
    and m.desired_revision > m.applied_revision
    and m.next_attempt_at > pg_catalog.now();

  return private.outbound_status(p_business_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Workers (service role only)
-- ---------------------------------------------------------------------------

-- Outbound configurations whose dedicated calendar is due to be created.
create function public.calendar_outbound_due_creations(p_limit integer default 20)
returns table (business_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select o.business_id
  from private.calendar_outbound o
  join public.calendar_connections c on c.id = o.connection_id
  where o.status = 'creating'
    and (o.creation_next_attempt_at is null or o.creation_next_attempt_at <= pg_catalog.now())
    and (o.creation_lease_until is null or o.creation_lease_until < pg_catalog.now())
    and c.status = 'active'
    and c.provider_account_id = o.provider_account_id
    and private.has_write_scope(c.scopes)
  order by o.creation_next_attempt_at nulls first, o.business_id
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- Whether a creation claim still has authority: same claim, outbound still
-- creating under the captured generation, connection still the captured
-- incarnation and account. Lock order: connection (share), outbound row;
-- both stay locked until the caller's transaction ends, so its write is
-- made under the authority checked here.
--
-- Strictly true or false, never null: a released claim (creation_claim_id
-- null: a worker finished, another may have claimed and released since) or
-- a missing row is a rejection. `=` and not `is not distinct from`: a null
-- claim never matches a released one. Callers test `is not true`.
create function private.creation_claim_valid(
  p_business_id uuid,
  p_claim_id uuid,
  p_generation uuid,
  p_credential_generation uuid
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_connection public.calendar_connections;
  v_outbound private.calendar_outbound;
begin
  select c.* into v_connection
  from public.calendar_connections c
  join private.calendar_outbound o on o.connection_id = c.id
  where o.business_id = p_business_id
  for share of c;

  select o.* into v_outbound
  from private.calendar_outbound o
  where o.business_id = p_business_id
  for update;

  return coalesce(
    v_outbound.status = 'creating'
      and v_outbound.creation_claim_id = p_claim_id
      and v_outbound.generation = p_generation
      and v_connection.status = 'active'
      and v_connection.credential_generation = p_credential_generation
      and v_connection.provider_account_id = v_outbound.provider_account_id,
    false
  );
end;
$$;

-- Claims the creation of the dedicated calendar (one worker at a time).
-- `requested`: an insert of this attempt was sent and its outcome is
-- unknown (a lost answer may hide a calendar Google created): the worker
-- only searches, it never sends another insert for this attempt.
-- `knownCalendarIds`: calendars of this account the app created and
-- adopted before (proven), most recent first.
create function public.calendar_outbound_begin_creation(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbound private.calendar_outbound;
  v_connection public.calendar_connections;
  v_business public.businesses;
  v_claim uuid := gen_random_uuid();
begin
  select c.* into v_connection
  from public.calendar_connections c
  join private.calendar_outbound o on o.connection_id = c.id
  where o.business_id = p_business_id
  for share of c;
  if v_connection.id is null or v_connection.status <> 'active'
    or not private.has_write_scope(v_connection.scopes) then
    return null;
  end if;

  select o.* into v_outbound
  from private.calendar_outbound o
  where o.business_id = p_business_id
  for update;
  if v_outbound.status is distinct from 'creating'
    or v_outbound.provider_account_id <> v_connection.provider_account_id
    or v_outbound.creation_lease_until > pg_catalog.now()
    or v_outbound.creation_next_attempt_at > pg_catalog.now() then
    return null;
  end if;

  update private.calendar_outbound o
  set creation_claim_id = v_claim,
      creation_lease_until = pg_catalog.now() + interval '2 minutes'
  where o.business_id = p_business_id;

  select b.* into v_business from public.businesses b where b.id = p_business_id;

  return pg_catalog.jsonb_build_object(
    'claimId', v_claim,
    'generation', v_outbound.generation,
    'connectionId', v_connection.id,
    'credentialGeneration', v_connection.credential_generation,
    'marker', v_outbound.calendar_marker,
    'nonce', v_outbound.creation_nonce,
    'businessName', v_business.name,
    'timezone', v_business.timezone,
    'requested', v_outbound.creation_requested_at is not null,
    'knownCalendarIds', (
      select coalesce(pg_catalog.jsonb_agg(h.provider_calendar_id order by h.created_at desc), '[]'::jsonb)
      from private.calendar_outbound_calendars h
      where h.business_id = p_business_id
        and h.provider_account_id = v_outbound.provider_account_id
    )
  );
end;
$$;

-- Recorded (and committed) before calendars.insert is sent. Once set for
-- this attempt it is never granted again: false means no insert may be
-- sent (another one already was, its outcome unknown).
create function public.calendar_outbound_mark_creation_requested(
  p_business_id uuid,
  p_claim_id uuid,
  p_generation uuid,
  p_credential_generation uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.creation_claim_valid(
    p_business_id, p_claim_id, p_generation, p_credential_generation
  ) is not true then
    return false;
  end if;
  update private.calendar_outbound o
  set creation_requested_at = pg_catalog.now()
  where o.business_id = p_business_id
    and o.creation_requested_at is null
    and o.creation_lease_until > pg_catalog.now();
  return found;
end;
$$;

-- Which of these calendars this business may not adopt: their id is
-- attributed to another business, or to this one under another Google
-- account. Read by the creation worker before any provider write to a
-- candidate (the sentinel included): a calendar of another business never
-- receives anything from this one. Advisory only: the attribution itself is
-- decided atomically by calendar_outbound_adopt_calendar.
create function public.calendar_outbound_attributed_elsewhere(
  p_business_id uuid,
  p_provider_calendar_ids text[]
)
returns table (provider_calendar_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select h.provider_calendar_id
  from private.calendar_outbound_calendars h
  left join private.calendar_outbound o on o.business_id = p_business_id
  where h.provider = 'google'
    and h.provider_calendar_id = any (p_provider_calendar_ids)
    and (h.business_id <> p_business_id
         or h.provider_account_id is distinct from o.provider_account_id)
  order by h.provider_calendar_id;
$$;

-- Adopts the dedicated calendar (created now, or a candidate whose
-- ownership was proven at the provider, or one adopted before), only for
-- the claim, generation and credentials that found it, and only if the
-- calendar is, or becomes now, this business's own. Its attribution is
-- decided here, atomically, by the history's key: a calendar attributed to
-- another business (or to this one under another Google account) is
-- refused, whatever the provider proved, and nothing is adopted, replayed
-- or excluded for it ('attributed_elsewhere'). Otherwise its id is in the
-- history from now on (never an inbound blocking source) and every enrolled
-- mirror converges to it ('adopted'). Without authority: 'superseded'.
create function public.calendar_outbound_adopt_calendar(
  p_business_id uuid,
  p_claim_id uuid,
  p_generation uuid,
  p_credential_generation uuid,
  p_provider_calendar_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbound private.calendar_outbound;
  v_owner private.calendar_outbound_calendars;
begin
  if coalesce(pg_catalog.char_length(p_provider_calendar_id), 0) not between 1 and 1024 then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  -- Connection (share) and outbound row, held until commit.
  if private.creation_claim_valid(
    p_business_id, p_claim_id, p_generation, p_credential_generation
  ) is not true then
    return 'superseded';
  end if;
  select o.* into v_outbound
  from private.calendar_outbound o
  where o.business_id = p_business_id;

  -- The attribution, never decided by an earlier read: the key admits one
  -- row per calendar id. A concurrent adoption of the same id (another
  -- business) waits on this insert, or this insert on its own, until that
  -- transaction ends; the owner read next is the committed one.
  insert into private.calendar_outbound_calendars (
    provider, provider_calendar_id, business_id, provider_account_id
  )
  values ('google', p_provider_calendar_id, p_business_id, v_outbound.provider_account_id)
  on conflict (provider, provider_calendar_id) do nothing;

  select h.* into v_owner
  from private.calendar_outbound_calendars h
  where h.provider = 'google'
    and h.provider_calendar_id = p_provider_calendar_id
  for key share;
  if v_owner.business_id is distinct from p_business_id
    or v_owner.provider_account_id is distinct from v_outbound.provider_account_id then
    return 'attributed_elsewhere';
  end if;

  -- Recomputed from the history (trigger), then cleaned.
  update public.external_calendars c
  set booking_outbound = true
  where c.business_id = p_business_id
    and c.provider_calendar_id = p_provider_calendar_id
    and not c.booking_outbound;
  perform private.exclude_outbound_calendars(p_business_id);

  update private.calendar_outbound o
  set status = 'active',
      provider_calendar_id = p_provider_calendar_id,
      creation_claim_id = null,
      creation_lease_until = null,
      creation_requested_at = null,
      creation_attempts = 0,
      creation_recovery_attempts = 0,
      creation_next_attempt_at = null,
      last_error = null
  where o.business_id = p_business_id;

  -- A new incarnation (another calendar: the former one was deleted, or
  -- belongs to another Google account): every mirror already enrolled
  -- whose appointment must still exist and whose event is not in this
  -- calendar is replayed to it. Nothing of it is applied in the new target
  -- (applied_revision 0); its latest desired revision is kept, and the
  -- normal worker inserts it with the same deterministic id. A cancelled or
  -- deleted appointment is never recreated. Driven by this business's
  -- mirrors only: appointments are never scanned (never-enrolled ones are
  -- the backfill's, #11b).
  update private.appointment_calendar_mirrors m
  set applied_revision = 0
  from public.appointments a
  where m.business_id = p_business_id
    and a.id = m.appointment_id
    and a.business_id = p_business_id
    and a.status <> 'cancelled'
    and m.applied_revision > 0
    and m.provider_calendar_id is distinct from p_provider_calendar_id;

  -- What was recorded meanwhile (action required, creation) and what is
  -- replayed is due now.
  update private.appointment_calendar_mirrors m
  set next_attempt_at = pg_catalog.now(),
      attempts = 0,
      claim_id = null,
      lease_until = null
  where m.business_id = p_business_id
    and m.desired_revision > m.applied_revision;
  return 'adopted';
end;
$$;

-- The outcome of a creation step that did not adopt a calendar, recorded
-- only with the claim's full authority (claim, generation, credentials):
--   definite   the insert was refused, nothing was created: the attempt
--              may send an insert again (bounded backoff);
--   ambiguous  the insert may have been processed (timeout, network, 5xx):
--              no insert any more for this attempt, searches only;
--   not_found  a search after an ambiguous insert found nothing: retried
--              (bounded), then calendar_creation_uncertain;
--   multiple   several proven candidates: never chosen arbitrarily,
--              calendar_creation_uncertain;
--   forbidden  the write scope is missing: write_authorization_required;
--   retry      the search itself failed (provider unavailable).
create function public.calendar_outbound_creation_failed(
  p_business_id uuid,
  p_claim_id uuid,
  p_generation uuid,
  p_credential_generation uuid,
  p_outcome text,
  p_error text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbound private.calendar_outbound;
  v_action text;
begin
  if p_outcome is null or p_outcome not in (
    'definite', 'ambiguous', 'not_found', 'multiple', 'forbidden', 'retry'
  ) then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  -- Connection (share) and outbound row, held until the write below.
  if private.creation_claim_valid(
    p_business_id, p_claim_id, p_generation, p_credential_generation
  ) is not true then
    return 'superseded';
  end if;
  select o.* into v_outbound
  from private.calendar_outbound o
  where o.business_id = p_business_id;

  v_action := case
    when p_outcome = 'forbidden' then 'write_authorization_required'
    when p_outcome = 'multiple' then 'calendar_creation_uncertain'
    when p_outcome = 'not_found' and v_outbound.creation_recovery_attempts + 1 >= 5
      then 'calendar_creation_uncertain'
  end;

  if v_action is not null then
    update private.calendar_outbound o
    set status = 'action_required',
        action_code = v_action,
        generation = gen_random_uuid(),
        creation_claim_id = null,
        creation_lease_until = null,
        creation_next_attempt_at = null,
        creation_recovery_attempts = o.creation_recovery_attempts
          + case when p_outcome = 'not_found' then 1 else 0 end,
        last_error = pg_catalog.left(p_error, 64)
    where o.business_id = p_business_id;
    return v_action;
  end if;

  update private.calendar_outbound o
  set creation_claim_id = null,
      creation_lease_until = null,
      creation_requested_at = case
        when p_outcome = 'definite' then null else o.creation_requested_at
      end,
      creation_attempts = o.creation_attempts
        + case when p_outcome in ('definite', 'retry') then 1 else 0 end,
      creation_recovery_attempts = o.creation_recovery_attempts
        + case when p_outcome = 'not_found' then 1 else 0 end,
      creation_next_attempt_at = pg_catalog.now() + case
        -- A calendar that may exist is looked for again soon, a few times.
        when p_outcome in ('ambiguous', 'not_found')
          then interval '1 minute' * power(2, least(o.creation_recovery_attempts, 4))
        else least(interval '1 hour', interval '30 seconds' * power(2, least(o.creation_attempts, 7)))
      end,
      last_error = pg_catalog.left(p_error, 64)
  where o.business_id = p_business_id;
  return 'retry';
end;
$$;

-- Claims due mirrors of active outbound configurations, fairly: at most
-- p_per_business per business, oldest due first. Each claim captures the
-- outbound generation, the credential generation and the desired revision;
-- the appointment is read after the mirror is locked (the data matches the
-- revision). For an appointment that must exist, the target calendar is
-- recorded before any provider call: a lost insert answer can always be
-- found and removed later.
create function public.calendar_outbound_claim_mirrors(
  p_limit integer default 50,
  p_business_id uuid default null,
  p_per_business integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_mirror private.appointment_calendar_mirrors;
  v_appointment record;
  v_items jsonb := '[]'::jsonb;
  v_active boolean;
  v_previous text;
begin
  for v_candidate in
    select ranked.appointment_id, ranked.generation, ranked.credential_generation,
           ranked.connection_id, ranked.target
    from (
      select m.appointment_id, m.next_attempt_at, o.generation,
             c.credential_generation, c.id as connection_id,
             o.provider_calendar_id as target,
             pg_catalog.row_number() over (
               partition by m.business_id order by m.next_attempt_at, m.appointment_id
             ) as rank
      from private.appointment_calendar_mirrors m
      join private.calendar_outbound o on o.business_id = m.business_id
      join public.calendar_connections c on c.id = o.connection_id
      where m.desired_revision > m.applied_revision
        and m.next_attempt_at <= pg_catalog.now()
        and (m.lease_until is null or m.lease_until < pg_catalog.now())
        and (p_business_id is null or m.business_id = p_business_id)
        and o.status = 'active'
        and c.status = 'active'
        and c.provider_account_id = o.provider_account_id
        and private.has_write_scope(c.scopes)
    ) ranked
    where ranked.rank <= least(greatest(coalesce(p_per_business, 10), 1), 50)
    order by ranked.rank, ranked.next_attempt_at, ranked.appointment_id
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  loop
    select m.provider_calendar_id into v_previous
    from private.appointment_calendar_mirrors m
    where m.appointment_id = v_candidate.appointment_id;

    select a.id, a.status::text as status, a.starts_at, a.ends_at,
           a.service_name_snapshot, cl.first_name
    into v_appointment
    from public.appointments a
    left join public.clients cl on cl.id = a.client_id
    where a.id = v_candidate.appointment_id;

    v_active := v_appointment.id is not null and v_appointment.status <> 'cancelled';

    -- Re-checked under the row lock: another worker may have claimed it.
    update private.appointment_calendar_mirrors m
    set claim_id = gen_random_uuid(),
        lease_until = pg_catalog.now() + interval '2 minutes',
        claim_generation = v_candidate.generation,
        claim_credential_generation = v_candidate.credential_generation,
        provider_calendar_id = case when v_active then v_candidate.target else m.provider_calendar_id end
    where m.appointment_id = v_candidate.appointment_id
      and m.desired_revision > m.applied_revision
      and m.next_attempt_at <= pg_catalog.now()
      and (m.lease_until is null or m.lease_until < pg_catalog.now())
    returning m.* into v_mirror;
    if v_mirror.appointment_id is null then
      continue;
    end if;

    -- Read again after the lock: the appointment state of this revision.
    select a.id, a.status::text as status, a.starts_at, a.ends_at,
           a.service_name_snapshot, cl.first_name
    into v_appointment
    from public.appointments a
    left join public.clients cl on cl.id = a.client_id
    where a.id = v_candidate.appointment_id;
    if (v_appointment.id is not null and v_appointment.status <> 'cancelled') <> v_active then
      -- Changed between the two reads: the newer revision is claimed next.
      update private.appointment_calendar_mirrors m
      set claim_id = null, lease_until = null
      where m.appointment_id = v_mirror.appointment_id;
      v_mirror := null;
      continue;
    end if;

    v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'appointmentId', v_mirror.appointment_id,
      'businessId', v_mirror.business_id,
      'claimId', v_mirror.claim_id,
      'generation', v_candidate.generation,
      'connectionId', v_candidate.connection_id,
      'credentialGeneration', v_candidate.credential_generation,
      'revision', v_mirror.desired_revision,
      'eventId', v_mirror.event_id,
      'targetCalendarId', v_candidate.target,
      'previousCalendarId', v_previous,
      'active', v_active,
      'startsAt', v_appointment.starts_at,
      'endsAt', v_appointment.ends_at,
      'serviceName', v_appointment.service_name_snapshot,
      'clientFirstName', v_appointment.first_name
    ));
    v_mirror := null;
  end loop;
  return v_items;
end;
$$;

-- Whether a mirror's claim still has authority: same claim, outbound still
-- active under the captured generation, connection still the captured
-- incarnation. Locks the outbound row (share) then the mirror (order).
-- Never for a null claim: a released mirror's claim is null too.
create function private.mirror_claim_valid(
  p_appointment_id uuid,
  p_claim_id uuid
)
returns private.appointment_calendar_mirrors
language plpgsql
set search_path = ''
as $$
declare
  v_mirror private.appointment_calendar_mirrors;
  v_valid boolean;
begin
  select m.* into v_mirror
  from private.appointment_calendar_mirrors m
  where m.appointment_id = p_appointment_id;
  if v_mirror.appointment_id is null then
    return null;
  end if;

  perform 1 from private.calendar_outbound o
  where o.business_id = v_mirror.business_id
  for share;

  select m.* into v_mirror
  from private.appointment_calendar_mirrors m
  where m.appointment_id = p_appointment_id
  for update;

  select exists (
    select 1
    from private.calendar_outbound o
    join public.calendar_connections c on c.id = o.connection_id
    where o.business_id = v_mirror.business_id
      and o.status = 'active'
      and o.generation = v_mirror.claim_generation
      and c.status = 'active'
      and c.credential_generation = v_mirror.claim_credential_generation
      and c.provider_account_id = o.provider_account_id
  ) into v_valid;

  if p_claim_id is null
    or v_mirror.claim_id is distinct from p_claim_id
    or v_valid is not true then
    return null;
  end if;
  return v_mirror;
end;
$$;

-- The provider applied `p_revision`: recorded only with authority. A newer
-- revision recorded meanwhile stays due (latest state wins).
create function public.calendar_outbound_complete_mirror(
  p_appointment_id uuid,
  p_claim_id uuid,
  p_revision bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mirror private.appointment_calendar_mirrors;
begin
  v_mirror := private.mirror_claim_valid(p_appointment_id, p_claim_id);
  if v_mirror.appointment_id is null then
    return 'superseded';
  end if;
  update private.appointment_calendar_mirrors m
  set applied_revision = greatest(m.applied_revision, p_revision),
      claim_id = null,
      lease_until = null,
      attempts = 0,
      last_error = null,
      next_attempt_at = pg_catalog.now()
  where m.appointment_id = p_appointment_id;
  return 'applied';
end;
$$;

-- A failed attempt of this mirror only: retried after a bounded backoff.
create function public.calendar_outbound_fail_mirror(
  p_appointment_id uuid,
  p_claim_id uuid,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mirror private.appointment_calendar_mirrors;
begin
  v_mirror := private.mirror_claim_valid(p_appointment_id, p_claim_id);
  if v_mirror.appointment_id is null then
    return false;
  end if;
  update private.appointment_calendar_mirrors m
  set claim_id = null,
      lease_until = null,
      attempts = m.attempts + 1,
      next_attempt_at = pg_catalog.now()
        + least(interval '6 hours', interval '30 seconds' * power(2, least(m.attempts, 10)))
          * (0.8 + random() * 0.4),
      last_error = pg_catalog.left(p_error, 64)
  where m.appointment_id = p_appointment_id;
  return true;
end;
$$;

-- A configuration-level failure (the dedicated calendar was deleted, the
-- write authorization is missing) found by a mirror worker: outbound waits
-- for the professional, under a new generation. Only with the full
-- authority of the worker's claim (claim, outbound generation, credential
-- generation, account): a late answer of a stale worker changes nothing.
-- Desired states keep being recorded; no mirror retries.
--
-- The authority is held from the check to the write, in the global order:
-- connection row (share), outbound row (update), mirror. A reconnection
-- (new credential generation, same account included) either committed
-- before the check, which then sees it (stale: nothing written), or waits
-- for this transaction: it never slips between the check and the update.
create function public.calendar_outbound_mark_action_required(
  p_appointment_id uuid,
  p_claim_id uuid,
  p_action_code text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_id uuid;
  v_mirror private.appointment_calendar_mirrors;
begin
  if p_action_code is null
    or p_action_code not in ('calendar_deleted', 'write_authorization_required') then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  select m.business_id into v_business_id
  from private.appointment_calendar_mirrors m
  where m.appointment_id = p_appointment_id;
  if v_business_id is null then
    return false;
  end if;

  -- 1. The connection row, before anything is checked.
  perform 1
  from public.calendar_connections c
  join private.calendar_outbound o on o.connection_id = c.id
  where o.business_id = v_business_id
  for share of c;
  -- 2. The outbound row, for the update below (never a share lock
  -- upgraded later: two workers reporting at once would deadlock).
  perform 1
  from private.calendar_outbound o
  where o.business_id = v_business_id
  for update;
  -- 3. The mirror, and the claim's authority read under those locks.
  v_mirror := private.mirror_claim_valid(p_appointment_id, p_claim_id);
  if v_mirror.appointment_id is null then
    return false;
  end if;

  update private.calendar_outbound o
  set status = 'action_required',
      action_code = p_action_code,
      generation = gen_random_uuid(),
      provider_calendar_id = null,
      creation_claim_id = null,
      creation_lease_until = null,
      creation_requested_at = null,
      creation_next_attempt_at = null,
      last_error = pg_catalog.left(coalesce(p_error, p_action_code), 64)
  where o.business_id = v_mirror.business_id
    and o.status = 'active'
    and o.generation = v_mirror.claim_generation;
  if not found then
    return false;
  end if;

  update private.appointment_calendar_mirrors m
  set claim_id = null, lease_until = null
  where m.business_id = v_mirror.business_id
    and m.claim_id is not null;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function private.has_write_scope(text[]) from public;
revoke all on function private.mirror_event_id(uuid) from public;
revoke all on function private.record_appointment_mirror() from public;
revoke all on function private.record_client_mirrors() from public;
revoke all on function private.outbound_follow_connection() from public;
revoke all on function private.guard_outbound_calendar() from public;
revoke all on function private.exclude_outbound_calendars(uuid) from public;
revoke all on function private.outbound_status(uuid) from public;
revoke all on function private.mirror_claim_valid(uuid, uuid) from public;
revoke all on function private.creation_claim_valid(uuid, uuid, uuid, uuid) from public;

do $$
declare
  v_signature text;
begin
  -- The professional (session; membership checked inside).
  foreach v_signature in array array[
    'public.calendar_begin_oauth(uuid, text, text, text, text)',
    'public.calendar_consume_oauth_state(text)',
    'public.calendar_outbound_status(uuid)',
    'public.calendar_outbound_enable(uuid)',
    'public.calendar_outbound_disable(uuid)',
    'public.calendar_outbound_retry(uuid)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;

  -- Workers and the OAuth callback's privileged step (service role only).
  foreach v_signature in array array[
    'public.calendar_add_write_authorization(uuid, uuid, text, text[], text, text, timestamptz)',
    'public.calendar_outbound_due_creations(integer)',
    'public.calendar_outbound_begin_creation(uuid)',
    'public.calendar_outbound_mark_creation_requested(uuid, uuid, uuid, uuid)',
    'public.calendar_outbound_attributed_elsewhere(uuid, text[])',
    'public.calendar_outbound_adopt_calendar(uuid, uuid, uuid, uuid, text)',
    'public.calendar_outbound_creation_failed(uuid, uuid, uuid, uuid, text, text)',
    'public.calendar_outbound_claim_mirrors(integer, uuid, integer)',
    'public.calendar_outbound_complete_mirror(uuid, uuid, bigint)',
    'public.calendar_outbound_fail_mirror(uuid, uuid, text)',
    'public.calendar_outbound_mark_action_required(uuid, uuid, text, text)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
