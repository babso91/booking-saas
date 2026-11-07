-- Private beta by invitation (docs/BETA_ACCESS.md).
--
-- Anyone may still create an Auth account (Supabase Auth's sign-up is
-- public), but only an account with beta access can create a business:
-- the gate is on the business itself (a trigger on public.businesses), so
-- no path (the onboarding action, a direct call to complete_onboarding, a
-- future one) goes around it. Access comes from an invitation accepted for
-- the account's address, or from having an account before this migration.
--
-- An invitation is created by the service only (an operator's command, never
-- a public endpoint), for one address, with an expiry. Only the SHA-256 of
-- its token is stored: the link cannot be rebuilt from the database.

-- ---------------------------------------------------------------------------
-- Invitations and access
-- ---------------------------------------------------------------------------

create table private.beta_invitations (
  id uuid primary key default gen_random_uuid(),
  -- Lowercase and trimmed: the address it is for, and only that one.
  email text not null check (
    email = pg_catalog.lower(pg_catalog.btrim(email))
    and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and pg_catalog.char_length(email) <= 254
  ),
  -- SHA-256 of the token, hex. Never the token.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.now(),
  -- Who issued it, for the operator's own records (free text, no PII).
  note text check (note is null or pg_catalog.char_length(note) <= 200),
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (expires_at > created_at),
  -- accepted_by is cleared if that account is deleted; accepted_at stays.
  check (accepted_by is null or accepted_at is not null)
);

create index beta_invitations_email_idx on private.beta_invitations (email);

-- At most one invitation pending per address: re-issuing revokes the
-- previous one first (create_beta_invitation, under the address's lock).
create unique index beta_invitations_one_pending_idx
  on private.beta_invitations (email)
  where accepted_at is null and revoked_at is null;

-- The accounts allowed to create a business.
create table private.beta_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  source text not null check (source in ('invitation', 'existing')),
  invitation_id uuid references private.beta_invitations (id) on delete set null,
  granted_at timestamptz not null default pg_catalog.now(),
  -- The session in which she proved who she is when it was granted (her
  -- password at sign-in, her mailbox through a recovery link), if any.
  proof_session_id uuid
);

-- Every account that exists now keeps what it could do: create its business
-- (or keep the one it has).
insert into private.beta_access (user_id, source)
select u.id, 'existing' from auth.users u
on conflict (user_id) do nothing;

revoke all on table private.beta_invitations from public, anon, authenticated;
revoke all on table private.beta_access from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The gate
-- ---------------------------------------------------------------------------

-- The session of the request's JWT (its `session_id` claim), if any.
create function private.jwt_session_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when auth.jwt() ->> 'session_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (auth.jwt() ->> 'session_id')::uuid
  end;
$$;

revoke all on function private.jwt_session_id() from public;

-- Access counts only once the account's address is confirmed: proof that
-- whoever uses it holds the invited mailbox.
--
-- With `p_check_session` (a request made with her JWT), an access given by
-- an invitation also needs the JWT's session to be one Auth still holds
-- (a signed-out or revoked session's access token stays cryptographically
-- valid until it expires) and to be the session that proved who she is, or
-- one opened after the access was given. A session opened before, by
-- whoever knew the account then, never uses it, even if its revocation
-- failed. Not checked for the service acting for her (no JWT) nor for the
-- accounts that existed before the beta.
create function private.has_beta_access(p_user_id uuid, p_check_session boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.beta_access a
    join auth.users u on u.id = a.user_id
    where a.user_id = p_user_id and u.email_confirmed_at is not null
      and (
        not p_check_session
        or a.source = 'existing'
        or exists (
          select 1 from auth.sessions s
          where s.id = private.jwt_session_id()
            and s.user_id = p_user_id
            and (s.id = a.proof_session_id or s.created_at >= a.granted_at)
        )
      )
  );
$$;

revoke all on function private.has_beta_access(uuid, boolean) from public;

