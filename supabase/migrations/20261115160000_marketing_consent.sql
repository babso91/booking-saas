-- Marketing consent and unsubscribe links (docs/MARKETING_CONSENT_CONTRACT.md;
-- R3-02's consent register, R4-01's unsubscribe slice).
--
-- An append-only register per customer × purpose × channel. Its current
-- state is its latest event; without any, 'unknown' (never contacted for
-- marketing: opt-in is explicit). Appointment emails are not marketing and
-- never read it.
--
-- V1 rules (the product's decision, not a legal certification): consent is
-- given by the customer herself (her booking), on texts archived in full
-- and versioned (private.consent_texts), activated by the platform's
-- administrator (scripts/consent-admin.mjs, docs/MARKETING_CONSENT_OPERATIONS.md);
-- a professional may record a withdrawal, never an agreement; and no
-- agreement is recorded at all while the platform's collection switch is
-- off (private.platform_flags, off by default). Withdrawals are always
-- possible.
--
-- Every change takes the subject's lock (private.lock_consent_subject),
-- which a marketing delivery takes too before its last check: a withdrawal
-- committed before that check stops the delivery.

-- The texts shown when consent is collected, archived in full: the two
-- boxes (email, sms), the common information under them, and the privacy
-- notice's template. A text never changes once registered (a new version
-- replaces it); one active version per kind, made active by the platform's
-- administrator after checking it. Active is not legally certified.
create table private.consent_texts (
  version text primary key check (version ~ '^[A-Za-z0-9._-]{1,64}$'),
  kind text not null check (kind in ('email', 'sms', 'information', 'notice')),
  purpose text not null default 'marketing' check (purpose in ('marketing')),
  body text not null check (pg_catalog.char_length(body) between 1 and 20000),
  -- Set from the body when it is registered (consent_texts_guard).
  body_sha256 text not null,
  state text not null default 'draft' check (state in ('draft', 'active', 'retired')),
  created_at timestamptz not null default pg_catalog.now(),
  activated_at timestamptz,
  activation_note text check (activation_note is null or pg_catalog.char_length(activation_note) <= 500),
  retired_at timestamptz
);

create unique index consent_texts_active_idx on private.consent_texts (kind) where state = 'active';

-- A text's body never changes; its state only moves forward.
create function private.consent_texts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.body_sha256 := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(new.body, 'UTF8')), 'hex');
    return new;
  end if;
  if tg_op = 'DELETE' or new.body <> old.body or new.body_sha256 <> old.body_sha256
     or new.kind <> old.kind or new.version <> old.version
     or (old.state = 'active' and new.state = 'draft')
     or (old.state = 'retired' and new.state <> 'retired') then
    raise exception using errcode = '55000', message = 'consent_text_immutable';
  end if;
  return new;
end;
$$;

create trigger consent_texts_guard
  before insert or update or delete on private.consent_texts
  for each row execute function private.consent_texts_guard();

-- The platform's switches. marketing_consent_collection: off until the
-- platform's owner authorises collecting marketing consent for real.
create table private.platform_flags (
  key text primary key check (key ~ '^[a-z_]{1,64}$'),
  enabled boolean not null,
  changed_at timestamptz not null default pg_catalog.now(),
  note text check (note is null or pg_catalog.char_length(note) <= 500)
);

insert into private.platform_flags (key, enabled, note)
values ('marketing_consent_collection', false, 'Off until explicitly authorised.');

-- The V1 texts decided for the product, registered as DRAFTS only: the
-- administrator activates them (docs/MARKETING_CONSENT_OPERATIONS.md).
insert into private.consent_texts (version, kind, body) values
  ('email-v1', 'email',
   'J''accepte de recevoir par e-mail les offres, promotions et nouveautés commerciales de cet établissement.'),
  ('sms-v1', 'sms',
   'J''accepte de recevoir par SMS les offres, promotions et nouveautés commerciales de cet établissement.'),
  ('information-v1', 'information',
   'Ces choix sont facultatifs et n''affectent pas votre réservation. Vous pouvez retirer votre accord à tout moment, gratuitement. Les messages concernant vos rendez-vous restent indépendants.');

