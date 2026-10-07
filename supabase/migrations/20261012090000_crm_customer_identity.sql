-- CRM V1, step 1: the customer domain, its identity and appointment linking.
--
-- The customer entity already exists: public.clients is business-scoped
-- (business 1 → N clients), every appointment references one client of its
-- own business (composite foreign key (client_id, business_id)), and
-- clients are never Supabase Auth users (no credentials, no auth.users
-- link). This migration makes that entity the CRM customer instead of
-- adding a parallel table:
--
--   1. One normalization, in the database: private.canonical_email (Unicode
--      NFC, trimmed, lower-cased, empty → null). A trigger applies it to
--      every write of clients.email, whatever the path (RPC, member DML,
--      service role). The
--      existing unique (business_id, email) is therefore uniqueness of the
--      canonical email within a business. No global identity, no fuzzy or
--      provider-specific rule (dots and +tags stay significant), no phone
--      identity.
--   2. private.resolve_client: the one resolution used by every creation
--      path (public booking, manual agenda creation), inside the caller's
--      booking transaction. Atomic INSERT … ON CONFLICT on the canonical
--      email; an existing customer is reused and only its missing last name
--      / phone are filled (never an overwrite). Without email, a new
--      customer record: an empty email is never an identity.
--   3. Contact snapshots on appointments (client_*_snapshot): the contact as
--      submitted for that appointment, kept as history whatever later
--      happens to the customer record. Never rewritten except when a
--      professional moves the appointment to another customer.
--   4. Backfill of history: snapshots from the linked records, then
--      customers of one business whose emails are the same canonical email
--      (whitespace, case or Unicode-form variants left by direct writes) are
--      merged into one, deterministically; then stored emails become
--      canonical.
--
-- Google Calendar is unaffected: the outbound event still carries the
-- customer's first name only (never email, phone or customer id), and
-- external events never create customers.

-- ---------------------------------------------------------------------------
-- 1. Canonical email
-- ---------------------------------------------------------------------------

create function private.canonical_email(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    pg_catalog.lower(pg_catalog.btrim(pg_catalog.normalize(p_value, 'NFC'))),
    ''
  );
$$;

revoke all on function private.canonical_email(text) from public;

comment on function private.canonical_email(text) is
  'The customer identity key: NFC, trimmed, lower-cased email; null when empty.';

-- ---------------------------------------------------------------------------
-- 2. Contact snapshots on appointments
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column client_first_name_snapshot text,
  add column client_last_name_snapshot text,
  add column client_email_snapshot text,
  add column client_phone_snapshot text;

comment on column public.appointments.client_first_name_snapshot is
  'Contact as submitted for this appointment (history; the customer record may change).';
comment on column public.appointments.client_last_name_snapshot is
  'Contact as submitted for this appointment (history; the customer record may change).';
comment on column public.appointments.client_email_snapshot is
  'Canonical email as submitted for this appointment (history; never an identity).';
comment on column public.appointments.client_phone_snapshot is
  'Contact as submitted for this appointment (history; the customer record may change).';

-- History: before this migration the submitted contact was not kept per
-- appointment; the best record of it is the linked customer as it is now,
-- taken before any merge below. Filling a new column is not an edit:
-- version and updated_at stay as they are (no stale form, no mirror change:
-- the calendar trigger ignores these columns).
alter table public.appointments disable trigger appointments_bump_version;
alter table public.appointments disable trigger set_appointments_updated_at;

update public.appointments a
set client_first_name_snapshot = c.first_name,
    client_last_name_snapshot = nullif(pg_catalog.btrim(c.last_name), ''),
    client_email_snapshot = private.canonical_email(c.email::text),
    client_phone_snapshot = nullif(pg_catalog.btrim(c.phone), '')
from public.clients c
where c.id = a.client_id
  and c.business_id = a.business_id;

alter table public.appointments enable trigger appointments_bump_version;
alter table public.appointments enable trigger set_appointments_updated_at;