-- A business created through the API requires beta access for the user it
-- is created for: the signed-in user (auth.uid(), complete_onboarding or
-- anything running with her JWT), or, for the service acting for someone
-- (auth.uid() null), the user it names as its creator. Created through the
-- API for nobody: refused. Only the database owner's own SQL (migrations,
-- an operator's explicit administration) is not concerned.
create function private.businesses_require_beta_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_api boolean := pg_catalog.current_setting('role', true) in ('anon', 'authenticated', 'service_role')
    or session_user::text in ('anon', 'authenticated', 'service_role', 'authenticator');
  v_user uuid := coalesce(auth.uid(), case when v_api then new.created_by end);
begin
  -- Her session is checked when the request carries her JWT (auth.uid()).
  if v_api and (v_user is null or not private.has_beta_access(v_user, auth.uid() is not null)) then
    raise exception using errcode = 'P0001', message = 'beta_invitation_required';
  end if;
  if not v_api and auth.uid() is not null and not private.has_beta_access(auth.uid(), true) then
    raise exception using errcode = 'P0001', message = 'beta_invitation_required';
  end if;
  return new;
end;
$$;

create trigger businesses_require_beta_access
  before insert on public.businesses
  for each row execute function private.businesses_require_beta_access();

-- For her session: may she create her business? (the onboarding page tells
-- her before she fills it in).
create function public.my_beta_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and private.has_beta_access(auth.uid(), true);
$$;

revoke all on function public.my_beta_access() from public, anon;
grant execute on function public.my_beta_access() to authenticated;

-- ---------------------------------------------------------------------------
-- Invitations (the service only)
-- ---------------------------------------------------------------------------

