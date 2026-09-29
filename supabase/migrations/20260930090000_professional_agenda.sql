-- Professional agenda V1: the professional's view and edits of the one
-- schedule that public booking already writes to.
--
-- No new calendar model. Appointments stay in public.appointments, blocks in
-- public.availability_exceptions (kind 'blocked' / 'closed'), and every
-- guarantee of the booking engine applies unchanged:
--   * `appointments_no_overlap` (GiST, buffer included) between appointments;
--   * the schedule triggers between appointments and blocks
--     (`schedule_conflict`), serialised by the per-business schedule lock;
--   * READ COMMITTED only for writes that take the schedule lock.
--
-- Additions:
--   1. `version` on appointments and availability_exceptions, bumped by a
--      trigger on every UPDATE whatever the code path: optimistic concurrency
--      for edits made from a stale screen (`stale_appointment`,
--      `stale_block`). An integer rather than updated_at: it survives any
--      JSON / JavaScript round trip exactly.
--   2. `appointments.creation_request_id` + `creation_request_fingerprint`:
--      optional idempotency key of a manual creation, bound to a SHA-256 of
--      the canonical command (service, UTC start, client, notes). A retry of
--      the same command returns the first result; the same key with another
--      command is refused (`idempotency_conflict`), never answered with the
--      first appointment.
--   3. `clients.email` becomes optional: a professional can add a client
--      known only by name or phone. Public booking still requires an email and
--      still deduplicates on (business_id, email).
--   4. Appointment writes for professionals, as SECURITY DEFINER RPCs
--      (authenticated has no write policy on appointments):
--        agenda_create_appointment, agenda_update_appointment,
--        agenda_set_appointment_status.
--      Each checks the session (auth.uid()) and the membership of the
--      business before anything else; every row is then addressed by
--      (id, business_id), so an identifier of another tenant is simply
--      "not found".
--   5. search_clients: tenant-scoped client lookup (SECURITY INVOKER, RLS on).
--
-- Blocks keep the existing write path (RLS-filtered DML whose triggers take
-- the schedule lock and refuse overlaps); the agenda only adds the version
-- condition.

-- ---------------------------------------------------------------------------
-- Optimistic concurrency
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column version integer not null default 1 check (version >= 1);
alter table public.availability_exceptions
  add column version integer not null default 1 check (version >= 1);

create function private.bump_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

revoke all on function private.bump_version() from public;

create trigger appointments_bump_version
  before update on public.appointments
  for each row execute function private.bump_version();
create trigger availability_exceptions_bump_version
  before update on public.availability_exceptions
  for each row execute function private.bump_version();

comment on column public.appointments.version is
  'Incremented on every update. Edits carry the version they were based on.';
comment on column public.availability_exceptions.version is
  'Incremented on every update. Edits carry the version they were based on.';

-- ---------------------------------------------------------------------------
-- Idempotent manual creation
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column creation_request_id uuid,
  add column creation_request_fingerprint text,
  add constraint appointments_creation_request_fingerprint_present check (
    (creation_request_id is null) = (creation_request_fingerprint is null)
  );

create unique index appointments_creation_request_idx
  on public.appointments (business_id, creation_request_id)
  where creation_request_id is not null;

comment on column public.appointments.creation_request_id is
  'Idempotency key of a manual creation (one per submitted form).';
comment on column public.appointments.creation_request_fingerprint is
  'SHA-256 (hex) of the canonical creation command bound to creation_request_id.';

-- ---------------------------------------------------------------------------
-- Clients known without email
-- ---------------------------------------------------------------------------

-- unique (business_id, email) keeps deduplicating non-null emails; several
-- clients without email may coexist.
alter table public.clients alter column email drop not null;

create index clients_business_phone_idx
  on public.clients (business_id, phone)
  where phone is not null;

-- ---------------------------------------------------------------------------
-- Shared checks
-- ---------------------------------------------------------------------------

-- Session + membership, before any read of tenant data.
create function private.assert_agenda_access(p_business_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;

  if p_business_id is null or not exists (
    select 1
    from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = (select auth.uid())
  ) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

revoke all on function private.assert_agenda_access(uuid) from public;

-- Optional text: Unicode NFC, trimmed, empty → null, bounded. NFC makes
-- canonically equivalent spellings identical ("É" precomposed or "E" +
-- combining acute), both in stored values and in idempotency fingerprints.
create function private.optional_text(p_value text, p_max integer, p_field text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_value, 'NFC')), '');
begin
  if v_value is not null and pg_catalog.char_length(v_value) > p_max then
    raise exception using errcode = '22023', message = 'invalid_input', hint = p_field;
  end if;

  return v_value;