-- ---------------------------------------------------------------------------
-- 3. Backfill: one customer per canonical email within a business
-- ---------------------------------------------------------------------------

-- Groups: customers of one business whose emails have the same canonical
-- form. Survivor: the earliest record (created_at, then id). Its non-empty
-- values are kept; a missing last name / phone / loyalty token is taken from
-- the latest record of the group that has one (created_at desc, id desc).
-- Internal notes are never lost: the others' notes are appended, oldest
-- first. Every reference (appointments, loyalty, redemptions, emails) moves
-- to the survivor; the other records are then removed. Appointment snapshots
-- (filled above) keep each appointment's own contact.
create temporary table crm_customer_merge as
with keyed as (
  select
    c.id,
    c.business_id,
    c.created_at,
    private.canonical_email(c.email::text) as canonical
  from public.clients c
  where c.email is not null
)
select
  k.id,
  k.business_id,
  k.created_at,
  pg_catalog.first_value(k.id) over (
    partition by k.business_id, k.canonical
    order by k.created_at, k.id
  ) as survivor
from keyed k
where k.canonical is not null;

delete from crm_customer_merge m
where not exists (
  select 1 from crm_customer_merge o
  where o.survivor = m.survivor and o.id <> m.id
);

update public.clients s
set last_name = coalesce(
      nullif(pg_catalog.btrim(s.last_name), ''),
      (select c.last_name
       from crm_customer_merge m
       join public.clients c on c.id = m.id
       where m.survivor = s.id
         and nullif(pg_catalog.btrim(c.last_name), '') is not null
       order by c.created_at desc, c.id desc
       limit 1)
    ),
    phone = coalesce(
      nullif(pg_catalog.btrim(s.phone), ''),
      (select c.phone
       from crm_customer_merge m
       join public.clients c on c.id = m.id
       where m.survivor = s.id
         and nullif(pg_catalog.btrim(c.phone), '') is not null
       order by c.created_at desc, c.id desc
       limit 1)
    ),
    internal_notes = nullif(
      pg_catalog.concat_ws(
        E'\n\n',
        nullif(pg_catalog.btrim(s.internal_notes), ''),
        (select pg_catalog.string_agg(c.internal_notes, E'\n\n' order by c.created_at, c.id)
         from crm_customer_merge m
         join public.clients c on c.id = m.id
         where m.survivor = s.id
           and c.id <> s.id
           and nullif(pg_catalog.btrim(c.internal_notes), '') is not null)
      ),
      ''
    )
where s.id in (select m.survivor from crm_customer_merge m);

update public.appointments a
set client_id = m.survivor
from crm_customer_merge m
where a.client_id = m.id
  and m.id <> m.survivor;
update public.loyalty_events e
set client_id = m.survivor
from crm_customer_merge m
where e.client_id = m.id
  and m.id <> m.survivor;
update public.reward_redemptions r
set client_id = m.survivor
from crm_customer_merge m
where r.client_id = m.id
  and m.id <> m.survivor;
update public.email_events e
set client_id = m.survivor
from crm_customer_merge m
where e.client_id = m.id
  and m.id <> m.survivor;

-- The loyalty token is unique: the survivor takes one only once the others
-- are gone.
create temporary table crm_customer_token as
select distinct on (m.survivor) m.survivor, c.loyalty_token_hash
from crm_customer_merge m
join public.clients c on c.id = m.id
where m.id <> m.survivor
  and c.loyalty_token_hash is not null
order by m.survivor, c.created_at desc, c.id desc;

delete from public.clients c
using crm_customer_merge m
where c.id = m.id
  and m.id <> m.survivor;

update public.clients s
set loyalty_token_hash = t.loyalty_token_hash
from crm_customer_token t
where s.id = t.survivor
  and s.loyalty_token_hash is null;

drop table crm_customer_token;
drop table crm_customer_merge;

