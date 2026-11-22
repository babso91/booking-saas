-- A customer's right to erasure (Higani point 205), on the rules the
-- founder validated on 22/11:
-- 1. anonymise rather than delete: her name, contact, the professional's
--    notes, her form answers and her consents are erased; her appointments
--    and amounts stay in the business's history, without name or contact;
-- 2. refused while she has an appointment to come (cancel it first);
-- 3. this business only: another business keeps what it holds, and her
--    client space account (shared across businesses) stays.
--
-- Nothing is emailed: clearing an appointment's address cancels what was
-- queued for it, and no reminder or notice is queued without an address.
-- Kept on purpose: loyalty entries and rewards (immutable ledger, amounts
-- only), her referral link's history (it is also the history of the
-- customers she referred: the link is revoked, not deleted) and marketing
-- sends (status only).

alter table public.clients add column erased_at timestamptz;

comment on column public.clients.erased_at is
  'Set when the customer''s personal data were erased (privacy_erase_client).';

-- The contact an appointment was booked with stays immutable, except for
-- the erasure of that very customer, inside privacy_erase_client, which can only
-- blank it. An erased customer cannot get a new appointment.
create or replace function private.snapshot_appointment_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.client_id is not distinct from old.client_id then
      if new.client_first_name_snapshot is distinct from old.client_first_name_snapshot
        or new.client_last_name_snapshot is distinct from old.client_last_name_snapshot
        or new.client_email_snapshot is distinct from old.client_email_snapshot
        or new.client_phone_snapshot is distinct from old.client_phone_snapshot then
        if pg_catalog.current_setting('booking.erasing_client', true) = new.client_id::text
          and new.client_first_name_snapshot = 'Cliente effacée'
          and new.client_last_name_snapshot is null
          and new.client_email_snapshot is null
          and new.client_phone_snapshot is null then
          return new;
        end if;
        raise exception using errcode = '55000', message = 'contact_snapshot_immutable';
      end if;
      return new;
    end if;
  elsif new.client_first_name_snapshot is not null then
    if exists (
      select 1 from public.clients c
      where c.id = new.client_id and c.erased_at is not null
    ) then
      raise exception using errcode = 'P0001', message = 'client_erased';
    end if;
    new.client_email_snapshot := private.canonical_email(new.client_email_snapshot);
    return new;
  end if;

  if exists (
    select 1 from public.clients c
    where c.id = new.client_id and c.erased_at is not null
  ) then
    raise exception using errcode = 'P0001', message = 'client_erased';
  end if;

  select
    c.first_name,
    nullif(pg_catalog.btrim(c.last_name), ''),
    c.email::text,
    nullif(pg_catalog.btrim(c.phone), '')
  into
    new.client_first_name_snapshot,
    new.client_last_name_snapshot,
    new.client_email_snapshot,
    new.client_phone_snapshot
  from public.clients c
  where c.id = new.client_id
    and c.business_id = new.business_id;

  -- Not found: the composite foreign key refuses the row right after (and,
  -- for an API role, row level security before it), with their own errors.

  return new;
end;
$$;

-- Erases her personal data in this business, if her record is still the
-- version the professional saw (`stale_client` otherwise). Erasing an
-- already erased record answers it again, whatever the version.
create function public.privacy_erase_client(
  p_business_id uuid,
  p_client_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients;
  v_email text;
  v_now timestamptz := pg_catalog.now();
begin
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  select c.* into v_client
  from public.clients c
  where c.id = p_client_id and c.business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'client_not_found';
  end if;

  if v_client.erased_at is not null then
    return pg_catalog.jsonb_build_object('erased', false, 'erasedAt', v_client.erased_at);
  end if;
  if p_expected_version is null or v_client.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_client';
  end if;

  -- Rule 2: nothing to come.
  if exists (
    select 1 from public.appointments a
    where a.business_id = p_business_id
      and a.client_id = p_client_id
      and a.status = 'confirmed'
      and a.ends_at > v_now
  ) then
    raise exception using errcode = 'P0001', message = 'client_has_upcoming_appointments';
  end if;
  -- An email being handed to the provider right now: try again in a moment.
  if exists (
    select 1 from public.email_events e
    where e.business_id = p_business_id
      and e.client_id = p_client_id
      and e.status = 'processing'
  ) then
    raise exception using errcode = 'P0001', message = 'client_erasure_busy';
  end if;

  v_email := v_client.email::text;

  -- Her appointments: no name, no contact, no free text.
  perform pg_catalog.set_config('booking.erasing_client', p_client_id::text, true);
  update public.appointments a
  set client_first_name_snapshot = 'Cliente effacée',
      client_last_name_snapshot = null,
      client_email_snapshot = null,
      client_phone_snapshot = null,
      internal_notes = null,
      cancellation_reason = null
  where a.business_id = p_business_id and a.client_id = p_client_id;
  perform pg_catalog.set_config('booking.erasing_client', '', true);

  -- Emails: nothing left to send, no address kept.
  update public.email_events e
  set status = 'cancelled', last_error = 'client_erased'
  where e.business_id = p_business_id
    and e.client_id = p_client_id
    and e.status = 'pending';
  delete from private.email_renderings r
  using public.email_events e
  where r.email_event_id = e.id
    and e.business_id = p_business_id
    and e.client_id = p_client_id;
  update public.email_events e
  set recipient_email = 'adresse-effacee'
  where e.business_id = p_business_id and e.client_id = p_client_id;

  -- The professional's notes, her forms and answers, her consents.
  delete from public.client_notes n
  where n.business_id = p_business_id and n.client_id = p_client_id;
  delete from private.client_note_requests q
  where q.business_id = p_business_id and q.client_id = p_client_id;
  delete from private.form_assignments f
  where f.business_id = p_business_id and f.client_id = p_client_id;
  delete from private.consent_confirmations cc
  where cc.business_id = p_business_id and cc.client_id = p_client_id;
  delete from private.consent_events ce
  where ce.business_id = p_business_id and ce.client_id = p_client_id;
  delete from private.unsubscribe_links u
  where u.business_id = p_business_id and u.client_id = p_client_id;

  -- Her client space access here (her account itself is shared).
  delete from public.client_hub_access h
  where h.business_id = p_business_id and h.client_id = p_client_id;

  -- Her referral link: revoked, its history kept.
  update private.referral_links l
  set revoked_at = coalesce(l.revoked_at, v_now)
  where l.business_id = p_business_id and l.client_id = p_client_id;

  -- Her waitlist requests here, under her address.
  if v_email is not null then
    delete from private.waitlist_requests w
    where w.business_id = p_business_id
      and private.canonical_email(w.email::text) = private.canonical_email(v_email);
  end if;

  -- Her record, last (its triggers see the appointments already blank).
  update public.clients c
  set first_name = 'Cliente effacée',
      last_name = null,
      email = null,
      phone = null,
      internal_notes = null,
      loyalty_token_hash = null,
      erased_at = v_now
  where c.id = p_client_id;

  return pg_catalog.jsonb_build_object('erased', true, 'erasedAt', v_now);
end;
$$;

revoke all on function public.privacy_erase_client(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.privacy_erase_client(uuid, uuid, integer) to authenticated;