revoke all on table private.consent_texts from public, anon, authenticated;
revoke all on table private.platform_flags from public, anon, authenticated;
revoke all on function private.consent_texts_guard() from public;

create table private.consent_events (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  client_id uuid not null,
  purpose text not null check (purpose in ('marketing')),
  channel text not null check (channel in ('email', 'sms')),
  state text not null check (state in ('unknown', 'granted', 'withdrawn')),
  -- The exact texts she was shown (a grant needs them all): her box, the
  -- information under it, and the notice.
  proof_version text references private.consent_texts (version),
  information_version text references private.consent_texts (version),
  notice_version text references private.consent_texts (version),
  -- Where she gave it (a grant: booking or client_hub, herself).
  source text not null check (source in (
    'booking', 'client_hub', 'professional', 'unsubscribe_link', 'unsubscribe_undo'
  )),
  -- What proves it (the booking it came with).
  evidence jsonb,
  actor_user_id uuid references auth.users (id) on delete set null,
  request_id uuid,
  fingerprint text,
  link_id uuid,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade,
  check (state <> 'granted' or (proof_version is not null and information_version is not null
                                and notice_version is not null)),
  check (state <> 'granted' or source in ('booking', 'client_hub', 'unsubscribe_undo'))
);

create index consent_events_subject_idx
  on private.consent_events (client_id, purpose, channel, id desc);
create unique index consent_events_request_idx
  on private.consent_events (business_id, request_id) where request_id is not null;

create function private.consent_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '42501', message = 'consent_events is append-only';
end;
$$;

create trigger consent_events_append_only
  before update on private.consent_events
  for each row execute function private.consent_events_append_only();

create table private.unsubscribe_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  client_id uuid not null,
  purpose text not null default 'marketing' check (purpose in ('marketing')),
  channel text not null check (channel in ('email', 'sms')),
  -- SHA-256 of the token, hex. Never the token.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade
);

create index unsubscribe_links_client_idx on private.unsubscribe_links (client_id);

revoke all on table private.consent_events from public, anon, authenticated;
revoke all on table private.unsubscribe_links from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- State and lock
-- ---------------------------------------------------------------------------

create function private.lock_consent_subject(p_client_id uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('consent:' || p_client_id::text, 0)
  );
$$;

-- The latest event of the subject, or nothing.
create function private.consent_latest(p_client_id uuid, p_purpose text, p_channel text)
returns private.consent_events
language sql
stable
set search_path = ''
as $$
  select e.* from private.consent_events e
  where e.client_id = p_client_id and e.purpose = p_purpose and e.channel = p_channel
  order by e.id desc
  limit 1;
$$;

