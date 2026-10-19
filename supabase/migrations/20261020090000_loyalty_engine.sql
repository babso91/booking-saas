-- Loyalty engine V1: configuration, automatic earning, ledger, rewards and
-- redemptions, on the loyalty tables the initial foundation already created.
--
-- Reused as they were:
--   * public.loyalty_programs  one program per business (primary key);
--   * public.loyalty_events    the ledger: one row per points movement,
--                              (business_id, idempotency_key) unique;
--   * public.rewards           reward definitions;
--   * public.reward_redemptions one row per reward issued to a customer, bound
--                              to the ledger entry that paid for it.
--
-- Principles:
--   1. The ledger is the only source of truth. A balance is the sum of a
--      customer's entries, never a stored counter that could drift. Entries
--      are immutable: a mistake is corrected by a compensating entry that
--      names the entry it reverses (`reverses_event_id`, at most once).
--   2. Points are earned only on the professional's completion of an
--      appointment: the transition of public.appointments.status to
--      'completed' (agenda_set_appointment_status, behind the membership
--      check). Public booking only ever creates 'confirmed' appointments and
--      can never earn. The earning runs in a trigger on that transition, in
--      the same transaction, under the appointment's row lock: a duplicate
--      or concurrent completion cannot award twice.
--   3. Leaving 'completed' (a correction back to 'confirmed') reverses the
--      award with a compensating entry; a later completion awards again,
--      under a new generation, from the appointment's snapshots at that time.
--   4. Every write that can spend points (redemption, negative adjustment)
--      locks the customer row first and checks the balance under that lock:
--      two concurrent requests cannot spend the same points.
--   5. The API roles never write these tables directly. Configuration,
--      adjustments and redemptions go through SECURITY DEFINER functions
--      that check the session and the business membership first, then
--      address every row by (id, business_id).
--   6. Nothing here is reachable without a professional session: no anon
--      grant, no lookup by email or loyalty token. Customer-facing access
--      (the future Client Hub) is out of scope.

-- ---------------------------------------------------------------------------
-- 1. Program configuration
-- ---------------------------------------------------------------------------

-- Opt-in: a program is active only once the professional activates it.
alter table public.loyalty_programs
  alter column active set default false,
  add column version integer not null default 1 check (version >= 1);

create trigger loyalty_programs_bump_version
  before update on public.loyalty_programs
  for each row execute function private.bump_version();

-- The onboarding created an active program for every business without the
-- professional ever choosing it (no screen existed). Those that never
-- recorded a single entry become inactive; any business with ledger history
-- keeps its program as it is. Before the bounds below: a NOT VALID check
-- still applies to the rows an UPDATE writes, and members could write any
-- value directly until now.
update public.loyalty_programs p
set active = false
where p.active
  and not exists (
    select 1 from public.loyalty_events e where e.business_id = p.business_id
  );

-- Bounds for new writes. The previous schema accepted wider values (and
-- members could write this table directly): a CHECK, even NOT VALID, would
-- apply to every later UPDATE of such a row, so any change to it (an
-- activation, a foreign-key action, this migration's own backfills) would
-- fail. The guard therefore bounds every value an INSERT or UPDATE writes,
-- and lets a historical value that an UPDATE leaves unchanged stay as it
-- was (grandfathered: readable, kept on edit, never newly written).
create function private.loyalty_programs_bounds()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT'
      or new.points_per_completed_appointment is distinct from old.points_per_completed_appointment)
    and new.points_per_completed_appointment not between 1 and 10000 then
    raise exception using errcode = '23514', message = 'loyalty_programs_points_per_appointment_range';
  end if;
  if (tg_op = 'INSERT' or new.points_per_euro is distinct from old.points_per_euro)
    and new.points_per_euro is not null
    and new.points_per_euro not between 0.01 and 100 then
    raise exception using errcode = '23514', message = 'loyalty_programs_points_per_euro_range';
  end if;

  return new;
end;
$$;

revoke all on function private.loyalty_programs_bounds() from public;

create trigger loyalty_programs_bounds
  before insert or update on public.loyalty_programs
  for each row execute function private.loyalty_programs_bounds();

-- Businesses created without onboarding get an inactive program.
insert into public.loyalty_programs (business_id, active)
select b.id, false
from public.businesses b
on conflict (business_id) do nothing;

comment on column public.loyalty_programs.points_per_euro is
  'Spend mode: points per 100 minor units of the appointment price snapshot '
  '(rounded down), in the appointment''s currency.';
comment on column public.loyalty_programs.version is
  'Incremented on every update. Configuration writes carry the version they were based on.';

-- Per-service override of the program's calculation: `points` for a
-- completed appointment of that service (0 = the service earns nothing).
create table public.loyalty_service_rules (
  business_id uuid not null references public.businesses (id) on delete cascade,
  service_id uuid not null,
  points integer not null check (points between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, service_id),
  foreign key (service_id, business_id)
    references public.services (id, business_id) on delete cascade
);

create trigger set_loyalty_service_rules_updated_at
  before update on public.loyalty_service_rules
  for each row execute function public.set_updated_at();

alter table public.loyalty_service_rules enable row level security;

create policy "loyalty_service_rules_select_member"
  on public.loyalty_service_rules for select to authenticated
  using (public.is_business_member(business_id));

-- Configuration is written through the functions below only (validation,
-- versioning); members keep read access.
drop policy "loyalty_programs_insert_member" on public.loyalty_programs;
drop policy "loyalty_programs_update_member" on public.loyalty_programs;
drop policy "loyalty_programs_delete_member" on public.loyalty_programs;
drop policy "rewards_insert_member" on public.rewards;
drop policy "rewards_update_member" on public.rewards;
drop policy "rewards_delete_member" on public.rewards;

revoke all on public.loyalty_programs, public.rewards, public.loyalty_service_rules,
  public.loyalty_events, public.reward_redemptions
  from anon, authenticated;
grant select on public.loyalty_programs, public.rewards, public.loyalty_service_rules,
  public.loyalty_events, public.reward_redemptions
  to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Ledger
-- ---------------------------------------------------------------------------

alter table public.loyalty_events
  add column ledger_seq bigint,
  add column award_generation integer check (award_generation >= 1),
  add column reverses_event_id uuid,
  add column details jsonb not null default '{}'::jsonb;

update public.loyalty_events
set award_generation = 1
where type = 'appointment_completed';

-- Existing entries are numbered in the order of the facts (creation date),
-- not in their physical order; new entries follow.
update public.loyalty_events e
set ledger_seq = o.seq
from (
  select e2.id, row_number() over (order by e2.created_at, e2.id) as seq
  from public.loyalty_events e2
) o
where o.id = e.id;

alter table public.loyalty_events
  alter column ledger_seq set not null,
  alter column ledger_seq add generated always as identity;

