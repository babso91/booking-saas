-- An unexpected closure (Higani point 101): the professional closes dates on
-- which customers are booked. She sees them (closure_preview), decides for
-- each one, cancel or move to a time outside the closure, and confirms once
-- (closure_commit): every decision, the closure itself and the emails, all or
-- nothing, under the schedule lock, once per requestId.
--
-- * The decisions must cover exactly the confirmed appointments the closure
--   touches, at the versions she saw (`closure_stale` otherwise: reload).
-- * Cancelling and moving go through agenda_set_appointment_status and
--   agenda_update_appointment: the same rules, snapshots, triggers (reminders,
--   calendar mirror, freed time for the waiting list) as one by one.
-- * A moved appointment keeps its service, price and options. Its new time
--   must be to come and outside the closure (`invalid_input`); a time taken,
--   blocked or closed is `closure_conflict` naming it.
-- * Every customer with an address hears of it, the professional entered the
--   appointment herself or not (she confirms a closure, unlike a single
--   cancellation, and sees the list first): a cancellation or a change notice
--   saying the business is exceptionally closed, with her optional message.
--   Nothing for an appointment already begun. A cancelled customer gets the
--   link to book again. Her words carry no link (`invalid_input`, hint
--   `message`): they reach addresses she typed herself, never a way to send
--   anyone a link under the platform's name.
-- * Closing today starts the closure now: what is over stays as it was.
-- * Owner and admins only. At most 100 appointments per closure.

create table private.closure_requests (
  business_id uuid not null references public.businesses (id) on delete cascade,
  request_id uuid not null,
  actor uuid not null,
  fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (business_id, request_id)
);

revoke all on private.closure_requests from public, anon, authenticated;

-- The instants a closure of these civil dates covers, from now at the
-- earliest.
create function private.closure_window(
  p_business_id uuid,
  p_start_date date,
  p_end_date date,
  p_now timestamptz,
  out starts_at timestamptz,
  out ends_at timestamptz,
  out timezone text
)
language plpgsql
stable
set search_path = ''
as $$
begin
  select b.timezone into timezone from public.businesses b where b.id = p_business_id;
  if p_start_date is null or p_end_date is null
     or p_end_date < p_start_date or p_end_date - p_start_date >= 366 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'endDate';
  end if;
  if p_start_date < private.local_date_of(p_now, timezone) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'startDate';
  end if;
  starts_at := greatest(private.local_day_start(p_start_date, timezone), p_now);
  ends_at := private.local_day_start(p_end_date + 1, timezone);
  if starts_at >= ends_at then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'endDate';
  end if;
end;
$$;

revoke all on function private.closure_window(uuid, date, date, timestamptz) from public;

-- A link in her words: a scheme, www., or a name ending in a common domain.
create function private.closure_message_has_link(p_message text)
returns boolean language sql immutable set search_path = '' as $$
  select p_message operator(pg_catalog.~*)
    '(https?:|www\.|[[:alnum:]-]\.(com|fr|net|org|eu|io|co|me|ly|be|ch|info|biz|xyz|app|link|site|shop|online|club|gl|gg|to)([^[:alnum:]]|$))'
$$;

revoke all on function private.closure_message_has_link(text) from public;

create function private.closure_max_appointments()
returns integer language sql immutable set search_path = '' as $$ select 100 $$;

revoke all on function private.closure_max_appointments() from public;

-- The confirmed appointments a closure of these dates would touch.
create function public.closure_preview(
  p_business_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_window record;
  v_list jsonb;
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  select * into v_window from private.closure_window(p_business_id, p_start_date, p_end_date, v_now);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', a.id,
    'version', a.version,
    'startsAt', a.starts_at,
    'endsAt', a.ends_at,
    'localStartsAt', private.wall_clock(a.starts_at, v_window.timezone),
    'localEndsAt', private.wall_clock(a.ends_at, v_window.timezone),
    'begun', a.starts_at <= v_now,
    'serviceName', a.service_name_snapshot,
    'durationMinutes', a.duration_minutes_snapshot,
    'client', pg_catalog.jsonb_build_object(
      'id', a.client_id,
      'firstName', a.client_first_name_snapshot,
      'lastName', a.client_last_name_snapshot,
      'email', a.client_email_snapshot,
      'phone', a.client_phone_snapshot
    )
  ) order by a.starts_at, a.id), '[]'::jsonb)
  into v_list
  from public.appointments a
  where a.business_id = p_business_id
    and a.status = 'confirmed'
    and a.starts_at < v_window.ends_at
    and a.ends_at > v_window.starts_at;

  if pg_catalog.jsonb_array_length(v_list) > private.closure_max_appointments() then
    raise exception using errcode = 'P0001', message = 'too_many_appointments', hint = 'endDate';
  end if;

  return pg_catalog.jsonb_build_object(
    'startsAt', v_window.starts_at,
    'endsAt', v_window.ends_at,
    'timeZone', v_window.timezone,
    'appointments', v_list
  );
