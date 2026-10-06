-- Calendar outbound: backfill, drift detection and reconciliation.
--
-- Booking stays the only source of truth; this adds three things on top of
-- the outbound core (20261010), without a second writer:
--
-- A. Backfill. Appointments that must exist in Google and have not ended,
--    but were never enrolled (existing before the first activation, created
--    while outbound was disabled, missed by older code), get a mirror, in
--    small batches, from the periodic job only. The normal writer applies
--    them. Never in an enable, appointment or request transaction; never
--    historical (ended appointments are left alone).
--
-- B. Drift detection. The periodic job lists the current dedicated calendar
--    (events.list, sync tokens, full scan then incremental) and compares, in
--    the application, the Booking-owned fields of the events whose id is the
--    deterministic id of one of this business's mirrors with the state the
--    writer would send now (one canonical serializer). Remote metadata is
--    never authority: the local mirror and the deterministic id are. Events
--    of no mirror (created by the professional, probes) are ignored. Nothing
--    of it ever reaches inbound (external_calendar_events, availability).
--
-- C. Reconciliation. A drift is recorded as a repair request on the mirror
--    (repair_generation), never as a new desired revision: the normal writer
--    claims it like any due mirror, writes the full desired state, and
--    acknowledges the repair generation its claim captured. A drift recorded
--    after the claim stays due (an older success never clears it).
--
-- Lock order (unchanged, extended): connection row (share), outbound row,
-- reconciliation row, mirror rows. The database never contacts Google.

-- ---------------------------------------------------------------------------
-- Mirrors: repair requests, last successful write, full-scan presence
-- ---------------------------------------------------------------------------

alter table private.appointment_calendar_mirrors
  -- Drift reported by reconciliation (bumped), and the last repair the
  -- writer applied (the generation its claim captured). Due while greater.
  add column repair_generation bigint not null default 0,
  add column repaired_generation bigint not null default 0,
  -- When the writer last applied this mirror at the provider (any outcome
  -- that completed it). A listing started before it may predate the write.
  add column applied_at timestamptz,
  -- The last full scan that listed this event (any status).
  add column seen_scan uuid;

-- Due: a desired revision not applied yet, or a repair not applied yet.
drop index private.appointment_calendar_mirrors_due_idx;
create index appointment_calendar_mirrors_due_idx
  on private.appointment_calendar_mirrors (next_attempt_at)
  where desired_revision > applied_revision
     or repair_generation > repaired_generation;

-- Backfill scan: per business, appointments that may still need an event,
-- soonest end first. Without it the scan reads the business's whole history
-- (appointments_business_starts_at_idx) to find the few that have not ended.
create index appointments_outbound_backfill_idx
  on public.appointments (business_id, ends_at)
  where status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- Backfill schedule (per business)
-- ---------------------------------------------------------------------------

-- null: due now (a new row, every new generation: first activation,
-- re-enable, reactivation). Set by the backfill itself otherwise.
alter table private.calendar_outbound
  add column backfill_next_at timestamptz;

-- A new generation (enabled again, reactivated, disabled) makes the
-- backfill due again: appointments created while outbound was off are
-- enrolled by the next periodic job, never by the enabling transaction.
create function private.outbound_reset_backfill()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.generation is distinct from old.generation then
    new.backfill_next_at := null;
  end if;
  return new;
end;
$$;

create trigger calendar_outbound_reset_backfill
  before update of generation on private.calendar_outbound
  for each row execute function private.outbound_reset_backfill();