select pg_catalog.setval(
  pg_catalog.pg_get_serial_sequence('public.loyalty_events', 'ledger_seq'),
  coalesce((select max(e.ledger_seq) from public.loyalty_events e), 0) + 1,
  false
);

alter table public.loyalty_events
  add constraint loyalty_events_ledger_seq_key unique (ledger_seq),
  add constraint loyalty_events_award_generation_present check (
    (type = 'appointment_completed') = (award_generation is not null)
  ),
  add constraint loyalty_events_award_has_appointment check (
    type <> 'appointment_completed' or appointment_id is not null
  ),
  add constraint loyalty_events_reversal_is_correction check (
    reverses_event_id is null or type = 'correction'
  ),
  add constraint loyalty_events_reverses_fkey
    foreign key (reverses_event_id, business_id)
    references public.loyalty_events (id, business_id),
  add constraint loyalty_events_details_object check (
    pg_catalog.jsonb_typeof(details) = 'object'
  );

-- One award per completion generation; one reversal per entry.
drop index public.loyalty_events_completed_appointment_once_idx;
create unique index loyalty_events_award_generation_idx
  on public.loyalty_events (business_id, appointment_id, award_generation)
  where type = 'appointment_completed';
create unique index loyalty_events_reversal_once_idx
  on public.loyalty_events (reverses_event_id)
  where reverses_event_id is not null;
create index loyalty_events_client_seq_idx
  on public.loyalty_events (business_id, client_id, ledger_seq);

comment on column public.loyalty_events.ledger_seq is
  'Global insertion order: the ledger''s order for running balances and pagination.';
comment on column public.loyalty_events.award_generation is
  'appointment_completed only: 1 for the first completion, n + 1 after the '
  'award n was reversed. At most one unreversed award per appointment.';
comment on column public.loyalty_events.reverses_event_id is
  'The entry this correction compensates (same customer, opposite points), at most once.';
comment on column public.loyalty_events.details is
  'Machine-readable source of the entry (earning calculation, redemption, request).';

-- A reversal must exactly compensate its target, within one customer.
create function private.loyalty_check_entry()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_target public.loyalty_events%rowtype;
begin
  -- Writers that predate generations record the first one.
  if new.type = 'appointment_completed' then
    new.award_generation := coalesce(new.award_generation, 1);
  end if;

  if new.reverses_event_id is not null then
    select e.* into v_target
    from public.loyalty_events e
    where e.id = new.reverses_event_id
      and e.business_id = new.business_id;

    if not found
      or v_target.reverses_event_id is not null
      or v_target.client_id <> new.client_id
      or v_target.points_delta <> -new.points_delta
    then
      raise exception using errcode = '23514', message = 'invalid_loyalty_reversal';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.loyalty_check_entry() from public;

create trigger loyalty_events_check_entry
  before insert on public.loyalty_events
  for each row execute function private.loyalty_check_entry();

-- Entries are immutable. Two foreign-key actions are the only exceptions,
-- both cascaded (trigger depth > 1):
--   * the deletion of the business itself removes its whole ledger;
--   * the deletion of an account clears the authorship of its entries
--     (created_by → null), nothing else.
create function private.loyalty_ledger_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_catalog.pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' and not exists (
      select 1 from public.businesses b where b.id = old.business_id
    ) then
      return old;
    end if;

    if tg_op = 'UPDATE'
      and new.created_by is null
      and old.created_by is not null
      and (pg_catalog.to_jsonb(new) - 'created_by') = (pg_catalog.to_jsonb(old) - 'created_by')
    then
      return new;
    end if;
  end if;

  raise exception using errcode = '55000', message = 'loyalty_ledger_immutable';
end;
$$;

revoke all on function private.loyalty_ledger_immutable() from public;

create trigger loyalty_events_immutable
  before update or delete on public.loyalty_events
  for each row execute function private.loyalty_ledger_immutable();

-- Current balance of one customer, from the ledger.
create function private.loyalty_balance(p_business_id uuid, p_client_id uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(e.points_delta), 0)::bigint
  from public.loyalty_events e
  where e.business_id = p_business_id
    and e.client_id = p_client_id;
$$;

revoke all on function private.loyalty_balance(uuid, uuid) from public;

