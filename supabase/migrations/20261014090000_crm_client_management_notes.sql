-- CRM V1, step 3: managing customers and private dated notes (professionals
-- only). Backend only; the CRM screens of step 2 are unchanged.
--
--   1. Manual creation of a customer (public.crm_create_client) and edition
--      of its identity and contact (public.crm_update_client). The customer
--      entity stays public.clients with its identity rules
--      (20261012090000): the email, canonicalized by the database
--      (private.canonical_email, through the clients trigger), is the only
--      identity within a business; a name or a phone never is. Neither
--      function ever merges or fills another record: an email already used
--      by another customer of the business is answered as a conflict naming
--      that customer, and nothing is written.
--   2. clients.version (optimistic concurrency, as appointments) and
--      clients.creation_request_id / creation_request_fingerprint
--      (idempotent creation, as appointments): a retried or double
--      submission creates one customer.
--   3. public.client_notes: private dated notes about a customer, written
--      by the business's professionals. Authorship and dates belong to the
--      database: members may change the content only (column privileges),
--      and an author reference becomes null only when that profile is
--      really deleted (its foreign key). The legacy free text
--      clients.internal_notes is neither migrated nor changed; it is only
--      read back (crm_list_client_notes, `legacyNotes`).
--   4. private.client_note_requests: the durable record of every processed
--      note creation request. It outlives the note: a replayed request
--      never writes a note again, even once its note is deleted. It keeps
--      no content (a fingerprint), is unreachable from the API and goes
--      with the customer.
--
-- Security: every function is SECURITY INVOKER: row level security on
-- clients, client_notes, appointments and email_events stays the authority
-- for every read and write; each function also refuses a caller who is not
-- a member of p_business_id (`forbidden`, public.crm_assert_member) and
-- filters every statement by p_business_id. Executable by authenticated
-- only (never anon). Public booking never reads client_notes.
--
-- History is never rewritten: appointment contact snapshots stay as
-- submitted (their trigger refuses any rewrite), and queued emails keep the
-- recipient they were recorded with (email_events.recipient_email). A
-- contact edit changes the customer record only; the edit answers how many
-- upcoming appointments and queued emails keep another address.
--
-- Google Calendar is unaffected: the existing trigger marks a customer's
-- mirrors due when, and only when, the first name (the event title)
-- changes, exactly as for any other write of clients.

-- ---------------------------------------------------------------------------
-- 1. Customer records: version and idempotent creation
-- ---------------------------------------------------------------------------

alter table public.clients
  add column version integer not null default 1 check (version >= 1),
  add column creation_request_id uuid,
  add column creation_request_fingerprint text,
  add constraint clients_creation_request_fingerprint_present check (
    (creation_request_id is null) = (creation_request_fingerprint is null)
  );

-- Every write path (these functions, bookings filling a missing phone,
-- member DML) makes earlier edits stale.
create trigger clients_bump_version
  before update on public.clients
  for each row execute function private.bump_version();

create unique index clients_creation_request_idx
  on public.clients (business_id, creation_request_id)
  where creation_request_id is not null;

comment on column public.clients.version is
  'Incremented on every update. Edits carry the version they were based on.';
comment on column public.clients.creation_request_id is
  'Idempotency key of a manual creation (crm_create_client), unique within the business.';
comment on column public.clients.creation_request_fingerprint is
  'SHA-256 of the canonical creation command bound to creation_request_id.';

-- ---------------------------------------------------------------------------
-- 2. Shared checks
-- ---------------------------------------------------------------------------

-- The customer identity key, for the invoker functions below (which cannot
-- reach the private schema): exactly private.canonical_email.
create function public.crm_canonical_email(p_value text)
returns text
language sql
immutable
parallel safe
security definer
set search_path = ''
as $$
  select private.canonical_email(p_value);
$$;

-- ---------------------------------------------------------------------------
-- 3. Manual creation
-- ---------------------------------------------------------------------------

