-- « Gérer ou annuler mon rendez-vous » from the email, for a customer whose
-- record the professional never opened in the Hub.
--
-- The appointment emails carry a link to
-- /espace/connexion?next=/espace/<business>/rendez-vous/<appointment>. The
-- Hub opened a business only through the professional's grant on the CRM
-- record (client_hub_access): a guest who booked from the public page,
-- touched that link and typed the code sent to her address reached an
-- empty space (tester's report, Higani backlog point 78).
--
-- A session now reaches ONE appointment from its emails when, all at once:
--   1. an email of THIS appointment carrying that link (confirmation,
--      change or reminder) was sent to the session's verified address:
--      accepted by the provider, or handed to it (first_submitted_at, its
--      answer possibly lost), as appointment_contact_informed counts it;
--   2. that address is still the appointment's (given to another customer:
--      the former recipient loses it);
--   3. it is still the record's (an address corrected by the professional:
--      the former one loses it);
--   4. the professional has not revoked the Hub access of that record for
--      that address (a record never opened is not a revoked one).
-- It then reads that appointment and may cancel or move it under the
-- business's policy (unchanged). Nothing else: the business in her space,
-- the record, its other appointments and the loyalty still need the
-- professional's grant (docs/CLIENT_HUB_CONTRACT.md § 4). A login alone, or
-- an address that matches without any email of the appointment sent to
-- it, still shows nothing.

-- The appointment of `p_business_id` the account reaches from its emails
-- (rules 1–4), or null.
create function private.client_hub_emailed_appointment(
  p_account private.client_hub_accounts,
  p_business_id uuid,
  p_appointment_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id
  from public.appointments a
  join public.clients c on c.id = a.client_id and c.business_id = a.business_id
  where a.id = p_appointment_id
    and a.business_id = p_business_id
    and private.canonical_email(a.client_email_snapshot) = p_account.email::text
    and private.canonical_email(c.email::text) = p_account.email::text
    and exists (
      select 1 from public.email_events e
      where e.appointment_id = a.id
        and e.business_id = a.business_id
        and e.type in ('booking_confirmation', 'appointment_changed', 'appointment_reminder')
        and (e.status = 'sent' or e.first_submitted_at is not null)
        and private.canonical_email(e.recipient_email::text) = p_account.email::text
    )
    and not exists (
      select 1 from public.client_hub_access g
      where g.business_id = a.business_id
        and g.client_id = a.client_id
        and g.email = p_account.email
        and g.revoked_at is not null
    );
$$;

revoke all on function private.client_hub_emailed_appointment(private.client_hub_accounts, uuid, uuid) from public;

-- Read: by the grant on her record, or from the appointment's emails.
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
  v_client uuid;
begin
  if p_business_id is not null then
    v_client := private.client_hub_client(v_account, p_business_id);
  end if;
  if not exists (
    select 1 from public.appointments a
    where a.id = p_appointment_id
      and a.business_id = p_business_id
      and a.client_id = v_client
  ) and private.client_hub_emailed_appointment(v_account, p_business_id, p_appointment_id) is null then
    raise exception using errcode = 'P0002', message = 'client_hub_not_found';
  end if;
  return private.hub_appointment_detail(p_appointment_id);
end;
$$;

-- Writes (cancel, reschedule): the same two ways, decided after every lock,
-- in the order the grant path takes them (record and access FOR SHARE,
-- then the appointment FOR UPDATE): an address corrected, an access revoked
-- or the appointment given to another customer meanwhile is seen, even if
-- her page was opened before.
create or replace function private.hub_lock_for_write(
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
  v_record uuid;
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

  if v_client is not null then
    perform 1
    from public.appointments a
    where a.id = p_appointment_id and a.business_id = p_business_id and a.client_id = v_client
    for update;
    if found then
      return v_account.id;
    end if;
  end if;

  -- From the appointment's emails: its record and access first, then the
  -- appointment, then the rules, read after those locks.
  select a.client_id into v_record
  from public.appointments a
  where a.id = p_appointment_id and a.business_id = p_business_id;
  if v_record is not null then
    perform 1 from public.clients c where c.id = v_record for share;
    perform 1 from public.client_hub_access g
    where g.business_id = p_business_id and g.client_id = v_record
    for share;
    perform 1 from public.appointments a
    where a.id = p_appointment_id and a.business_id = p_business_id and a.client_id = v_record
    for update;
    if found and private.client_hub_emailed_appointment(v_account, p_business_id, p_appointment_id) is not null then
      return v_account.id;
    end if;
  end if;

  raise exception using errcode = 'P0002', message = 'client_hub_not_found';
end;
$$;

-- The times she may move to: the same two ways.
create or replace function public.client_hub_reschedule_slots(
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
  v_client uuid;
  v_appointment public.appointments;
  v_timezone text;
begin
  if p_business_id is not null then
    v_client := private.client_hub_client(v_account, p_business_id);
  end if;
  select a.* into v_appointment
  from public.appointments a
  where a.id = p_appointment_id and a.business_id = p_business_id
    and (
      a.client_id = v_client
      or a.id = private.client_hub_emailed_appointment(v_account, p_business_id, p_appointment_id)
    );
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