-- Session + membership, then the customer row, locked: every write that
-- spends points is serialised per customer. FOR NO KEY UPDATE does not
-- conflict with the key-share locks of foreign keys (appointments, entries).
create function private.loyalty_lock_client(p_business_id uuid, p_client_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_client_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'clientId';
  end if;

  perform 1
  from public.clients c
  where c.id = p_client_id
    and c.business_id = p_business_id
  for no key update;

  if not found then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;
end;
$$;

revoke all on function private.loyalty_lock_client(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- 3. Earning on completion
-- ---------------------------------------------------------------------------

-- Eligibility of an appointment, decided once and for all at its first
-- completion: whether the business's program was active then. It survives
-- reopenings (appointments.completed_at does not: it is cleared on reopen),
-- so an appointment completed while the program was inactive never earns
-- retroactively by being reopened and completed again after activation; one
-- completed while active keeps earning through the generation mechanism.
-- A professional can still credit a historical visit by a manual
-- adjustment. Internal: no API role reads or writes it.
create table private.loyalty_appointment_eligibility (
  appointment_id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  eligible boolean not null,
  decided_at timestamptz not null default now(),
  foreign key (appointment_id, business_id)
    references public.appointments (id, business_id) on delete cascade
);

revoke all on private.loyalty_appointment_eligibility from public, anon, authenticated;

-- Existing appointments, conservatively, from what the database proves:
--   * an award exists (whatever its status now) → eligible;
--   * completed without any award → not eligible: whether a program was
--     active then cannot be proven, and never crediting is the safe side.
-- An appointment completed then reopened before this migration without an
-- award leaves no trace (completed_at was cleared): its next completion is
-- treated as its first (documented limitation).
insert into private.loyalty_appointment_eligibility (appointment_id, business_id, eligible, decided_at)
select a.id, a.business_id, true, pg_catalog.now()
from public.appointments a
where exists (
  select 1 from public.loyalty_events e
  where e.business_id = a.business_id
    and e.appointment_id = a.id
    and e.type = 'appointment_completed'
)
union all
select a.id, a.business_id, false, pg_catalog.now()
from public.appointments a
where a.status = 'completed'
  and not exists (
    select 1 from public.loyalty_events e
    where e.business_id = a.business_id
      and e.appointment_id = a.id
      and e.type = 'appointment_completed'
  );

-- Points for one completion, from the program as it is now and the
-- appointment's own snapshots (service, price at booking or last edit).
-- Integers and NUMERIC only: no floating point. Capped per appointment.
create function private.loyalty_award_points(
  p_program public.loyalty_programs,
  p_appointment public.appointments,
  p_rule_points integer
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(
    case
      when p_rule_points is not null then p_rule_points::numeric
      when p_program.accrual_mode = 'appointment' then p_program.points_per_completed_appointment::numeric
      else pg_catalog.floor(
        p_appointment.price_cents_snapshot::numeric * p_program.points_per_euro / 100
      )
    end,
    1000000
  )::integer;
$$;

revoke all on function private.loyalty_award_points(
  public.loyalty_programs, public.appointments, integer
) from public;

create function private.loyalty_award_appointment(p_appointment public.appointments)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_program public.loyalty_programs%rowtype;
  v_rule_points integer;
  v_points integer;
  v_generation integer;
  v_eligible boolean;
begin
  select p.* into v_program
  from public.loyalty_programs p
  where p.business_id = p_appointment.business_id;

  -- First completion: record whether it can ever earn (under the
  -- appointment's row lock, held by the UPDATE that fired this).
  insert into private.loyalty_appointment_eligibility (appointment_id, business_id, eligible)
  values (p_appointment.id, p_appointment.business_id, coalesce(v_program.active, false))
  on conflict (appointment_id) do nothing;

  select el.eligible into v_eligible
  from private.loyalty_appointment_eligibility el
  where el.appointment_id = p_appointment.id;

  if not v_eligible or v_program.business_id is null or not v_program.active then
    return;
  end if;

  -- Defensive: never two unreversed awards for one appointment.
  if exists (
    select 1
    from public.loyalty_events e
    where e.business_id = p_appointment.business_id
      and e.appointment_id = p_appointment.id
      and e.type = 'appointment_completed'
      and not exists (
        select 1 from public.loyalty_events r
        where r.reverses_event_id = e.id
      )
  ) then
    return;
  end if;

  select r.points into v_rule_points
  from public.loyalty_service_rules r
  where r.business_id = p_appointment.business_id
    and r.service_id = p_appointment.service_id;

  v_points := private.loyalty_award_points(v_program, p_appointment, v_rule_points);

  if v_points is null or v_points <= 0 then
    return;
  end if;

  select coalesce(max(e.award_generation), 0) + 1 into v_generation
  from public.loyalty_events e
  where e.business_id = p_appointment.business_id
    and e.appointment_id = p_appointment.id
    and e.type = 'appointment_completed';

  insert into public.loyalty_events (
    business_id, client_id, appointment_id, type, points_delta, reason,
    idempotency_key, created_by, award_generation, details
  )
  values (
    p_appointment.business_id,
    p_appointment.client_id,
    p_appointment.id,
    'appointment_completed',
    v_points,
    pg_catalog.left('Rendez-vous terminé : ' || p_appointment.service_name_snapshot, 500),
    'appointment:' || p_appointment.id::text || ':award:' || v_generation::text,
    (select auth.uid()),
    v_generation,
    pg_catalog.jsonb_build_object(
      'source', 'appointment_completed',
      'accrualMode', v_program.accrual_mode,
      'pointsPerCompletedAppointment', v_program.points_per_completed_appointment,
      'pointsPerEuro', v_program.points_per_euro::text,
      'serviceRulePoints', v_rule_points,
      'serviceId', p_appointment.service_id,
      'serviceName', p_appointment.service_name_snapshot,
      'priceCents', p_appointment.price_cents_snapshot,
      'currency', p_appointment.currency,
      'programVersion', v_program.version
    )
  );
end;
$$;

revoke all on function private.loyalty_award_appointment(public.appointments) from public;

-- Reverses every unreversed award of the appointment (normally one).
create function private.loyalty_reverse_appointment(
  p_appointment public.appointments,
  p_new_status public.appointment_status
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_award public.loyalty_events%rowtype;
begin
  for v_award in
    select e.*
    from public.loyalty_events e
    where e.business_id = p_appointment.business_id
      and e.appointment_id = p_appointment.id
      and e.type = 'appointment_completed'
      and not exists (
        select 1 from public.loyalty_events r
        where r.reverses_event_id = e.id
      )
    order by e.ledger_seq
  loop
    insert into public.loyalty_events (
      business_id, client_id, appointment_id, type, points_delta, reason,
      idempotency_key, created_by, reverses_event_id, details
    )
    values (
      v_award.business_id,
      v_award.client_id,
      v_award.appointment_id,
      'correction',
      -v_award.points_delta,
      'Points annulés : rendez-vous rouvert',
      'appointment:' || p_appointment.id::text || ':reverse:' || v_award.award_generation::text,
      (select auth.uid()),
      v_award.id,
      pg_catalog.jsonb_build_object(
        'source', 'appointment_reopened',
        'appointmentStatus', p_new_status,
        'awardGeneration', v_award.award_generation
      )
    );
  end loop;
end;
$$;

revoke all on function private.loyalty_reverse_appointment(
  public.appointments, public.appointment_status
) from public;

-- Runs inside the UPDATE, under the appointment's row lock.
create function private.loyalty_on_appointment_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if old.status <> 'completed' and new.status = 'completed' then
    perform private.loyalty_award_appointment(new);
  elsif old.status = 'completed' and new.status <> 'completed' then
    perform private.loyalty_reverse_appointment(new, new.status);
  elsif old.status = 'completed' and (
    new.client_id <> old.client_id
    or new.service_id <> old.service_id
    or new.price_cents_snapshot <> old.price_cents_snapshot
  ) and exists (
    select 1
    from public.loyalty_events e
    where e.business_id = new.business_id
      and e.appointment_id = new.id
      and e.type = 'appointment_completed'
      and not exists (
        select 1 from public.loyalty_events r
        where r.reverses_event_id = e.id
      )
  ) then
    -- The standing award was computed from these: they stay as they are
    -- (reopen the appointment first, as the agenda requires).
    raise exception using errcode = 'P0001', message = 'appointment_not_editable';
  end if;

  return null;
end;
$$;

revoke all on function private.loyalty_on_appointment_update() from public;

create trigger appointments_loyalty
  after update of status, client_id, service_id, price_cents_snapshot
  on public.appointments
  for each row execute function private.loyalty_on_appointment_update();

-- The agenda's status transitions, unchanged except one rule: a completed
-- appointment can be reopened (completed → confirmed) even after points
-- were awarded; the trigger above reverses them with a compensating entry.
create or replace function public.agenda_set_appointment_status(
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
-- 4. Rewards and redemptions
-- ---------------------------------------------------------------------------

alter table public.rewards
  add column service_id uuid,
  add column currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  add column version integer not null default 1 check (version >= 1),
  add column creation_request_id uuid,
  add column creation_request_fingerprint text,
  add constraint rewards_service_fkey
    foreign key (service_id, business_id)
    references public.services (id, business_id) on delete set null (service_id),
  add constraint rewards_creation_request_fingerprint_present check (
    (creation_request_id is null) = (creation_request_fingerprint is null)
  );

-- Existing fixed discounts were expressed in the business currency. Only
-- the new column is written: every historical value stays as it was.
update public.rewards w
set currency = coalesce(st.currency, 'EUR')
from public.business_settings st
where st.business_id = w.business_id
  and w.reward_type = 'fixed_discount'
  and w.currency is null;

-- Bounds for new writes, with the same grandfathering as
-- private.loyalty_programs_bounds: the previous schema accepted longer
-- descriptions, more points, any positive value. Such a reward stays
-- readable and redeemable; an update may keep its historical values
-- unchanged (an activation, a foreign-key action), never write new ones
-- out of bounds.
create function private.rewards_bounds()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_insert boolean := tg_op = 'INSERT';
begin
  if (v_insert or new.points_required is distinct from old.points_required)
    and new.points_required > 1000000 then
    raise exception using errcode = '23514', message = 'rewards_points_required_range';
  end if;
  if (v_insert or new.description is distinct from old.description)
    and pg_catalog.char_length(new.description) > 1000 then
    raise exception using errcode = '23514', message = 'rewards_description_length';
  end if;
  if (v_insert
      or new.reward_value is distinct from old.reward_value
      or new.reward_type is distinct from old.reward_type)
    and new.reward_type = 'percentage_discount'
    and new.reward_value not between 1 and 100 then
    raise exception using errcode = '23514', message = 'rewards_percentage_range';
  end if;
  if (v_insert
      or new.reward_value is distinct from old.reward_value
      or new.reward_type is distinct from old.reward_type
      or new.currency is distinct from old.currency)
    and new.reward_type = 'fixed_discount'
    and (new.reward_value > 10000000 or new.currency is null) then
    raise exception using errcode = '23514', message = 'rewards_fixed_value_range';
  end if;

  return new;
end;
$$;

revoke all on function private.rewards_bounds() from public;

create trigger rewards_bounds
  before insert or update on public.rewards
  for each row execute function private.rewards_bounds();

create unique index rewards_creation_request_idx
  on public.rewards (business_id, creation_request_id)
  where creation_request_id is not null;

create trigger rewards_bump_version
  before update on public.rewards
  for each row execute function private.bump_version();

comment on column public.rewards.reward_value is
  'fixed_discount: amount in minor units of `currency`; percentage_discount: 1-100; free_service: null.';
comment on column public.rewards.service_id is
  'free_service: the complimentary service (null once that service is deleted: the reward is then unavailable).';

create type public.reward_redemption_status as enum ('issued', 'fulfilled', 'cancelled');

alter table public.reward_redemptions
  add column status public.reward_redemption_status not null default 'issued',
  add column request_id uuid,
  add column reward_name_snapshot text,
  add column reward_type_snapshot public.reward_type,
  add column reward_value_snapshot integer,
  add column reward_currency_snapshot text,
  add column reward_service_id_snapshot uuid,
  add column reward_service_name_snapshot text,
  add column fulfilled_at timestamptz,
  add column fulfilled_by uuid references public.profiles (id) on delete set null,
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references public.profiles (id) on delete set null,
  add column cancellation_reason text check (
    cancellation_reason is null or char_length(cancellation_reason) <= 500
  ),
  add column refund_event_id uuid,
  add column updated_at timestamptz not null default now();

-- Redemptions recorded before this migration were final: fulfilled.
update public.reward_redemptions r
set status = 'fulfilled',
    fulfilled_at = r.redeemed_at,
    reward_name_snapshot = w.name,
    reward_type_snapshot = w.reward_type,
    reward_value_snapshot = w.reward_value,
    reward_currency_snapshot = w.currency
from public.rewards w
where w.id = r.reward_id
  and w.business_id = r.business_id;

alter table public.reward_redemptions
  alter column reward_name_snapshot set not null,
  alter column reward_type_snapshot set not null,
  add constraint reward_redemptions_refund_fkey
    foreign key (refund_event_id, business_id)
    references public.loyalty_events (id, business_id),
  add constraint reward_redemptions_refund_once unique (refund_event_id),
  add constraint reward_redemptions_status_fields check (
    (status = 'issued' and fulfilled_at is null and cancelled_at is null and refund_event_id is null)
    or (status = 'fulfilled' and fulfilled_at is not null and cancelled_at is null and refund_event_id is null)
    or (status = 'cancelled' and cancelled_at is not null and fulfilled_at is null and refund_event_id is not null)
  );

create unique index reward_redemptions_request_idx
  on public.reward_redemptions (business_id, request_id)
  where request_id is not null;

create trigger set_reward_redemptions_updated_at
  before update on public.reward_redemptions
  for each row execute function public.set_updated_at();

comment on column public.reward_redemptions.status is
  'issued: points debited, reward owed to the customer; fulfilled: applied at a '
  'visit (recorded by the professional, no payment is settled here); '
  'cancelled: points refunded by `refund_event_id`.';

-- The reward as it was when issued, whatever the write path; and the
-- identity of an issued reward never changes afterwards.
create function private.reward_redemption_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reward public.rewards%rowtype;
begin
  if tg_op = 'INSERT' then
    select w.* into v_reward
    from public.rewards w
    where w.id = new.reward_id
      and w.business_id = new.business_id;

    if found then
      new.reward_name_snapshot := v_reward.name;
      new.reward_type_snapshot := v_reward.reward_type;
      new.reward_value_snapshot := v_reward.reward_value;
      new.reward_currency_snapshot := v_reward.currency;
      new.reward_service_id_snapshot := v_reward.service_id;
      new.reward_service_name_snapshot := (
        select s.name from public.services s
        where s.id = v_reward.service_id and s.business_id = v_reward.business_id
      );
    end if;

    return new;
  end if;

  if (new.business_id, new.reward_id, new.client_id, new.loyalty_event_id,
      new.points_spent, new.redeemed_at, new.request_id,
      new.reward_name_snapshot, new.reward_type_snapshot, new.reward_value_snapshot,
      new.reward_currency_snapshot, new.reward_service_id_snapshot,
      new.reward_service_name_snapshot)
     is distinct from
     (old.business_id, old.reward_id, old.client_id, old.loyalty_event_id,
      old.points_spent, old.redeemed_at, old.request_id,
      old.reward_name_snapshot, old.reward_type_snapshot, old.reward_value_snapshot,
      old.reward_currency_snapshot, old.reward_service_id_snapshot,
      old.reward_service_name_snapshot)
  then
    raise exception using errcode = '55000', message = 'reward_redemption_immutable';
  end if;

  return new;
end;
$$;

revoke all on function private.reward_redemption_guard() from public;

create trigger reward_redemptions_guard
  before insert or update on public.reward_redemptions
  for each row execute function private.reward_redemption_guard();

-- ---------------------------------------------------------------------------
-- 5. Balances (read model over the ledger)
-- ---------------------------------------------------------------------------

-- One row per customer with at least one entry. SECURITY INVOKER: the
-- ledger's RLS applies (members of the business only).
create view public.loyalty_balances
with (security_invoker = true)
as
select
  e.business_id,
  e.client_id,
  sum(e.points_delta)::bigint as balance,
  coalesce(sum(e.points_delta) filter (where e.points_delta > 0), 0)::bigint as points_credited,
  coalesce(-sum(e.points_delta) filter (where e.points_delta < 0), 0)::bigint as points_debited,
  max(e.created_at) as last_entry_at
from public.loyalty_events e
group by e.business_id, e.client_id;

revoke all on public.loyalty_balances from anon, authenticated;
grant select on public.loyalty_balances to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Professional API
-- ---------------------------------------------------------------------------

-- Replaces the whole configuration, if it is still at `p_expected_version`
-- (0: no program row yet). The same values again are a success whatever
-- the version (a retried save).
create function public.loyalty_configure_program(
  p_business_id uuid,
  p_expected_version integer,
  p_active boolean,
  p_accrual_mode public.loyalty_accrual_mode,
  p_points_per_completed_appointment integer,
  p_points_per_euro numeric default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_current public.loyalty_programs%rowtype;
  v_per_euro numeric(10, 4);
  v_version integer;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;
  if p_active is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'active';
  end if;
  if p_accrual_mode is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'accrualMode';
  end if;
  select p.* into v_current
  from public.loyalty_programs p
  where p.business_id = p_business_id
  for update;

  -- A historical out-of-bounds value is accepted only unchanged (see
  -- private.loyalty_programs_bounds); any new value must be in bounds.
  if p_points_per_completed_appointment is null
    or (p_points_per_completed_appointment not between 1 and 10000
        and p_points_per_completed_appointment is distinct from v_current.points_per_completed_appointment) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'pointsPerCompletedAppointment';
  end if;
  if p_accrual_mode = 'spend' then
    if p_points_per_euro is null
      or (p_points_per_euro not between 0.01 and 100
          and p_points_per_euro is distinct from v_current.points_per_euro)
      or p_points_per_euro <> pg_catalog.round(p_points_per_euro, 4) then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'pointsPerEuro';
    end if;
    v_per_euro := p_points_per_euro;
  elsif p_points_per_euro is not null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'pointsPerEuro';
  end if;

  if v_current.business_id is null then
    if p_expected_version <> 0 then
      raise exception using errcode = 'P0001', message = 'stale_loyalty_program';
    end if;

    insert into public.loyalty_programs (
      business_id, active, accrual_mode, points_per_completed_appointment, points_per_euro
    )
    values (
      p_business_id, p_active, p_accrual_mode, p_points_per_completed_appointment, v_per_euro
    )
    on conflict (business_id) do nothing
    returning version into v_version;

    if v_version is null then
      -- Created concurrently: this save was based on "no program".
      raise exception using errcode = 'P0001', message = 'stale_loyalty_program';
    end if;

    return v_version;
  end if;

  if v_current.active = p_active
    and v_current.accrual_mode = p_accrual_mode
    and v_current.points_per_completed_appointment = p_points_per_completed_appointment
    and v_current.points_per_euro is not distinct from v_per_euro then
    return v_current.version;
  end if;

  if v_current.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_loyalty_program';
  end if;

  update public.loyalty_programs p
  set active = p_active,
      accrual_mode = p_accrual_mode,
      points_per_completed_appointment = p_points_per_completed_appointment,
      points_per_euro = v_per_euro
  where p.business_id = p_business_id
  returning p.version into v_version;

  return v_version;
end;
$$;

-- Sets (p_points 0-10000) or removes (null) the rule of one service.
create function public.loyalty_set_service_rule(
  p_business_id uuid,
  p_service_id uuid,
  p_points integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_agenda_access(p_business_id);

  if p_service_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'serviceId';
  end if;
  if p_points is not null and p_points not between 0 and 10000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'points';
  end if;

  perform 1
  from public.services s
  where s.id = p_service_id
    and s.business_id = p_business_id
  for key share;

  if not found then
    raise exception using errcode = 'P0002', message = 'service_not_found', hint = 'serviceId';
  end if;

  if p_points is null then
    delete from public.loyalty_service_rules r
    where r.business_id = p_business_id
      and r.service_id = p_service_id;
  else
    insert into public.loyalty_service_rules (business_id, service_id, points)
    values (p_business_id, p_service_id, p_points)
    on conflict (business_id, service_id)
      do update set points = excluded.points
      where public.loyalty_service_rules.points is distinct from excluded.points;
  end if;
end;
$$;

-- Validated reward fields; raises invalid_input with the field as hint.
create function private.loyalty_reward_fields(
  p_business_id uuid,
  p_name text,
  p_description text,
  p_points_required integer,
  p_reward_type public.reward_type,
  p_reward_value integer,
  p_service_id uuid,
  p_current public.rewards,
  out name text,
  out description text,
  out reward_value integer,
  out service_id uuid,
  out currency text
)
language plpgsql
stable
set search_path = ''
as $$
begin
  -- p_current (an update): a historical value outside today's bounds is
  -- accepted only unchanged (see private.rewards_bounds).
  name := private.optional_text(p_name, 120, 'name');
  if name is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'name';
  end if;
  if p_current.id is not null and p_description = p_current.description then
    description := p_current.description;
  else
    description := private.optional_text(p_description, 1000, 'description');
  end if;

  if p_points_required is null
    or p_points_required < 1
    or (p_points_required > 1000000
        and p_points_required is distinct from p_current.points_required) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'pointsRequired';
  end if;
  if p_reward_type is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'rewardType';
  end if;

  if p_reward_type = 'percentage_discount' then
    if p_reward_value is null
      or p_reward_value < 1
      or (p_reward_value > 100 and p_reward_value is distinct from p_current.reward_value) then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'rewardValue';
    end if;
  elsif p_reward_type = 'fixed_discount' then
    if p_reward_value is null
      or p_reward_value < 1
      or (p_reward_value > 10000000 and p_reward_value is distinct from p_current.reward_value) then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'rewardValue';
    end if;
    select st.currency into currency
    from public.business_settings st
    where st.business_id = p_business_id;
    currency := coalesce(currency, 'EUR');
  elsif p_reward_value is not null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'rewardValue';
  end if;
  reward_value := p_reward_value;

  if p_reward_type = 'free_service' then
    if p_service_id is null or not exists (
      select 1 from public.services s
      where s.id = p_service_id and s.business_id = p_business_id
    ) then
      raise exception using errcode = 'P0002', message = 'service_not_found', hint = 'serviceId';
    end if;
    service_id := p_service_id;
  elsif p_service_id is not null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'serviceId';
  end if;
end;
$$;

revoke all on function private.loyalty_reward_fields(
  uuid, text, text, integer, public.reward_type, integer, uuid, public.rewards
) from public;

-- Creates a reward, once per request: a retry of the same command answers
-- the reward it created; the same request with another command is refused.
create function public.loyalty_create_reward(
  p_business_id uuid,
  p_request_id uuid,
  p_name text,
  p_description text,
  p_points_required integer,
  p_reward_type public.reward_type,
  p_reward_value integer,
  p_service_id uuid,
  p_active boolean
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fields record;
  v_fingerprint text;
  v_existing record;
  v_id uuid;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_active is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'active';
  end if;

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'name', p_name,
        'description', p_description,
        'points_required', p_points_required,
        'reward_type', p_reward_type,
        'reward_value', p_reward_value,
        'service_id', p_service_id,
        'active', p_active
      )::text,
      'UTF8'
    )),
    'hex'
  );

  select w.id, w.creation_request_fingerprint into v_existing
  from public.rewards w
  where w.business_id = p_business_id
    and w.creation_request_id = p_request_id;

  if found then
    if v_existing.creation_request_fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    return v_existing.id;
  end if;

  v_fields := private.loyalty_reward_fields(
    p_business_id, p_name, p_description, p_points_required, p_reward_type,
    p_reward_value, p_service_id, null
  );

  insert into public.rewards (
    business_id, name, description, points_required, reward_type, reward_value,
    service_id, currency, active, creation_request_id, creation_request_fingerprint
  )
  values (
    p_business_id, v_fields.name, v_fields.description, p_points_required, p_reward_type,
    v_fields.reward_value, v_fields.service_id, v_fields.currency, p_active,
    p_request_id, v_fingerprint
  )
  on conflict (business_id, creation_request_id) where creation_request_id is not null
    do nothing
  returning id into v_id;

  if v_id is null then
    -- The same request, committed concurrently.
    select w.id, w.creation_request_fingerprint into v_existing
    from public.rewards w
    where w.business_id = p_business_id
      and w.creation_request_id = p_request_id;
    if v_existing.creation_request_fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    return v_existing.id;
  end if;

  return v_id;
end;
$$;

-- Replaces the editable fields (the type is fixed at creation), if the
-- reward is still at `p_expected_version`. Issued rewards keep their
-- snapshot: an edit never changes what a customer already holds.
create function public.loyalty_update_reward(
  p_business_id uuid,
  p_reward_id uuid,
  p_expected_version integer,
  p_name text,
  p_description text,
  p_points_required integer,
  p_reward_value integer,
  p_service_id uuid,
  p_active boolean
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_current public.rewards%rowtype;
  v_fields record;
  v_version integer;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_expected_version is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;
  if p_active is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'active';
  end if;

  select w.* into v_current
  from public.rewards w
  where w.id = p_reward_id
    and w.business_id = p_business_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'reward_not_found';
  end if;

  v_fields := private.loyalty_reward_fields(
    p_business_id, p_name, p_description, p_points_required, v_current.reward_type,
    p_reward_value, p_service_id, v_current
  );

  if v_current.name = v_fields.name
    and v_current.description is not distinct from v_fields.description
    and v_current.points_required = p_points_required
    and v_current.reward_value is not distinct from v_fields.reward_value
    and v_current.service_id is not distinct from v_fields.service_id
    and v_current.currency is not distinct from coalesce(v_fields.currency, v_current.currency)
    and v_current.active = p_active then
    return v_current.version;
  end if;

  if v_current.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_reward';
  end if;

  update public.rewards w
  set name = v_fields.name,
      description = v_fields.description,
      points_required = p_points_required,
      reward_value = v_fields.reward_value,
      service_id = v_fields.service_id,
      currency = coalesce(v_fields.currency, w.currency),
      active = p_active
  where w.id = p_reward_id
  returning w.version into v_version;

  return v_version;
end;
$$;

-- Issues a reward to a customer: debits its points and records the
-- redemption, atomically, once per request. Under the customer's lock the
-- balance is read after every earlier spending has committed.
create function public.loyalty_redeem_reward(
  p_business_id uuid,
  p_client_id uuid,
  p_reward_id uuid,
  p_request_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing public.reward_redemptions%rowtype;
  v_program public.loyalty_programs%rowtype;
  v_reward public.rewards%rowtype;
  v_event_id uuid;
  v_redemption_id uuid := gen_random_uuid();
begin
  perform private.assert_agenda_access(p_business_id);

  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_reward_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'rewardId';
  end if;

  perform private.loyalty_lock_client(p_business_id, p_client_id);

  -- After the lock: a concurrent retry of this request has committed.
  select r.* into v_existing
  from public.reward_redemptions r
  where r.business_id = p_business_id
    and r.request_id = p_request_id;

  if found then
    if v_existing.client_id <> p_client_id or v_existing.reward_id <> p_reward_id then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    return v_existing.id;
  end if;

  -- Shared lock: a concurrent (de)activation commits first or waits.
  select p.* into v_program
  from public.loyalty_programs p
  where p.business_id = p_business_id
  for share;

  if not found or not v_program.active then
    raise exception using errcode = 'P0001', message = 'loyalty_program_inactive';
  end if;

  select w.* into v_reward
  from public.rewards w
  where w.id = p_reward_id
    and w.business_id = p_business_id
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'reward_not_found', hint = 'rewardId';
  end if;
  if not v_reward.active
    or (v_reward.reward_type = 'free_service' and v_reward.service_id is null)
    or (v_reward.reward_type = 'fixed_discount' and v_reward.currency is null) then
    raise exception using errcode = 'P0001', message = 'reward_unavailable', hint = 'rewardId';
  end if;

  if private.loyalty_balance(p_business_id, p_client_id) < v_reward.points_required then
    raise exception using errcode = 'P0001', message = 'insufficient_points';
  end if;

  begin
    insert into public.loyalty_events (
      business_id, client_id, type, points_delta, reason, idempotency_key, created_by, details
    )
    values (
      p_business_id,
      p_client_id,
      'reward_redeemed',
      -v_reward.points_required,
      pg_catalog.left('Récompense : ' || v_reward.name, 500),
      'redemption:' || p_request_id::text,
      (select auth.uid()),
      pg_catalog.jsonb_build_object(
        'source', 'reward_redeemed',
        'redemptionId', v_redemption_id,
        'rewardId', v_reward.id,
        'rewardVersion', v_reward.version
      )
    )
    returning id into v_event_id;
  exception
    when unique_violation then
      -- The same request, committed meanwhile for another customer (a
      -- retry for this customer waits on the customer lock instead).
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
  end;

  insert into public.reward_redemptions (
    id, business_id, reward_id, client_id, loyalty_event_id, points_spent,
    created_by, request_id, status
  )
  values (
    v_redemption_id, p_business_id, v_reward.id, p_client_id, v_event_id,
    v_reward.points_required, (select auth.uid()), p_request_id, 'issued'
  );

  return v_redemption_id;
end;
$$;

-- issued → fulfilled: the professional records that the reward was applied
-- at a visit (optionally that appointment, of the same customer). Nothing is
-- charged or settled. Already fulfilled: success (a retry).
create function public.loyalty_fulfil_redemption(
  p_business_id uuid,
  p_redemption_id uuid,
  p_appointment_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_current public.reward_redemptions%rowtype;
begin
  perform private.assert_agenda_access(p_business_id);

  select r.* into v_current
  from public.reward_redemptions r
  where r.id = p_redemption_id
    and r.business_id = p_business_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'redemption_not_found';
  end if;

  if v_current.status = 'fulfilled' then
    return;
  end if;
  if v_current.status <> 'issued' then
    raise exception using errcode = 'P0001', message = 'invalid_redemption_transition';
  end if;

  if p_appointment_id is not null and not exists (
    select 1 from public.appointments a
    where a.id = p_appointment_id
      and a.business_id = p_business_id
      and a.client_id = v_current.client_id
  ) then
    raise exception using errcode = 'P0002', message = 'appointment_not_found', hint = 'appointmentId';
  end if;

  update public.reward_redemptions r
  set status = 'fulfilled',
      fulfilled_at = pg_catalog.now(),
      fulfilled_by = (select auth.uid()),
      appointment_id = coalesce(p_appointment_id, r.appointment_id)
  where r.id = p_redemption_id;
end;
$$;

-- issued → cancelled: the points come back with a compensating entry that
-- names the debit. Already cancelled: success (a retry). A fulfilled reward
-- is final (correct it with an adjustment).
create function public.loyalty_cancel_redemption(
  p_business_id uuid,
  p_redemption_id uuid,
  p_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := private.optional_text(p_reason, 500, 'reason');
  v_current public.reward_redemptions%rowtype;
  v_debit public.loyalty_events%rowtype;
  v_refund_id uuid;
begin
  perform private.assert_agenda_access(p_business_id);

  select r.* into v_current
  from public.reward_redemptions r
  where r.id = p_redemption_id
    and r.business_id = p_business_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'redemption_not_found';
  end if;

  if v_current.status = 'cancelled' then
    return;
  end if;
  if v_current.status <> 'issued' then
    raise exception using errcode = 'P0001', message = 'invalid_redemption_transition';
  end if;

  select e.* into v_debit
  from public.loyalty_events e
  where e.id = v_current.loyalty_event_id
    and e.business_id = p_business_id;

  insert into public.loyalty_events (
    business_id, client_id, type, points_delta, reason, idempotency_key,
    created_by, reverses_event_id, details
  )
  values (
    p_business_id,
    v_debit.client_id,
    'correction',
    -v_debit.points_delta,
    pg_catalog.left('Récompense annulée : ' || v_current.reward_name_snapshot, 500),
    'redemption:' || p_redemption_id::text || ':refund',
    (select auth.uid()),
    v_debit.id,
    pg_catalog.jsonb_build_object(
      'source', 'redemption_cancelled',
      'redemptionId', p_redemption_id
    )
  )
  returning id into v_refund_id;

  update public.reward_redemptions r
  set status = 'cancelled',
      cancelled_at = pg_catalog.now(),
      cancelled_by = (select auth.uid()),
      cancellation_reason = v_reason,
      refund_event_id = v_refund_id
  where r.id = p_redemption_id;
end;
$$;

-- A manual credit or debit, once per request. A debit cannot take the
-- balance below zero.
create function public.loyalty_adjust_points(
  p_business_id uuid,
  p_client_id uuid,
  p_request_id uuid,
  p_points_delta integer,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := private.optional_text(p_reason, 500, 'reason');
  v_key text;
  v_existing public.loyalty_events%rowtype;
  v_id uuid;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if p_points_delta is null or p_points_delta = 0 or abs(p_points_delta) > 100000 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'pointsDelta';
  end if;
  if v_reason is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'reason';
  end if;

  perform private.loyalty_lock_client(p_business_id, p_client_id);

  v_key := 'manual:' || p_request_id::text;

  select e.* into v_existing
  from public.loyalty_events e
  where e.business_id = p_business_id
    and e.idempotency_key = v_key;

  if found then
    if v_existing.client_id <> p_client_id
      or v_existing.points_delta <> p_points_delta
      or v_existing.reason <> v_reason then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    return v_existing.id;
  end if;

  if p_points_delta < 0
    and private.loyalty_balance(p_business_id, p_client_id) + p_points_delta < 0 then
    raise exception using errcode = 'P0001', message = 'insufficient_points';
  end if;

  begin
    insert into public.loyalty_events (
      business_id, client_id, type, points_delta, reason, idempotency_key, created_by, details
    )
    values (
      p_business_id, p_client_id, 'manual_adjustment', p_points_delta, v_reason, v_key,
      (select auth.uid()),
      pg_catalog.jsonb_build_object('source', 'manual_adjustment', 'requestId', p_request_id)
    )
    returning id into v_id;
  exception
    when unique_violation then
      -- The same request, committed meanwhile for another customer.
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
  end;

  return v_id;
end;
$$;

-- Reverses one manual adjustment with a compensating entry (once: a retry
-- answers the existing reversal). Awards and redemptions are reversed by
-- their own workflows (reopening the appointment, cancelling the reward).
create function public.loyalty_reverse_adjustment(
  p_business_id uuid,
  p_entry_id uuid,
  p_reason text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := private.optional_text(p_reason, 500, 'reason');
  v_target public.loyalty_events%rowtype;
  v_id uuid;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_entry_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'entryId';
  end if;

  select e.* into v_target
  from public.loyalty_events e
  where e.id = p_entry_id
    and e.business_id = p_business_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'loyalty_entry_not_found';
  end if;

  perform private.loyalty_lock_client(p_business_id, v_target.client_id);

  if v_target.type <> 'manual_adjustment' then
    raise exception using errcode = 'P0001', message = 'loyalty_entry_not_reversible';
  end if;

  select e.id into v_id
  from public.loyalty_events e
  where e.reverses_event_id = p_entry_id;

  if found then
    return v_id;
  end if;

  -- Reversing a credit is a debit: never below zero (cancel what it paid
  -- for first).
  if v_target.points_delta > 0
    and private.loyalty_balance(p_business_id, v_target.client_id) - v_target.points_delta < 0 then
    raise exception using errcode = 'P0001', message = 'insufficient_points';
  end if;

  insert into public.loyalty_events (
    business_id, client_id, type, points_delta, reason, idempotency_key,
    created_by, reverses_event_id, details
  )
  values (
    p_business_id,
    v_target.client_id,
    'correction',
    -v_target.points_delta,
    coalesce(v_reason, 'Ajustement annulé'),
    'manual:' || p_entry_id::text || ':reverse',
    (select auth.uid()),
    v_target.id,
    pg_catalog.jsonb_build_object('source', 'adjustment_reversed')
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- One customer's loyalty state: balance, totals, and every reward of the
-- business with its eligibility for this customer.
create function public.loyalty_client_summary(
  p_business_id uuid,
  p_client_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_active boolean;
begin
  perform private.assert_agenda_access(p_business_id);

  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  v_balance := private.loyalty_balance(p_business_id, p_client_id);
  select coalesce(
    (select p.active from public.loyalty_programs p where p.business_id = p_business_id),
    false
  ) into v_active;

  return pg_catalog.jsonb_build_object(
    'clientId', p_client_id,
    'programActive', v_active,
    'balance', v_balance,
    'pointsCredited', (
      select coalesce(sum(e.points_delta), 0) from public.loyalty_events e
      where e.business_id = p_business_id and e.client_id = p_client_id and e.points_delta > 0
    ),
    'pointsDebited', (
      select coalesce(-sum(e.points_delta), 0) from public.loyalty_events e
      where e.business_id = p_business_id and e.client_id = p_client_id and e.points_delta < 0
    ),
    'issuedRedemptions', (
      select count(*) from public.reward_redemptions r
      where r.business_id = p_business_id and r.client_id = p_client_id and r.status = 'issued'
    ),
    'rewards', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rewardId', w.id,
          'pointsRequired', w.points_required,
          'eligible', v_active and w.active and w.unavailable is null
                      and v_balance >= w.points_required,
          'missingPoints', greatest(w.points_required - v_balance, 0),
          'unavailableReason', case
            when not v_active then 'program_inactive'
            when not w.active then 'inactive'
            else w.unavailable
          end
        )
        order by w.points_required, w.name, w.id
      )
      from (
        select r.*,
          case
            when r.reward_type = 'free_service' and r.service_id is null then 'service_missing'
            when r.reward_type = 'fixed_discount' and r.currency is null then 'currency_missing'
          end as unavailable
        from public.rewards r
        where r.business_id = p_business_id
      ) w
    ), '[]'::jsonb)
  );
end;
$$;

-- One customer's ledger, newest first, keyset-paginated on ledger_seq
-- (p_before_seq: the last seq of the previous page). Each entry carries the
-- balance right after it, what reversed it, and its redemption if any.
create function public.loyalty_client_ledger(
  p_business_id uuid,
  p_client_id uuid,
  p_before_seq bigint default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  seq bigint,
  type public.loyalty_event_type,
  points_delta integer,
  balance_after bigint,
  reason text,
  appointment_id uuid,
  reverses_event_id uuid,
  reversed_by_event_id uuid,
  award_generation integer,
  details jsonb,
  created_at timestamptz,
  created_by uuid,
  redemption jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_agenda_access(p_business_id);

  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  return query
  with ledger as (
    select e.*,
      sum(e.points_delta) over (order by e.ledger_seq)::bigint as running
    from public.loyalty_events e
    where e.business_id = p_business_id
      and e.client_id = p_client_id
  )
  select
    l.id, l.ledger_seq, l.type, l.points_delta, l.running, l.reason,
    l.appointment_id, l.reverses_event_id,
    (select r.id from public.loyalty_events r where r.reverses_event_id = l.id),
    l.award_generation, l.details, l.created_at, l.created_by,
    (
      select pg_catalog.jsonb_build_object(
        'id', d.id,
        'rewardId', d.reward_id,
        'rewardName', d.reward_name_snapshot,
        'rewardType', d.reward_type_snapshot,
        'rewardValue', d.reward_value_snapshot,
        'currency', d.reward_currency_snapshot,
        'serviceId', d.reward_service_id_snapshot,
        'serviceName', d.reward_service_name_snapshot,
        'pointsSpent', d.points_spent,
        'status', d.status,
        'redeemedAt', d.redeemed_at,
        'fulfilledAt', d.fulfilled_at,
        'appointmentId', d.appointment_id,
        'cancelledAt', d.cancelled_at,
        'cancellationReason', d.cancellation_reason
      )
      from public.reward_redemptions d
      where d.business_id = p_business_id
        and (d.loyalty_event_id = l.id or d.refund_event_id = l.id)
    )
  from ledger l
  where p_before_seq is null or l.ledger_seq < p_before_seq
  order by l.ledger_seq desc
  -- 100 entries per page at most, plus one: the caller asks for one more
  -- than it shows to know whether another page exists.
  limit least(greatest(coalesce(p_limit, 50), 1), 101);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants: signed-in professionals only
-- ---------------------------------------------------------------------------

revoke all on function public.loyalty_configure_program(
  uuid, integer, boolean, public.loyalty_accrual_mode, integer, numeric
) from public, anon;
revoke all on function public.loyalty_set_service_rule(uuid, uuid, integer) from public, anon;
revoke all on function public.loyalty_create_reward(
  uuid, uuid, text, text, integer, public.reward_type, integer, uuid, boolean
) from public, anon;
revoke all on function public.loyalty_update_reward(
  uuid, uuid, integer, text, text, integer, integer, uuid, boolean
) from public, anon;
revoke all on function public.loyalty_redeem_reward(uuid, uuid, uuid, uuid) from public, anon;
revoke all on function public.loyalty_fulfil_redemption(uuid, uuid, uuid) from public, anon;
revoke all on function public.loyalty_cancel_redemption(uuid, uuid, text) from public, anon;
revoke all on function public.loyalty_adjust_points(uuid, uuid, uuid, integer, text) from public, anon;
revoke all on function public.loyalty_reverse_adjustment(uuid, uuid, text) from public, anon;
revoke all on function public.loyalty_client_summary(uuid, uuid) from public, anon;
revoke all on function public.loyalty_client_ledger(uuid, uuid, bigint, integer) from public, anon;

grant execute on function public.loyalty_configure_program(
  uuid, integer, boolean, public.loyalty_accrual_mode, integer, numeric
) to authenticated;
grant execute on function public.loyalty_set_service_rule(uuid, uuid, integer) to authenticated;
grant execute on function public.loyalty_create_reward(
  uuid, uuid, text, text, integer, public.reward_type, integer, uuid, boolean
) to authenticated;
grant execute on function public.loyalty_update_reward(
  uuid, uuid, integer, text, text, integer, integer, uuid, boolean
) to authenticated;
grant execute on function public.loyalty_redeem_reward(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.loyalty_fulfil_redemption(uuid, uuid, uuid) to authenticated;
grant execute on function public.loyalty_cancel_redemption(uuid, uuid, text) to authenticated;
grant execute on function public.loyalty_adjust_points(uuid, uuid, uuid, integer, text) to authenticated;
grant execute on function public.loyalty_reverse_adjustment(uuid, uuid, text) to authenticated;
grant execute on function public.loyalty_client_summary(uuid, uuid) to authenticated;
grant execute on function public.loyalty_client_ledger(uuid, uuid, bigint, integer) to authenticated;