-- Creates a customer of p_business_id from a contact typed by a
-- professional. Same rules as the booking paths for every field: first
-- name required (1–120), last name ≤ 120, email optional (canonical,
-- ≤ 254, one "@" and a dot after it), phone optional (digits, spaces,
-- ().- and a leading +, 6–30). Text is Unicode NFC and trimmed.
--
-- Outcome (one row):
--   created         a new customer, client_id;
--   replayed        p_request_id already created client_id with the same
--                   canonical command (a retry or a double submission);
--   email_conflict  another customer of this business already has this
--                   canonical email: client_id is that customer, nothing is
--                   written (never a merge, never a fill).
-- p_request_id reused for another command: idempotency_conflict.
--
-- Concurrency: one atomic INSERT … ON CONFLICT DO NOTHING arbitrated by the
-- unique (business_id, email) and (business_id, creation_request_id): two
-- concurrent creations of one email or of one request converge on one
-- record; the other is answered from it.
create function public.crm_create_client(
  p_business_id uuid,
  p_first_name text,
  p_last_name text default null,
  p_email text default null,
  p_phone text default null,
  p_request_id uuid default null
)
returns table (status text, client_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_first_name text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_first_name, 'NFC')), '');
  v_last_name text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_last_name, 'NFC')), '');
  v_email text := public.crm_canonical_email(p_email);
  v_phone text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_phone, 'NFC')), '');
  v_fingerprint text;
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_client_id uuid;
begin
  perform public.crm_assert_member(p_business_id);

  if v_first_name is null or pg_catalog.char_length(v_first_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'firstName';
  end if;
  if pg_catalog.char_length(v_last_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'lastName';
  end if;
  if v_email is not null and (
    pg_catalog.char_length(v_email) > 254
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'email';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ().-]{6,30}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'phone';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;

  -- The key is bound to the canonical command (normalized fields, jsonb key
  -- order).
  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'first_name', v_first_name,
        'last_name', v_last_name,
        'email', v_email,
        'phone', v_phone
      )::text,
      'UTF8'
    )),
    'hex'
  );

  -- 1. This request already created a customer (a retry).
  select c.id, c.creation_request_fingerprint
  into v_existing_id, v_existing_fingerprint
  from public.clients c
  where c.business_id = p_business_id
    and c.creation_request_id = p_request_id;

  if v_existing_id is null then
    -- 2. Create. Any unique conflict (this email, or this request committed
    --    meanwhile by a concurrent call) inserts nothing.
    insert into public.clients (
      business_id, first_name, last_name, email, phone,
      creation_request_id, creation_request_fingerprint
    )
    values (
      p_business_id, v_first_name, v_last_name, v_email, v_phone,
      p_request_id, v_fingerprint
    )
    on conflict do nothing
    returning id into v_client_id;

    if v_client_id is not null then
      return query select 'created'::text, v_client_id;
      return;
    end if;

    -- 3. Why nothing was inserted: the same request, committed meanwhile...
    select c.id, c.creation_request_fingerprint
    into v_existing_id, v_existing_fingerprint
    from public.clients c
    where c.business_id = p_business_id
      and c.creation_request_id = p_request_id;
  end if;

  if v_existing_id is not null then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    return query select 'replayed'::text, v_existing_id;
    return;
  end if;

  -- ... or another customer with this email.
  select c.id into v_client_id
  from public.clients c
  where c.business_id = p_business_id
    and c.email operator(extensions.=) v_email::extensions.citext;

  if v_client_id is not null then
    return query select 'email_conflict'::text, v_client_id;
    return;
  end if;

  raise exception using errcode = '40001', message = 'conflict';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Identity and contact edition
-- ---------------------------------------------------------------------------