-- Enrolls, for a few businesses whose outbound is enrolled (creating,
-- active, action_required), a bounded batch of appointments that must
-- exist in Google (not cancelled), have not ended, and have no mirror yet.
-- Soonest end first, then id: deterministic. Idempotent (the mirror's key,
-- on conflict do nothing): a concurrent trigger, another backfill or a
-- second run never enroll twice; the writer derives present/absent from
-- the appointment when it claims, so an appointment cancelled meanwhile is
-- never written. Each business's outbound row is locked (skip locked:
-- another backfill takes the next business) and its status re-checked under
-- the lock: a disable that committed first is seen, one that comes later
-- waits for this batch (its mirrors then follow the disabled outbound like
-- every enrolled one). Local rows only: never a provider call.
create function public.calendar_outbound_backfill(
  p_businesses integer default 5,
  p_per_business integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business uuid;
  v_count integer;
  v_enrolled integer := 0;
  v_businesses integer := 0;
  v_limit integer := least(greatest(coalesce(p_per_business, 100), 1), 500);
begin
  for v_business in
    select o.business_id
    from private.calendar_outbound o
    where o.status in ('creating', 'active', 'action_required')
      and (o.backfill_next_at is null or o.backfill_next_at <= pg_catalog.now())
    order by o.backfill_next_at nulls first, o.business_id
    limit least(greatest(coalesce(p_businesses, 5), 1), 50)
    for update skip locked
  loop
    insert into private.appointment_calendar_mirrors (
      appointment_id, business_id, event_id
    )
    select a.id, a.business_id, private.mirror_event_id(a.id)
    from public.appointments a
    where a.business_id = v_business
      and a.status <> 'cancelled'
      and a.ends_at > pg_catalog.now()
      and not exists (
        select 1 from private.appointment_calendar_mirrors m
        where m.appointment_id = a.id
      )
    order by a.ends_at, a.id
    limit v_limit
    on conflict (appointment_id) do nothing;
    get diagnostics v_count = row_count;

    -- More left: due again at the next run. Otherwise a cheap safety
    -- check every 6 hours (the trigger enrolls everything else).
    update private.calendar_outbound o
    set backfill_next_at = case
          when exists (
            select 1 from public.appointments a
            where a.business_id = v_business
              and a.status <> 'cancelled'
              and a.ends_at > pg_catalog.now()
              and not exists (
                select 1 from private.appointment_calendar_mirrors m
                where m.appointment_id = a.id
              )
          ) then pg_catalog.now()
          else pg_catalog.now() + interval '6 hours'
        end
    where o.business_id = v_business;

    v_enrolled := v_enrolled + v_count;
    v_businesses := v_businesses + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'businesses', v_businesses,
    'enrolled', v_enrolled
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Writer: due repairs, acknowledged with the generation the claim captured
-- ---------------------------------------------------------------------------

-- Same as 20261010, plus: a mirror whose repair is due is claimed like one
-- whose revision is due. The claim returns the repair generation it
-- captured (`repairGeneration`) and whether a repair is due (`repair`): the
-- writer then also removes an event of an absent appointment from the
-- target even if no write of it was ever recorded there. `p_exclude`:
-- businesses the worker stopped in this run (claimed in small batches,
-- they are never claimed again by the same run). `p_due_before`: only work
-- due by then (a pass's start): what becomes due while it runs (a newer
-- revision, a reactivation) is the next pass's, never a hot loop.
drop function public.calendar_outbound_claim_mirrors(integer, uuid, integer);

create function public.calendar_outbound_claim_mirrors(
  p_limit integer default 50,
  p_business_id uuid default null,
  p_per_business integer default 10,
  p_exclude uuid[] default '{}',
  p_due_before timestamptz default null
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
      where (m.desired_revision > m.applied_revision
             or m.repair_generation > m.repaired_generation)
        and m.next_attempt_at <= least(pg_catalog.now(), coalesce(p_due_before, 'infinity'))
        and (m.lease_until is null or m.lease_until < pg_catalog.now())
        and (p_business_id is null or m.business_id = p_business_id)
        and not (m.business_id = any (coalesce(p_exclude, '{}')))
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
      and (m.desired_revision > m.applied_revision
           or m.repair_generation > m.repaired_generation)
      and m.next_attempt_at <= least(pg_catalog.now(), coalesce(p_due_before, 'infinity'))
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
      'repairGeneration', v_mirror.repair_generation,
      'repair', v_mirror.repair_generation > v_mirror.repaired_generation,
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

-- The provider applied `p_revision` (the whole desired state, which also
-- repairs every drift recorded up to `p_repair_generation`, the generation
-- the claim captured): recorded only with authority. A newer revision or a
-- newer drift recorded meanwhile stays due (compare-and-set by `greatest`:
-- an older success never acknowledges more than it applied).
drop function public.calendar_outbound_complete_mirror(uuid, uuid, bigint);

create function public.calendar_outbound_complete_mirror(
  p_appointment_id uuid,
  p_claim_id uuid,
  p_revision bigint,
  p_repair_generation bigint default 0
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
      repaired_generation = greatest(
        m.repaired_generation,
        least(coalesce(p_repair_generation, 0), m.repair_generation)
      ),
      applied_at = pg_catalog.now(),
      claim_id = null,
      lease_until = null,
      attempts = 0,
      last_error = null,
      next_attempt_at = pg_catalog.now()
  where m.appointment_id = p_appointment_id;
  return 'applied';
end;
$$;

-- A claim the worker will not process in this run (its business stopped,
-- or its time is up): available again at once instead of after its lease.
-- Only the claim's own holder can release it; nothing else changes.
create function public.calendar_outbound_release_mirror(
  p_appointment_id uuid,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.appointment_calendar_mirrors m
  set claim_id = null, lease_until = null
  where m.appointment_id = p_appointment_id
    and m.claim_id = p_claim_id;
  return found;
end;
$$;

-- Same as 20261010; pending and failing counts include due repairs (the
-- event differs from Booking until the writer repairs it).
create or replace function private.outbound_status(p_business_id uuid)
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
      where m.business_id = p_business_id
        and (m.desired_revision > m.applied_revision
             or m.repair_generation > m.repaired_generation)
    ),
    'errorCount', (
      select pg_catalog.count(*) from private.appointment_calendar_mirrors m
      where m.business_id = p_business_id
        and (m.desired_revision > m.applied_revision
             or m.repair_generation > m.repaired_generation)
        and m.attempts > 0
    )
  )
  from (select p_business_id as business_id) b
  left join public.calendar_connections c
    on c.business_id = b.business_id and c.provider = 'google'
  left join private.calendar_outbound o on o.business_id = b.business_id;
$$;

-- Same as 20261010; due repairs waiting for a backoff are retried too.
create or replace function public.calendar_outbound_retry(p_business_id uuid)
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
    and (m.desired_revision > m.applied_revision
         or m.repair_generation > m.repaired_generation)
    and m.next_attempt_at > pg_catalog.now();

  return private.outbound_status(p_business_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation state (private, one per business, server only)
-- ---------------------------------------------------------------------------

-- The listing cursor of the current dedicated calendar. Valid only for the
-- calendar and the outbound generation it was built under: any other value
-- of either (a new calendar, a re-enable, a reactivation) resets it at the
-- next claim, and the next pass starts with a full scan. Sync and page
-- tokens are Google server state: never returned to a browser, never
-- logged. Separate from inbound's sync state: nothing listed here ever
-- becomes a blocking event.
create table private.calendar_outbound_reconciliation (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  provider_calendar_id text not null
    check (pg_catalog.char_length(provider_calendar_id) between 1 and 1024),
  outbound_generation uuid not null,
  -- Incremental cursor (nextSyncToken of the last complete listing). null:
  -- the next listing is a full scan.
  sync_token text check (pg_catalog.char_length(sync_token) <= 4096),
  -- The listing in progress (full or incremental), resumed by the next pass.
  page_token text check (pg_catalog.char_length(page_token) <= 4096),
  -- The full scan in progress, and when it started: missing events are
  -- decided only once all of its pages were read.
  scan_id uuid,
  scan_started_at timestamptz,
  -- When the page being read was requested (database clock): a mirror
  -- applied since then may be newer than what the page shows.
  page_started_at timestamptz,
  next_reconcile_at timestamptz not null default pg_catalog.now(),
  claim_id uuid,
  lease_until timestamptz,
  claim_credential_generation uuid,
  attempts integer not null default 0,
  last_error text check (pg_catalog.char_length(last_error) <= 64),
  last_reconciled_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create index calendar_outbound_reconciliation_due_idx
  on private.calendar_outbound_reconciliation (next_reconcile_at);

create trigger calendar_outbound_reconciliation_set_updated_at
  before update on private.calendar_outbound_reconciliation
  for each row execute function public.set_updated_at();

-- Interval between two complete listings of a calendar (the periodic job
-- runs every 15 minutes; a pass stopped by its limits resumes at the next).
create function private.reconciliation_interval()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '30 minutes';
$$;

-- Appointment ids of the deterministic event ids among `p_event_ids`
-- ('bk' + 32 hex digits). Anything else (an event the professional created,
-- a probe) is no mirror's and is ignored.
create function private.mirror_appointment_ids(p_event_ids text[])
returns table (appointment_id uuid, event_id text)
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.substr(e, 3)::uuid, e
  from pg_catalog.unnest(coalesce(p_event_ids, '{}')) e
  where e ~ '^bk[0-9a-f]{32}$';
$$;

-- Whether a reconciliation claim still has authority: same claim, outbound
-- still active under the generation and calendar the state was built for,
-- connection still the captured incarnation, same account, write scope.
-- Locks, in the global order: connection (share), outbound row (share, or
-- update when the caller will change it), reconciliation row (update); held
-- until the caller's transaction ends. Returns the row, or null.
create function private.reconciliation_claim_valid(
  p_business_id uuid,
  p_claim_id uuid,
  p_for_update boolean
)
returns private.calendar_outbound_reconciliation
language plpgsql
set search_path = ''
as $$
declare
  v_connection public.calendar_connections;
  v_outbound private.calendar_outbound;
  v_row private.calendar_outbound_reconciliation;
begin
  select c.* into v_connection
  from public.calendar_connections c
  join private.calendar_outbound o on o.connection_id = c.id
  where o.business_id = p_business_id
  for share of c;

  if p_for_update then
    select o.* into v_outbound
    from private.calendar_outbound o
    where o.business_id = p_business_id
    for update;
  else
    select o.* into v_outbound
    from private.calendar_outbound o
    where o.business_id = p_business_id
    for share;
  end if;

  select r.* into v_row
  from private.calendar_outbound_reconciliation r
  where r.business_id = p_business_id
  for update;

  if p_claim_id is null
    or v_row.claim_id is distinct from p_claim_id
    or not coalesce(
      v_outbound.status = 'active'
        and v_outbound.generation = v_row.outbound_generation
        and v_outbound.provider_calendar_id = v_row.provider_calendar_id
        and v_connection.status = 'active'
        and v_connection.credential_generation = v_row.claim_credential_generation
        and v_connection.provider_account_id = v_outbound.provider_account_id
        and private.has_write_scope(v_connection.scopes),
      false
    ) then
    return null;
  end if;
  return v_row;
end;
$$;

-- Claims the next due reconciliation (one business), oldest due first; a
-- business whose state belongs to another calendar or generation first (it
-- is reset here). Only active outbound configurations whose connection is
-- usable: disabled, creating and action_required ones are never listed (no
-- provider call). `p_exclude`: businesses already handled in this run.
-- Returns null when nothing is due. The cursor is returned to the server
-- worker only.
create function public.calendar_outbound_claim_reconciliation(
  p_exclude uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_connection public.calendar_connections;
  v_outbound private.calendar_outbound;
  v_row private.calendar_outbound_reconciliation;
begin
  for v_candidate in
    select o.business_id
    from private.calendar_outbound o
    join public.calendar_connections c on c.id = o.connection_id
    left join private.calendar_outbound_reconciliation r on r.business_id = o.business_id
    where o.status = 'active'
      and c.status = 'active'
      and c.provider_account_id = o.provider_account_id
      and private.has_write_scope(c.scopes)
      and not (o.business_id = any (coalesce(p_exclude, '{}')))
      and (r.lease_until is null or r.lease_until < pg_catalog.now())
      and (r.business_id is null
           or r.outbound_generation <> o.generation
           or r.provider_calendar_id <> o.provider_calendar_id
           or r.next_reconcile_at <= pg_catalog.now())
    order by
      case
        when r.business_id is null
          or r.outbound_generation <> o.generation
          or r.provider_calendar_id <> o.provider_calendar_id
          then '-infinity'::timestamptz
        else r.next_reconcile_at
      end,
      o.business_id
    limit 5
  loop
    -- Lock order: connection (share), outbound (share), reconciliation row.
    select c.* into v_connection
    from public.calendar_connections c
    join private.calendar_outbound o on o.connection_id = c.id
    where o.business_id = v_candidate.business_id
    for share of c;
    select o.* into v_outbound
    from private.calendar_outbound o
    where o.business_id = v_candidate.business_id
    for share;
    if not coalesce(
      v_outbound.status = 'active'
        and v_connection.status = 'active'
        and v_connection.provider_account_id = v_outbound.provider_account_id
        and private.has_write_scope(v_connection.scopes),
      false
    ) then
      continue;
    end if;

    insert into private.calendar_outbound_reconciliation (
      business_id, provider_calendar_id, outbound_generation
    )
    values (v_candidate.business_id, v_outbound.provider_calendar_id, v_outbound.generation)
    on conflict (business_id) do nothing;

    select r.* into v_row
    from private.calendar_outbound_reconciliation r
    where r.business_id = v_candidate.business_id
    for update;
    if v_row.lease_until > pg_catalog.now() then
      continue;
    end if;

    if v_row.outbound_generation <> v_outbound.generation
      or v_row.provider_calendar_id <> v_outbound.provider_calendar_id then
      -- Built for another calendar or authority: nothing of it is kept.
      update private.calendar_outbound_reconciliation r
      set provider_calendar_id = v_outbound.provider_calendar_id,
          outbound_generation = v_outbound.generation,
          sync_token = null,
          page_token = null,
          scan_id = null,
          scan_started_at = null,
          attempts = 0,
          last_error = null,
          next_reconcile_at = pg_catalog.now()
      where r.business_id = v_candidate.business_id
      returning r.* into v_row;
    elsif v_row.next_reconcile_at > pg_catalog.now() then
      continue;
    end if;

    -- No cursor and no listing in progress: a new full scan starts.
    update private.calendar_outbound_reconciliation r
    set claim_id = gen_random_uuid(),
        lease_until = pg_catalog.now() + interval '2 minutes',
        claim_credential_generation = v_connection.credential_generation,
        page_started_at = pg_catalog.now(),
        scan_id = case
          when r.sync_token is null and r.page_token is null then gen_random_uuid()
          else r.scan_id
        end,
        scan_started_at = case
          when r.sync_token is null and r.page_token is null then pg_catalog.now()
          else r.scan_started_at
        end
    where r.business_id = v_candidate.business_id
    returning r.* into v_row;

    return pg_catalog.jsonb_build_object(
      'businessId', v_row.business_id,
      'claimId', v_row.claim_id,
      'connectionId', v_connection.id,
      'credentialGeneration', v_connection.credential_generation,
      'calendarId', v_row.provider_calendar_id,
      'mode', case when v_row.sync_token is null then 'full' else 'incremental' end,
      'syncToken', v_row.sync_token,
      'pageToken', v_row.page_token
    );
  end loop;
  return null;
end;
$$;

-- The local state of the listed events that are this business's mirrors
-- (deterministic id; any other id is ignored), as the writer would derive
-- it now: the comparison itself uses the writer's serializer. Read only.
--   pending   a revision is waiting for the writer: it rewrites the whole
--             event anyway, the listing is not compared;
--   active    the event must exist (appointment present, not cancelled);
--   eligible  the appointment has not ended (or no longer exists): only
--             those are repaired, history is left alone.
create function public.calendar_outbound_reconciliation_snapshot(
  p_business_id uuid,
  p_claim_id uuid,
  p_event_ids text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.cardinality(p_event_ids), 0) > 2500 then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  if not exists (
    select 1 from private.calendar_outbound_reconciliation r
    where r.business_id = p_business_id and r.claim_id = p_claim_id
  ) then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'appointmentId', m.appointment_id,
      'eventId', m.event_id,
      'revision', m.desired_revision,
      'pending', m.desired_revision > m.applied_revision,
      'active', a.id is not null and a.status <> 'cancelled',
      'eligible', a.id is null or a.ends_at > pg_catalog.now(),
      'startsAt', a.starts_at,
      'endsAt', a.ends_at,
      'serviceName', a.service_name_snapshot,
      'clientFirstName', cl.first_name
    ) order by m.appointment_id)
    from private.mirror_appointment_ids(p_event_ids) ids
    join private.appointment_calendar_mirrors m
      on m.appointment_id = ids.appointment_id
     and m.event_id = ids.event_id
     and m.business_id = p_business_id
    left join public.appointments a
      on a.id = m.appointment_id and a.business_id = p_business_id
    left join public.clients cl on cl.id = a.client_id
  ), '[]'::jsonb);
end;
$$;

-- Records one listed page, only with the claim's full authority:
--   - drift found in it becomes a repair request of the mirror, only if the
--     mirror is still at the revision the comparison used, nothing is
--     pending, and no write was applied after the page was requested (the
--     page may predate it); a mirror changed since is rewritten by the
--     writer anyway, never repaired from a stale comparison;
--   - in a full scan, every listed event of a mirror is marked seen;
--   - the last page (nextSyncToken) of a full scan decides the missing
--     events: a mirror that must exist in this calendar, applied before the
--     scan started, not pending and never listed by it is repaired. Never
--     decided from part of a scan: a scan that failed is resumed or
--     restarted, its earlier pages never stand for a complete one;
--   - the cursor is stored: the next page, or the new sync token (the pass
--     is complete and the next one is scheduled).
-- Returns {result: 'continue' | 'done' | 'superseded' (nothing recorded),
-- repairs: the repair requests actually recorded}.
create function public.calendar_outbound_reconciliation_page(
  p_business_id uuid,
  p_claim_id uuid,
  p_drifted jsonb,
  p_seen_event_ids text[],
  p_next_page_token text,
  p_next_sync_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.calendar_outbound_reconciliation;
  v_repairs integer := 0;
  v_missing integer := 0;
begin
  if (p_next_page_token is null) = (p_next_sync_token is null)
    or coalesce(pg_catalog.char_length(p_next_page_token), 0) > 4096
    or coalesce(pg_catalog.char_length(p_next_sync_token), 0) > 4096
    or p_next_page_token = '' or p_next_sync_token = ''
    or p_drifted is null or pg_catalog.jsonb_typeof(p_drifted) <> 'array'
    or pg_catalog.jsonb_array_length(p_drifted) > 2500
    or coalesce(pg_catalog.cardinality(p_seen_event_ids), 0) > 2500 then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  v_row := private.reconciliation_claim_valid(p_business_id, p_claim_id, false);
  if v_row.business_id is null then
    return pg_catalog.jsonb_build_object('result', 'superseded', 'repairs', 0);
  end if;

  update private.appointment_calendar_mirrors m
  set repair_generation = m.repair_generation + 1,
      -- Already due (a repair waiting for its backoff): its schedule stays.
      next_attempt_at = case
        when m.repair_generation > m.repaired_generation then m.next_attempt_at
        else pg_catalog.now()
      end,
      attempts = case
        when m.repair_generation > m.repaired_generation then m.attempts
        else 0
      end
  from (
    select distinct d.appointment_id, d.revision
    from pg_catalog.jsonb_to_recordset(p_drifted) as d(appointment_id uuid, revision bigint)
  ) d
  where m.appointment_id = d.appointment_id
    and m.business_id = p_business_id
    and m.desired_revision = d.revision
    and m.applied_revision = m.desired_revision
    and coalesce(m.applied_at, '-infinity'::timestamptz) < v_row.page_started_at
    and not exists (
      select 1 from public.appointments a
      where a.id = m.appointment_id and a.ends_at <= pg_catalog.now()
    );
  get diagnostics v_repairs = row_count;

  if v_row.sync_token is null then
    update private.appointment_calendar_mirrors m
    set seen_scan = v_row.scan_id
    from private.mirror_appointment_ids(p_seen_event_ids) ids
    where m.appointment_id = ids.appointment_id
      and m.event_id = ids.event_id
      and m.business_id = p_business_id
      and m.seen_scan is distinct from v_row.scan_id;
  end if;

  if p_next_sync_token is null then
    update private.calendar_outbound_reconciliation r
    set page_token = p_next_page_token,
        page_started_at = pg_catalog.now(),
        lease_until = pg_catalog.now() + interval '2 minutes'
    where r.business_id = p_business_id;
    return pg_catalog.jsonb_build_object('result', 'continue', 'repairs', v_repairs);
  end if;

  if v_row.sync_token is null then
    -- The full scan is complete: what it never listed is missing.
    update private.appointment_calendar_mirrors m
    set repair_generation = m.repair_generation + 1,
        next_attempt_at = case
          when m.repair_generation > m.repaired_generation then m.next_attempt_at
          else pg_catalog.now()
        end,
        attempts = case
          when m.repair_generation > m.repaired_generation then m.attempts
          else 0
        end
    from public.appointments a
    where m.business_id = p_business_id
      and a.id = m.appointment_id
      and a.business_id = p_business_id
      and a.status <> 'cancelled'
      and a.ends_at > pg_catalog.now()
      and m.desired_revision = m.applied_revision
      and m.applied_revision > 0
      and m.provider_calendar_id = v_row.provider_calendar_id
      and m.seen_scan is distinct from v_row.scan_id
      and coalesce(m.applied_at, '-infinity'::timestamptz) < v_row.scan_started_at;
    get diagnostics v_missing = row_count;
  end if;

  update private.calendar_outbound_reconciliation r
  set sync_token = p_next_sync_token,
      page_token = null,
      scan_id = null,
      scan_started_at = null,
      claim_id = null,
      lease_until = null,
      attempts = 0,
      last_error = null,
      last_reconciled_at = pg_catalog.now(),
      next_reconcile_at = pg_catalog.now() + private.reconciliation_interval()
  where r.business_id = p_business_id;
  return pg_catalog.jsonb_build_object('result', 'done', 'repairs', v_repairs + v_missing);
end;
$$;

-- A pass stopped by its own limits (pages, time): the cursor is kept and
-- the listing resumes at the next run.
create function public.calendar_outbound_reconciliation_release(
  p_business_id uuid,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.calendar_outbound_reconciliation;
begin
  v_row := private.reconciliation_claim_valid(p_business_id, p_claim_id, false);
  if v_row.business_id is null then
    return false;
  end if;
  update private.calendar_outbound_reconciliation r
  set claim_id = null,
      lease_until = null,
      next_reconcile_at = pg_catalog.now()
  where r.business_id = p_business_id;
  return true;
end;
$$;

-- A failed listing, classified by the same rules as the writer, recorded
-- only with the claim's full authority (a stale worker records nothing):
--   retry, rate_limited           backoff; the cursor is kept;
--   invalid_token                 the cursor is no longer valid (410): it
--                                 is dropped, the next pass is a full scan;
--   calendar_deleted,
--   write_authorization_required  the whole configuration waits for the
--                                 professional (action_required, a new
--                                 generation: every worker becomes stale),
--                                 exactly as when the writer finds it.
-- Lock order: connection (share), outbound (update), reconciliation row,
-- mirrors.
create function public.calendar_outbound_reconciliation_failed(
  p_business_id uuid,
  p_claim_id uuid,
  p_outcome text,
  p_error text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.calendar_outbound_reconciliation;
  v_action boolean;
begin
  if p_outcome is null or p_outcome not in (
    'retry', 'rate_limited', 'invalid_token', 'calendar_deleted',
    'write_authorization_required'
  ) then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  v_action := p_outcome in ('calendar_deleted', 'write_authorization_required');

  v_row := private.reconciliation_claim_valid(p_business_id, p_claim_id, v_action);
  if v_row.business_id is null then
    return 'superseded';
  end if;

  if v_action then
    update private.calendar_outbound o
    set status = 'action_required',
        action_code = p_outcome,
        generation = gen_random_uuid(),
        provider_calendar_id = null,
        creation_claim_id = null,
        creation_lease_until = null,
        creation_requested_at = null,
        creation_next_attempt_at = null,
        last_error = pg_catalog.left(coalesce(p_error, p_outcome), 64)
    where o.business_id = p_business_id
      and o.status = 'active'
      and o.generation = v_row.outbound_generation;

    update private.calendar_outbound_reconciliation r
    set claim_id = null,
        lease_until = null,
        last_error = pg_catalog.left(coalesce(p_error, p_outcome), 64)
    where r.business_id = p_business_id;

    update private.appointment_calendar_mirrors m
    set claim_id = null, lease_until = null
    where m.business_id = p_business_id
      and m.claim_id is not null;
    return 'action_required';
  end if;

  update private.calendar_outbound_reconciliation r
  set claim_id = null,
      lease_until = null,
      attempts = r.attempts + 1,
      last_error = pg_catalog.left(coalesce(p_error, p_outcome), 64),
      sync_token = case when p_outcome = 'invalid_token' then null else r.sync_token end,
      page_token = case when p_outcome = 'invalid_token' then null else r.page_token end,
      scan_id = case when p_outcome = 'invalid_token' then null else r.scan_id end,
      scan_started_at = case when p_outcome = 'invalid_token' then null else r.scan_started_at end,
      next_reconcile_at = case
        -- A new full scan at the next run (a lost cursor is not a failure
        -- of the provider), unless it keeps happening.
        when p_outcome = 'invalid_token' and r.attempts < 2 then pg_catalog.now()
        else pg_catalog.now()
          + least(interval '6 hours', interval '1 minute' * power(2, least(r.attempts, 9)))
            * (0.8 + random() * 0.4)
      end
  where r.business_id = p_business_id;
  return case when p_outcome = 'invalid_token' then 'reset' else 'retry' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function private.outbound_reset_backfill() from public;
revoke all on function private.reconciliation_interval() from public;
revoke all on function private.mirror_appointment_ids(text[]) from public;
revoke all on function private.reconciliation_claim_valid(uuid, uuid, boolean) from public;

do $$
declare
  v_signature text;
begin
  -- Workers (service role only).
  foreach v_signature in array array[
    'public.calendar_outbound_backfill(integer, integer)',
    'public.calendar_outbound_claim_mirrors(integer, uuid, integer, uuid[], timestamptz)',
    'public.calendar_outbound_release_mirror(uuid, uuid)',
    'public.calendar_outbound_complete_mirror(uuid, uuid, bigint, bigint)',
    'public.calendar_outbound_claim_reconciliation(uuid[])',
    'public.calendar_outbound_reconciliation_snapshot(uuid, uuid, text[])',
    'public.calendar_outbound_reconciliation_page(uuid, uuid, jsonb, text[], text, text)',
    'public.calendar_outbound_reconciliation_release(uuid, uuid)',
    'public.calendar_outbound_reconciliation_failed(uuid, uuid, text, text)'
  ]
  loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
