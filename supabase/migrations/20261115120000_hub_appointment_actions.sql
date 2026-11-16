-- M2-R04: from her Client Hub, a client cancels or moves her own appointment
-- (docs/CLIENT_HUB_CONTRACT.md, « Annuler ou déplacer »).
--
--   * A structured policy per business (lead minutes for cancelling and for
--     moving; null = not from the Hub), FROZEN on every new appointment
--     (appointments.policy_snapshot). A changed policy applies to new
--     appointments only; an appointment from before has no snapshot and is
--     handled by the business (policy_unavailable).
--   * Moving keeps everything but the time: same service, options, price,
--     duration and buffer (the appointment's snapshots). The new time must be
--     one the public booking would offer for that duration, its own interval
--     excepted (private.compute_available_slots learns to ignore ONE
--     appointment, passed only by the functions below, never by a client).
--   * One replay per (business, requestId), for the account that sent it; the
--     answer of a replay is the appointment as it is now.
--   * Every freed interval (cancellation, move, from any writer) is recorded
--     once per appointment version in private.capacity_releases: the signal
--     the waiting list will read. No personal data in it.
--
-- Lock order of the two writes: business_schedule → her Hub session row
-- (FOR SHARE) → her CRM record (FOR SHARE) → its Hub access (FOR SHARE) → the
-- appointment (FOR UPDATE). The record → access order is the one of
-- client_hub_set_access and of the email-change trigger; the sign-out locks
-- session rows without taking the schedule lock: no wait cycle.

-- ---------------------------------------------------------------------------
-- Policy

alter table public.business_settings
  add column cancellation_lead_minutes integer
    check (cancellation_lead_minutes between 0 and 43200),
  add column reschedule_lead_minutes integer
    check (reschedule_lead_minutes between 0 and 43200);

comment on column public.business_settings.cancellation_lead_minutes is
  'Minutes before the start until which a client may cancel from her Hub; null: never from the Hub.';
comment on column public.business_settings.reschedule_lead_minutes is
  'Minutes before the start until which a client may move from her Hub; null: never from the Hub.';

alter table public.appointments add column policy_snapshot jsonb;

comment on column public.appointments.policy_snapshot is
  'The Hub policy in force when the appointment was made: {version, cancellationLeadMinutes, rescheduleLeadMinutes}. Null for appointments made before it existed.';

create function private.snapshot_appointment_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.policy_snapshot is null then
    select pg_catalog.jsonb_build_object(
      'version', 1,
      'cancellationLeadMinutes', st.cancellation_lead_minutes,
      'rescheduleLeadMinutes', st.reschedule_lead_minutes
    )
    into new.policy_snapshot
    from public.business_settings st
    where st.business_id = new.business_id;
  end if;
  return new;
end;
$$;

revoke all on function private.snapshot_appointment_policy() from public;

create trigger appointments_snapshot_policy
  before insert on public.appointments
  for each row execute function private.snapshot_appointment_policy();

-- Her policy, set by an owner or an admin. Applies to appointments made after.
create function public.set_booking_policy(
  p_business_id uuid,
  p_cancellation_lead_minutes integer,
  p_reschedule_lead_minutes integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not public.has_business_role(p_business_id, array['owner', 'admin']::public.business_member_role[]) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_cancellation_lead_minutes is not null and p_cancellation_lead_minutes not between 0 and 43200 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'cancellationLeadMinutes';
  end if;
  if p_reschedule_lead_minutes is not null and p_reschedule_lead_minutes not between 0 and 43200 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'rescheduleLeadMinutes';
  end if;
  update public.business_settings st
  set cancellation_lead_minutes = p_cancellation_lead_minutes,
      reschedule_lead_minutes = p_reschedule_lead_minutes
  where st.business_id = p_business_id;
  return pg_catalog.jsonb_build_object(
    'cancellationLeadMinutes', p_cancellation_lead_minutes,
    'rescheduleLeadMinutes', p_reschedule_lead_minutes
  );
end;
$$;

revoke all on function public.set_booking_policy(uuid, integer, integer) from public;
grant execute on function public.set_booking_policy(uuid, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Freed capacity (cancellation or move, whoever wrote it)

create table private.capacity_releases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  appointment_id uuid not null,
  appointment_version integer not null,
  occupied_from timestamptz not null,
  occupied_until timestamptz not null,
  reason text not null check (reason in ('cancelled', 'rescheduled')),
  occurred_at timestamptz not null default now(),
  unique (appointment_id, appointment_version)
);

create index capacity_releases_business_idx
  on private.capacity_releases (business_id, occurred_at);

revoke all on private.capacity_releases from public, anon, authenticated;

create function private.record_capacity_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'cancelled' or old.occupied_window is null then
    return null;
  end if;
  if new.status = 'cancelled' or new.occupied_window is distinct from old.occupied_window then
    insert into private.capacity_releases (
      business_id, appointment_id, appointment_version, occupied_from, occupied_until, reason
    ) values (
      new.business_id, new.id, new.version,
      pg_catalog.lower(old.occupied_window), pg_catalog.upper(old.occupied_window),
      case when new.status = 'cancelled' then 'cancelled' else 'rescheduled' end
    )
    on conflict (appointment_id, appointment_version) do nothing;
  end if;
  return null;
end;
$$;

revoke all on function private.record_capacity_release() from public;

create trigger appointments_record_capacity_release
  after update of status, starts_at, ends_at, buffer_minutes_snapshot on public.appointments
  for each row execute function private.record_capacity_release();

-- ---------------------------------------------------------------------------
-- Availability that ignores ONE appointment (the one being moved)

drop function private.compute_available_slots(uuid, date, timestamptz, text, integer, integer, integer, integer, integer);

create function private.compute_available_slots(
  p_business_id uuid,
  p_date date,
  p_now timestamptz,
  p_timezone text,
  p_duration_minutes integer,
  p_slot_interval_minutes integer,
  p_buffer_minutes integer,
  p_minimum_notice_minutes integer,
  p_maximum_advance_days integer,
  p_ignore_appointment uuid default null
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

  v_earliest := p_now + pg_catalog.make_interval(mins => p_minimum_notice_minutes);
  v_latest := private.local_day_start(
    private.local_date_of(p_now, p_timezone) + p_maximum_advance_days + 1,
    p_timezone
  );
  v_day_start := private.local_day_start(p_date, p_timezone);
  v_day_end := private.local_day_start(p_date + 1, p_timezone);

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
    and (p_ignore_appointment is null or a.id <> p_ignore_appointment)
    and a.occupied_window && pg_catalog.tstzrange(
      v_day_start - interval '24 hours',
      v_day_end + interval '24 hours',
      '[)'
    );

  v_occupied := v_occupied + private.external_busy(
    p_business_id,
    v_day_start - interval '24 hours',
    v_day_end + interval '24 hours'
  );

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

revoke all on function private.compute_available_slots(uuid, date, timestamptz, text, integer, integer, integer, integer, integer, uuid) from public;

-- The times she could move `p_appointment` to on local day `p_date`: same
-- duration and buffer as agreed, the business's step, notice and horizon.
create function private.reschedule_slots(
  p_appointment public.appointments,
  p_date date,
  p_now timestamptz
)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select slot.starts_at, slot.ends_at
  from public.businesses b
  join public.business_settings st on st.business_id = b.id
  cross join lateral private.compute_available_slots(
    b.id, p_date, p_now, b.timezone,
    p_appointment.duration_minutes_snapshot, st.slot_interval_minutes,
    p_appointment.buffer_minutes_snapshot, st.minimum_booking_notice_minutes,
    st.maximum_booking_advance_days, p_appointment.id
  ) slot
  where b.id = p_appointment.business_id;
$$;

revoke all on function private.reschedule_slots(public.appointments, date, timestamptz) from public;

-- ---------------------------------------------------------------------------
-- What she may do with an appointment, decided by the server

create function private.hub_action(
  p_appointment public.appointments,
  p_lead_key text,
  p_now timestamptz
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_lead integer;
  v_deadline timestamptz;
begin
  if p_appointment.status <> 'confirmed' or p_appointment.starts_at <= p_now then
    return '{"allowed": false, "deadlineAt": null, "reason": "appointment_not_editable"}';
  end if;
  if p_appointment.policy_snapshot is null
     or pg_catalog.jsonb_typeof(p_appointment.policy_snapshot -> p_lead_key) is distinct from 'number' then
    return '{"allowed": false, "deadlineAt": null, "reason": "policy_unavailable"}';
  end if;
  v_lead := (p_appointment.policy_snapshot ->> p_lead_key)::integer;
  v_deadline := p_appointment.starts_at - pg_catalog.make_interval(mins => v_lead);
  -- The start itself is never included, even with no lead.
  if p_now > v_deadline or p_now >= p_appointment.starts_at then
    return pg_catalog.jsonb_build_object('allowed', false, 'deadlineAt', v_deadline, 'reason', 'policy_cutoff_passed');
  end if;
  return pg_catalog.jsonb_build_object('allowed', true, 'deadlineAt', v_deadline, 'reason', null);
end;
$$;

revoke all on function private.hub_action(public.appointments, text, timestamptz) from public;

create function private.hub_actions(p_appointment public.appointments, p_now timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    when p_appointment.status <> 'confirmed' or p_appointment.starts_at <= p_now then null
    else pg_catalog.jsonb_build_object(
      'version', p_appointment.version,
      'cancel', private.hub_action(p_appointment, 'cancellationLeadMinutes', p_now),
      'reschedule', private.hub_action(p_appointment, 'rescheduleLeadMinutes', p_now)
    )
  end;
$$;

revoke all on function private.hub_actions(public.appointments, timestamptz) from public;

-- The detail, as client_hub_appointment answers it, with `actions`.
create function private.hub_appointment_detail(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_appointment public.appointments%rowtype;
  v_business public.businesses%rowtype;
begin
  select a.* into v_appointment from public.appointments a where a.id = p_appointment_id;
  select b.* into v_business from public.businesses b where b.id = v_appointment.business_id;
  return private.client_hub_appointment_json(v_appointment)
    || pg_catalog.jsonb_build_object(
      'business', pg_catalog.jsonb_build_object(
        'name', v_business.name,
        'slug', v_business.slug::text,
        'timezone', v_business.timezone,
        'location', v_business.location,
        'cancellationPolicy', v_business.cancellation_policy
      ),
      'actions', private.hub_actions(v_appointment, pg_catalog.now())
    );
end;
$$;

revoke all on function private.hub_appointment_detail(uuid) from public;

create or replace function public.client_hub_appointment(
  p_session_token text,
  p_business_id uuid,
  p_appointment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.client_hub_require_client(v_account, p_business_id);
begin
  if not exists (
    select 1 from public.appointments a
    where a.id = p_appointment_id
      and a.business_id = p_business_id
      and a.client_id = v_client
  ) then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;
  return private.hub_appointment_detail(p_appointment_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The two writes

create table private.hub_appointment_changes (
  business_id uuid not null references public.businesses (id) on delete cascade,
  request_id uuid not null,
  account_id uuid not null,
  appointment_id uuid not null,
  kind text not null check (kind in ('cancel', 'reschedule')),
  fingerprint text not null,
  from_starts_at timestamptz not null,
  to_starts_at timestamptz,
  version_after integer not null,
  occurred_at timestamptz not null default now(),
  primary key (business_id, request_id)
);

create index hub_appointment_changes_appointment_idx
  on private.hub_appointment_changes (appointment_id, occurred_at);

revoke all on private.hub_appointment_changes from public, anon, authenticated;

-- Her session, record, access and appointment, locked in the documented
-- order. Returns her Hub account; the appointment row stays locked FOR UPDATE.
create function private.hub_lock_for_write(
  p_session_token text,
  p_business_id uuid,
  p_appointment_id uuid,
  p_now timestamptz
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts;
  v_client uuid;
begin
  if p_business_id is null or p_appointment_id is null then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;
  perform private.lock_business_schedule(p_business_id);

  v_account := private.client_hub_session_account(p_session_token, p_now);
  -- A sign-out in flight either ends the session first or waits for us.
  perform 1 from private.client_hub_sessions s
  where s.token_hash = pg_catalog.encode(extensions.digest(p_session_token, 'sha256'), 'hex')
    and s.revoked_at is null and s.expires_at > p_now
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'client_hub_unauthenticated';
  end if;

  select c.id into v_client
  from public.clients c
  join public.client_hub_access a on a.client_id = c.id and a.business_id = c.business_id
  where c.business_id = p_business_id
    and a.revoked_at is null
    and a.email = v_account.email
    and private.canonical_email(c.email::text) = v_account.email::text
  for share of c, a;
  if v_client is null then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;

  perform 1
  from public.appointments a
  where a.id = p_appointment_id and a.business_id = p_business_id and a.client_id = v_client
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;

  return v_account.id;
end;
$$;

revoke all on function private.hub_lock_for_write(text, uuid, uuid, timestamptz) from public;

-- Replay first (after her authorization): the same request answers with
-- the appointment as it is now; the same key for something else conflicts.
create function private.hub_change_replay(
  p_business_id uuid,
  p_request_id uuid,
  p_account_id uuid,
  p_appointment_id uuid,
  p_kind text,
  p_fingerprint text
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_existing private.hub_appointment_changes;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  select * into v_existing
  from private.hub_appointment_changes c
  where c.business_id = p_business_id and c.request_id = p_request_id;
  if not found then
    return false;
  end if;
  if v_existing.account_id <> p_account_id or v_existing.appointment_id <> p_appointment_id
     or v_existing.kind <> p_kind or v_existing.fingerprint <> p_fingerprint then
    raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
  end if;
  return true;
end;
$$;

revoke all on function private.hub_change_replay(uuid, uuid, uuid, uuid, text, text) from public;

create function public.client_hub_cancel_appointment(
  p_session_token text,
  p_business_id uuid,
  p_appointment_id uuid,
  p_expected_version integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_account uuid;
  v_appointment public.appointments;
  v_action jsonb;
  v_fingerprint text := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'expectedVersion', p_expected_version)::text);
begin
  v_account := private.hub_lock_for_write(p_session_token, p_business_id, p_appointment_id, pg_catalog.clock_timestamp());
  select a.* into v_appointment from public.appointments a where a.id = p_appointment_id;
  -- The server's clock at the point of authority, after every lock.
  v_now := pg_catalog.clock_timestamp();

  if private.hub_change_replay(p_business_id, p_request_id, v_account, p_appointment_id, 'cancel', v_fingerprint) then
    return private.hub_appointment_detail(p_appointment_id);
  end if;

  if p_expected_version is null or v_appointment.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_appointment';
  end if;
  v_action := private.hub_action(v_appointment, 'cancellationLeadMinutes', v_now);
  if not (v_action ->> 'allowed')::boolean then
    raise exception using errcode = 'P0001', message = v_action ->> 'reason';
  end if;

  update public.appointments a
  set status = 'cancelled', cancellation_reason = 'Annulé par la cliente depuis son espace'
  where a.id = v_appointment.id;

  insert into private.hub_appointment_changes (
    business_id, request_id, account_id, appointment_id, kind, fingerprint,
    from_starts_at, to_starts_at, version_after
  ) values (
    p_business_id, p_request_id, v_account, v_appointment.id, 'cancel', v_fingerprint,
    v_appointment.starts_at, null, v_appointment.version + 1
  );

  return private.hub_appointment_detail(v_appointment.id);
end;
$$;

create function public.client_hub_reschedule_appointment(
  p_session_token text,
  p_business_id uuid,
  p_appointment_id uuid,
  p_expected_version integer,
  p_request_id uuid,
  p_starts_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_account uuid;
  v_appointment public.appointments;
  v_action jsonb;
  v_timezone text;
  v_fingerprint text := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'expectedVersion', p_expected_version, 'startsAt', p_starts_at)::text);
begin
  if p_starts_at is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'startsAt';
  end if;
  v_account := private.hub_lock_for_write(p_session_token, p_business_id, p_appointment_id, pg_catalog.clock_timestamp());
  select a.* into v_appointment from public.appointments a where a.id = p_appointment_id;
  v_now := pg_catalog.clock_timestamp();

  if private.hub_change_replay(p_business_id, p_request_id, v_account, p_appointment_id, 'reschedule', v_fingerprint) then
    return private.hub_appointment_detail(p_appointment_id);
  end if;

  if p_expected_version is null or v_appointment.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_appointment';
  end if;
  v_action := private.hub_action(v_appointment, 'rescheduleLeadMinutes', v_now);
  if not (v_action ->> 'allowed')::boolean then
    raise exception using errcode = 'P0001', message = v_action ->> 'reason';
  end if;
  if p_starts_at = v_appointment.starts_at then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'startsAt';
  end if;

  select b.timezone into v_timezone from public.businesses b where b.id = p_business_id;
  -- One of the times the public booking would offer for this duration, its
  -- own interval excepted; the exclusion constraint has the final word.
  if not exists (
    select 1
    from private.reschedule_slots(v_appointment, private.local_date_of(p_starts_at, v_timezone), v_now) s
    where s.starts_at = p_starts_at
  ) then
    raise exception using errcode = 'P0001', message = 'slot_unavailable';
  end if;

  begin
    update public.appointments a
    set starts_at = p_starts_at,
        ends_at = p_starts_at + pg_catalog.make_interval(mins => v_appointment.duration_minutes_snapshot)
    where a.id = v_appointment.id;
  exception when exclusion_violation then
    raise exception using errcode = 'P0001', message = 'slot_unavailable';
  end;

  insert into private.hub_appointment_changes (
    business_id, request_id, account_id, appointment_id, kind, fingerprint,
    from_starts_at, to_starts_at, version_after
  ) values (
    p_business_id, p_request_id, v_account, v_appointment.id, 'reschedule', v_fingerprint,
    v_appointment.starts_at, p_starts_at, v_appointment.version + 1
  );

  return private.hub_appointment_detail(v_appointment.id);
end;
$$;

-- Read only: what she could pick on one local day. Informative; the move
-- checks again on its own.
create function public.client_hub_reschedule_slots(
  p_session_token text,
  p_business_id uuid,
  p_appointment_id uuid,
  p_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account private.client_hub_accounts := private.client_hub_session_account(p_session_token, pg_catalog.now());
  v_client uuid := private.client_hub_require_client(v_account, p_business_id);
  v_appointment public.appointments;
  v_timezone text;
begin
  select a.* into v_appointment
  from public.appointments a
  where a.id = p_appointment_id and a.business_id = p_business_id and a.client_id = v_client;
  if not found then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;
  if p_date is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'date';
  end if;
  select b.timezone into v_timezone from public.businesses b where b.id = p_business_id;
  if not (private.hub_action(v_appointment, 'rescheduleLeadMinutes', pg_catalog.now()) ->> 'allowed')::boolean then
    return pg_catalog.jsonb_build_object('date', p_date, 'timezone', v_timezone, 'slots', '[]'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object(
    'date', p_date,
    'timezone', v_timezone,
    'slots', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'startsAt', s.starts_at,
        'endsAt', s.ends_at,
        'localStartsAt', pg_catalog.to_char(s.starts_at at time zone v_timezone, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'localEndsAt', pg_catalog.to_char(s.ends_at at time zone v_timezone, 'YYYY-MM-DD"T"HH24:MI:SS')
      ) order by s.starts_at)
      from private.reschedule_slots(v_appointment, p_date, pg_catalog.now()) s
      where s.starts_at <> v_appointment.starts_at
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.client_hub_cancel_appointment(text, uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.client_hub_reschedule_appointment(text, uuid, uuid, integer, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.client_hub_reschedule_slots(text, uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.client_hub_cancel_appointment(text, uuid, uuid, integer, uuid) to service_role;
grant execute on function public.client_hub_reschedule_appointment(text, uuid, uuid, integer, uuid, timestamptz) to service_role;
grant execute on function public.client_hub_reschedule_slots(text, uuid, uuid, date) to service_role;