-- Replaces the first name, last name, email and phone of one customer of
-- p_business_id (same rules as creation; null or empty removes an optional
-- field). Edits carry the version they were based on.
--
-- Outcome (one row):
--   updated         written; the version is bumped;
--   unchanged       the record already has exactly these values: nothing is
--                   written, whatever p_expected_version (a retried edit);
--   email_conflict  another customer of this business has this email:
--                   client_id is that customer, nothing is written.
-- Errors: client_not_found (not a customer of this business),
-- stale_client (changed since p_expected_version).
--
-- Plus, for the record as it now is: upcoming confirmed appointments whose
-- contact snapshot has another email, and queued emails (pending or being
-- sent) addressed to another email. Both keep their address: an edit never
-- reroutes a booking's messages.
--
-- Locks: this customer's row only (FOR UPDATE), then the calendar mirrors
-- of its appointments when the first name changes: the order of every path
-- that writes a customer. Never the business schedule lock.
create function public.crm_update_client(
  p_business_id uuid,
  p_client_id uuid,
  p_expected_version integer,
  p_first_name text,
  p_last_name text default null,
  p_email text default null,
  p_phone text default null
)
returns table (
  status text,
  client_id uuid,
  upcoming_with_other_email integer,
  queued_emails_to_other_address integer
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_first_name text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_first_name, 'NFC')), '');
  v_last_name text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_last_name, 'NFC')), '');
  v_email text := public.crm_canonical_email(p_email);
  v_phone text := nullif(pg_catalog.btrim(pg_catalog.normalize(p_phone, 'NFC')), '');
  v_current record;
  v_status text;
  v_conflict_id uuid;
begin
  perform public.crm_assert_member(p_business_id);

  if p_client_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;
  if v_first_name is null or pg_catalog.char_length(v_first_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'firstName';
  end if;
  if pg_catalog.char_length(v_last_name) > 120 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'lastName';
  end if;
  if v_email is not null and (
    pg_catalog.char_length(v_email) > 254
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'email';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ().-]{6,30}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'phone';
  end if;

  select c.version, c.first_name, c.last_name, c.email::text as email, c.phone
  into v_current
  from public.clients c
  where c.id = p_client_id
    and c.business_id = p_business_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  if (v_current.first_name, v_current.last_name, v_current.email, v_current.phone)
     is not distinct from (v_first_name, v_last_name, v_email, v_phone) then
    v_status := 'unchanged';
  elsif v_current.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_client', hint = 'expectedVersion';
  else
    begin
      update public.clients c
      set first_name = v_first_name,
          last_name = v_last_name,
          email = v_email,
          phone = v_phone
      where c.id = p_client_id
        and c.business_id = p_business_id;
    exception
      when unique_violation then
        select c.id into v_conflict_id
        from public.clients c
        where c.business_id = p_business_id
          and c.id <> p_client_id
          and c.email operator(extensions.=) v_email::extensions.citext;
        if v_conflict_id is null then
          raise;
        end if;
        return query select 'email_conflict'::text, v_conflict_id, 0, 0;
        return;
    end;
    v_status := 'updated';
  end if;

  return query
  select
    v_status,
    p_client_id,
    (select pg_catalog.count(*)::integer
     from public.appointments a
     where a.business_id = p_business_id
       and a.client_id = p_client_id
       and a.status = 'confirmed'
       and a.starts_at > pg_catalog.now()
       and a.client_email_snapshot is distinct from v_email),
    (select pg_catalog.count(*)::integer
     from public.email_events e
     where e.business_id = p_business_id
       and e.client_id = p_client_id
       and e.status in ('pending', 'processing')
       and (v_email is null
            or e.recipient_email operator(extensions.<>) v_email::extensions.citext));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Private dated notes
-- ---------------------------------------------------------------------------

-- A note's content as stored, whatever the path (the functions below, a
-- member's direct insert or edit, service role): Unicode NFC, then the
-- peripheral whitespace String.prototype.trim removes (the characters of
-- private.canonical_email; the browser applies the same NFC + trim). Line
-- breaks and spaces inside are kept. The only implementation: the guard
-- trigger and the note functions all call it.
create function public.crm_canonical_note_content(p_value text)
returns text
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select pg_catalog.btrim(
    pg_catalog.normalize(p_value, 'NFC'),
    E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'
  );
$$;

-- A note about one customer, written by a professional of its business.
-- Dated by created_at (set by the database, never by the caller): the
-- instant a timeline shows it at, unchanged by edits. updated_at, updated_by
-- and version follow edits of the content only.
create table public.client_notes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_id uuid not null,
  content text not null
    check (pg_catalog.char_length(content) between 1 and 5000 and content ~ '[^[:space:]]'),
  version integer not null default 1 check (version >= 1),
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  -- The creation request that wrote it (idempotency: see
  -- private.client_note_requests).
  creation_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The customer of the note's own business (a note of another business's
  -- customer cannot exist). Notes go with their customer.
  constraint client_notes_client_fkey foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade
);