-- Stored emails become canonical (an empty one becomes null).
update public.clients c
set email = private.canonical_email(c.email::text)
where c.email is not null
  and c.email::text is distinct from private.canonical_email(c.email::text);

-- ---------------------------------------------------------------------------
-- 4. The invariant, whatever the write path
-- ---------------------------------------------------------------------------

create function private.canonicalize_client_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.email := private.canonical_email(new.email::text);
  return new;
end;
$$;

revoke all on function private.canonicalize_client_email() from public;

-- Before the uniqueness check, so ON CONFLICT arbitrates canonical values.
create trigger clients_canonicalize_email
  before insert or update of email on public.clients
  for each row execute function private.canonicalize_client_email();

comment on column public.clients.email is
  'Canonical email (private.canonical_email): the customer identity within the business. Null: no email identity.';

-- ---------------------------------------------------------------------------
-- 5. Snapshots follow the appointment, not the customer record
-- ---------------------------------------------------------------------------

-- Insert: a path that does not submit a contact (an existing customer
-- chosen by id, arrangement inserts) gets the linked record's contact.
-- Update: unchanged while the appointment stays with its customer (an
-- attempt to rewrite them is refused); moved to another customer by a
-- professional, it takes that customer's contact.
create function private.snapshot_appointment_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.client_id is not distinct from old.client_id then
      if new.client_first_name_snapshot is distinct from old.client_first_name_snapshot
        or new.client_last_name_snapshot is distinct from old.client_last_name_snapshot
        or new.client_email_snapshot is distinct from old.client_email_snapshot
        or new.client_phone_snapshot is distinct from old.client_phone_snapshot then
        raise exception using errcode = '55000', message = 'contact_snapshot_immutable';
      end if;
      return new;
    end if;
  elsif new.client_first_name_snapshot is not null then
    new.client_email_snapshot := private.canonical_email(new.client_email_snapshot);
    return new;
  end if;

  select
    c.first_name,
    nullif(pg_catalog.btrim(c.last_name), ''),
    c.email::text,
    nullif(pg_catalog.btrim(c.phone), '')
  into
    new.client_first_name_snapshot,
    new.client_last_name_snapshot,
    new.client_email_snapshot,
    new.client_phone_snapshot
  from public.clients c
  where c.id = new.client_id
    and c.business_id = new.business_id;

  -- Not found: the composite foreign key refuses the row right after (and,
  -- for an API role, row level security before it), with their own errors.

  return new;
end;
$$;

revoke all on function private.snapshot_appointment_contact() from public;

create trigger appointments_snapshot_contact
  before insert or update on public.appointments
  for each row execute function private.snapshot_appointment_contact();

-- ---------------------------------------------------------------------------
-- 6. Resolution
-- ---------------------------------------------------------------------------

