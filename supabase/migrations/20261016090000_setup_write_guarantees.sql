-- Professional setup (PR #20): write guarantees of services and weekly
-- hours, found by the setup screens (docs/SETUP_WRITE_GUARANTEES_HANDOFF.md).
--
--   1. Idempotent service creation (public.create_service). A creation
--      request is processed once: a retry after a lost answer is answered
--      with the service it created, never a second one. The request is
--      recorded in private.service_creation_requests, with a fingerprint of
--      the command, and outlives its service: once that service is deleted,
--      a replay writes nothing again. Two services with the same name stay
--      possible (two requests).
--   2. services.version: optimistic concurrency of service edits, as
--      clients and appointments. The database owns the number (trigger):
--      it grows when the service itself changes (name, description,
--      duration, price, active, business), never for its position in the
--      list (reorder_services), so reordering never makes an open form
--      stale. Edits carry the version they were based on (the compare and
--      swap is the UPDATE's WHERE, see src/features/services/data).
--   3. public.replace_business_hours compares the week it replaces with the
--      week the edit was based on (p_expected), under the schedule lock:
--      a week saved on the basis of an outdated read is refused
--      (stale_business_hours) and nothing is written. The previous
--      two-argument function is dropped: no API path replaces the week
--      without this check.
--
-- Security: create_service and replace_business_hours are SECURITY DEFINER
-- (as replace_business_hours already was), check the caller's membership of
-- p_business_id first and touch that business only. Executable by
-- authenticated only. The request records are unreachable from the API.
-- Public booking, appointments (their service snapshots), the CRM, loyalty
-- and Google Calendar are unchanged.

-- ---------------------------------------------------------------------------
-- 1. Service version
-- ---------------------------------------------------------------------------

alter table public.services
  add column version integer not null default 1 check (version >= 1);

comment on column public.services.version is
  'Incremented when the service changes (not its display order). Edits carry the version they were based on.';

-- Every path (functions, member DML, privileged writers): the number is the
-- database's, a value written by a caller is ignored.
create function private.set_service_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  elsif (
    new.business_id, new.name, new.description, new.duration_minutes,
    new.price_cents, new.active
  ) is distinct from (
    old.business_id, old.name, old.description, old.duration_minutes,
    old.price_cents, old.active
  ) then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

revoke all on function private.set_service_version() from public;

create trigger services_version
  before insert or update on public.services
  for each row execute function private.set_service_version();

-- ---------------------------------------------------------------------------
-- 2. Idempotent service creation
-- ---------------------------------------------------------------------------

-- One row per processed creation request: its id (unique within the
-- business), a fingerprint of the command and the service it created. The
-- row outlives the service: when the service is deleted, by any path, its
-- foreign key sets service_id to null in the same transaction (the
-- tombstone), so a replay never creates it again. Unreachable from the API;
-- the rows go with the business.
create table private.service_creation_requests (
  business_id uuid not null references public.businesses (id) on delete cascade,
  request_id uuid not null,
  fingerprint text not null,
  service_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, request_id),
  constraint service_creation_requests_service_fkey
    foreign key (service_id, business_id)
    references public.services (id, business_id)
    on delete set null (service_id)
);

create index service_creation_requests_service_idx
  on private.service_creation_requests (service_id)
  where service_id is not null;

alter table private.service_creation_requests enable row level security;
revoke all on table private.service_creation_requests from public, anon, authenticated, service_role;

-- Creates a service of p_business_id, once per request.
-- Fields: the CHECK constraints of public.services (name 1–120, description
-- ≤ 1000, duration 5–720 minutes, price ≥ 0 cents); p_display_order null
-- puts the service last.
-- Outcome (one row):
--   created   a new service, service_id;
--   replayed  p_request_id already created service_id with the same command
--             (a retry or a double submission): nothing is written, the
--             service is answered as it is now;
--   deleted   p_request_id already created a service with the same command,
--             deleted since: nothing is written again (service_id null).
-- Errors: forbidden (not a member), invalid_input (requestId, active),
-- idempotency_conflict (p_request_id used for another command, its service
-- deleted or not), and the CHECK violations of the fields.
-- Concurrency: the request is claimed first (primary key): a concurrent
-- call of the same request waits for the first one, then is answered from
-- its record; the record is locked, so that a deletion of its service in
-- progress settles before it is read. A creation that fails records
-- nothing (same transaction).
create function public.create_service(
  p_business_id uuid,
  p_request_id uuid,
  p_name text,
  p_duration_minutes integer,
  p_price_cents integer,
  p_description text default null,
  p_active boolean default true,
  p_display_order integer default null
)
returns table (status text, service_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_fingerprint text;
  v_existing record;
  v_service_id uuid;
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_active is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'active';
  end if;

  -- The request is bound to its command, as sent (jsonb key order).
  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'name', p_name,
        'description', p_description,
        'duration_minutes', p_duration_minutes,
        'price_cents', p_price_cents,
        'active', p_active,
        'display_order', p_display_order
      )::text,
      'UTF8'
    )),
    'hex'
  );

  insert into private.service_creation_requests (business_id, request_id, fingerprint)
  values (p_business_id, p_request_id, v_fingerprint)
  on conflict (business_id, request_id) do nothing;

  if not found then
    select r.fingerprint, r.service_id into v_existing
    from private.service_creation_requests r
    where r.business_id = p_business_id
      and r.request_id = p_request_id
    for update;

    if v_existing.fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    if v_existing.service_id is null then
      return query select 'deleted'::text, null::uuid;
      return;
    end if;
    return query select 'replayed'::text, v_existing.service_id;
    return;
  end if;

  insert into public.services (
    business_id, name, description, duration_minutes, price_cents, active, display_order
  )
  values (
    p_business_id, p_name, p_description, p_duration_minutes, p_price_cents, p_active,
    coalesce(
      p_display_order,
      (
        select coalesce(max(s.display_order) + 1, 0)
        from public.services s
        where s.business_id = p_business_id
      )
    )
  )
  returning id into v_service_id;

  update private.service_creation_requests r
  set service_id = v_service_id
  where r.business_id = p_business_id
    and r.request_id = p_request_id;

  return query select 'created'::text, v_service_id;