-- One customer's notes, newest first (also the order of a future timeline
-- branch: occurred_at = created_at, then id).
create index client_notes_client_idx
  on public.client_notes (business_id, client_id, created_at desc, id desc);

comment on table public.client_notes is
  'Private dated notes about a customer, written by the business''s professionals. Never public.';
comment on column public.client_notes.created_at is
  'When the note was written (set by the database): its date.';
comment on column public.client_notes.updated_at is
  'Last change of the content (set by the database).';
comment on column public.client_notes.version is
  'Incremented on every change of the content. Edits carry the version they were based on.';

-- Whatever the write path (functions below, member DML, service role):
--   content canonical (public.crm_canonical_note_content) and 1–5000
--           characters once canonical; an edit that changes it only by
--           Unicode form or peripheral whitespace is no change;
--   insert  authorship and dates come from the database (the caller's
--           session, now()), version 1;
--   update  business, customer, date, author and creation request never
--           change (a note stays with its customer); a change of the
--           content bumps version, updated_at and updated_by; otherwise
--           they stay.
-- An author reference (created_by, updated_by) becomes null only when that
-- profile no longer exists: the ON DELETE SET NULL of its foreign key,
-- which runs after the profile's deletion. SECURITY DEFINER: the profile is
-- looked up whatever the caller may see (row level security hides other
-- users' profiles), never inferred from the caller's view.
create function private.guard_client_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 1. Canonical content (the same as the functions'), 2. validated, then
  -- stored; the request record (AFTER INSERT) fingerprints this stored text.
  new.content := public.crm_canonical_note_content(new.content);
  if new.content is null or pg_catalog.char_length(new.content) not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'content';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.updated_by := null;
    new.version := 1;
    new.created_at := pg_catalog.now();
    new.updated_at := new.created_at;
    return new;
  end if;

  if new.business_id is distinct from old.business_id
    or new.client_id is distinct from old.client_id
    or new.created_at is distinct from old.created_at
    or new.creation_request_id is distinct from old.creation_request_id
    or (new.created_by is distinct from old.created_by
        and (new.created_by is not null
             or exists (select 1 from public.profiles p where p.id = old.created_by))) then
    raise exception using errcode = '55000', message = 'client_note_immutable';
  end if;

  if new.content is distinct from old.content then
    new.version := old.version + 1;
    new.updated_at := pg_catalog.now();
    new.updated_by := (select auth.uid());
  else
    if new.updated_by is distinct from old.updated_by
      and (new.updated_by is not null
           or exists (select 1 from public.profiles p where p.id = old.updated_by)) then
      raise exception using errcode = '55000', message = 'client_note_immutable';
    end if;
    new.version := old.version;
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

revoke all on function private.guard_client_note() from public;

create trigger client_notes_guard
  before insert or update on public.client_notes
  for each row execute function private.guard_client_note();

alter table public.client_notes enable row level security;

create policy client_notes_select_member
  on public.client_notes for select to authenticated
  using (public.is_business_member(business_id));
create policy client_notes_insert_member
  on public.client_notes for insert to authenticated
  with check (public.is_business_member(business_id));
create policy client_notes_update_member
  on public.client_notes for update to authenticated
  using (public.is_business_member(business_id))
  with check (public.is_business_member(business_id));
create policy client_notes_delete_member
  on public.client_notes for delete to authenticated
  using (public.is_business_member(business_id));

-- Signed-in members only, through row level security; never anonymous.
-- Column privileges: a member writes a note's customer, content and
-- creation request, then changes its content only. Authorship, dates and
-- version are never the caller's (a table-wide UPDATE grant would override
-- these column grants, so there is none).
revoke all on table public.client_notes from anon, authenticated;
grant select, delete on table public.client_notes to authenticated;
grant insert (business_id, client_id, content, creation_request_id)
  on table public.client_notes to authenticated;
grant update (content) on table public.client_notes to authenticated;

-- ---------------------------------------------------------------------------
-- 5b. Processed note creation requests
-- ---------------------------------------------------------------------------

-- One row per creation request ever processed for a customer: the request
-- id (unique within the business), a fingerprint of the command (customer
-- and content) and the note it wrote. The row outlives the note: when the
-- note is deleted, by any path, its foreign key sets note_id to null in the
-- same transaction (the tombstone). A replayed request is thus answered
-- from here and never writes a note again.
--
-- Privacy: no content is kept, only a SHA-256 fingerprint, which is still
-- treated as sensitive (it can confirm a guess of a deleted note): the
-- table is in the private schema, readable by no API role, and no function
-- returns it. Lifecycle: the rows go with the customer (and so with the
-- business).
create table private.client_note_requests (
  business_id uuid not null,
  request_id uuid not null,
  client_id uuid not null,
  fingerprint text not null,
  note_id uuid references public.client_notes (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (business_id, request_id),
  constraint client_note_requests_client_fkey foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade
);

create index client_note_requests_note_idx
  on private.client_note_requests (note_id)
  where note_id is not null;
create index client_note_requests_client_idx
  on private.client_note_requests (business_id, client_id);

alter table private.client_note_requests enable row level security;
revoke all on table private.client_note_requests from public, anon, authenticated, service_role;

-- After a note with a creation request is inserted (any path), records the
-- request in the same transaction. A request processed before is never
-- processed again: the insert is refused with
--   client_note_replayed  same command, its note still exists (DETAIL: id);
--   client_note_deleted   same command, its note was deleted since;
--   idempotency_conflict  another customer or content.
-- Concurrency: the request's primary key makes a concurrent insert of the
-- same request wait for the first; the existing record is then locked, so
-- that a deletion of its note in progress settles before it is read.
create function private.record_client_note_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fingerprint text := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('client_id', new.client_id, 'content', new.content)::text,
      'UTF8'
    )),
    'hex'
  );
  v_existing record;
