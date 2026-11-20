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
--   1. the booking confirmation of THIS appointment was sent to the
--      session's verified address and the provider accepted it (status
--      'sent'). An attempt alone, a failed send, a reminder alone or a
--      change email alone opens nothing (founder's rule, first version);
--   2. that address is still the appointment's (given to another customer:
--      the former recipient loses it);
--   3. it is still the record's (an address corrected by the professional:
--      the former one loses it);
--   4. the professional has not withdrawn the access of that customer
--      (« Retirer l'accès », or « Retirer l'accès depuis les e-mails » on a
--      record she never opened): a record never opened is not a withdrawn
--      one. A withdrawal covers every email link of that customer in the
--      business, whatever her address since; an automatic revocation (her
--      address changed after a grant) does not block the new address.
-- It then reads that appointment and may cancel or move it under the
-- business's policy (unchanged). Nothing else: the business in her space,
-- the record, its other appointments and the loyalty still need the
-- professional's grant (docs/CLIENT_HUB_CONTRACT.md § 4). A login alone, or
-- an address that matches without any email of the appointment sent to
-- it, still shows nothing.

-- Why an access row was revoked: 'withdrawn' by the professional, or
-- 'email_changed' (the record's address changed after a grant). Rows
-- revoked before this migration keep null: treated as withdrawn for the
-- address they named.
alter table public.client_hub_access
  add column revocation text check (revocation in ('withdrawn', 'email_changed')),
  add check (revocation is null or revoked_at is not null);

comment on column public.client_hub_access.revocation is
  'Why revoked_at is set: withdrawn (by a member, also without a prior grant: granted_by null) or email_changed (automatic). Null: active, or revoked before 20261120120000.';

-- A withdrawal by the professional, as rule 4 reads it.
create function private.client_hub_withdrawn(
  p_business_id uuid,
  p_client_id uuid,
  p_email text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.client_hub_access g
    where g.business_id = p_business_id
      and g.client_id = p_client_id
      and g.revoked_at is not null
      and (g.revocation = 'withdrawn'
           or (g.revocation is null and g.email::text = p_email))
  );
$$;

revoke all on function private.client_hub_withdrawn(uuid, uuid, text) from public;

-- The email change still revokes a grant at once, now saying why.
create or replace function private.client_hub_revoke_on_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.canonical_email(new.email::text) is distinct from private.canonical_email(old.email::text) then
    update public.client_hub_access a
    set revoked_at = pg_catalog.now(),
        revoked_by = (select auth.uid()),
        revocation = 'email_changed'
    where a.business_id = new.business_id
      and a.client_id = new.id
      and a.revoked_at is null;
  end if;
  return null;
end;
$$;

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
        and e.type = 'booking_confirmation'
        and e.status = 'sent'
        and private.canonical_email(e.recipient_email::text) = p_account.email::text
    )
    and not private.client_hub_withdrawn(a.business_id, a.client_id, p_account.email::text);
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

-- « Retirer l'accès » now also works on a record never opened (« Retirer
-- l'accès depuis les e-mails »): the customer's email links are withdrawn
-- directly, nothing is opened on the way (no grant, granted_by null). The
-- withdrawal covers the customer in the business, all her email links,
-- until a member grants access again. Otherwise unchanged.
create or replace function public.client_hub_set_access(
  p_business_id uuid,
  p_client_id uuid,
  p_granted boolean,
  p_expected_email text default null
)
returns table (granted boolean, email text, granted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_current public.client_hub_access%rowtype;
begin
  perform private.assert_agenda_access(p_business_id);

  if p_granted is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'granted';
  end if;

  select private.canonical_email(c.email::text) into v_email
  from public.clients c
  where c.id = p_client_id
    and c.business_id = p_business_id
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'client_not_found', hint = 'clientId';
  end if;

  if p_granted and p_expected_email is not null
    and v_email is distinct from private.canonical_email(p_expected_email) then
    raise exception using errcode = 'P0001', message = 'stale_client', hint = 'clientId';
  end if;

  select a.* into v_current
  from public.client_hub_access a
  where a.business_id = p_business_id
    and a.client_id = p_client_id
  for update;

  if p_granted then
    if v_email is null then
      raise exception using errcode = 'P0001', message = 'client_hub_email_required', hint = 'clientId';
    end if;

    if v_current.client_id is not null
      and v_current.revoked_at is null
      and v_current.email::text = v_email then
      return query select true, v_email, v_current.granted_at;
      return;
    end if;

    insert into public.client_hub_access (business_id, client_id, email, granted_by, granted_at)
    values (p_business_id, p_client_id, v_email, (select auth.uid()), pg_catalog.now())
    on conflict (business_id, client_id) do update
      set email = excluded.email,
          granted_by = excluded.granted_by,
          granted_at = excluded.granted_at,
          revoked_by = null,
          revoked_at = null,
          revocation = null;

    return query select true, v_email, pg_catalog.now();
    return;
  end if;

  if v_current.client_id is not null then
    -- Opened, or revoked by an email change: withdrawn now (idempotent).
    if v_current.revoked_at is null or v_current.revocation is distinct from 'withdrawn' then
      update public.client_hub_access a
      set revoked_by = (select auth.uid()),
          revoked_at = pg_catalog.now(),
          revocation = 'withdrawn'
      where a.business_id = p_business_id
        and a.client_id = p_client_id;
    end if;
  elsif v_email is not null then
    -- Never opened: her email links are withdrawn, nothing is opened.
    insert into public.client_hub_access (
      business_id, client_id, email, granted_by, granted_at, revoked_by, revoked_at, revocation
    ) values (
      p_business_id, p_client_id, v_email, null, pg_catalog.now(),
      (select auth.uid()), pg_catalog.now(), 'withdrawn'
    );
  end if;

  return query select false, null::text, null::timestamptz;
end;
$$;
