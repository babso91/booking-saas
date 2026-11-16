-- Marketing consent and unsubscribe links (docs/MARKETING_CONSENT_CONTRACT.md;
-- R3-02's consent register, R4-01's unsubscribe slice).
--
-- An append-only register per customer × purpose × channel. Its current
-- state is its latest event; without any, 'unknown' (never contacted for
-- marketing: opt-in is explicit). Appointment emails are not marketing and
-- never read it.
--
-- Every change takes the subject's lock (private.lock_consent_subject),
-- which a marketing delivery takes too before its last check: a withdrawal
-- committed before that check stops the delivery.

create table private.consent_events (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  client_id uuid not null,
  purpose text not null check (purpose in ('marketing')),
  channel text not null check (channel in ('email', 'sms')),
  state text not null check (state in ('unknown', 'granted', 'withdrawn')),
  -- The version of the wording she agreed to (a grant needs one).
  proof_version text check (proof_version is null or proof_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  source text not null
    check (source in ('professional', 'unsubscribe_link', 'unsubscribe_undo')),
  actor_user_id uuid references auth.users (id) on delete set null,
  request_id uuid,
  fingerprint text,
  link_id uuid,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (client_id, business_id)
    references public.clients (id, business_id) on delete cascade,
  check (state <> 'granted' or proof_version is not null)
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

-- The wordings validated (legal review) for collecting consent: a grant
-- must name one. Registered by an operator (SQL, after validation), never
-- from the application. None yet: every grant is refused.
create table private.consent_wording_versions (
  version text primary key check (version ~ '^[A-Za-z0-9._-]{1,64}$'),
  purpose text not null check (purpose in ('marketing')),
  -- SHA-256 of the exact text shown, for the record.
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  validated_at timestamptz not null default pg_catalog.now(),
  note text check (note is null or pg_catalog.char_length(note) <= 200)
);

revoke all on table private.consent_wording_versions from public, anon, authenticated;
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

-- She agreed (`grant`, with the version of the wording she was shown) or
-- refused (`withdraw`), told to the professional. Replayed by requestId:
-- the same command answers the current state, another one
-- idempotency_conflict.
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
  if p_action = 'grant' and (
    p_proof_version is null or p_proof_version !~ '^[A-Za-z0-9._-]{1,64}$'
  ) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'proofVersion';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  -- Only a validated wording proves a consent (none validated yet: refused).
  if p_action = 'grant' and not exists (
    select 1 from private.consent_wording_versions w
    where w.version = p_proof_version and w.purpose = p_purpose
  ) then
    raise exception using errcode = 'P0001', message = 'consent_wording_not_validated', hint = 'proofVersion';
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
    business_id, client_id, purpose, channel, state, proof_version, source, link_id
  ) values (
    v_link.business_id, v_link.client_id, v_link.purpose, v_link.channel,
    coalesce(v_before.state, 'unknown'),
    case when v_before.state = 'granted' then v_before.proof_version end,
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