begin
  insert into private.client_note_requests (business_id, request_id, client_id, fingerprint, note_id)
  values (new.business_id, new.creation_request_id, new.client_id, v_fingerprint, new.id)
  on conflict (business_id, request_id) do nothing;

  if found then
    return null;
  end if;

  select r.fingerprint, r.note_id into v_existing
  from private.client_note_requests r
  where r.business_id = new.business_id
    and r.request_id = new.creation_request_id
  for update;

  if v_existing.fingerprint is distinct from v_fingerprint then
    raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
  end if;
  if v_existing.note_id is null then
    raise exception using errcode = 'P0001', message = 'client_note_deleted', hint = 'requestId';
  end if;
  raise exception using
    errcode = 'P0001',
    message = 'client_note_replayed',
    detail = v_existing.note_id::text,
    hint = 'requestId';
end;
$$;

revoke all on function private.record_client_note_request() from public;

create trigger client_notes_record_request
  after insert on public.client_notes
  for each row
  when (new.creation_request_id is not null)
  execute function private.record_client_note_request();

-- ---------------------------------------------------------------------------
-- 6. Notes: read
-- ---------------------------------------------------------------------------

-- One page of a customer's notes, newest first (created_at desc, id desc),
-- keyset paginated after (p_before_at, p_before_id), the last note read:
-- deterministic, no duplicate and no skip while notes are not added or
-- removed; a note written meanwhile is newer than every page and appears
-- when reading again from the first page. Returns p_limit + 1 notes at most
-- (one more tells that a next page exists) and the legacy free text of the
-- record, read only:
--   { legacyNotes, notes: [{ id, content, version, createdBy, updatedBy,
--     createdAt, updatedAt }] }
create function public.crm_list_client_notes(
  p_business_id uuid,
  p_client_id uuid,
  p_limit integer default 20,
  p_before_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_legacy text;
  v_notes jsonb;
begin
  perform public.crm_assert_member(p_business_id);

  if p_client_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'limit';
  end if;
  if (p_before_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'cursor';
  end if;

  select c.internal_notes into v_legacy
  from public.clients c
  where c.id = p_client_id
    and c.business_id = p_business_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', n.id,
        'content', n.content,
        'version', n.version,
        'createdBy', n.created_by,
        'updatedBy', n.updated_by,
        'createdAt', n.created_at,
        'updatedAt', n.updated_at
      )
      order by n.created_at desc, n.id desc
    ),
    '[]'::jsonb
  )
  into v_notes
  from (
    select *
    from public.client_notes n
    where n.business_id = p_business_id
      and n.client_id = p_client_id
      and (p_before_at is null or (n.created_at, n.id) < (p_before_at, p_before_id))
    order by n.created_at desc, n.id desc
    limit p_limit + 1
  ) n;

  return pg_catalog.jsonb_build_object('legacyNotes', v_legacy, 'notes', v_notes);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Notes: write
