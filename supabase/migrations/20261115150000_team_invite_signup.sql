-- Team, lot 2: the invitation email and joining with or without an account
-- (docs/TEAM_CONTRACT.md, « Rejoindre l'équipe »).
--
-- The same rule as the private beta (20261107090000_beta_invitations.sql):
-- an invitation is never proof that an account is hers. It is accepted for
-- an account whose password she just chose (sign-up through the
-- invitation), whose password she proved in this session (sign-in), or
-- whose mailbox she proved through a recovery link and whose password she
-- then set. The access is bound to the session of that proof, or to a
-- session opened afterwards: a session opened before, by whoever knew the
-- account then, never reaches the business (request_session_trusted).

alter table private.team_invitations
  -- The account the server created with her password, through this
  -- invitation (sign-up): her first session after confirming her address
  -- may accept it without proving her password again.
  add column signup_user_id uuid references auth.users (id) on delete set null,
  -- The session in which it was accepted.
  add column accepted_session_id uuid;

create index team_invitations_accepted_by_idx
  on private.team_invitations (accepted_by, accepted_at desc)
  where status = 'accepted';

-- ---------------------------------------------------------------------------
-- State of an invitation for an address
-- ---------------------------------------------------------------------------

-- 'valid', 'email_mismatch', or 'invalid' (unknown, replaced, revoked,
-- expired or used: one answer, as accept_team_invitation gives). With
-- `p_lock`, the invitation's row is locked (under the business schedule
-- lock first, the order of every team write).
create function private.team_invitation_state(p_token_hash text, p_email text, p_lock boolean)
returns table (state text, invitation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite private.team_invitations;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  select * into v_invite from private.team_invitations i where i.token_hash = p_token_hash;
  if not found then
    return query select 'invalid'::text, null::uuid;
    return;
  end if;
  if p_lock then
    perform private.lock_business_schedule(v_invite.business_id);
    select * into v_invite from private.team_invitations i where i.id = v_invite.id for update;
  end if;
  if v_invite.status <> 'pending' or v_invite.expires_at <= pg_catalog.now() then
    return query select 'invalid'::text, v_invite.id;
  elsif pg_catalog.lower(v_invite.email::text) <> pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, ''))) then
    return query select 'email_mismatch'::text, v_invite.id;
  else
    return query select 'valid'::text, v_invite.id;
  end if;
end;
$$;

revoke all on function private.team_invitation_state(text, text, boolean) from public;

