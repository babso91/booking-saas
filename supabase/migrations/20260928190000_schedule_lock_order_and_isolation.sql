-- Second audit of PR #1: atomic replacements, isolation level and lock order.
--
-- 1. replace_business_hours was not an atomic replacement. The schedule lock
--    was only taken by the row trigger of business_hours, i.e. after the
--    DELETE had already run on the caller's snapshot. On an empty schedule,
--    two concurrent calls both deleted nothing, then both inserted: the result
--    was the union of the two requested schedules. The lock is now taken first
--    thing, so the DELETE runs on a snapshot that includes the previous
--    replacement, and the last serialised call wins entirely. reorder_services
--    (same "validate a set, then rewrite it" shape) gets the same treatment.
--
-- 2. The coordination triggers rely on READ COMMITTED: after waiting for the
--    schedule lock, each following statement takes a fresh snapshot that
--    includes the concurrent write. Under REPEATABLE READ or SERIALIZABLE the
--    snapshot is fixed at the first statement, so a transaction could wait for
--    the lock and still not see a block or appointment committed meanwhile.
--    Decision for V1 (the application, PostgREST and Supabase all use
--    READ COMMITTED): every write that takes the schedule lock refuses any
--    other isolation level with `unsupported_isolation_level` (SQLSTATE
--    0A000) before touching data. Writes that only free time (cancelling an
--    appointment, deleting a block) do not need the lock and are allowed at
--    any level: a concurrent writer validated against the older state only
--    saw less availability, so it can be refused but never made inconsistent.
--
-- 3. Lock order convention: schedule lock first, then business rows
--    (businesses, business_settings, services, business_hours). Direct DML on
--    business_hours by API roles broke it (row lock taken before the trigger
--    acquires the schedule lock, while replace_business_hours holds the
--    schedule lock and deletes the same rows): a concurrent direct UPDATE and
--    replace could deadlock. Weekly hours are now written only through
--    replace_business_hours.

-- ---------------------------------------------------------------------------
-- Schedule lock: refuses unsupported isolation levels before waiting
-- ---------------------------------------------------------------------------

create or replace function private.lock_business_schedule(p_business_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using
      errcode = '0A000',
      message = 'unsupported_isolation_level',
      hint = 'Schedule writes require READ COMMITTED.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('business_schedule:' || p_business_id::text, 0)
  );
end;
$$;

revoke all on function private.lock_business_schedule(uuid) from public;

-- Triggers run as the caller (SECURITY INVOKER, see 20260928090000), so they
-- inline the same check instead of calling the private helper.

create or replace function private.guard_availability_exception()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using
      errcode = '0A000',
      message = 'unsupported_isolation_level',
      hint = 'Schedule writes require READ COMMITTED.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('business_schedule:' || new.business_id::text, 0)
  );

  if new.kind in ('closed', 'blocked') and exists (
    select 1
    from public.appointments a
    where a.business_id = new.business_id
      and a.status <> 'cancelled'
      and a.starts_at < new.ends_at
      and a.ends_at > new.starts_at
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'schedule_conflict',
      detail = 'The period overlaps an existing appointment.';
  end if;

  return new;
end;
$$;

create or replace function private.guard_appointment_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Cancelling frees time: no lock, any isolation level.
  if new.status = 'cancelled' then
    return new;
  end if;

  -- Same occupancy (status change between non-cancelled states, note edit).
  if tg_op = 'UPDATE'
    and old.status <> 'cancelled'
    and old.business_id = new.business_id
    and old.starts_at = new.starts_at
    and old.ends_at = new.ends_at then
    return new;
  end if;

  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using
      errcode = '0A000',
      message = 'unsupported_isolation_level',
      hint = 'Schedule writes require READ COMMITTED.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('business_schedule:' || new.business_id::text, 0)
  );

  if exists (
    select 1
    from public.availability_exceptions e
    where e.business_id = new.business_id
      and e.kind in ('closed', 'blocked')
      and e.starts_at < new.ends_at
      and e.ends_at > new.starts_at
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'schedule_conflict',
      detail = 'The appointment overlaps a closed or blocked period.';
  end if;

  return new;
end;
$$;

-- Safety net for privileged writers (postgres, service role). Inside
-- replace_business_hours the lock is already held, so this is re-entrant.
create or replace function private.lock_schedule_for_hours()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using
      errcode = '0A000',
      message = 'unsupported_isolation_level',
      hint = 'Schedule writes require READ COMMITTED.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'business_schedule:' || coalesce(new.business_id, old.business_id)::text,
      0
    )
  );

  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- Weekly hours: only through an atomic replacement
-- ---------------------------------------------------------------------------

revoke insert, update, delete on public.business_hours from authenticated;
drop policy business_hours_insert_member on public.business_hours;
drop policy business_hours_update_member on public.business_hours;
drop policy business_hours_delete_member on public.business_hours;

-- SECURITY DEFINER because API roles no longer write business_hours directly;
-- membership is checked explicitly before anything else.
create or replace function public.replace_business_hours(p_business_id uuid, p_hours jsonb)
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

  -- Before any read or write of the schedule: the DELETE below then runs on a
  -- snapshot that includes the previous serialised replacement.
  perform private.lock_business_schedule(p_business_id);

  delete from public.business_hours where business_id = p_business_id;

  insert into public.business_hours (business_id, weekday, starts_at, ends_at)
  select p_business_id, h.weekday, h.starts_at, h.ends_at
  from pg_catalog.jsonb_to_recordset(p_hours)
    as h(weekday smallint, starts_at time, ends_at time);

  return query
  select *
  from public.business_hours bh
  where bh.business_id = p_business_id
  order by bh.weekday, bh.starts_at;
end;
$$;

revoke all on function public.replace_business_hours(uuid, jsonb) from public, anon;
grant execute on function public.replace_business_hours(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Service ordering: same validate-then-rewrite shape
-- ---------------------------------------------------------------------------

-- Stays SECURITY INVOKER (RLS applies to the UPDATE). The lock is taken
-- before validation so that the permutation check and the rewrite see the
-- same, current set of services, and two reorders never interleave.
create or replace function public.reorder_services(p_business_id uuid, p_service_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using
      errcode = '0A000',
      message = 'unsupported_isolation_level',
      hint = 'Schedule writes require READ COMMITTED.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('business_schedule:' || p_business_id::text, 0)
  );

  if p_service_ids is null
    or pg_catalog.cardinality(p_service_ids) <> (
      select count(distinct id) from pg_catalog.unnest(p_service_ids) as u(id)
    )
    or pg_catalog.cardinality(p_service_ids) <> (
      select count(*) from public.services where business_id = p_business_id
    )
    or exists (
      select 1
      from pg_catalog.unnest(p_service_ids) as u(id)
      where not exists (
        select 1
        from public.services s
        where s.id = u.id and s.business_id = p_business_id
      )
    ) then
    raise exception using errcode = '22023', message = 'invalid_service_order';
  end if;

  -- Every row is rewritten (no "already in place" filter): the final order is
  -- exactly this call's, never a mix with a concurrent one.
  update public.services s
  set display_order = o.position - 1
  from pg_catalog.unnest(p_service_ids) with ordinality as o(id, position)
  where s.id = o.id
    and s.business_id = p_business_id;
end;
$$;