end;
$$;

revoke all on function private.optional_text(text, integer, text) from public;

-- ---------------------------------------------------------------------------
-- Manual creation
-- ---------------------------------------------------------------------------

-- Creates a confirmed appointment placed by a professional.
--
-- The server decides everything that shapes the schedule: duration, price
-- and name from the active service; buffer and currency from the settings;
-- end = start + duration. Opening hours, minimum notice and maximum advance
-- are booking rules for clients and do not apply here, but overlaps do,
-- exactly as for public booking: same schedule lock, same exclusion
-- constraint (buffer included), same block triggers.
--
-- Client: an existing client of this business (p_client_id), or a new one
-- from minimal fields. A new client whose email already exists in this
-- business reuses that record without modifying it.
create function public.agenda_create_appointment(
  p_business_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_client_id uuid default null,
  p_client_first_name text default null,
  p_client_last_name text default null,
  p_client_email text default null,
  p_client_phone text default null,
  p_internal_notes text default null,
  p_request_id uuid default null
)
returns table (appointment_id uuid, created boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_first_name text := private.optional_text(p_client_first_name, 120, 'firstName');
  v_last_name text := private.optional_text(p_client_last_name, 120, 'lastName');
  v_email text := pg_catalog.lower(private.optional_text(p_client_email, 254, 'email'));
  v_phone text := private.optional_text(p_client_phone, 30, 'phone');
  v_notes text := private.optional_text(p_internal_notes, 2000, 'internalNotes');
  v_service public.services%rowtype;
  v_settings public.business_settings%rowtype;
  v_client_id uuid;
  v_appointment_id uuid;
  v_fingerprint text;
  v_existing_fingerprint text;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_starts_at is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'startsAt';
  end if;
  if p_client_id is null and v_first_name is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'firstName';
  end if;
  if p_client_id is not null and coalesce(v_first_name, v_last_name, v_email, v_phone) is not null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;
  if v_email is not null
    and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'email';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ().-]{6,30}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'phone';
  end if;

  -- 1. Schedule lock first (lock order convention), then fresh snapshots.
  perform private.lock_business_schedule(p_business_id);

  -- 2. Idempotency. The key is bound to the canonical command: normalised
  --    inputs (NFC, trimmed, email lower-cased), start as UTC epoch (independent of the session time zone),
  --    jsonb key order. Under the schedule lock, a concurrent use of the same
  --    key has either committed (and is compared here) or not started.
  if p_request_id is not null then
    v_fingerprint := pg_catalog.encode(
      extensions.digest(
        pg_catalog.jsonb_build_object(
          'service_id', p_service_id,
          'starts_at_epoch', extract(epoch from p_starts_at),
          'client_id', p_client_id,
          'client_first_name', v_first_name,
          'client_last_name', v_last_name,
          'client_email', v_email,
          'client_phone', v_phone,
          'internal_notes', v_notes
        )::text,
        'sha256'
      ),
      'hex'
    );

    select a.id, a.creation_request_fingerprint
    into v_appointment_id, v_existing_fingerprint
    from public.appointments a
    where a.business_id = p_business_id
      and a.creation_request_id = p_request_id;

    if found then
      if v_existing_fingerprint <> v_fingerprint then
        raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
      end if;

      return query select v_appointment_id, false;
      return;
    end if;
  end if;

  -- 3. Values used for the whole transaction, locked against changes.
  select s.* into v_service
  from public.services s
  where s.id = p_service_id
    and s.business_id = p_business_id
    and s.active
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'service_unavailable', hint = 'serviceId';
  end if;

  select st.* into v_settings
  from public.business_settings st
  where st.business_id = p_business_id
  for share;

  -- 4. Client, strictly within this business.
  if p_client_id is not null then
    select c.id into v_client_id
    from public.clients c
    where c.id = p_client_id
      and c.business_id = p_business_id;

    if not found then
      raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
    end if;
  else
    if v_email is not null then
      insert into public.clients (business_id, first_name, last_name, email, phone)
      values (p_business_id, v_first_name, v_last_name, v_email, v_phone)
      on conflict (business_id, email) do nothing
      returning id into v_client_id;

      if v_client_id is null then
        select c.id into v_client_id
        from public.clients c
        where c.business_id = p_business_id
          and c.email operator(extensions.=) v_email::extensions.citext;
      end if;
    else
      insert into public.clients (business_id, first_name, last_name, phone)
      values (p_business_id, v_first_name, v_last_name, v_phone)
      returning id into v_client_id;
    end if;
  end if;

  -- 5. Insert. The exclusion constraint and the block trigger decide.
  begin
    insert into public.appointments (
      business_id,
      client_id,
      service_id,
      starts_at,
      ends_at,
      status,
      service_name_snapshot,
      duration_minutes_snapshot,
      price_cents_snapshot,
      currency,
      buffer_minutes_snapshot,
      internal_notes,
      created_by,
      creation_request_id,
      creation_request_fingerprint
    )
    values (
      p_business_id,
      v_client_id,
      v_service.id,
      p_starts_at,
      p_starts_at + pg_catalog.make_interval(mins => v_service.duration_minutes),
      'confirmed',
      v_service.name,
      v_service.duration_minutes,
      v_service.price_cents,
      v_settings.currency,
      v_settings.buffer_minutes,
      v_notes,
      (select auth.uid()),
      p_request_id,
      v_fingerprint
    )
    returning id into v_appointment_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'schedule_conflict';
  end;

  return query select v_appointment_id, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Edit / reschedule