-- The customer of p_business_id for this contact, inside the caller's
-- transaction (the booking's, after its schedule lock). Private: no API
-- role can call it, so it never answers whether an email is known.
--
-- * Email (canonicalized here): INSERT … ON CONFLICT on
--   (business_id, email). Concurrent resolutions of one email converge on
--   one record. An existing record keeps every non-empty value; only a
--   missing last name / phone is filled from the submission. The first
--   name (required) is never changed, so the calendar title never changes
--   by a booking.
-- * No email: a new customer record (never matched to another by name or
--   phone).
--
-- Lock order: the caller holds the business schedule lock; the existing
-- customer row is then locked (FOR NO KEY UPDATE, by ON CONFLICT). No path
-- holding a customer row waits for the schedule lock (member edits of a
-- customer touch only calendar mirror rows).
create function private.resolve_client(
  p_business_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone text
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_email text := private.canonical_email(p_email);
  v_last_name text := nullif(pg_catalog.btrim(p_last_name), '');
  v_phone text := nullif(pg_catalog.btrim(p_phone), '');
  v_client_id uuid;
begin
  if v_email is null then
    insert into public.clients (business_id, first_name, last_name, phone)
    values (p_business_id, p_first_name, v_last_name, v_phone)
    returning id into v_client_id;
    return v_client_id;
  end if;

  insert into public.clients as c (business_id, first_name, last_name, email, phone)
  values (p_business_id, p_first_name, v_last_name, v_email, v_phone)
  on conflict (business_id, email) do update
  set last_name = coalesce(nullif(pg_catalog.btrim(c.last_name), ''), excluded.last_name),
      phone = coalesce(nullif(pg_catalog.btrim(c.phone), ''), excluded.phone)
  where (nullif(pg_catalog.btrim(c.last_name), '') is null and excluded.last_name is not null)
     or (nullif(pg_catalog.btrim(c.phone), '') is null and excluded.phone is not null)
  returning c.id into v_client_id;

  if v_client_id is null then
    -- Existing and complete: nothing to fill (the row is locked all the
    -- same by ON CONFLICT and visible to this statement).
    select c.id into v_client_id
    from public.clients c
    where c.business_id = p_business_id
      and c.email operator(extensions.=) v_email::extensions.citext;
  end if;

  return v_client_id;
end;
$$;

revoke all on function private.resolve_client(uuid, text, text, text, text) from public;

-- ---------------------------------------------------------------------------
-- 7. Creation paths
-- ---------------------------------------------------------------------------

-- Public booking: identical to 20261001090000 except the email
-- (private.canonical_email), the customer (private.resolve_client) and the
-- contact snapshot (the submitted values). The answer is the same whether
-- the customer existed or not.
create or replace function private.create_public_booking_at(
  p_now timestamptz,
  p_slug text,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_first_name text,
  p_email text,
  p_last_name text default null,
  p_phone text default null
)
returns table (
  appointment_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  service_name text,
  duration_minutes integer,
  price_cents integer,
  currency text,
  business_name text
)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_business_id uuid;
  v_business_slug text;
  v_business_name text;
  v_timezone text;
  v_currency text;
  v_step integer;
  v_buffer integer;
  v_notice integer;
  v_max_days integer;
  v_service_name text;
  v_duration integer;
  v_price integer;
  v_first_name text := pg_catalog.btrim(p_first_name);
  v_last_name text := nullif(pg_catalog.btrim(p_last_name), '');
  v_email text := private.canonical_email(p_email);
  v_phone text := nullif(pg_catalog.btrim(p_phone), '');
  v_ends_at timestamptz;
  v_client_id uuid;
  v_appointment_id uuid;
begin
  if v_first_name is null or pg_catalog.char_length(v_first_name) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'invalid_first_name';
  end if;
  if v_last_name is not null and pg_catalog.char_length(v_last_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid_last_name';
  end if;
  if v_email is null
    or pg_catalog.char_length(v_email) > 254
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid_email';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ().-]{6,30}$' then
    raise exception using errcode = '22023', message = 'invalid_phone';
  end if;
  if p_starts_at is null then
    raise exception using errcode = '22023', message = 'invalid_starts_at';
  end if;

  v_business_id := private.business_id_by_slug(p_slug);

  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;

  -- 1. Serialise with every other write to this schedule (bookings, blocks,
  --    weekly hours). Statements below run on snapshots taken after the lock.
  perform private.lock_business_schedule(v_business_id);

  -- 2. Read business, settings and service once and lock them in share mode
  --    until commit: a concurrent change either commits before (and is read
  --    here) or waits for this transaction. These values are the only ones
  --    used for validation, occupied window and insertion.
  select
    b.slug::text, b.name, b.timezone,
    st.currency, st.slot_interval_minutes, st.buffer_minutes,
    st.minimum_booking_notice_minutes, st.maximum_booking_advance_days,
    s.name, s.duration_minutes, s.price_cents
  into
    v_business_slug, v_business_name, v_timezone,
    v_currency, v_step, v_buffer, v_notice, v_max_days,
    v_service_name, v_duration, v_price
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  join public.services s on s.business_id = b.id
  where b.id = v_business_id
    and s.id = p_service_id
    and s.active
  for share of b, st, s;

  if not found then
    raise exception using errcode = 'P0002', message = 'service_not_found';
  end if;

  -- 3. Validate the requested start with exactly those values, on the real
  --    civil day that contains it (the day the listing attributed it to).
  if not exists (
    select 1
    from private.compute_available_slots(
      v_business_id,
      private.local_date_of(p_starts_at, v_timezone),
      p_now,
      v_timezone,
      v_duration,
      v_step,
      v_buffer,
      v_notice,
      v_max_days
    ) slot
    where slot.starts_at = p_starts_at
  ) then
    raise exception using errcode = 'P0001', message = 'slot_unavailable';
  end if;

  v_ends_at := p_starts_at + pg_catalog.make_interval(mins => v_duration);

  -- The customer of this business with this email: found or created in
  -- this transaction, atomically (private.resolve_client).
  v_client_id := private.resolve_client(
    v_business_id, v_first_name, v_last_name, v_email, v_phone
  );

  -- 4. Insert with the same values. The exclusion constraint and the schedule
  --    triggers remain the final guarantees.
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
      client_first_name_snapshot,
      client_last_name_snapshot,
      client_email_snapshot,
      client_phone_snapshot
    )
    values (
      v_business_id,
      v_client_id,
      p_service_id,
      p_starts_at,
      v_ends_at,
      'confirmed',
      v_service_name,
      v_duration,
      v_price,
      v_currency,
      v_buffer,
      v_first_name,
      v_last_name,
      v_email,
      v_phone
    )
    returning id into v_appointment_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'slot_unavailable';
    when raise_exception then
      if sqlerrm = 'schedule_conflict' then
        raise exception using errcode = 'P0001', message = 'slot_unavailable';
      end if;
      raise;
  end;

  insert into public.email_events (
    business_id,
    client_id,
    appointment_id,
    type,
    recipient_email,
    payload,
    dedupe_key
  )
  values (
    v_business_id,
    v_client_id,
    v_appointment_id,
    'booking_confirmation',
    v_email,
    pg_catalog.jsonb_build_object(
      'appointment_id', v_appointment_id,
      'business_slug', v_business_slug,
      'business_name', v_business_name,
      'timezone', v_timezone,
      'service_name', v_service_name,
      'starts_at', p_starts_at,
      'ends_at', v_ends_at,
      'local_starts_at', private.wall_clock(p_starts_at, v_timezone),
      'local_ends_at', private.wall_clock(v_ends_at, v_timezone),
      'client_first_name', v_first_name
    ),
    'booking_confirmation:' || v_appointment_id::text
  );

  return query
  select
    v_appointment_id,
    p_starts_at,
    v_ends_at,
    v_timezone,
    v_service_name,
    v_duration,
    v_price,
    v_currency,
    v_business_name;
end;
$$;

-- Manual creation: identical to 20260930090000 except the email
-- (private.canonical_email, after the same validation), a new customer
-- (private.resolve_client) and the contact snapshot.
create or replace function public.agenda_create_appointment(
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
  v_email text := private.canonical_email(private.optional_text(p_client_email, 254, 'email'));
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
    -- Same resolution as public booking: an email is the customer's
    -- identity in this business; without one, a new customer record.
    v_client_id := private.resolve_client(
      p_business_id, v_first_name, v_last_name, v_email, v_phone
    );
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
      creation_request_fingerprint,
      client_first_name_snapshot,
      client_last_name_snapshot,
      client_email_snapshot,
      client_phone_snapshot
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
      v_fingerprint,
      -- New customer: the submitted contact. Existing one (p_client_id):
      -- null, the snapshot trigger copies that record.
      v_first_name,
      v_last_name,
      v_email,
      v_phone
    )
    returning id into v_appointment_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'schedule_conflict';
  end;

  return query select v_appointment_id, true;
end;
$$;