-- Before signing up or in through a team invitation: its state for the
-- address and, when valid, the account of that address ('none',
-- 'unconfirmed' or 'confirmed').
create function public.team_invited_account(p_token_hash text, p_email text)
returns table (state text, user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_user auth.users%rowtype;
begin
  select s.state into v_state from private.team_invitation_state(p_token_hash, p_email, false) s;
  if v_state <> 'valid' then
    return query select v_state, null::uuid;
    return;
  end if;
  select * into v_user from auth.users u
  where pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
    and not u.is_sso_user;
  if not found then
    return query select 'none'::text, null::uuid;
  elsif v_user.email_confirmed_at is null then
    return query select 'unconfirmed'::text, v_user.id;
  else
    return query select 'confirmed'::text, v_user.id;
  end if;
end;
$$;

-- The server just created `p_user_id` with her password for this
-- invitation (no session exists yet). Answers the invitation's state, or
-- 'account_mismatch' when that account is not the invited address's.
create function public.record_team_invitation_signup(
  p_token_hash text,
  p_email text,
  p_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_invitation_id uuid;
begin
  select s.state, s.invitation_id into v_state, v_invitation_id
  from private.team_invitation_state(p_token_hash, p_email, true) s;
  if v_state <> 'valid' then
    return v_state;
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = p_user_id and not u.is_sso_user
      and pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
  ) then
    return 'account_mismatch';
  end if;
  update private.team_invitations i set signup_user_id = p_user_id where i.id = v_invitation_id;
  return 'valid';
end;
$$;

-- ---------------------------------------------------------------------------
-- Acceptance
-- ---------------------------------------------------------------------------

-- Joins `p_user_id` to the business of the locked, valid invitation, on its
-- profile, bound to `p_session`. The caller has checked the address and the
-- proof.
create function private.team_accept(p_invitation_id uuid, p_user_id uuid, p_session uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite private.team_invitations;
begin
  select * into v_invite from private.team_invitations i where i.id = p_invitation_id;

  -- One business per account in this version, checked under the account's
  -- own lock: two invitations of two businesses (each under its own
  -- schedule lock) accepted at once never both pass.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('team_accept:' || p_user_id::text, 0)
  );
  if exists (select 1 from public.business_members bm where bm.user_id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'already_member';
  end if;

  update public.staff_members s
  set user_id = p_user_id, revision = s.revision + 1
  where s.id = v_invite.staff_id and s.user_id is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'invitation_invalid';
  end if;

  insert into public.business_members (business_id, user_id, role)
  values (v_invite.business_id, p_user_id, v_invite.role::public.business_member_role);

  update private.team_invitations i
  set status = 'accepted', accepted_at = pg_catalog.now(), accepted_by = p_user_id,
      accepted_session_id = p_session
  where i.id = v_invite.id;

  return v_invite.business_id;
end;
$$;

revoke all on function private.team_accept(uuid, uuid, uuid) from public;

-- The invited person, signed in with the invited address (confirmed). Her
-- session must prove the account is hers: signed in with her password, or
-- the first sessions of the account the server created with her password
-- through this invitation. Any other session (a recovery link, a magic
-- link) answers invitation_password_required: she sets her password first
-- (accept_team_invitation_for). The caller has ended her other sessions.
-- Unknown, used, revoked or expired tokens all answer invitation_invalid.
create or replace function public.accept_team_invitation(p_token_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session uuid := private.jwt_session_id();
  v_email text;
  v_confirmed timestamptz;
  v_state text;
  v_invitation_id uuid;
  v_signup_user uuid;
begin
  -- A session Auth still holds (a signed-out session's token stays valid
  -- until it expires).
  if v_user is null or v_session is null or not exists (
    select 1 from auth.sessions s where s.id = v_session and s.user_id = v_user
  ) then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  -- Same session rule as every professional door (is_business_member).
  if not private.request_session_trusted() then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  select u.email, u.email_confirmed_at into v_email, v_confirmed
  from auth.users u where u.id = v_user;

  select s.state, s.invitation_id into v_state, v_invitation_id
  from private.team_invitation_state(p_token_hash, v_email, true) s;
  if v_state = 'email_mismatch' or (v_state = 'valid' and v_confirmed is null) then
    raise exception using errcode = 'P0001', message = 'invitation_email_mismatch';
  elsif v_state <> 'valid' then
    raise exception using errcode = 'P0001', message = 'invitation_invalid';
  end if;

  select i.signup_user_id into v_signup_user from private.team_invitations i where i.id = v_invitation_id;
  if v_signup_user is distinct from v_user
     and not coalesce(auth.jwt() -> 'amr' @> '[{"method": "password"}]'::jsonb, false) then
    raise exception using errcode = 'P0001', message = 'invitation_password_required';
  end if;

  return private.team_accept(v_invitation_id, v_user, v_session);
end;
$$;

-- For the server, once she proved her mailbox through a recovery link and
-- set her own password in `p_proof_session` (an account made before her
-- invitation, maybe by someone else): the caller has ended every other
-- session. Same refusals as accept_team_invitation; 'account_mismatch'
-- (invitation_invalid) if the account or the session is not the invited
-- address's.
create function public.accept_team_invitation_for(
  p_token_hash text,
  p_email text,
  p_user_id uuid,
  p_proof_session uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_invitation_id uuid;
begin
  select s.state, s.invitation_id into v_state, v_invitation_id
  from private.team_invitation_state(p_token_hash, p_email, true) s;
  if v_state = 'email_mismatch' then
    raise exception using errcode = 'P0001', message = 'invitation_email_mismatch';
  elsif v_state <> 'valid' then
    raise exception using errcode = 'P0001', message = 'invitation_invalid';
  end if;
  if p_proof_session is null or not exists (
    select 1 from auth.users u
    join auth.sessions s on s.user_id = u.id and s.id = p_proof_session
    where u.id = p_user_id and u.email_confirmed_at is not null
      and pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
  ) then
    raise exception using errcode = 'P0001', message = 'invitation_invalid';
  end if;
  return private.team_accept(v_invitation_id, p_user_id, p_proof_session);
end;
$$;

-- ---------------------------------------------------------------------------
-- The invitation email
-- ---------------------------------------------------------------------------

-- What the invitation email says, for the pending invitation of this token
-- only: nothing for a replayed send_team_invitation (its new token was
-- discarded), so no email carries a link that does not work.
create function public.team_invitation_email(p_token_hash text)
returns table (email text, business_name text, inviter_name text, role text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.email::text, b.name,
    nullif(pg_catalog.btrim(pg_catalog.concat_ws(' ', p.first_name, p.last_name)), ''),
    i.role, i.expires_at
  from private.team_invitations i
  join public.businesses b on b.id = i.business_id
  left join public.profiles p on p.id = i.created_by
  where i.token_hash = p_token_hash and i.status = 'pending' and i.expires_at > pg_catalog.now();
$$;

-- send_team_invitation replayed (same operationId, same author: checked by
-- team_begin) after its email could not leave: the invitation it recorded,
-- if still pending, takes the replay's new token, so the email sent now
-- carries a link that works (the previous one, maybe never delivered,
-- stops working). True if a token was replaced.
create function public.rotate_team_invitation_token(
  p_business_id uuid,
  p_operation_id uuid,
  p_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request private.team_requests;
  v_invitation_id uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  perform private.lock_business_schedule(p_business_id);
  select * into v_request from private.team_requests r
  where r.business_id = p_business_id and r.operation_id = p_operation_id and r.kind = 'invite';
  if not found then
    return false;
  end if;
  -- The invitation that request recorded (same transaction, same author).
  select i.id into v_invitation_id
  from private.team_invitations i
  where i.business_id = p_business_id
    and i.staff_id = (v_request.response ->> 'id')::uuid
    and i.created_at = v_request.created_at
    and i.created_by is not distinct from v_request.created_by
    and i.status = 'pending' and i.expires_at > pg_catalog.now()
  for update;
  if not found then
    return false;
  end if;
  update private.team_invitations i set token_hash = p_token_hash where i.id = v_invitation_id;
  return true;
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.rotate_team_invitation_token(uuid, uuid, text)',
    'public.team_invited_account(text, text)',
    'public.record_team_invitation_signup(text, text, uuid)',
    'public.accept_team_invitation_for(text, text, uuid, uuid)',
    'public.team_invitation_email(text)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The session rule
-- ---------------------------------------------------------------------------

-- As before for the beta's access; and for an account that joined a team by
-- invitation, only the session it was accepted in, or one opened after it,
-- still held by Auth. Memoised per transaction as before.
create or replace function private.request_session_trusted()
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
  v_accepted_at timestamptz;
  v_accepted_session uuid;
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
  if v_trusted then
    select i.accepted_at, i.accepted_session_id into v_accepted_at, v_accepted_session
    from private.team_invitations i
    where i.accepted_by = v_user and i.status = 'accepted'
    order by i.accepted_at desc
    limit 1;
    if found then
      v_trusted := exists (
        select 1 from auth.sessions s
        where s.id = private.jwt_session_id()
          and s.user_id = v_user
          and (s.id = v_accepted_session or s.created_at >= v_accepted_at)
      );
    end if;
  end if;
  perform pg_catalog.set_config(
    'private.trusted_session', v_key || case when v_trusted then '=t' else '=f' end, true
  );
  return v_trusted;
end;
$$;

revoke all on function private.request_session_trusted() from public;
