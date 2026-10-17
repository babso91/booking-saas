-- Transactional emails (PR #22): the outbox becomes deliverable.
--
-- public.email_events (initial foundation) stays the outbox: one row per
-- logical email, unique (business_id, dedupe_key). Until now only booking
-- confirmations were queued, and nothing consumed them. This migration adds:
--
--   1. Delivery state on email_events: a claim (claim_id, lease_until) for
--      concurrent workers, next_attempt_at for retries with backoff, and
--      stable codes only in last_error (never a provider answer, never an
--      address).
--   2. public.email_delivery_attempts: one row per delivery attempt
--      (outcome, error code, provider message id), readable by the members
--      of the business, written by the worker functions only. No recipient,
--      subject nor body is stored there.
--   3. Notifications derived from appointments, on every write path (a
--      trigger, like the calendar mirror):
--      * a reminder the day before the appointment, at 18:00 in the
--        business's time zone (only when that moment is still ahead);
--      * appointment_changed when a confirmed appointment moves or changes
--        service, unless its confirmation is still queued (it is rendered
--        from the current appointment, so it already says the new time);
--      * appointment_cancelled when a future confirmed appointment is
--        cancelled;
--      * queued emails that no longer apply are cancelled (reminder of an
--        old time, anything of a cancelled, completed or no-show
--        appointment, anything addressed to a former contact).
--   4. Worker functions, executable by service_role only:
--      email_outbox_claim, _verify, _complete, _fail, _release. A claim
--      locks due rows (FOR UPDATE SKIP LOCKED), re-checks that each email
--      still applies against the current appointment, and returns what the
--      template needs, read now (never a stale payload); _verify re-checks
--      it right before the send. A lease that expires (crashed or timed out
--      worker) makes the row claimable again. Completion and failure are
--      compare-and-set on the claim id: a late worker never overwrites a
--      newer claim. A business gets at most 300 attempts per 24 hours.
--
-- Delivery is at least once: a worker that crashes after the provider
-- accepted a message, but before recording it, leads to a second attempt
-- after the lease. The email id is the provider idempotency key, which
-- removes that duplicate where the provider honours it (Resend: 24 hours).

-- ---------------------------------------------------------------------------
-- 1. Delivery state
-- ---------------------------------------------------------------------------

alter table public.email_events
  add column next_attempt_at timestamptz,
  add column claim_id uuid,
  add column lease_until timestamptz,
  add constraint email_events_id_business_key unique (id, business_id);

-- Checked on every new write. NOT VALID: rows written before this migration
-- are kept as they are (none was ever delivered; nothing is rewritten).
alter table public.email_events
  add constraint email_events_last_error_code
    check (last_error is null or last_error ~ '^[a-z0-9_]{1,64}$') not valid,
  add constraint email_events_provider_message_id_length
    check (provider_message_id is null or char_length(provider_message_id) <= 200) not valid,
  add constraint email_events_claim_consistent
    check ((status = 'processing') = (claim_id is not null and lease_until is not null)) not valid;

comment on column public.email_events.next_attempt_at is
  'Next delivery attempt after a retryable failure (null: scheduled_for).';
comment on column public.email_events.claim_id is
  'Claim of the worker delivering this email (status processing only).';
comment on column public.email_events.lease_until is
  'End of the current claim: past it, another worker may claim the email again.';
comment on column public.email_events.last_error is
  'Stable code of the last failure or cancellation reason. Never a provider message nor an address.';

create index email_events_due_idx
  on public.email_events ((coalesce(next_attempt_at, scheduled_for)), business_id)
  where status = 'pending';
create index email_events_lease_idx
  on public.email_events (lease_until)
  where status = 'processing';
create index email_events_appointment_idx
  on public.email_events (appointment_id, type)
  where appointment_id is not null;

comment on table public.email_events is
  'Transactional email outbox. dedupe_key identifies one logical delivery. Delivered by the worker functions email_outbox_* (service role only), at least once.';

create table public.email_delivery_attempts (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  email_event_id uuid not null,
  attempt_number integer not null check (attempt_number >= 1),
  claim_id uuid not null unique,
  started_at timestamptz not null,
  finished_at timestamptz,
  -- null while in flight; lease_expired when the worker never reported;
  -- cancelled when the email stopped applying right before the send.
  outcome text check (outcome in ('sent', 'retry', 'failed', 'lease_expired', 'cancelled')),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$'),
  provider_message_id text
    check (provider_message_id is null or char_length(provider_message_id) <= 200),
  foreign key (email_event_id, business_id)
    references public.email_events (id, business_id) on delete cascade
);

create index email_delivery_attempts_event_idx
  on public.email_delivery_attempts (email_event_id, attempt_number);
create index email_delivery_attempts_business_idx
  on public.email_delivery_attempts (business_id, started_at desc);
create index email_delivery_attempts_started_idx
  on public.email_delivery_attempts (started_at);

alter table public.email_delivery_attempts enable row level security;
revoke all on table public.email_delivery_attempts from public, anon, authenticated;
grant select on table public.email_delivery_attempts to authenticated;
revoke all on sequence public.email_delivery_attempts_id_seq from public, anon, authenticated;

create policy "email_delivery_attempts_select_member"
  on public.email_delivery_attempts for select to authenticated
  using (public.is_business_member(business_id));

comment on table public.email_delivery_attempts is
  'One row per delivery attempt of an email_events row: outcome and stable error code only (no recipient, subject nor body). Written by the worker functions.';

-- The outbox is written by the database only (booking functions, the
-- appointment trigger, the worker functions). Members read it under RLS;
-- they never insert, update nor delete it (no policy allows it), and the
-- table privileges say so too.
revoke insert, update, delete, truncate on table public.email_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Rules
-- ---------------------------------------------------------------------------

-- Attempts before an email is given up (status failed, attempts_exhausted).
create function private.email_max_attempts()
returns integer
language sql
immutable
set search_path = ''
as $$ select 8 $$;

-- Wait before attempt n + 1 after n failed attempts.
create function private.email_retry_delay(p_attempts integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select (array[
    interval '1 minute', interval '5 minutes', interval '15 minutes',
    interval '1 hour', interval '3 hours', interval '6 hours', interval '12 hours'
  ])[least(greatest(coalesce(p_attempts, 1), 1), 7)];
$$;

-- The types the worker delivers. Others (loyalty, reactivation) have no
-- producer nor template yet and stay queued untouched.
create function private.email_deliverable_types()
returns public.email_event_type[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'booking_confirmation', 'appointment_reminder',
    'appointment_changed', 'appointment_cancelled'
  ]::public.email_event_type[];
$$;

-- The reminder of an appointment: the day before, at 18:00 on the business's
-- wall clock. A repeated 18:00 takes its first occurrence; a 18:00 skipped by
-- a clock change takes PostgreSQL's reading (just after the gap).
create function private.email_reminder_at(p_starts_at timestamptz, p_timezone text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_local timestamp;
  v_resolved record;
begin
  if p_starts_at is null or p_timezone is null then
    return null;
  end if;
  v_local := (private.local_date_of(p_starts_at, p_timezone) - 1) + time '18:00';
  select * into v_resolved from private.resolve_local(v_local, p_timezone);
  if v_resolved.status = 'nonexistent' then
    return v_local at time zone p_timezone;
  end if;
  return v_resolved.first_at;
end;
$$;

-- Delivery attempts per business over 24 hours, beyond which its emails
-- wait (they stay pending, nothing is lost): a business, or someone
-- booking with chosen addresses, cannot use the platform to send in bulk.
create function private.email_daily_cap()
returns integer
language sql
immutable
set search_path = ''
as $$ select 300 $$;

-- A reminder is no longer sent once the appointment is this close.
create function private.email_reminder_cutoff()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '1 hour' $$;

-- Confirmation, change and cancellation emails are no longer sent this long
-- after they were queued (a worker that was down for days does not send
-- stale news).
create function private.email_max_age()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '48 hours' $$;

-- Same rule as the booking functions (canonical, at most 254 characters).
create function private.email_recipient_valid(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_email is not null
    and pg_catalog.char_length(p_email) <= 254
    and p_email ~ '^[^@[:space:][:cntrl:]<>,;"]+@[^@[:space:][:cntrl:]<>,;"]+\.[^@[:space:][:cntrl:]<>,;"]+$';
$$;

-- Queues the reminder of a confirmed appointment when its moment is still
-- ahead. The key carries the appointment version: a later change queues a
-- new reminder, the trigger cancels the former one.
create function private.queue_appointment_reminder(
  p_appointment public.appointments,
  p_timezone text,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := private.email_reminder_at(p_appointment.starts_at, p_timezone);
begin
  if p_appointment.status <> 'confirmed'
    or p_appointment.client_email_snapshot is null
    or v_at is null
    or v_at <= p_now
    or v_at >= p_appointment.starts_at - private.email_reminder_cutoff() then
    return;
  end if;

  insert into public.email_events (
    business_id, client_id, appointment_id, type, recipient_email,
    payload, dedupe_key, scheduled_for
  )
  values (
    p_appointment.business_id,
    p_appointment.client_id,
    p_appointment.id,
    'appointment_reminder',
    p_appointment.client_email_snapshot,
    pg_catalog.jsonb_build_object(
      'appointment_id', p_appointment.id,
      'starts_at', p_appointment.starts_at,
      'timezone', p_timezone
    ),
    'appointment_reminder:' || p_appointment.id::text || ':v' || p_appointment.version::text,
    v_at
  )
  on conflict (business_id, dedupe_key) do nothing;
end;
$$;

-- Cancels the queued (not yet claimed) emails of an appointment. An email
-- already claimed may still be delivered: the claim re-checks every email
-- right before it is handed to a worker, not after.
create function private.cancel_queued_emails(
  p_appointment_id uuid,
  p_business_id uuid,
  p_types public.email_event_type[],
  p_reason text,
  p_keep_recipient text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_events e
  set status = 'cancelled',
      last_error = p_reason,
      next_attempt_at = null
  where e.appointment_id = p_appointment_id
    and e.business_id = p_business_id
    and e.status = 'pending'
    and e.type = any (p_types)
    and (p_keep_recipient is null
         or e.recipient_email operator(extensions.<>) p_keep_recipient::extensions.citext);
$$;

create function private.queue_appointment_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_timezone text;
  v_moved boolean;
  v_recipient_changed boolean;
  v_appointment_types public.email_event_type[] := array[
    'booking_confirmation', 'appointment_reminder', 'appointment_changed'
  ]::public.email_event_type[];
begin
  select b.timezone into v_timezone
  from public.businesses b
  where b.id = new.business_id;

  if tg_op = 'INSERT' then
    perform private.queue_appointment_reminder(new, v_timezone, v_now);
    return null;
  end if;

  v_moved := new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or new.service_name_snapshot is distinct from old.service_name_snapshot;
  v_recipient_changed :=
    new.client_email_snapshot is distinct from old.client_email_snapshot;

  if new.status is not distinct from old.status
    and not v_moved
    and not v_recipient_changed then
    return null;
  end if;

  if new.status <> 'confirmed' then
    perform private.cancel_queued_emails(
      new.id, new.business_id, v_appointment_types,
      case when new.status = 'cancelled' then 'appointment_cancelled' else 'appointment_closed' end
    );

    if new.status = 'cancelled'
      and old.status = 'confirmed'
      and new.client_email_snapshot is not null
      and new.starts_at > v_now then
      insert into public.email_events (
        business_id, client_id, appointment_id, type, recipient_email,
        payload, dedupe_key
      )
      values (
        new.business_id,
        new.client_id,
        new.id,
        'appointment_cancelled',
        new.client_email_snapshot,
        pg_catalog.jsonb_build_object(
          'appointment_id', new.id,
          'starts_at', new.starts_at
        ),
        'appointment_cancelled:' || new.id::text
      )
      on conflict (business_id, dedupe_key) do nothing;
    end if;
    return null;
  end if;

  -- Confirmed (again, or still).
  if v_recipient_changed then
    -- Moved to another customer: nothing queued for the former contact is
    -- sent. The new contact gets the reminder (below), not a change notice
    -- about an appointment they never received a confirmation for.
    perform private.cancel_queued_emails(
      new.id, new.business_id, v_appointment_types, 'recipient_changed',
      new.client_email_snapshot
    );
  end if;

  if v_moved or v_recipient_changed or old.status <> 'confirmed' then
    perform private.cancel_queued_emails(
      new.id, new.business_id,
      array['appointment_reminder']::public.email_event_type[],
      'rescheduled'
    );
    perform private.queue_appointment_reminder(new, v_timezone, v_now);
  end if;

  if v_moved
    and not v_recipient_changed
    and old.status = 'confirmed'
    and new.client_email_snapshot is not null
    and new.starts_at > v_now
    and not exists (
      -- A queued confirmation is rendered from the current appointment: it
      -- already gives the new details.
      select 1
      from public.email_events e
      where e.appointment_id = new.id
        and e.business_id = new.business_id
        and e.type = 'booking_confirmation'
        and e.status = 'pending'
    ) then
    perform private.cancel_queued_emails(
      new.id, new.business_id,
      array['appointment_changed']::public.email_event_type[],
      'superseded'
    );
    insert into public.email_events (
      business_id, client_id, appointment_id, type, recipient_email,
      payload, dedupe_key
    )
    values (
      new.business_id,
      new.client_id,
      new.id,
      'appointment_changed',
      new.client_email_snapshot,
      pg_catalog.jsonb_build_object(
        'appointment_id', new.id,
        'starts_at', new.starts_at,
        'previous_starts_at', old.starts_at
      ),
      'appointment_changed:' || new.id::text || ':v' || new.version::text
    )
    on conflict (business_id, dedupe_key) do nothing;
  end if;

  return null;
end;
$$;

create trigger appointments_queue_notifications
  after insert or update on public.appointments
  for each row execute function private.queue_appointment_notifications();

-- ---------------------------------------------------------------------------
-- 3. Worker
-- ---------------------------------------------------------------------------

-- Why a claimed email no longer applies (null: it still does), read against
-- the current appointment. Each reason is a stable code.
create function private.email_obsolete_reason(
  p_email public.email_events,
  p_appointment public.appointments,
  p_timezone text,
  p_now timestamptz
)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_appointment.id is null then
    return 'appointment_missing';
  end if;
  if p_appointment.client_email_snapshot is null
    or p_email.recipient_email operator(extensions.<>)
       p_appointment.client_email_snapshot::extensions.citext then
    return 'recipient_changed';
  end if;

  if p_email.type = 'appointment_cancelled' then
    if p_appointment.status <> 'cancelled' then
      return 'appointment_not_cancelled';
    end if;
    if p_email.created_at < p_now - private.email_max_age() then
      return 'expired';
    end if;
    if p_appointment.starts_at <= p_now then
      return 'appointment_past';
    end if;
    return null;
  end if;

  if p_appointment.status = 'cancelled' then
    return 'appointment_cancelled';
  end if;
  if p_appointment.status <> 'confirmed' then
    return 'appointment_closed';
  end if;

  if p_email.type = 'appointment_reminder' then
    if (p_email.payload ->> 'starts_at') is null
      or (p_email.payload ->> 'starts_at')::timestamptz <> p_appointment.starts_at then
      return 'rescheduled';
    end if;
    if p_now >= p_appointment.starts_at - private.email_reminder_cutoff() then
      return 'reminder_too_late';
    end if;
    return null;
  end if;

  if p_appointment.starts_at <= p_now then
    return 'appointment_past';
  end if;
  if p_email.created_at < p_now - private.email_max_age() then
    return 'expired';
  end if;
  if p_email.type = 'appointment_changed' and exists (
    select 1
    from public.email_events e
    where e.appointment_id = p_email.appointment_id
      and e.business_id = p_email.business_id
      and e.type = 'appointment_changed'
      and e.id <> p_email.id
      and e.created_at > p_email.created_at
      and e.status in ('pending', 'processing', 'sent')
  ) then
    return 'superseded';
  end if;
  return null;
end;
$$;

-- Records the end of a claim on its attempt row.
create function private.finish_email_attempt(
  p_claim_id uuid,
  p_outcome text,
  p_error_code text,
  p_provider_message_id text,
  p_at timestamptz
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_delivery_attempts a
  set outcome = p_outcome,
      error_code = p_error_code,
      provider_message_id = p_provider_message_id,
      finished_at = p_at
  where a.claim_id = p_claim_id
    and a.outcome is null;
$$;

-- Claims up to p_limit due emails (at most p_per_business per business, so
-- one busy business never starves the others) at p_now, of one business
-- when p_business_id is given. Returns, for each,
-- the claim and the data its template needs, read from the current
-- appointment and business. Emails that no longer apply are cancelled on
-- the way, emails out of attempts or with an invalid recipient fail.
create function private.email_outbox_claim_at(
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
  v_candidate uuid;
  v_email public.email_events;
  v_appointment public.appointments;
  v_business public.businesses;
  v_reason text;
  v_expected timestamptz;
  v_claim uuid;
  v_items jsonb := '[]'::jsonb;
  v_claimed integer := 0;
begin
  for v_candidate in
    with saturated as (
      select a.business_id
      from public.email_delivery_attempts a
      where a.started_at > p_now - interval '24 hours'
      group by a.business_id
      having pg_catalog.count(*) >= private.email_daily_cap()
    )
    select ranked.id
    from (
      select e.id, e.business_id,
             coalesce(e.lease_until, e.next_attempt_at, e.scheduled_for) as due,
             pg_catalog.row_number() over (
               partition by e.business_id
               order by coalesce(e.lease_until, e.next_attempt_at, e.scheduled_for), e.id
             ) as rank
      from public.email_events e
      where e.type = any (private.email_deliverable_types())
        and (p_business_id is null or e.business_id = p_business_id)
        and e.business_id not in (select s.business_id from saturated s)
        and (
          (e.status = 'pending' and coalesce(e.next_attempt_at, e.scheduled_for) <= p_now)
          or (e.status = 'processing' and (e.lease_until is null or e.lease_until < p_now))
        )
    ) ranked
    where ranked.rank <= v_per_business
    order by ranked.rank, ranked.due, ranked.id
    limit v_limit * 4
  loop
    exit when v_claimed >= v_limit;

    -- Locked and re-checked: another worker may hold or have taken it.
    select e.* into v_email
    from public.email_events e
    where e.id = v_candidate
      and (
        (e.status = 'pending' and coalesce(e.next_attempt_at, e.scheduled_for) <= p_now)
        or (e.status = 'processing' and (e.lease_until is null or e.lease_until < p_now))
      )
    for update skip locked;
    if not found then
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

    v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', v_email.id,
      'claimId', v_claim,
      'businessId', v_email.business_id,
      'type', v_email.type,
      'attempt', v_email.attempt_count,
      'recipient', v_email.recipient_email::text,
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

create function public.email_outbox_claim(
  p_limit integer default 20,
  p_per_business integer default 5,
  p_business_id uuid default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.email_outbox_claim_at(
    pg_catalog.now(), p_limit, p_per_business, 120, p_business_id
  );
$$;

-- Right before the send: does the claimed email still apply? The claim
-- checked it, but a batch is sent one email at a time, and the appointment
-- may have been cancelled or moved meanwhile. When it no longer applies,
-- the email is cancelled (its attempt too) and false is returned: the
-- worker does not send it. A change committed after this check and before
-- the provider accepts the message is not seen (a window of the duration
-- of one provider call).
create function public.email_outbox_verify(p_id uuid, p_claim_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_email public.email_events;
  v_appointment public.appointments;
  v_timezone text;
  v_reason text;
begin
  select e.* into v_email
  from public.email_events e
  where e.id = p_id
    and e.claim_id = p_claim_id
    and e.status = 'processing'
  for update;
  if not found then
    return false;
  end if;

  select a.* into v_appointment
  from public.appointments a
  where a.id = v_email.appointment_id
    and a.business_id = v_email.business_id;
  select b.timezone into v_timezone
  from public.businesses b
  where b.id = v_email.business_id;

  v_reason := private.email_obsolete_reason(v_email, v_appointment, v_timezone, v_now);
  if v_reason is null then
    return true;
  end if;

  update public.email_events e
  set status = 'cancelled', last_error = v_reason,
      claim_id = null, lease_until = null, next_attempt_at = null
  where e.id = p_id;
  perform private.finish_email_attempt(p_claim_id, 'cancelled', v_reason, null, v_now);
  return false;
end;
$$;

-- The provider accepted the message. False when the claim is no longer
-- the current one (lease expired and the email claimed again): nothing is
-- recorded.
create function public.email_outbox_complete(
  p_id uuid,
  p_claim_id uuid,
  p_provider_message_id text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_message_id text := nullif(pg_catalog.left(pg_catalog.btrim(p_provider_message_id), 200), '');
  v_now timestamptz := pg_catalog.now();
begin
  update public.email_events e
  set status = 'sent',
      sent_at = v_now,
      provider_message_id = v_message_id,
      last_error = null,
      claim_id = null,
      lease_until = null,
      next_attempt_at = null
  where e.id = p_id
    and e.claim_id = p_claim_id
    and e.status = 'processing';
  if not found then
    return false;
  end if;
  perform private.finish_email_attempt(p_claim_id, 'sent', null, v_message_id, v_now);
  return true;
end;
$$;

-- The attempt failed. A permanent failure, or the last allowed attempt,
-- gives the email up (failed); otherwise it is retried after a backoff.
-- Returns the new status, or null when the claim is no longer the current
-- one (nothing recorded).
create function public.email_outbox_fail(
  p_id uuid,
  p_claim_id uuid,
  p_error_code text,
  p_permanent boolean default false
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := case
    when p_error_code ~ '^[a-z0-9_]{1,64}$' then p_error_code
    else 'provider_error'
  end;
  v_now timestamptz := pg_catalog.now();
  v_email public.email_events;
  v_final boolean;
begin
  select e.* into v_email
  from public.email_events e
  where e.id = p_id
    and e.claim_id = p_claim_id
    and e.status = 'processing'
  for update;
  if not found then
    return null;
  end if;

  v_final := coalesce(p_permanent, false)
    or v_email.attempt_count >= private.email_max_attempts();

  update public.email_events e
  set status = case when v_final then 'failed' else 'pending' end::public.email_event_status,
      last_error = v_code,
      claim_id = null,
      lease_until = null,
      next_attempt_at = case
        when v_final then null
        else v_now + private.email_retry_delay(v_email.attempt_count)
      end
  where e.id = p_id;

  perform private.finish_email_attempt(
    p_claim_id, case when v_final then 'failed' else 'retry' end, v_code, null, v_now
  );
  return case when v_final then 'failed' else 'pending' end;
end;
$$;

-- Gives back a claimed email that was not attempted (the worker ran out of
-- time): it is due again at once, and the claim does not count as an
-- attempt.
create function public.email_outbox_release(p_id uuid, p_claim_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.email_events e
  set status = 'pending',
      claim_id = null,
      lease_until = null,
      attempt_count = greatest(e.attempt_count - 1, 0)
  where e.id = p_id
    and e.claim_id = p_claim_id
    and e.status = 'processing';
  if not found then
    return false;
  end if;
  delete from public.email_delivery_attempts a
  where a.claim_id = p_claim_id
    and a.outcome is null;
  return true;
end;
$$;

revoke all on function private.email_max_attempts() from public;
revoke all on function private.email_retry_delay(integer) from public;
revoke all on function private.email_deliverable_types() from public;
revoke all on function private.email_reminder_at(timestamptz, text) from public;
revoke all on function private.email_reminder_cutoff() from public;
revoke all on function private.email_daily_cap() from public;
revoke all on function private.email_max_age() from public;
revoke all on function private.email_recipient_valid(text) from public;
revoke all on function private.queue_appointment_reminder(public.appointments, text, timestamptz) from public;
revoke all on function private.cancel_queued_emails(uuid, uuid, public.email_event_type[], text, text) from public;
revoke all on function private.queue_appointment_notifications() from public;
revoke all on function private.email_obsolete_reason(public.email_events, public.appointments, text, timestamptz) from public;
revoke all on function private.finish_email_attempt(uuid, text, text, text, timestamptz) from public;
revoke all on function private.email_outbox_claim_at(timestamptz, integer, integer, integer, uuid) from public;

revoke all on function public.email_outbox_claim(integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.email_outbox_complete(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.email_outbox_fail(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.email_outbox_release(uuid, uuid) from public, anon, authenticated;
revoke all on function public.email_outbox_verify(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_outbox_claim(integer, integer, uuid) to service_role;
grant execute on function public.email_outbox_complete(uuid, uuid, text) to service_role;
grant execute on function public.email_outbox_fail(uuid, uuid, text, boolean) to service_role;
grant execute on function public.email_outbox_release(uuid, uuid) to service_role;
grant execute on function public.email_outbox_verify(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Existing appointments
-- ---------------------------------------------------------------------------

-- Confirmed upcoming appointments get the reminder they would have had
-- (idempotent: the key carries the appointment version). Nothing else is
-- queued retroactively, and existing outbox rows are left as they are: the
-- claim's rules (age, appointment state) decide whether they still apply.
do $$
declare
  v_row record;
begin
  for v_row in
    select a as appointment, b.timezone
    from public.appointments a
    join public.businesses b on b.id = a.business_id
    where a.status = 'confirmed'
      and a.starts_at > pg_catalog.now()
      and a.client_email_snapshot is not null
  loop
    perform private.queue_appointment_reminder(v_row.appointment, v_row.timezone, pg_catalog.now());
  end loop;
end;
$$;