end;
$$;

revoke all on function public.create_service(uuid, uuid, text, integer, integer, text, boolean, integer) from public, anon;
grant execute on function public.create_service(uuid, uuid, text, integer, integer, text, boolean, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Weekly hours: replaced only from the week they were read as
-- ---------------------------------------------------------------------------

drop function public.replace_business_hours(uuid, jsonb);

-- Replaces the whole weekly schedule of p_business_id with p_hours, on the
-- basis of p_expected: the week as the caller read it ([{ weekday,
-- starts_at, ends_at }], same shape as p_hours; ids are ignored).
-- Under the schedule lock (taken first, as before), the week as it is now:
--   - is already p_hours: nothing is written (a retried save), it is
--     returned whatever p_expected;
--   - is p_expected (as a set of ranges): replaced by p_hours;
--   - is anything else: stale_business_hours, nothing is written.
-- Errors: forbidden, invalid_hours (an argument is not an array),
-- stale_business_hours, and the constraints of business_hours for invalid
-- ranges (the whole call is rolled back: the week is unchanged).
create function public.replace_business_hours(
  p_business_id uuid,
  p_hours jsonb,
  p_expected jsonb
)
returns setof public.business_hours
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  if p_hours is null or pg_catalog.jsonb_typeof(p_hours) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_hours';
  end if;
  if p_expected is null or pg_catalog.jsonb_typeof(p_expected) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_hours', hint = 'expected';
  end if;

  -- Before any read or write of the schedule: the reads below see the
  -- previous serialised replacement.
  perform private.lock_business_schedule(p_business_id);

  if exists (
    (
      select bh.weekday, bh.starts_at, bh.ends_at
      from public.business_hours bh
      where bh.business_id = p_business_id
      except all
      select h.weekday, h.starts_at, h.ends_at
      from pg_catalog.jsonb_to_recordset(p_hours)
        as h(weekday smallint, starts_at time, ends_at time)
    )
    union all
    (
      select h.weekday, h.starts_at, h.ends_at
      from pg_catalog.jsonb_to_recordset(p_hours)
        as h(weekday smallint, starts_at time, ends_at time)
      except all
      select bh.weekday, bh.starts_at, bh.ends_at
      from public.business_hours bh
      where bh.business_id = p_business_id
    )
  ) then
    if exists (
      (
        select bh.weekday, bh.starts_at, bh.ends_at
        from public.business_hours bh
        where bh.business_id = p_business_id
        except all
        select e.weekday, e.starts_at, e.ends_at
        from pg_catalog.jsonb_to_recordset(p_expected)
          as e(weekday smallint, starts_at time, ends_at time)
      )
      union all
      (
        select e.weekday, e.starts_at, e.ends_at
        from pg_catalog.jsonb_to_recordset(p_expected)
          as e(weekday smallint, starts_at time, ends_at time)
        except all
        select bh.weekday, bh.starts_at, bh.ends_at
        from public.business_hours bh
        where bh.business_id = p_business_id
      )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'stale_business_hours',
        hint = 'expected';
    end if;

    delete from public.business_hours where business_id = p_business_id;

    insert into public.business_hours (business_id, weekday, starts_at, ends_at)
    select p_business_id, h.weekday, h.starts_at, h.ends_at
    from pg_catalog.jsonb_to_recordset(p_hours)
      as h(weekday smallint, starts_at time, ends_at time);
  end if;

  return query
  select *
  from public.business_hours bh
  where bh.business_id = p_business_id
  order by bh.weekday, bh.starts_at;
end;
$$;

revoke all on function public.replace_business_hours(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.replace_business_hours(uuid, jsonb, jsonb) to authenticated;
