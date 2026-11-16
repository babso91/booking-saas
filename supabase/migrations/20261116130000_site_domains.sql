-- Her own domain for her public page (docs/SITE_DOMAIN_CONTRACT.md, R5-02).
--
-- Nothing is bought, no DNS is written, no certificate is requested here.
-- The state moves only on evidence:
--   awaiting_dns     a challenge (generation n): a TXT proof and a CNAME
--   provisioning_tls the TXT proof of generation n was read in public DNS
--                    and the name points to our target: a certificate may
--                    now be issued for it (site_domain_tls_allowed, the
--                    certificate server's "ask")
--   active           a request over HTTPS to the name reached us and named
--                    this domain (certificate and routing both work)
--   error            the last check failed (reason), retry possible
--   detached         unlinked; the name is free again (a new proof needed)
-- The verifier (the server, never the browser) reports with the generation
-- it checked: a report for an older generation is refused.

create table private.site_domains (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  hostname text not null check (
    hostname ~ '^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,63}$'
    and pg_catalog.char_length(hostname) <= 253
  ),
  state text not null check (state in (
    'awaiting_dns', 'provisioning_tls', 'active', 'error', 'detached'
  )),
  generation integer not null default 1,
  -- The TXT value to publish; a random token, not a secret (it is public
  -- in DNS once published).
  challenge text not null check (challenge ~ '^[A-Za-z0-9_-]{32}$'),
  proof_expires_at timestamptz not null,
  reason text check (reason in ('proof_missing', 'proof_mismatch', 'target_mismatch', 'tls_failed', 'dns_lost')),
  checked_at timestamptz,
  verified_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

-- A name belongs to the business whose proof was seen first: only a
-- verified domain holds it. Pending requests never block anyone (no
-- squatting a name without its DNS).
create unique index site_domains_hostname_idx on private.site_domains (hostname)
  where state in ('provisioning_tls', 'active');
create unique index site_domains_business_idx on private.site_domains (business_id) where state <> 'detached';

create table private.site_domain_requests (
  business_id uuid not null references public.businesses (id) on delete cascade,
  request_id uuid not null,
  kind text not null,
  fingerprint text not null,
  response jsonb not null,
  primary key (business_id, request_id)
);

revoke all on table private.site_domains from public, anon, authenticated;
revoke all on table private.site_domain_requests from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function private.site_domain_dto(p private.site_domains, p_target text, p_fallback text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p.id is null then null else pg_catalog.jsonb_build_object(
    'id', p.id,
    'hostname', p.hostname,
    'state', p.state,
    'generation', p.generation,
    'records', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('type', 'TXT', 'name', '_booking-verify.' || p.hostname,
        'value', 'booking-verify=' || p.challenge),
      pg_catalog.jsonb_build_object('type', 'CNAME', 'name', p.hostname, 'value', p_target)
    ),
    'proofExpiresAt', case when p.state in ('awaiting_dns', 'error') then p.proof_expires_at end,
    'fallbackUrl', p_fallback,
    'reason', p.reason,
    'checkedAt', p.checked_at
  ) end;
$$;

create function private.site_domain_owner(p_business_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null
     or not public.has_business_role(p_business_id, array['owner']::public.business_member_role[]) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

create function private.site_domain_new_challenge()
returns text
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.left(pg_catalog.translate(
    pg_catalog.encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_'), 32);
$$;

-- Replay by requestId (same kind and content: the same answer).
create function private.site_domain_replay(p_business_id uuid, p_request_id uuid, p_kind text, p_payload jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_request private.site_domain_requests;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'requestId';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_domain:' || p_business_id::text, 0));
  select * into v_request from private.site_domain_requests r
  where r.business_id = p_business_id and r.request_id = p_request_id;
  if found then
    if v_request.kind <> p_kind or v_request.fingerprint <> pg_catalog.md5(p_payload::text) then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    return v_request.response;
  end if;
  return null;
end;
$$;

create function private.site_domain_record(
  p_business_id uuid, p_request_id uuid, p_kind text, p_payload jsonb, p_response jsonb
)
returns jsonb
language sql
set search_path = ''
as $$
  insert into private.site_domain_requests (business_id, request_id, kind, fingerprint, response)
  values (p_business_id, p_request_id, p_kind, pg_catalog.md5(p_payload::text), p_response)
  returning response;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.site_domain_dto(private.site_domains, text, text)',
    'private.site_domain_owner(uuid)',
    'private.site_domain_new_challenge()',
    'private.site_domain_replay(uuid, uuid, text, jsonb)',
    'private.site_domain_record(uuid, uuid, text, jsonb, jsonb)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The owner's side (the server passes the CNAME target and her usual
-- address, from its configuration)
-- ---------------------------------------------------------------------------

create function public.site_domain_read(p_business_id uuid, p_target text, p_fallback text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_domain private.site_domains;
begin
  perform private.site_domain_owner(p_business_id);
  select * into v_domain from private.site_domains d
  where d.business_id = p_business_id and d.state <> 'detached';
  return private.site_domain_dto(v_domain, p_target, p_fallback);
end;
$$;

-- A new challenge for `p_hostname` (normalised by the server). domain_taken
-- when another business holds it (without saying which); her current
-- domain, if any, is replaced (detached).
create function public.site_domain_request(
  p_business_id uuid,
  p_hostname text,
  p_request_id uuid,
  p_target text,
  p_fallback text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := pg_catalog.jsonb_build_object('hostname', p_hostname);
  v_replay jsonb;
  v_domain private.site_domains;
begin
  perform private.site_domain_owner(p_business_id);
  v_replay := private.site_domain_replay(p_business_id, p_request_id, 'request', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  if p_hostname is null or p_hostname !~ '^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,63}$'
     or pg_catalog.char_length(p_hostname) > 253 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'hostname';
  end if;
  -- Serialised per name: two businesses asking at once, one wins.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_domain_host:' || p_hostname, 0));
  if exists (
    select 1 from private.site_domains d
    where d.hostname = p_hostname and d.state in ('provisioning_tls', 'active')
      and d.business_id <> p_business_id
  ) then
    raise exception using errcode = 'P0001', message = 'domain_taken';
  end if;
  update private.site_domains d set state = 'detached', updated_at = pg_catalog.now()
  where d.business_id = p_business_id and d.state <> 'detached';
  insert into private.site_domains (business_id, hostname, state, challenge, proof_expires_at)
  values (p_business_id, p_hostname, 'awaiting_dns', private.site_domain_new_challenge(),
          pg_catalog.now() + interval '7 days')
  returning * into v_domain;
  return private.site_domain_record(
    p_business_id, p_request_id, 'request', v_payload,
    private.site_domain_dto(v_domain, p_target, p_fallback)
  );
end;
$$;

-- Before a check: her domain at this generation; an expired proof gets a
-- new challenge (generation n + 1; answers {proofExpired: true}, and the
-- server answers proof_expired for the screen to show the new value).
-- domain_generation_changed for an older generation.
create function public.site_domain_begin_check(
  p_business_id uuid,
  p_domain_id uuid,
  p_expected_generation integer,
  p_target text,
  p_fallback text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain private.site_domains;
begin
  perform private.site_domain_owner(p_business_id);
  select * into v_domain from private.site_domains d
  where d.id = p_domain_id and d.business_id = p_business_id and d.state <> 'detached'
  for update;
  if v_domain.id is null then
    raise exception using errcode = 'P0002', message = 'domain_unavailable';
  end if;
  if v_domain.generation is distinct from p_expected_generation then
    raise exception using errcode = 'P0001', message = 'domain_generation_changed';
  end if;
  -- A check every 30 seconds at most (the server reads DNS and probes).
  if v_domain.checked_at > pg_catalog.now() - interval '30 seconds' then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;
  if v_domain.state in ('awaiting_dns', 'error') and v_domain.proof_expires_at <= pg_catalog.now() then
    update private.site_domains d
    set generation = d.generation + 1, challenge = private.site_domain_new_challenge(),
        proof_expires_at = pg_catalog.now() + interval '7 days', state = 'awaiting_dns',
        reason = null, updated_at = pg_catalog.now()
    where d.id = v_domain.id;
    -- Answered, not raised: the new challenge must stay.
    return pg_catalog.jsonb_build_object('proofExpired', true);
  end if;
  return pg_catalog.jsonb_build_object(
    'id', v_domain.id, 'hostname', v_domain.hostname, 'generation', v_domain.generation,
    'state', v_domain.state, 'challenge', v_domain.challenge
  );
end;
$$;

-- The verifier's report for one generation (the service only):
--   dns_ok (TXT proof and CNAME target seen) → provisioning_tls;
--   https_ok (our probe answered over HTTPS on the name) → active;
--   failure (reason) → error, or dns_lost for an active one.
-- Answers the domain, or 'stale' for another generation.
create function public.site_domain_report(
  p_domain_id uuid,
  p_generation integer,
  p_outcome text,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain private.site_domains;
begin
  if p_outcome is null or p_outcome not in ('dns_ok', 'https_ok', 'failure') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'outcome';
  end if;
  select * into v_domain from private.site_domains d where d.id = p_domain_id;
  if v_domain.id is null then
    return 'stale';
  end if;
  -- The name's lock first (as a request), then the row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_domain_host:' || v_domain.hostname, 0));
  select * into v_domain from private.site_domains d where d.id = p_domain_id for update;
  if v_domain.state = 'detached' or v_domain.generation <> p_generation then
    return 'stale';
  end if;
  if p_outcome = 'dns_ok' and v_domain.state in ('awaiting_dns', 'error') then
    -- An expired proof proves nothing; another business verified first wins.
    if v_domain.proof_expires_at <= pg_catalog.now() or exists (
      select 1 from private.site_domains d
      where d.hostname = v_domain.hostname and d.id <> v_domain.id
        and d.state in ('provisioning_tls', 'active')
    ) then
      return 'stale';
    end if;
    -- The other pending requests for this name lose it.
    update private.site_domains d set state = 'detached', updated_at = pg_catalog.now()
    where d.hostname = v_domain.hostname and d.id <> v_domain.id
      and d.state in ('awaiting_dns', 'error');
    update private.site_domains d
    set state = 'provisioning_tls', reason = null, verified_at = pg_catalog.now(),
        checked_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where d.id = v_domain.id;
  elsif p_outcome = 'https_ok' and v_domain.state in ('provisioning_tls', 'active') then
    update private.site_domains d
    set state = 'active', reason = null, activated_at = coalesce(d.activated_at, pg_catalog.now()),
        checked_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where d.id = v_domain.id;
  elsif p_outcome = 'failure' then
    if p_reason is null or p_reason not in ('proof_missing', 'proof_mismatch', 'target_mismatch', 'tls_failed', 'dns_lost') then
      raise exception using errcode = '22023', message = 'invalid_input', hint = 'reason';
    end if;
    update private.site_domains d
    set state = 'error', reason = p_reason, checked_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where d.id = v_domain.id;
  else
    update private.site_domains d set checked_at = pg_catalog.now() where d.id = v_domain.id;
  end if;
  return 'ok';
end;
$$;

create function public.site_domain_detach(
  p_business_id uuid,
  p_domain_id uuid,
  p_expected_generation integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'id', p_domain_id, 'expectedGeneration', p_expected_generation);
  v_replay jsonb;
  v_domain private.site_domains;
begin
  perform private.site_domain_owner(p_business_id);
  v_replay := private.site_domain_replay(p_business_id, p_request_id, 'detach', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_domain from private.site_domains d
  where d.id = p_domain_id and d.business_id = p_business_id and d.state <> 'detached'
  for update;
  if v_domain.id is null then
    raise exception using errcode = 'P0002', message = 'domain_unavailable';
  end if;
  if v_domain.generation is distinct from p_expected_generation then
    raise exception using errcode = 'P0001', message = 'domain_generation_changed';
  end if;
  update private.site_domains d set state = 'detached', updated_at = pg_catalog.now()
  where d.id = v_domain.id;
  return private.site_domain_record(p_business_id, p_request_id, 'detach', v_payload, 'null'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Routing and certificates (the service only)
-- ---------------------------------------------------------------------------

-- May a certificate be issued for this name? Only once its proof was seen
-- (the certificate server asks before issuing).
create function public.site_domain_tls_allowed(p_hostname text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.site_domains d
    where d.hostname = pg_catalog.lower(p_hostname) and d.state in ('provisioning_tls', 'active')
  );
$$;

-- What a request on this name serves: the business's public page slug, and
-- the domain (for the probe). Only a name whose proof was seen.
create function public.site_domain_route(p_hostname text)
returns table (domain_id uuid, generation integer, slug text, state text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.generation, b.slug::text, d.state
  from private.site_domains d
  join public.businesses b on b.id = d.business_id
  where d.hostname = pg_catalog.lower(p_hostname) and d.state in ('provisioning_tls', 'active');
$$;

-- Domains to check again (the clock): pending ones with a valid proof,
-- those waiting for their certificate, and active ones (lost DNS).
create function public.site_domains_due(p_limit integer)
returns table (domain_id uuid, hostname text, generation integer, state text, challenge text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.hostname, d.generation, d.state, d.challenge
  from private.site_domains d
  where (d.state = 'awaiting_dns' and d.proof_expires_at > pg_catalog.now())
     or d.state in ('provisioning_tls', 'active')
  order by d.checked_at nulls first, d.id
  limit least(greatest(p_limit, 1), 100);
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.site_domain_read(uuid, text, text)',
    'public.site_domain_request(uuid, text, uuid, text, text)',
    'public.site_domain_begin_check(uuid, uuid, integer, text, text)',
    'public.site_domain_detach(uuid, uuid, integer, uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.site_domain_report(uuid, integer, text, text)',
    'public.site_domain_tls_allowed(text)',
    'public.site_domain_route(text)',
    'public.site_domains_due(integer)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