end;
$$;

revoke all on function public.closure_preview(uuid, date, date) from public, anon;
grant execute on function public.closure_preview(uuid, date, date) to authenticated;

-- p_decisions: [{ "appointmentId", "expectedVersion", "moveTo": instant | null }]
-- (null: cancel). Answers { closureId, cancelled, moved, notified }.
create function public.closure_commit(
  p_business_id uuid,
  p_request_id uuid,
  p_start_date date,
  p_end_date date,
  p_reason text,
  p_message text,
  p_decisions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_reason text := private.optional_text(p_reason, 500, 'reason');
  v_message text := private.optional_text(p_message, 500, 'message');
  v_fingerprint text;
  v_existing private.closure_requests;
  v_now timestamptz;
  v_window record;
  v_item jsonb;
  v_id uuid;
  v_version integer;
  v_target timestamptz;
  v_appointment public.appointments;
  v_affected uuid[];
  v_decided uuid[] := '{}';
  v_cancelled uuid[] := '{}';
  v_moved uuid[] := '{}';
  v_previous jsonb := '{}';
  v_notice jsonb;
  v_notified integer := 0;
  v_closure uuid;
  v_response jsonb;
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  if private.closure_message_has_link(v_message) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'message';
  end if;
  if pg_catalog.jsonb_typeof(p_decisions) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_decisions) > private.closure_max_appointments() then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'decisions';
  end if;
  for v_item in select e from pg_catalog.jsonb_array_elements(p_decisions) e loop
    if pg_catalog.jsonb_typeof(v_item) is distinct from 'object'
       or pg_catalog.jsonb_typeof(v_item -> 'appointmentId') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_item -> 'expectedVersion') is distinct from 'number'
       or pg_catalog.jsonb_typeof(v_item -> 'moveTo') not in ('string', 'null') then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'decisions';
    end if;
    begin
      v_decided := v_decided || (v_item ->> 'appointmentId')::uuid;
      v_version := (v_item ->> 'expectedVersion')::integer;
      v_target := (v_item ->> 'moveTo')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'decisions';
    end;
  end loop;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'startDate', p_start_date, 'endDate', p_end_date, 'reason', v_reason,
    'message', v_message, 'decisions', p_decisions)::text);

  perform private.lock_business_schedule(p_business_id);
  v_now := pg_catalog.clock_timestamp();

  select * into v_existing
  from private.closure_requests r
  where r.business_id = p_business_id and r.request_id = p_request_id;
  if found then
    if v_existing.actor is distinct from v_actor or v_existing.fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'requestId';
    end if;
    return v_existing.response;
  end if;

  select * into v_window from private.closure_window(p_business_id, p_start_date, p_end_date, v_now);

  -- Exactly the appointments the closure touches now, each decided once.
  select coalesce(pg_catalog.array_agg(a.id order by a.id), '{}') into v_affected
  from public.appointments a
  where a.business_id = p_business_id
    and a.status = 'confirmed'
    and a.starts_at < v_window.ends_at
    and a.ends_at > v_window.starts_at;
  if v_affected is distinct from coalesce(
    (select pg_catalog.array_agg(d order by d) from pg_catalog.unnest(v_decided) d), '{}'
  ) then
    raise exception using errcode = 'P0001', message = 'closure_stale';
  end if;

  -- The cancellations first: the moves may use the time they free.
  for v_item in
    select e from pg_catalog.jsonb_array_elements(p_decisions) e
    order by pg_catalog.jsonb_typeof(e -> 'moveTo') = 'string'
  loop
    v_id := (v_item ->> 'appointmentId')::uuid;
    select a.* into v_appointment
    from public.appointments a
    where a.id = v_id and a.business_id = p_business_id
    for update;
    if v_appointment.version <> (v_item ->> 'expectedVersion')::integer then
      raise exception using errcode = 'P0001', message = 'closure_stale', detail = v_id::text;
    end if;

    if pg_catalog.jsonb_typeof(v_item -> 'moveTo') = 'null' then
      perform public.agenda_set_appointment_status(
        p_business_id, v_id, v_appointment.version, 'cancelled',
        coalesce(v_reason, 'Fermeture exceptionnelle')
      );
      v_cancelled := v_cancelled || v_id;
      continue;
    end if;

    v_target := (v_item ->> 'moveTo')::timestamptz;
    if v_target <= v_now
       or pg_catalog.tstzrange(v_target, v_target + (v_appointment.ends_at - v_appointment.starts_at), '[)')
          && pg_catalog.tstzrange(v_window.starts_at, v_window.ends_at, '[)') then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'moveTo',
        detail = v_id::text;
    end if;
    begin
      perform public.agenda_update_appointment(
        p_business_id, v_id, v_appointment.version, v_appointment.service_id,
        v_appointment.client_id, v_appointment.internal_notes, v_target, null
      );
    exception when others then
      if sqlerrm = 'schedule_conflict' then
        raise exception using errcode = 'P0001', message = 'closure_conflict', detail = v_id::text;
      end if;
      raise;
    end;
    v_previous := v_previous || pg_catalog.jsonb_build_object(v_id::text, v_appointment.starts_at);
    v_moved := v_moved || v_id;
  end loop;

  -- The closure, now that nothing confirmed is left in it.
  insert into public.availability_exceptions (business_id, kind, starts_at, ends_at, reason)
  values (p_business_id, 'closed', v_window.starts_at, v_window.ends_at, v_reason)
  returning id into v_closure;

  -- Her customers hear of it in the closure's words. A notice the triggers
  -- queued (a customer who booked online) gets them too.
  v_notice := pg_catalog.jsonb_build_object('kind', 'closure', 'message', v_message);
  for v_appointment in
    select a.* from public.appointments a
    where a.id = any (v_cancelled || v_moved) and a.business_id = p_business_id
  loop
    continue when v_appointment.client_email_snapshot is null;
    if v_appointment.status = 'cancelled' then
      continue when v_appointment.starts_at <= v_now;
      insert into public.email_events (
        business_id, client_id, appointment_id, type, recipient_email, payload, dedupe_key
      )
      values (
        p_business_id, v_appointment.client_id, v_appointment.id, 'appointment_cancelled',
        v_appointment.client_email_snapshot,
        pg_catalog.jsonb_build_object(
          'appointment_id', v_appointment.id,
          'starts_at', v_appointment.starts_at,
          'closure', v_notice
        ),
        'appointment_cancelled:' || v_appointment.id::text
      )
      on conflict (business_id, dedupe_key) do update
        set payload = excluded.payload
        where public.email_events.status = 'pending';
    else
      continue when (v_previous ->> v_appointment.id::text)::timestamptz <= v_now;
      insert into public.email_events (
        business_id, client_id, appointment_id, type, recipient_email, payload, dedupe_key
      )
      values (
        p_business_id, v_appointment.client_id, v_appointment.id, 'appointment_changed',
        v_appointment.client_email_snapshot,
        pg_catalog.jsonb_build_object(
          'appointment_id', v_appointment.id,
          'starts_at', v_appointment.starts_at,
          'previous_starts_at', v_previous -> v_appointment.id::text,
          'closure', v_notice
        ),
        'appointment_changed:' || v_appointment.id::text || ':v' || v_appointment.version::text
      )
      on conflict (business_id, dedupe_key) do update
        set payload = excluded.payload
        where public.email_events.status = 'pending';
    end if;
    v_notified := v_notified + 1;
  end loop;

  v_response := pg_catalog.jsonb_build_object(
    'closureId', v_closure,
    'cancelled', pg_catalog.to_jsonb(v_cancelled),
    'moved', pg_catalog.to_jsonb(v_moved),
    'notified', v_notified
  );
  insert into private.closure_requests (business_id, request_id, actor, fingerprint, response)
  values (p_business_id, p_request_id, v_actor, v_fingerprint, v_response);
  return v_response;
