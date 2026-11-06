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

-- The accounts allowed to create a business.
create table private.beta_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  source text not null check (source in ('invitation', 'existing')),
  invitation_id uuid references private.beta_invitations (id) on delete set null,
  granted_at timestamptz not null default pg_catalog.now()
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

create function private.has_beta_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.beta_access a where a.user_id = p_user_id);
$$;

revoke all on function private.has_beta_access(uuid) from public;

-- A business created on behalf of a signed-in user (complete_onboarding, or
-- anything else running with her JWT) requires her beta access. The service
-- and the database owner (no user in the request) are not concerned.
create function private.businesses_require_beta_access()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is not null and not private.has_beta_access(v_user) then
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
  select auth.uid() is not null and private.has_beta_access(auth.uid());
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

-- Once her account exists: the invitation is accepted for THE account of
-- the invited address (looked up here, never taken from the caller), which
-- gets beta access. Under the invitation's row lock: two attempts at once
-- accept it once. Accepting again for the same account is answered the same
-- (a retry after an interruption). Answers the state, 'accepted' on success.
create function public.accept_beta_invitation(p_token_hash text, p_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_invitation_id uuid;
  v_email text;
  v_account uuid;
begin
  select s.state, s.invitation_id, s.email into v_state, v_invitation_id, v_email
  from private.beta_invitation_state(p_token_hash, p_email, true) s;
  if v_state <> 'valid' then
    return v_state;
  end if;

  select u.id into v_account from auth.users u where pg_catalog.lower(u.email) = v_email;
  if v_account is null then
    -- Her account does not exist (yet): nothing accepted.
    return 'account_missing';
  end if;

  update private.beta_invitations i
  set accepted_at = coalesce(i.accepted_at, pg_catalog.now()),
      accepted_by = v_account
  where i.id = v_invitation_id;

  insert into private.beta_access (user_id, source, invitation_id)
  values (v_account, 'invitation', v_invitation_id)
  on conflict (user_id) do nothing;
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
    'public.accept_beta_invitation(text, text)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