-- What a marketing delivery reads, under the subject's lock.
create function private.consent_state(p_client_id uuid, p_purpose text, p_channel text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((private.consent_latest(p_client_id, p_purpose, p_channel)).state, 'unknown');
$$;

create function private.consent_view(p_client_id uuid, p_purpose text, p_channel text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'purpose', p_purpose,
    'channel', p_channel,
    'state', coalesce(l.state, 'unknown'),
    'proofVersion', case when l.state = 'granted' then l.proof_version end,
    'source', l.source,
    'changedAt', l.created_at
  )
  from (select (private.consent_latest(p_client_id, p_purpose, p_channel)).*) l;
$$;

revoke all on function private.consent_events_append_only() from public;
revoke all on function private.lock_consent_subject(uuid) from public;
revoke all on function private.consent_latest(uuid, text, text) from public;
revoke all on function private.consent_state(uuid, text, text) from public;
revoke all on function private.consent_view(uuid, text, text) from public;

-- ---------------------------------------------------------------------------
-- The professional's side
-- ---------------------------------------------------------------------------

create function private.consent_client(p_business_id uuid, p_client_id uuid)
returns uuid
language plpgsql
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
  if not exists (
    select 1 from public.clients c where c.id = p_client_id and c.business_id = p_business_id
  ) then
    raise exception using errcode = 'P0001', message = 'client_not_found';
  end if;
  return p_client_id;
end;
$$;

revoke all on function private.consent_client(uuid, uuid) from public;

-- A customer's marketing consent, per channel.
create function public.marketing_client_consents(p_business_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.consent_client(p_business_id, p_client_id);
  return pg_catalog.jsonb_build_array(
    private.consent_view(p_client_id, 'marketing', 'email'),
    private.consent_view(p_client_id, 'marketing', 'sms')
  );
end;
$$;

-- She refused (`withdraw`), as told to the professional. `grant` is
-- refused (consent_direct_only): only the customer herself agrees.
-- Replayed by requestId: the same command answers the current state,
-- another one idempotency_conflict.
create function public.marketing_set_consent(
  p_business_id uuid,
  p_client_id uuid,
  p_purpose text,
  p_channel text,
  p_action text,
  p_proof_version text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_fingerprint text;
  v_previous private.consent_events;
begin
  perform private.consent_client(p_business_id, p_client_id);
  if p_purpose is distinct from 'marketing' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'purpose';
  end if;
  if p_channel is null or p_channel not in ('email', 'sms') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'channel';
  end if;
  if p_action is null or p_action not in ('grant', 'withdraw') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'action';
  end if;
  -- A professional may record that she withdrew, never that she agreed:
  -- an agreement is given by the customer herself (her booking).
  if p_action = 'grant' then
    raise exception using errcode = 'P0001', message = 'consent_direct_only';
  end if;
  v_state := case p_action when 'grant' then 'granted' else 'withdrawn' end;
  v_fingerprint := pg_catalog.md5(pg_catalog.concat_ws('|',
    p_client_id, p_purpose, p_channel, v_state,
    case when v_state = 'granted' then p_proof_version end));

  perform private.lock_consent_subject(p_client_id);

  select * into v_previous from private.consent_events e
  where e.business_id = p_business_id and e.request_id = p_request_id;
  if found then
    if v_previous.fingerprint is distinct from v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    return private.consent_view(p_client_id, p_purpose, p_channel);
  end if;

  insert into private.consent_events (
    business_id, client_id, purpose, channel, state, proof_version, source,
    actor_user_id, request_id, fingerprint
  ) values (
    p_business_id, p_client_id, p_purpose, p_channel, v_state,
    case when v_state = 'granted' then p_proof_version end, 'professional',
    (select auth.uid()), p_request_id, v_fingerprint
  );
  return private.consent_view(p_client_id, p_purpose, p_channel);
end;
$$;

-- Her register, newest first: every change, never a deletion.
create function public.marketing_client_consent_history(p_business_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.consent_client(p_business_id, p_client_id);
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'purpose', e.purpose,
      'channel', e.channel,
      'state', e.state,
      'proofVersion', e.proof_version,
      'informationVersion', e.information_version,
      'noticeVersion', e.notice_version,
      'source', e.source,
      'businessName', b.name,
      'occurredAt', e.created_at
    ) order by e.id desc)
    from private.consent_events e
    join public.businesses b on b.id = e.business_id
    where e.business_id = p_business_id and e.client_id = p_client_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.marketing_client_consent_history(uuid, uuid) from public, anon;
grant execute on function public.marketing_client_consent_history(uuid, uuid) to authenticated;
revoke all on function public.marketing_client_consents(uuid, uuid) from public, anon;
revoke all on function public.marketing_set_consent(uuid, uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.marketing_client_consents(uuid, uuid) to authenticated;
grant execute on function public.marketing_set_consent(uuid, uuid, text, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Unsubscribe links (the service only)
-- ---------------------------------------------------------------------------

-- A link for one marketing message: proves this business, this customer and
-- this channel, nothing else. Valid a year.
create function public.issue_unsubscribe_link(
  p_business_id uuid,
  p_client_id uuid,
  p_channel text,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_channel is null or p_channel not in ('email', 'sms')
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  insert into private.unsubscribe_links (business_id, client_id, channel, token_hash, expires_at)
  values (p_business_id, p_client_id, p_channel, p_token_hash, pg_catalog.now() + interval '1 year')
  returning id into v_id;
  return v_id;
end;
$$;

-- The valid link of this token, or unsubscribe_link_invalid (unknown,
-- forged or expired: one answer).
create function private.unsubscribe_link(p_token_hash text)
returns private.unsubscribe_links
language plpgsql
stable
set search_path = ''
as $$
declare
  v_link private.unsubscribe_links;
begin
  if p_token_hash is not null and p_token_hash ~ '^[0-9a-f]{64}$' then
    select * into v_link from private.unsubscribe_links l
    where l.token_hash = p_token_hash and l.expires_at > pg_catalog.now();
  end if;
  if v_link.id is null then
    raise exception using errcode = 'P0001', message = 'unsubscribe_link_invalid';
  end if;
  return v_link;
end;
$$;

revoke all on function private.unsubscribe_link(text) from public;

-- What the page shows. The minutes after her withdrawal through this link,
-- `canUndo` (a click by mistake).
create function private.unsubscribe_view(v_link private.unsubscribe_links)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'businessName', b.name,
    'channel', v_link.channel,
    'alreadyWithdrawn', coalesce(l.state = 'withdrawn', false),
    'canUndo', coalesce(
      l.source = 'unsubscribe_link' and l.link_id = v_link.id
        and l.created_at > pg_catalog.now() - interval '30 minutes',
      false)
  )
  from public.businesses b
  left join lateral (
    select (private.consent_latest(v_link.client_id, v_link.purpose, v_link.channel)).*
  ) l on true
  where b.id = v_link.business_id;
$$;

revoke all on function private.unsubscribe_view(private.unsubscribe_links) from public;

-- Reads: changes nothing (link previews and mail scanners open links).
create function public.unsubscribe_read(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.unsubscribe_view(private.unsubscribe_link(p_token_hash));
$$;

-- Her click: withdrawn for this business and channel. Idempotent.
create function public.unsubscribe_withdraw(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link private.unsubscribe_links := private.unsubscribe_link(p_token_hash);
begin
  perform private.lock_consent_subject(v_link.client_id);
  if private.consent_state(v_link.client_id, v_link.purpose, v_link.channel) <> 'withdrawn' then
    insert into private.consent_events (
      business_id, client_id, purpose, channel, state, source, link_id
    ) values (
      v_link.business_id, v_link.client_id, v_link.purpose, v_link.channel,
      'withdrawn', 'unsubscribe_link', v_link.id
    );
  end if;
  return private.unsubscribe_view(v_link);
end;
$$;

-- Undo, within 30 minutes of her withdrawal through this same link: the
-- state before it comes back (her earlier grant with its proof, or
-- unknown). Otherwise unsubscribe_undo_unavailable. Idempotent.
create function public.unsubscribe_undo(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link private.unsubscribe_links := private.unsubscribe_link(p_token_hash);
  v_latest private.consent_events;
  v_before private.consent_events;
begin
  perform private.lock_consent_subject(v_link.client_id);
  v_latest := private.consent_latest(v_link.client_id, v_link.purpose, v_link.channel);
  if v_latest.source = 'unsubscribe_undo' and v_latest.link_id = v_link.id then
    return private.unsubscribe_view(v_link);
  end if;
  if v_latest.id is null or v_latest.source <> 'unsubscribe_link'
     or v_latest.link_id is distinct from v_link.id
     or v_latest.created_at <= pg_catalog.now() - interval '30 minutes' then
    raise exception using errcode = 'P0001', message = 'unsubscribe_undo_unavailable';
  end if;

  select * into v_before from private.consent_events e
  where e.client_id = v_link.client_id and e.purpose = v_link.purpose
    and e.channel = v_link.channel and e.id < v_latest.id
  order by e.id desc
  limit 1;

  insert into private.consent_events (
    business_id, client_id, purpose, channel, state, proof_version, information_version,
    notice_version, evidence, source, link_id
  ) values (
    v_link.business_id, v_link.client_id, v_link.purpose, v_link.channel,
    coalesce(v_before.state, 'unknown'),
    case when v_before.state = 'granted' then v_before.proof_version end,
    case when v_before.state = 'granted' then v_before.information_version end,
    case when v_before.state = 'granted' then v_before.notice_version end,
    case when v_before.state = 'granted' then v_before.evidence end,
    'unsubscribe_undo', v_link.id
  );
  return private.unsubscribe_view(v_link);
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.issue_unsubscribe_link(uuid, uuid, text, text)',
    'public.unsubscribe_read(text)',
    'public.unsubscribe_withdraw(text)',
    'public.unsubscribe_undo(text)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Collection from the customer herself (the booking)
-- ---------------------------------------------------------------------------

-- What a booking page shows: the active texts and whether collection is on.
-- No active text of a kind, or collection off: the page shows no box.
create function public.consent_texts_current()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'collectionEnabled', coalesce((
      select f.enabled from private.platform_flags f where f.key = 'marketing_consent_collection'
    ), false),
    'texts', coalesce((
      select pg_catalog.jsonb_object_agg(t.kind, pg_catalog.jsonb_build_object(
        'version', t.version, 'body', t.body))
      from private.consent_texts t where t.state = 'active'
    ), '{}'::jsonb)
  );
$$;

-- Her boxes, ticked with her booking, wait for her confirmation: a public
-- booking links the customer record by the email typed, without proving
-- the mailbox is hers, so a box ticked there proves nothing yet. A
-- confirmation link goes to the record's address (double opt-in); only her
-- click records the agreement (consent_confirm). An SMS agreement is for the
-- number typed with this booking, and only if it is the record's.
create table private.consent_confirmations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  business_id uuid not null,
  client_id uuid not null,
  appointment_id uuid not null,
  -- {"email": "email-v1", "sms": "sms-v1"}: the boxes ticked, with the
  -- version of each shown.
  channels jsonb not null,
  information_version text not null references private.consent_texts (version),
  notice_version text not null references private.consent_texts (version),
  -- The number she typed with this booking (an SMS agreement is for it).
  phone text,
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  unique (appointment_id),
  foreign key (client_id, business_id) references public.clients (id, business_id) on delete cascade
);

revoke all on table private.consent_confirmations from public, anon, authenticated;

-- The boxes she ticked with her booking `p_appointment_id` (the service,
-- from the booking route, after the booking), pending her confirmation:
-- answers {status: 'pending', email} (the address the link goes to), or why
-- nothing waits ('collection_off', 'text_not_active', 'unknown_booking',
-- 'nothing_ticked'). Never fails the booking. Once per booking.
create function public.consent_request_from_booking(
  p_appointment_id uuid,
  p_channels jsonb,
  p_information_version text,
  p_notice_version text,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment public.appointments;
  v_client public.clients;
  v_channel text;
begin
  if not coalesce((
    select f.enabled from private.platform_flags f where f.key = 'marketing_consent_collection'
  ), false) then
    return pg_catalog.jsonb_build_object('status', 'collection_off');
  end if;
  if p_channels is null or pg_catalog.jsonb_typeof(p_channels) <> 'object'
     or p_channels = '{}'::jsonb then
    return pg_catalog.jsonb_build_object('status', 'nothing_ticked');
  end if;
  for v_channel in select pg_catalog.jsonb_object_keys(p_channels) loop
    if v_channel not in ('email', 'sms') or not exists (
      select 1 from private.consent_texts t
      where t.version = p_channels ->> v_channel and t.kind = v_channel and t.state = 'active'
    ) then
      return pg_catalog.jsonb_build_object('status', 'text_not_active');
    end if;
  end loop;
  if not exists (select 1 from private.consent_texts t
                 where t.version = p_information_version and t.kind = 'information' and t.state = 'active')
     or not exists (select 1 from private.consent_texts t
                    where t.version = p_notice_version and t.kind = 'notice' and t.state = 'active') then
    return pg_catalog.jsonb_build_object('status', 'text_not_active');
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'token';
  end if;
  select * into v_appointment from public.appointments a where a.id = p_appointment_id;
  if v_appointment.id is null then
    return pg_catalog.jsonb_build_object('status', 'unknown_booking');
  end if;
  select * into v_client from public.clients c where c.id = v_appointment.client_id;
  if v_client.email is null then
    return pg_catalog.jsonb_build_object('status', 'unreachable');
  end if;
  insert into private.consent_confirmations (
    token_hash, business_id, client_id, appointment_id, channels, information_version,
    notice_version, phone, expires_at
  ) values (
    p_token_hash, v_appointment.business_id, v_client.id, v_appointment.id, p_channels,
    p_information_version, p_notice_version, v_appointment.client_phone_snapshot,
    pg_catalog.now() + interval '7 days'
  )
  on conflict (appointment_id) do nothing;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'already_requested');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'pending',
    'email', v_client.email::text,
    'businessName', (select b.name from public.businesses b where b.id = v_appointment.business_id)
  );
end;
$$;

-- Her click on the confirmation link: each ticked box becomes her
-- agreement, with its proof (the booking, the confirmation, the texts
-- shown). The SMS box counts only for the number she typed with that
-- booking, if it is still the record's. Collection must still be on.
-- Answers {status: 'confirmed', businessName, channels: {email?, sms?}}
-- ('granted' or why not), 'already_confirmed', or consent_link_invalid
-- (unknown or expired: one answer).
create function public.consent_confirm(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirmation private.consent_confirmations;
  v_client public.clients;
  v_channel text;
  v_outcomes jsonb := '{}'::jsonb;
  v_name text;
begin
  select * into v_confirmation from private.consent_confirmations c
  where c.token_hash = p_token_hash for update;
  if v_confirmation.id is null or v_confirmation.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'consent_link_invalid';
  end if;
  select b.name into v_name from public.businesses b where b.id = v_confirmation.business_id;
  if v_confirmation.confirmed_at is not null then
    return pg_catalog.jsonb_build_object('status', 'already_confirmed', 'businessName', v_name);
  end if;
  if not coalesce((
    select f.enabled from private.platform_flags f where f.key = 'marketing_consent_collection'
  ), false) then
    return pg_catalog.jsonb_build_object('status', 'collection_off', 'businessName', v_name);
  end if;

  perform private.lock_consent_subject(v_confirmation.client_id);
  select * into v_client from public.clients c where c.id = v_confirmation.client_id;
  for v_channel in select pg_catalog.jsonb_object_keys(v_confirmation.channels) loop
    if v_channel = 'sms' and (
      v_confirmation.phone is null or v_client.phone is distinct from v_confirmation.phone
    ) then
      v_outcomes := v_outcomes || pg_catalog.jsonb_build_object(v_channel, 'unreachable');
      continue;
    end if;
    insert into private.consent_events (
      business_id, client_id, purpose, channel, state, proof_version, information_version,
      notice_version, source, evidence
    ) values (
      v_confirmation.business_id, v_confirmation.client_id, 'marketing', v_channel, 'granted',
      v_confirmation.channels ->> v_channel, v_confirmation.information_version,
      v_confirmation.notice_version, 'booking',
      pg_catalog.jsonb_build_object(
        'appointmentId', v_confirmation.appointment_id,
        'bookingRequestId', (select a.creation_request_id from public.appointments a
                             where a.id = v_confirmation.appointment_id),
        'confirmationId', v_confirmation.id,
        'confirmedBy', 'email_link',
        'requestedAt', v_confirmation.created_at
      )
    );
    v_outcomes := v_outcomes || pg_catalog.jsonb_build_object(v_channel, 'granted');
  end loop;
  update private.consent_confirmations c set confirmed_at = pg_catalog.now()
  where c.id = v_confirmation.id;
  return pg_catalog.jsonb_build_object('status', 'confirmed', 'businessName', v_name, 'channels', v_outcomes);
end;
$$;

-- What the confirmation page shows before her click (changes nothing).
create function public.consent_confirmation_read(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_confirmation private.consent_confirmations;
begin
  select * into v_confirmation from private.consent_confirmations c where c.token_hash = p_token_hash;
  if v_confirmation.id is null or v_confirmation.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'consent_link_invalid';
  end if;
  return pg_catalog.jsonb_build_object(
    'businessName', (select b.name from public.businesses b where b.id = v_confirmation.business_id),
    'channels', (select pg_catalog.jsonb_agg(k order by k) from pg_catalog.jsonb_object_keys(v_confirmation.channels) k),
    'texts', (
      select pg_catalog.jsonb_object_agg(t.kind, t.body) from private.consent_texts t
      where t.version in (
        select value from pg_catalog.jsonb_each_text(v_confirmation.channels)
        union all select v_confirmation.information_version
      )
    ),
    'confirmed', v_confirmation.confirmed_at is not null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The privacy notice: her business's details
-- ---------------------------------------------------------------------------

-- What the notice says about the business, the data controller. Filled by
-- the owner; nothing is invented when missing.
create table private.business_legal_profiles (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  legal_name text check (legal_name is null or pg_catalog.char_length(legal_name) between 1 and 200),
  address text check (address is null or pg_catalog.char_length(address) between 1 and 500),
  contact_email text check (contact_email is null or contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  registration_number text check (registration_number is null or pg_catalog.char_length(registration_number) <= 50),
  updated_at timestamptz not null default pg_catalog.now()
);

revoke all on table private.business_legal_profiles from public, anon, authenticated;

create function private.consent_notice_view(p_business_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'businessName', b.name,
    'controller', pg_catalog.jsonb_build_object(
      'legalName', l.legal_name, 'address', l.address,
      'contactEmail', l.contact_email, 'registrationNumber', l.registration_number
    ),
    'missing', (
      select coalesce(pg_catalog.jsonb_agg(m order by m), '[]'::jsonb)
      from pg_catalog.unnest(array[
        case when l.legal_name is null then 'controller.legalName' end,
        case when l.address is null then 'controller.address' end,
        case when l.contact_email is null then 'controller.contactEmail' end
      ]) m
      where m is not null
    )
  )
  from public.businesses b
  left join private.business_legal_profiles l on l.business_id = b.id
  where b.id = p_business_id;
$$;

revoke all on function private.consent_notice_view(uuid) from public;

-- For the booking page: the business's details for the notice.
create function public.consent_notice(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.consent_notice_view(private.business_id_by_slug(p_slug));
$$;

create function public.business_legal_profile(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.consent_notice_view(p_business_id);
end;
$$;

-- The owner fills her details (null clears a field).
create function public.set_business_legal_profile(
  p_business_id uuid,
  p_legal_name text,
  p_address text,
  p_contact_email text,
  p_registration_number text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or p_business_id is null
     or not public.has_business_role(p_business_id, array['owner']::public.business_member_role[]) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  begin
    insert into private.business_legal_profiles (
      business_id, legal_name, address, contact_email, registration_number
    ) values (
      p_business_id, nullif(pg_catalog.btrim(p_legal_name), ''), nullif(pg_catalog.btrim(p_address), ''),
      nullif(pg_catalog.lower(pg_catalog.btrim(p_contact_email)), ''), nullif(pg_catalog.btrim(p_registration_number), '')
    )
    on conflict (business_id) do update set
      legal_name = excluded.legal_name, address = excluded.address,
      contact_email = excluded.contact_email, registration_number = excluded.registration_number,
      updated_at = pg_catalog.now();
  exception when check_violation then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'legalProfile';
  end;
  return private.consent_notice_view(p_business_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The platform administrator (the service only; scripts/consent-admin.mjs)
-- ---------------------------------------------------------------------------

-- Registers a text as a draft. The same version again with the same body:
-- nothing changes; with another body: consent_text_conflict (a text is
-- never rewritten: a new version replaces it).
create function public.consent_text_register(p_version text, p_kind text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text private.consent_texts;
begin
  select * into v_text from private.consent_texts t where t.version = p_version;
  if v_text.version is not null then
    if v_text.body <> p_body or v_text.kind <> p_kind then
      raise exception using errcode = 'P0001', message = 'consent_text_conflict';
    end if;
  else
    insert into private.consent_texts (version, kind, body)
    values (p_version, p_kind, p_body)
    returning * into v_text;
  end if;
  return pg_catalog.jsonb_build_object(
    'version', v_text.version, 'kind', v_text.kind, 'state', v_text.state,
    'sha256', v_text.body_sha256, 'body', v_text.body
  );
end;
$$;

-- Activates a draft after the administrator checked it (the hash she saw
-- must be the text's: what she checked is what is activated); the active
-- text of its kind is retired. Not a legal certification.
create function public.consent_text_activate(p_version text, p_expected_sha256 text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text private.consent_texts;
begin
  select * into v_text from private.consent_texts t where t.version = p_version for update;
  if v_text.version is null or v_text.state <> 'draft' then
    raise exception using errcode = 'P0001', message = 'consent_text_not_draft';
  end if;
  if v_text.body_sha256 is distinct from p_expected_sha256 then
    raise exception using errcode = 'P0001', message = 'consent_text_changed';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('consent_text:' || v_text.kind, 0));
  update private.consent_texts t set state = 'retired', retired_at = pg_catalog.now()
  where t.kind = v_text.kind and t.state = 'active';
  update private.consent_texts t
  set state = 'active', activated_at = pg_catalog.now(), activation_note = p_note
  where t.version = v_text.version;
  return pg_catalog.jsonb_build_object('version', v_text.version, 'kind', v_text.kind, 'state', 'active');
end;
$$;

-- One text in full, for the administrator to read before activating it.
create function public.consent_text_show(p_version text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'version', t.version, 'kind', t.kind, 'state', t.state, 'sha256', t.body_sha256, 'body', t.body
  )
  from private.consent_texts t where t.version = p_version;
$$;

create function public.consent_texts_list()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'version', t.version, 'kind', t.kind, 'state', t.state, 'sha256', t.body_sha256,
    'activatedAt', t.activated_at
  ) order by t.kind, t.created_at), '[]'::jsonb)
  from private.consent_texts t;
$$;

-- The platform's switches (collection of marketing consent: only on the
-- platform owner's explicit authorisation).
create function public.platform_set_flag(p_key text, p_enabled boolean, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.platform_flags f
  set enabled = p_enabled, changed_at = pg_catalog.now(), note = p_note
  where f.key = p_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found';
  end if;
  return pg_catalog.jsonb_build_object('key', p_key, 'enabled', p_enabled);
end;
$$;

revoke all on function public.consent_texts_current() from public;
grant execute on function public.consent_texts_current() to anon, authenticated, service_role;
revoke all on function public.consent_notice(text) from public;
grant execute on function public.consent_notice(text) to anon, authenticated, service_role;
revoke all on function public.business_legal_profile(uuid) from public, anon;
grant execute on function public.business_legal_profile(uuid) to authenticated;
revoke all on function public.set_business_legal_profile(uuid, text, text, text, text) from public, anon;
grant execute on function public.set_business_legal_profile(uuid, text, text, text, text) to authenticated;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.consent_request_from_booking(uuid, jsonb, text, text, text)',
    'public.consent_confirm(text)',
    'public.consent_confirmation_read(text)',
    'public.consent_text_show(text)',
    'public.consent_text_register(text, text, text)',
    'public.consent_text_activate(text, text, text)',
    'public.consent_texts_list()',
    'public.platform_set_flag(text, boolean, text)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