-- A new invitation for `p_email`, valid until `p_expires_at` (30 days at
-- most). The address's earlier invitations still pending are revoked: only
-- the newest link works.
create function public.create_beta_invitation(
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_id uuid;
begin
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or pg_catalog.char_length(v_email) > 254 then
    raise exception using errcode = '22023', message = 'invalid_email', hint = 'email';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'token';
  end if;
  if p_expires_at is null
    or p_expires_at <= pg_catalog.now()
    or p_expires_at > pg_catalog.now() + interval '30 days' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expiresAt';
  end if;

  -- Two issues for the same address at once are serialised: the later one
  -- revokes the earlier, committed one.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('beta_invitation:' || v_email, 0)
  );
  update private.beta_invitations i
  set revoked_at = pg_catalog.now()
  where i.email = v_email and i.accepted_at is null and i.revoked_at is null;

  insert into private.beta_invitations (email, token_hash, expires_at, note)
  values (v_email, p_token_hash, p_expires_at, nullif(pg_catalog.btrim(p_note), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- Revokes an invitation not yet accepted (a mistaken address).
create function public.revoke_beta_invitation(p_invitation_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.beta_invitations i
  set revoked_at = coalesce(i.revoked_at, pg_catalog.now())
  where i.id = p_invitation_id and i.accepted_at is null;
$$;

-- What the invitation of `p_token_hash` allows for `p_email`:
--   valid           it can be used (or, accepted by this address's account
--                   before it created its business, used again: a retry);
--   invalid         unknown or revoked;
--   email_mismatch  it is for another address (which is not revealed);
--   used            already accepted, and that account has its business (or
--                   another account took it);
--   expired         not accepted in time.
create function private.beta_invitation_state(p_token_hash text, p_email text, p_lock boolean)
returns table (state text, invitation_id uuid, email text)
language plpgsql
set search_path = ''
as $$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_invitation private.beta_invitations%rowtype;
  v_account uuid;
begin
  if p_lock then
    select * into v_invitation from private.beta_invitations i
    where i.token_hash = p_token_hash
    for update;
  else
    select * into v_invitation from private.beta_invitations i
    where i.token_hash = p_token_hash;
  end if;

  if not found or v_invitation.revoked_at is not null then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  if v_invitation.email <> v_email then
    return query select 'email_mismatch'::text, null::uuid, null::text;
    return;
  end if;
  if v_invitation.accepted_at is not null then
    select u.id into v_account from auth.users u
    where pg_catalog.lower(u.email) = v_invitation.email;
    if v_invitation.accepted_by is distinct from v_account
      or exists (
        select 1 from public.business_members m where m.user_id = v_invitation.accepted_by
      ) then
      return query select 'used'::text, v_invitation.id, v_invitation.email;
      return;
    end if;
    return query select 'valid'::text, v_invitation.id, v_invitation.email;
    return;
  end if;
  if v_invitation.expires_at <= pg_catalog.now() then
    return query select 'expired'::text, v_invitation.id, v_invitation.email;
    return;
  end if;
  return query select 'valid'::text, v_invitation.id, v_invitation.email;
end;
$$;

revoke all on function private.beta_invitation_state(text, text, boolean) from public;

-- Before creating her account: may this invitation be used for this address?
create function public.check_beta_invitation(p_token_hash text, p_email text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.state from private.beta_invitation_state(p_token_hash, p_email, false) s;
$$;

-- The account of the invited address, for the server to make it safe before
-- accepting: 'none', 'unconfirmed' (its password may be a third party's:
-- anyone can create an unconfirmed account for any address, and Auth keeps
-- the first password on a repeated sign-up) or 'confirmed'. Only for a valid
-- invitation of that address; otherwise the invitation's state.
create function public.beta_invited_account(p_token_hash text, p_email text)
returns table (state text, user_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_email text;
  v_user auth.users%rowtype;
begin
  select s.state, s.email into v_state, v_email
  from private.beta_invitation_state(p_token_hash, p_email, false) s;
  if v_state <> 'valid' then
    return query select v_state, null::uuid;
    return;
  end if;
  select * into v_user from auth.users u where pg_catalog.lower(u.email) = v_email;
  if not found then
    return query select 'none'::text, null::uuid;
  elsif v_user.email_confirmed_at is null then
    return query select 'unconfirmed'::text, v_user.id;
  else
    return query select 'confirmed'::text, v_user.id;
  end if;
end;
$$;

-- Accepts the invitation for `p_user_id`, which must be the account of the
-- invited address. The caller has first proven that account is hers: just
-- created by the server with her password (sign-up, no session yet), her
-- password proven on a confirmed account (sign-in), or her mailbox proven
-- through a recovery link and her own password set (an account made before
-- her invitation). `p_proof_session` is the session of that proof, which
-- must be the account's: only it, and sessions opened afterwards, use the
-- access (has_beta_access); the caller has ended every other session. An
-- unconfirmed account loses every session it may have. Under the
-- invitation's row lock: accepted once; again for the same account, the
-- same answer (a retry, which renews the proof). The access counts once the
-- address is confirmed. Answers 'accepted' or the invitation's state
-- ('account_mismatch' for another account or another account's session).
create function public.accept_beta_invitation(
  p_token_hash text,
  p_email text,
  p_user_id uuid,
  p_proof_session uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_invitation_id uuid;
  v_email text;
  v_user auth.users%rowtype;
begin
  select s.state, s.invitation_id, s.email into v_state, v_invitation_id, v_email
  from private.beta_invitation_state(p_token_hash, p_email, true) s;
  if v_state <> 'valid' then
    return v_state;
  end if;

  select * into v_user from auth.users u where pg_catalog.lower(u.email) = v_email;
  if not found or v_user.id is distinct from p_user_id then
    return 'account_mismatch';
  end if;
  if p_proof_session is not null and not exists (
    select 1 from auth.sessions s where s.id = p_proof_session and s.user_id = v_user.id
  ) then
    return 'account_mismatch';
  end if;

  if v_user.email_confirmed_at is null then
    delete from auth.sessions s where s.user_id = v_user.id;
    delete from auth.refresh_tokens t where t.user_id = v_user.id::text;
  end if;

  update private.beta_invitations i
  set accepted_at = coalesce(i.accepted_at, pg_catalog.now()),
      accepted_by = v_user.id
  where i.id = v_invitation_id;

  insert into private.beta_access (user_id, source, invitation_id, proof_session_id)
  values (v_user.id, 'invitation', v_invitation_id, p_proof_session)
  on conflict (user_id) do update
    set invitation_id = excluded.invitation_id,
        proof_session_id = excluded.proof_session_id,
        granted_at = pg_catalog.now()
    where private.beta_access.source = 'invitation';
  return 'accepted';
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.create_beta_invitation(text, text, timestamptz, text)',
    'public.revoke_beta_invitation(uuid)',
    'public.check_beta_invitation(text, text)',
    'public.beta_invited_account(text, text)',
    'public.accept_beta_invitation(text, text, uuid, uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Every professional permission follows the same session rule (Codex
-- re-audit)
-- ---------------------------------------------------------------------------
--
-- has_beta_access binds an invitation's access to the session that proved
-- who she is. The business it lets her create is then reached through the
-- common permission primitives (every RLS policy goes through
-- is_business_member or has_business_role; the RPCs through those, or
-- through assert_agenda_access and member_preferences_membership): without
-- the same rule there, an earlier session's token (revoked, or kept) would
-- read and change the business once it exists. So each primitive also
-- requires the request's session to be trusted for its user.

-- The request's JWT may act for its user: always for an account whose
-- access did not come from an invitation (accounts of before the beta, and
-- no user at all: the service); for one whose access came from an
-- invitation, only with a session that has_beta_access accepts (still held
-- by Auth, and the proving session or one opened after it).
--
-- RLS calls it for every row: the answer is kept for the rest of the
-- transaction (one request), keyed by user and session, in a
-- transaction-local setting. Setting it by hand needs raw SQL, which could
-- just as well rewrite request.jwt.claims itself: it opens no new way in.
-- Measured: 5,000 rows read under RLS in 95 ms (66 ms without the rule,
-- 1.8 s without the memo).
create function private.request_session_trusted()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_trusted boolean;
begin
  if v_user is null then
    return true;
  end if;
  v_key := v_user::text || '/' || coalesce(
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'session_id', ''
  );
  if pg_catalog.current_setting('private.trusted_session', true) = v_key || '=t' then
    return true;
  end if;
  if pg_catalog.current_setting('private.trusted_session', true) = v_key || '=f' then
    return false;
  end if;
  v_trusted := not exists (
      select 1 from private.beta_access a
      where a.user_id = v_user and a.source = 'invitation'
    )
    or private.has_beta_access(v_user, true);
  perform pg_catalog.set_config(
    'private.trusted_session', v_key || case when v_trusted then '=t' else '=f' end, true
  );
  return v_trusted;
end;
$$;

revoke all on function private.request_session_trusted() from public;

create or replace function public.is_business_member(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members
    where business_id = target_business_id
      and user_id = (select auth.uid())
  ) and private.request_session_trusted();
$$;

create or replace function public.has_business_role(
  target_business_id uuid,
  accepted_roles public.business_member_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members
    where business_id = target_business_id
      and user_id = (select auth.uid())
      and role = any (accepted_roles)
  ) and private.request_session_trusted();
$$;

create or replace function private.assert_agenda_access(p_business_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;

  if p_business_id is null or not exists (
    select 1
    from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = (select auth.uid())
  ) or not private.request_session_trusted() then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

create or replace function private.member_preferences_membership(p_business_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  select m.id into v_membership
  from public.business_members m
  where m.business_id = p_business_id and m.user_id = auth.uid();
  if v_membership is null or not private.request_session_trusted() then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return v_membership;
end;
$$;