-- ---------------------------------------------------------------------------

-- Replaces the editable fields of an appointment with the submitted state.
--
-- * p_starts_at null keeps the stored instant exactly: an edit that does
--   not touch the time never goes through a wall-clock → UTC conversion
--   (which is ambiguous in the repeated autumn hour).
-- * p_expected_version must be the version the form was loaded with,
--   otherwise `stale_appointment` (nothing is overwritten).
-- * Start, service and client can only change while the appointment is
--   `confirmed` (`appointment_not_editable` otherwise); internal notes can
--   always be edited.
-- * Same service: the frozen duration, price and buffer are kept (what was
--   booked). New service: duration, name and price from the service (active
--   only), buffer and currency from the current settings.
-- * Any change of occupancy goes through the schedule lock, the exclusion
--   constraint and the block trigger (`schedule_conflict`).
create function public.agenda_update_appointment(
  p_business_id uuid,
  p_appointment_id uuid,
  p_expected_version integer,
  p_service_id uuid,
  p_client_id uuid,
  p_internal_notes text default null,
  p_starts_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_notes text := private.optional_text(p_internal_notes, 2000, 'internalNotes');
  v_current public.appointments%rowtype;
  v_service public.services%rowtype;
  v_settings public.business_settings%rowtype;
  v_duration integer;
  v_price integer;
  v_name text;
  v_buffer integer;
  v_currency text;
  v_starts_at timestamptz;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_expected_version is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;
  if p_service_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'serviceId';
  end if;
  if p_client_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;

  perform private.lock_business_schedule(p_business_id);

  select a.* into v_current
  from public.appointments a
  where a.id = p_appointment_id
    and a.business_id = p_business_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'appointment_not_found';
  end if;

  if v_current.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_appointment';
  end if;

  v_starts_at := coalesce(p_starts_at, v_current.starts_at);

  if v_current.status <> 'confirmed' and (
    v_current.starts_at <> v_starts_at
    or v_current.service_id <> p_service_id
    or v_current.client_id <> p_client_id
  ) then
    raise exception using errcode = 'P0001', message = 'appointment_not_editable';
  end if;

  if p_client_id <> v_current.client_id and not exists (
    select 1
    from public.clients c
    where c.id = p_client_id
      and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  if p_service_id = v_current.service_id then
    v_duration := v_current.duration_minutes_snapshot;
    v_price := v_current.price_cents_snapshot;
    v_name := v_current.service_name_snapshot;
    v_buffer := v_current.buffer_minutes_snapshot;
    v_currency := v_current.currency;
  else
    select s.* into v_service
    from public.services s
    where s.id = p_service_id
      and s.business_id = p_business_id
      and s.active
    for share;

    if not found then
      raise exception using errcode = 'P0002', message = 'service_unavailable', hint = 'serviceId';
    end if;

    select st.* into v_settings
    from public.business_settings st
    where st.business_id = p_business_id
    for share;

    v_duration := v_service.duration_minutes;
    v_price := v_service.price_cents;
    v_name := v_service.name;
    v_buffer := v_settings.buffer_minutes;
    v_currency := v_settings.currency;
  end if;

  begin
    update public.appointments a
    set
      starts_at = v_starts_at,
      ends_at = v_starts_at + pg_catalog.make_interval(mins => v_duration),
      service_id = p_service_id,
      client_id = p_client_id,
      service_name_snapshot = v_name,
      duration_minutes_snapshot = v_duration,
      price_cents_snapshot = v_price,
      buffer_minutes_snapshot = v_buffer,
      currency = v_currency,
      internal_notes = v_notes
    where a.id = p_appointment_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'schedule_conflict';
  end;

  return p_appointment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Status
-- ---------------------------------------------------------------------------

-- Allowed transitions (anything else: `invalid_status_transition`):
--
--   confirmed → cancelled | completed | no_show
--   no_show   → confirmed | completed          (correction)
--   completed → confirmed                      (correction, only while no
--                                               loyalty point was granted)
--   cancelled → (terminal: book a new appointment instead)
--
-- `completed` and `no_show` require the appointment to have started.
-- Requesting the current status again is a no-op success (double submit).
--
-- Occupancy: only `cancelled` frees the slot (appointments_no_overlap ignores
-- cancelled rows); completed and no_show keep it, as in the booking engine.
-- None of these transitions adds occupancy, so no schedule lock is needed
-- (same rule as 20260928190000: writes that only free time take no lock).
create function public.agenda_set_appointment_status(
  p_business_id uuid,
  p_appointment_id uuid,
  p_expected_version integer,
  p_status public.appointment_status,
  p_cancellation_reason text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := private.optional_text(p_cancellation_reason, 500, 'cancellationReason');
  v_current public.appointments%rowtype;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_status is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'status';
  end if;
  if p_expected_version is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;

  select a.* into v_current
  from public.appointments a
  where a.id = p_appointment_id
    and a.business_id = p_business_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'appointment_not_found';
  end if;

  if v_current.status = p_status then
    return p_appointment_id;
  end if;

  if v_current.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_appointment';
  end if;

  if not (
    (v_current.status = 'confirmed' and p_status in ('cancelled', 'completed', 'no_show'))
    or (v_current.status = 'no_show' and p_status in ('confirmed', 'completed'))
    or (v_current.status = 'completed' and p_status = 'confirmed')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_status_transition', hint = 'status';
  end if;

  if p_status in ('completed', 'no_show') and v_current.starts_at > pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'invalid_status_transition', hint = 'status';
  end if;

  if v_current.status = 'completed' and exists (
    select 1
    from public.loyalty_events l
    where l.business_id = p_business_id
      and l.appointment_id = p_appointment_id
      and l.type = 'appointment_completed'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_status_transition', hint = 'status';
  end if;

  update public.appointments a
  set
    status = p_status,
    completed_at = case when p_status = 'completed' then pg_catalog.now() end,
    cancellation_reason = case when p_status = 'cancelled' then v_reason end
  where a.id = p_appointment_id;

  return p_appointment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client lookup
-- ---------------------------------------------------------------------------

-- Case- and accent-sensitive substring search on name, email and phone of the
-- clients of one business. SECURITY INVOKER: RLS applies on top of the
-- explicit business filter. LIKE wildcards in the query are escaped.
create function public.search_clients(
  p_business_id uuid,
  p_query text,
  p_limit integer default 10
)
returns table (
  id uuid,
  first_name text,
  last_name text,
  email text,
  phone text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select '%' || pg_catalog.replace(
      pg_catalog.replace(
        pg_catalog.replace(pg_catalog.btrim(p_query), '\', '\\'),
        '%', '\%'),
      '_', '\_') || '%' as pattern
  )
  select c.id, c.first_name, c.last_name, c.email::text, c.phone
  from public.clients c, q
  where c.business_id = p_business_id
    and pg_catalog.char_length(pg_catalog.btrim(p_query)) >= 2
    and (
      c.first_name ilike q.pattern
      or c.last_name ilike q.pattern
      or (c.first_name || ' ' || coalesce(c.last_name, '')) ilike q.pattern
      or c.email::text ilike q.pattern
      or c.phone ilike q.pattern
    )
  order by c.last_name nulls last, c.first_name, c.id
  limit least(greatest(coalesce(p_limit, 10), 1), 25);
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.agenda_create_appointment(
  uuid, uuid, timestamptz, uuid, text, text, text, text, text, uuid
) from public, anon;
revoke all on function public.agenda_update_appointment(
  uuid, uuid, integer, uuid, uuid, text, timestamptz
) from public, anon;
revoke all on function public.agenda_set_appointment_status(
  uuid, uuid, integer, public.appointment_status, text
) from public, anon;
revoke all on function public.search_clients(uuid, text, integer) from public, anon;

grant execute on function public.agenda_create_appointment(
  uuid, uuid, timestamptz, uuid, text, text, text, text, text, uuid
) to authenticated;
grant execute on function public.agenda_update_appointment(
  uuid, uuid, integer, uuid, uuid, text, timestamptz
) to authenticated;
grant execute on function public.agenda_set_appointment_status(
  uuid, uuid, integer, public.appointment_status, text
) to authenticated;
grant execute on function public.search_clients(uuid, text, integer) to authenticated;