end;
$$;

revoke all on function public.closure_commit(uuid, uuid, date, date, text, text, jsonb) from public, anon;
grant execute on function public.closure_commit(uuid, uuid, date, date, text, text, jsonb) to authenticated;

-- The email worker reads the closure's words with the email (`notice`, null
-- for any other email). The rest of the function is unchanged.
create or replace function private.email_outbox_claim_at(
  p_now timestamptz,
  p_limit integer default 20,
  p_per_business integer default 5,
  p_lease_seconds integer default 120,
  p_business_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_per_business integer := least(greatest(coalesce(p_per_business, 5), 1), 50);
  v_lease interval := pg_catalog.make_interval(
    secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900)
  );
  v_candidates uuid[];
  v_candidate uuid;
  v_business_ids uuid[];
  v_business_id uuid;
  v_remaining jsonb := '{}'::jsonb;
  v_left integer;
  v_email public.email_events;
  v_appointment public.appointments;
  v_business public.businesses;
  v_reason text;
  v_expected timestamptz;
  v_claim uuid;
  v_message jsonb;
  v_items jsonb := '[]'::jsonb;
  v_claimed integer := 0;
begin
  select
    coalesce(pg_catalog.array_agg(c.id order by c.rank, c.due, c.id), '{}'),
    coalesce(pg_catalog.array_agg(distinct c.business_id), '{}')
  into v_candidates, v_business_ids
  from (
    select ranked.*
    from (
      select e.id, e.business_id,
             coalesce(e.lease_until, greatest(e.scheduled_for, e.next_attempt_at)) as due,
             pg_catalog.row_number() over (
               partition by e.business_id
               order by coalesce(e.lease_until, greatest(e.scheduled_for, e.next_attempt_at)), e.id
             ) as rank
      from public.email_events e
      where e.type = any (private.email_deliverable_types())
        and (p_business_id is null or e.business_id = p_business_id)
        and (
          (e.status = 'pending' and greatest(e.scheduled_for, e.next_attempt_at) <= p_now)
          or (e.status = 'processing' and (e.lease_until is null or e.lease_until < p_now))
        )
    ) ranked
    where ranked.rank <= v_per_business
    order by ranked.rank, ranked.due, ranked.id
    limit v_limit * 4
  ) c;

  -- The daily cap, enforced atomically per business: concurrent claims of
  -- one business count and take its remaining attempts one after the other
  -- (a transaction lock per business, taken in a fixed order, so no
  -- deadlock; claims of other businesses never wait). Counted after the
  -- lock: the attempts of a claim that committed meanwhile are seen.
  foreach v_business_id in array (
    select coalesce(pg_catalog.array_agg(b order by b), '{}')
    from pg_catalog.unnest(v_business_ids) b
  )
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('email_daily_cap:' || v_business_id::text, 0)
    );
    select private.email_daily_cap() - pg_catalog.count(*)::integer into v_left
    from public.email_delivery_attempts a
    where a.business_id = v_business_id
      and a.started_at > p_now - interval '24 hours';
    v_remaining := v_remaining || pg_catalog.jsonb_build_object(v_business_id::text, v_left);
  end loop;

  foreach v_candidate in array v_candidates
  loop
    exit when v_claimed >= v_limit;

    -- Locked and re-checked: another worker may hold or have taken it.
    select e.* into v_email
    from public.email_events e
    where e.id = v_candidate
      and (
        (e.status = 'pending' and greatest(e.scheduled_for, e.next_attempt_at) <= p_now)
        or (e.status = 'processing' and (e.lease_until is null or e.lease_until < p_now))
      )
    for update skip locked;
    if not found then
      continue;
    end if;

    -- The business's attempts of the last 24 hours are used up: the email
    -- waits (still pending, nothing lost).
    if (v_remaining ->> v_email.business_id::text)::integer <= 0 then
      continue;
    end if;

    if v_email.status = 'processing' then
      -- The previous worker never reported (crash or timeout). Whether the
      -- provider accepted the message is unknown: the next attempt reuses
      -- the same idempotency key.
      perform private.finish_email_attempt(
        v_email.claim_id, 'lease_expired', 'lease_expired', null, p_now
      );
    end if;

    v_appointment := null;
    v_business := null;
    select a.* into v_appointment
    from public.appointments a
    where a.id = v_email.appointment_id
      and a.business_id = v_email.business_id;
    select b.* into v_business
    from public.businesses b
    where b.id = v_email.business_id;

    v_reason := private.email_obsolete_reason(
      v_email, v_appointment, v_business.timezone, p_now
    );
    if v_reason is not null then
      update public.email_events e
      set status = 'cancelled', last_error = v_reason,
          claim_id = null, lease_until = null, next_attempt_at = null
      where e.id = v_email.id;
      continue;
    end if;

    if not private.email_recipient_valid(v_email.recipient_email::text) then
      update public.email_events e
      set status = 'failed', last_error = 'invalid_recipient',
          claim_id = null, lease_until = null, next_attempt_at = null
      where e.id = v_email.id;
      continue;
    end if;

    if v_email.attempt_count >= private.email_max_attempts() then
      update public.email_events e
      set status = 'failed', last_error = 'attempts_exhausted',
          claim_id = null, lease_until = null, next_attempt_at = null
      where e.id = v_email.id;
      continue;
    end if;

    if v_email.type = 'appointment_reminder'
      and (v_email.payload ->> 'timezone') is distinct from v_business.timezone then
      -- The business changed its time zone after the reminder was queued:
      -- the moment follows the current one.
      v_expected := private.email_reminder_at(v_appointment.starts_at, v_business.timezone);
      update public.email_events e
      set payload = e.payload || pg_catalog.jsonb_build_object('timezone', v_business.timezone)
      where e.id = v_email.id;
      if v_expected is distinct from v_email.scheduled_for and v_expected > p_now then
        update public.email_events e
        set status = 'pending', scheduled_for = v_expected,
            claim_id = null, lease_until = null, next_attempt_at = null
        where e.id = v_email.id;
        continue;
      end if;
    end if;

    v_claim := gen_random_uuid();
    update public.email_events e
    set status = 'processing',
        claim_id = v_claim,
        lease_until = p_now + v_lease,
        attempt_count = e.attempt_count + 1,
        last_attempt_at = p_now
    where e.id = v_email.id
    returning e.* into v_email;

    insert into public.email_delivery_attempts (
      business_id, email_event_id, attempt_number, claim_id, started_at
    )
    values (v_email.business_id, v_email.id, v_email.attempt_count, v_claim, p_now);
    v_remaining := pg_catalog.jsonb_set(
      v_remaining,
      array[v_email.business_id::text],
      pg_catalog.to_jsonb((v_remaining ->> v_email.business_id::text)::integer - 1)
    );

    -- A message already handed to the provider is sent again as it was.
    select r.message into v_message
    from private.email_renderings r
    where r.email_event_id = v_email.id;

    v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', v_email.id,
      'claimId', v_claim,
      'businessId', v_email.business_id,
      'type', v_email.type,
      'attempt', v_email.attempt_count,
      'recipient', v_email.recipient_email::text,
      'message', v_message,
      'notice', v_email.payload -> 'closure',
      'business', pg_catalog.jsonb_build_object(
        'name', v_business.name,
        'slug', v_business.slug::text,
        'contactEmail', v_business.contact_email::text,
        'phone', v_business.phone,
        'location', v_business.location,
        'timezone', v_business.timezone
      ),
      'appointment', pg_catalog.jsonb_build_object(
        'id', v_appointment.id,
        'version', v_appointment.version,
        'status', v_appointment.status,
        'startsAt', v_appointment.starts_at,
        'endsAt', v_appointment.ends_at,
        'localStartsAt', private.wall_clock(v_appointment.starts_at, v_business.timezone),
        'localEndsAt', private.wall_clock(v_appointment.ends_at, v_business.timezone),
        'serviceName', v_appointment.service_name_snapshot,
        'durationMinutes', v_appointment.duration_minutes_snapshot,
        'priceCents', v_appointment.price_cents_snapshot,
        'currency', v_appointment.currency,
        'clientFirstName', v_appointment.client_first_name_snapshot
      )
    ));
    v_claimed := v_claimed + 1;
  end loop;

  return v_items;
end;
$$;