-- ---------------------------------------------------------------------------

-- Content: public.crm_canonical_note_content (Unicode NFC, peripheral
-- whitespace as String.prototype.trim), 1–5000 characters once canonical,
-- the same for the guard trigger: a request's fingerprint is the canonical
-- command whatever the path that first wrote it.

-- Writes a note about one customer of p_business_id, once per request.
-- Outcome:
--   created   a new note, note_id;
--   replayed  p_request_id already wrote note_id, for this customer and
--             content (a retry or a double submission);
--   deleted   p_request_id already wrote a note for this customer and
--             content, deleted since: nothing is written again (note_id
--             null).
-- Errors: client_not_found, idempotency_conflict (p_request_id used for
-- another customer or content, the note deleted or not).
-- The request is recorded by the insert itself (trigger
-- client_notes_record_request), whatever the path, in the same transaction.
create function public.crm_create_client_note(
  p_business_id uuid,
  p_client_id uuid,
  p_content text,
  p_request_id uuid
)
returns table (status text, note_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_content text := public.crm_canonical_note_content(p_content);
  v_note_id uuid;
  v_message text;
  v_detail text;
begin
  perform public.crm_assert_member(p_business_id);

  if p_client_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;
  if v_content is null or pg_catalog.char_length(v_content) not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'content';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id
      and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  begin
    insert into public.client_notes (business_id, client_id, content, creation_request_id)
    values (p_business_id, p_client_id, v_content, p_request_id)
    returning id into v_note_id;
  exception
    when raise_exception then
      get stacked diagnostics v_message = message_text, v_detail = pg_exception_detail;
      if v_message = 'client_note_replayed' then
        return query select 'replayed'::text, v_detail::uuid;
        return;
      elsif v_message = 'client_note_deleted' then
        return query select 'deleted'::text, null::uuid;
        return;
      end if;
      raise;
  end;

  return query select 'created'::text, v_note_id;
end;
$$;

-- Replaces the content of one note of one customer of p_business_id.
-- Outcome: updated (version bumped), or unchanged (the note already has
-- exactly this content: nothing is written, whatever p_expected_version).
-- Errors: note_not_found (no such note of this customer in this business),
-- stale_note (changed since p_expected_version).
create function public.crm_update_client_note(
  p_business_id uuid,
  p_client_id uuid,
  p_note_id uuid,
  p_expected_version integer,
  p_content text
)
returns table (status text, note_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_content text := public.crm_canonical_note_content(p_content);
  v_note record;
begin
  perform public.crm_assert_member(p_business_id);

  if p_client_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;
  if p_note_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'noteId';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;
  if v_content is null or pg_catalog.char_length(v_content) not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'content';
  end if;

  select n.version, n.content into v_note
  from public.client_notes n
  where n.id = p_note_id
    and n.business_id = p_business_id
    and n.client_id = p_client_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'note_not_found', hint = 'noteId';
  end if;

  if v_note.content = v_content then
    return query select 'unchanged'::text, p_note_id;
    return;
  end if;
  if v_note.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_note', hint = 'expectedVersion';
  end if;

  update public.client_notes n
  set content = v_content
  where n.id = p_note_id
    and n.business_id = p_business_id
    and n.client_id = p_client_id;

  return query select 'updated'::text, p_note_id;
end;
$$;

-- Deletes one note of one customer of p_business_id: the row and its
-- content. Its creation request, if any, stays processed (its record's
-- note_id becomes null in the same transaction, through the foreign key, as
-- for any other deletion path).
-- Outcome: deleted, or absent (no such note here: already deleted by a
-- previous call, or never one of this customer's: nothing is written, and
-- nothing tells which). Error: stale_note (the note changed since
-- p_expected_version: what would be deleted was not what was read).
create function public.crm_delete_client_note(
  p_business_id uuid,
  p_client_id uuid,
  p_note_id uuid,
  p_expected_version integer
)
returns table (status text, note_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_version integer;
begin
  perform public.crm_assert_member(p_business_id);

  if p_client_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;
  if p_note_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'noteId';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;

  select n.version into v_version
  from public.client_notes n
  where n.id = p_note_id
    and n.business_id = p_business_id
    and n.client_id = p_client_id
  for update;

  if not found then
    return query select 'absent'::text, p_note_id;
    return;
  end if;
  if v_version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_note', hint = 'expectedVersion';
  end if;

  delete from public.client_notes n
  where n.id = p_note_id
    and n.business_id = p_business_id
    and n.client_id = p_client_id;

  return query select 'deleted'::text, p_note_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: members' sessions only
-- ---------------------------------------------------------------------------

revoke all on function public.crm_canonical_email(text) from public, anon;
revoke all on function public.crm_canonical_note_content(text) from public, anon;
revoke all on function public.crm_create_client(uuid, text, text, text, text, uuid) from public, anon;
revoke all on function public.crm_update_client(uuid, uuid, integer, text, text, text, text) from public, anon;
revoke all on function public.crm_list_client_notes(uuid, uuid, integer, timestamptz, uuid) from public, anon;
revoke all on function public.crm_create_client_note(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.crm_update_client_note(uuid, uuid, uuid, integer, text) from public, anon;
revoke all on function public.crm_delete_client_note(uuid, uuid, uuid, integer) from public, anon;

grant execute on function public.crm_canonical_email(text) to authenticated;
grant execute on function public.crm_canonical_note_content(text) to authenticated;
grant execute on function public.crm_create_client(uuid, text, text, text, text, uuid) to authenticated;
grant execute on function public.crm_update_client(uuid, uuid, integer, text, text, text, text) to authenticated;
grant execute on function public.crm_list_client_notes(uuid, uuid, integer, timestamptz, uuid) to authenticated;
grant execute on function public.crm_create_client_note(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.crm_update_client_note(uuid, uuid, uuid, integer, text) to authenticated;
grant execute on function public.crm_delete_client_note(uuid, uuid, uuid, integer) to authenticated;
