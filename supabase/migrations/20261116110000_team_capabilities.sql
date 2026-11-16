-- Team, lot 3: capabilities. The practitioner role opens
-- (docs/TEAM_CONTRACT.md, « Rôle praticienne »).
--
-- Deny by default: public.is_business_member, the predicate of every RLS
-- policy and of most gates, now means a member with full access (owner or
-- admin). No practitioner existed before this migration, so owners and
-- admins see exactly what they saw; a practitioner sees nothing through any
-- of them. She is then given narrow, explicit rights only:
--   * her business, its settings, hours and exceptions, its catalog (read);
--   * her membership row, the team's profiles (names), her preferences;
--   * her own appointments (staff_id = her profile; read), and her agenda
--     with each customer's name and contact (practitioner_agenda), never a
--     customer's private columns;
--   * the outcome of her own visits (completed, no-show, reopened), never a
--     cancellation nor any other agenda write.
-- Every gate that read business_members directly (agenda, site, calendar)
-- now requires owner or admin as well.

-- The role itself: 20261116105900_practitioner_role.sql (a new enum value
-- cannot be used in the transaction that adds it).

-- ---------------------------------------------------------------------------
-- The predicates
-- ---------------------------------------------------------------------------

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
      and role in ('owner', 'admin')
  ) and private.request_session_trusted();
$$;

-- The caller is a practitioner of the business (trusted session).
create function private.is_practitioner(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = (select auth.uid())
      and m.role = 'practitioner'
  ) and private.request_session_trusted();
$$;

-- Her bookable profile in the business, if she is a practitioner of it.
create function private.practitioner_staff(p_business_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.staff_members s
  where s.business_id = p_business_id
    and s.user_id = (select auth.uid())
    and private.is_practitioner(p_business_id);
$$;

-- Her practitioner profiles (one per business she practises in), computed
-- once per statement in a policy (an uncorrelated subselect).
create function private.my_practitioner_staff_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(s.id), '{}'::uuid[])
  from public.staff_members s
  join public.business_members m
    on m.business_id = s.business_id and m.user_id = s.user_id and m.role = 'practitioner'
  where s.user_id = (select auth.uid())
    and private.request_session_trusted();
$$;

revoke all on function private.my_practitioner_staff_ids() from public;
grant execute on function private.my_practitioner_staff_ids() to authenticated;
revoke all on function private.is_practitioner(uuid) from public;
revoke all on function private.practitioner_staff(uuid) from public;
grant execute on function private.is_practitioner(uuid) to authenticated;
grant execute on function private.practitioner_staff(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Gates that read the membership directly: owner or admin only
-- ---------------------------------------------------------------------------

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
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION private.assert_site_actor(p_business_id uuid, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if p_business_id is null or p_actor is null then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  perform 1 from public.business_members m
  where m.business_id = p_business_id and m.user_id = p_actor
    and m.role in ('owner', 'admin')
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.calendar_save_connection(p_business_id uuid, p_user_id uuid, p_provider text, p_provider_account_id text, p_account_email text, p_scopes text[], p_refresh_token_ciphertext text, p_access_token_ciphertext text, p_access_token_expires_at timestamp with time zone, p_calendars jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing public.calendar_connections;
  v_id uuid;
  v_same_account boolean;
  v_generation uuid := gen_random_uuid();
begin
  if not exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_provider is distinct from 'google' or p_provider_account_id is null then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  -- 1. schedule lock, 2. connection row.
  perform private.lock_business_schedule(p_business_id);

  select c.* into v_existing
  from public.calendar_connections c
  where c.business_id = p_business_id and c.provider = p_provider
  for update;

  -- The revocation of the previous credentials may still be running at
  -- the provider: a grant obtained meanwhile could be revoked with it.
  if v_existing.revocation_pending_until > pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'calendar_disconnect_in_progress';
  end if;

  v_same_account := v_existing.id is not null
    and v_existing.status <> 'disconnected'
    and v_existing.provider_account_id = p_provider_account_id;

  if p_refresh_token_ciphertext is null and not (
    v_same_account and exists (
      select 1 from private.calendar_secrets s where s.connection_id = v_existing.id
    )
  ) then
    raise exception using errcode = 'P0001', message = 'calendar_refresh_token_missing';
  end if;

  if v_existing.id is null then
    insert into public.calendar_connections (
      business_id, provider, provider_account_id, account_email, status,
      scopes, connected_by, credential_generation
    )
    values (
      p_business_id, p_provider, p_provider_account_id, p_account_email,
      'active', coalesce(p_scopes, '{}'), p_user_id, v_generation
    )
    returning id into v_id;
  else
    v_id := v_existing.id;
    -- New incarnation: every operation started with the former
    -- credentials becomes a no-op.
    update public.calendar_connections c
    set provider_account_id = p_provider_account_id,
        account_email = p_account_email,
        status = 'active',
        scopes = coalesce(p_scopes, '{}'),
        connected_by = p_user_id,
        last_error = null,
        credential_generation = v_generation,
        revocation_pending_until = null,
        revocation_authorized_until = null
    where c.id = v_id;
  end if;

  -- 3. secrets, stamped with the new incarnation.
  if p_refresh_token_ciphertext is null then
    update private.calendar_secrets s
    set access_token_ciphertext = p_access_token_ciphertext,
        access_token_expires_at = p_access_token_expires_at,
        credential_generation = v_generation,
        secret_version = s.secret_version + 1,
        updated_at = pg_catalog.now()
    where s.connection_id = v_id;
  else
    insert into private.calendar_secrets (
      connection_id, refresh_token_ciphertext, access_token_ciphertext,
      access_token_expires_at, credential_generation
    )
    values (
      v_id, p_refresh_token_ciphertext, p_access_token_ciphertext,
      p_access_token_expires_at, v_generation
    )
    on conflict (connection_id) do update
    set refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        access_token_ciphertext = excluded.access_token_ciphertext,
        access_token_expires_at = excluded.access_token_expires_at,
        credential_generation = excluded.credential_generation,
        secret_version = private.calendar_secrets.secret_version + 1,
        updated_at = pg_catalog.now();
  end if;

  -- 4.–6. calendars, sync rows, events.
  if v_existing.id is not null and not v_same_account then
    delete from public.external_calendars c where c.connection_id = v_id;
  end if;

  perform private.save_calendars(v_id, p_business_id, p_calendars);

  update public.external_calendars c
  set sync_status = 'pending'
  where c.connection_id = v_id and c.selected_for_blocking;
  perform private.invalidate_sync(c.id)
  from public.external_calendars c
  where c.connection_id = v_id
  order by c.id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.calendar_add_write_authorization(p_business_id uuid, p_user_id uuid, p_provider_account_id text, p_scopes text[], p_refresh_token_ciphertext text, p_access_token_ciphertext text, p_access_token_expires_at timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_connection public.calendar_connections;
begin
  if not exists (
    select 1 from public.business_members m
    where m.business_id = p_business_id and m.user_id = p_user_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_provider_account_id is null or p_access_token_ciphertext is null
    or not private.has_write_scope(p_scopes) then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;

  -- 1. schedule lock, 2. connection row, 3. secrets.
  perform private.lock_business_schedule(p_business_id);

  select c.* into v_connection
  from public.calendar_connections c
  where c.business_id = p_business_id and c.provider = 'google'
  for update;

  if v_connection.id is null or v_connection.status <> 'active' then
    return 'not_connected';
  end if;
  if v_connection.provider_account_id <> p_provider_account_id then
    return 'account_mismatch';
  end if;

  update public.calendar_connections c
  set scopes = (
        select coalesce(pg_catalog.array_agg(distinct scope order by scope), '{}')
        from pg_catalog.unnest(c.scopes || p_scopes) scope
      ),
      last_error = null
  where c.id = v_connection.id;

  update private.calendar_secrets s
  set refresh_token_ciphertext = coalesce(p_refresh_token_ciphertext, s.refresh_token_ciphertext),
      access_token_ciphertext = p_access_token_ciphertext,
      access_token_expires_at = p_access_token_expires_at,
      secret_version = s.secret_version + 1,
      updated_at = pg_catalog.now()
  where s.connection_id = v_connection.id
    and s.credential_generation = v_connection.credential_generation;
  if not found then
    return 'not_connected';
  end if;
  return 'stored';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Her narrow rights (read)
-- ---------------------------------------------------------------------------

create policy "practitioner reads her business" on public.businesses
  for select to authenticated using (private.is_practitioner(id));
create policy "practitioner reads the settings" on public.business_settings
  for select to authenticated using (private.is_practitioner(business_id));
create policy "practitioner reads the hours" on public.business_hours
  for select to authenticated using (private.is_practitioner(business_id));
create policy "practitioner reads the exceptions" on public.availability_exceptions
  for select to authenticated using (private.is_practitioner(business_id));
create policy "practitioner reads the services" on public.services
  for select to authenticated using (private.is_practitioner(business_id));
create policy "practitioner reads the categories" on public.service_categories
  for select to authenticated using (private.is_practitioner(business_id));
create policy "practitioner reads the options" on public.service_options
  for select to authenticated using (private.is_practitioner(business_id));
create policy "practitioner reads the choices" on public.service_option_choices
  for select to authenticated using (private.is_practitioner(business_id));
create policy "practitioner reads the team's profiles" on public.staff_members
  for select to authenticated using (private.is_practitioner(business_id));

-- Every member reads her own membership (the session's business).
create policy "a member reads her own membership" on public.business_members
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and (public.is_business_member(business_id) or private.is_practitioner(business_id))
  );

create policy "practitioner reads her preferences" on public.member_preferences
  for select to authenticated
  using (user_id = (select auth.uid()) and private.is_practitioner(business_id));

create policy "practitioner reads her appointments" on public.appointments
  for select to authenticated
  -- array(subquery): an initplan, evaluated once per statement.
  using (staff_id = any (array(select pg_catalog.unnest(private.my_practitioner_staff_ids()))));

-- Her customers are not opened row by row: a clients row carries private
-- columns (internal notes, loyalty token). She reads their names and
-- contact through practitioner_agenda only.

-- ---------------------------------------------------------------------------
-- The outcome of her own visits
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.agenda_set_appointment_status(p_business_id uuid, p_appointment_id uuid, p_expected_version integer, p_status appointment_status, p_cancellation_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_reason text := private.optional_text(p_cancellation_reason, 500, 'cancellationReason');
  v_current public.appointments%rowtype;
  v_practitioner boolean;
begin
  -- Owner and admin: any appointment. A practitioner: the outcome of her
  -- own visits only (her profile checked on the locked row below), never a
  -- cancellation.
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  v_practitioner := p_business_id is not null and not public.is_business_member(p_business_id);
  if p_business_id is null
     or (v_practitioner and private.practitioner_staff(p_business_id) is null) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if v_practitioner and p_status = 'cancelled' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  if p_status is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'status';
  end if;
  if p_expected_version is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedVersion';
  end if;

  select a.* into v_current
  from public.appointments a
  where a.id = p_appointment_id
    and a.business_id = p_business_id
  for update;

  -- Another practitioner's appointment answers as if it did not exist.
  if not found or (
    v_practitioner and v_current.staff_id is distinct from private.practitioner_staff(p_business_id)
  ) then
    raise exception using errcode = 'P0002', message = 'appointment_not_found';
  end if;

  if v_current.status = p_status then
    return p_appointment_id;
  end if;

  if v_current.version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'stale_appointment';
  end if;

  if not (
    (v_current.status = 'confirmed' and p_status in ('cancelled', 'completed', 'no_show'))
    or (v_current.status = 'no_show' and p_status in ('confirmed', 'completed'))
    or (v_current.status = 'completed' and p_status = 'confirmed')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_status_transition', hint = 'status';
  end if;

  if p_status in ('completed', 'no_show') and v_current.starts_at > pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'invalid_status_transition', hint = 'status';
  end if;

  update public.appointments a
  set
    status = p_status,
    completed_at = case when p_status = 'completed' then pg_catalog.now() end,
    cancellation_reason = case when p_status = 'cancelled' then v_reason end
  where a.id = p_appointment_id;

  return p_appointment_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Invitations: the practitioner role is given
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.send_team_invitation(p_business_id uuid, p_operation_id uuid, p_staff_id uuid, p_expected_revision integer, p_email text, p_role text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_payload jsonb;
  v_replay jsonb;
  v_staff public.staff_members;
begin
  if v_email is null or pg_catalog.char_length(v_email) > 254
     or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'email';
  end if;
  if p_role is null or p_role not in ('admin', 'practitioner') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'role';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'token';
  end if;
  -- The token is not part of the command: a replay brings a new one,
  -- discarded.
  v_payload := pg_catalog.jsonb_build_object(
    'staffId', p_staff_id, 'expectedRevision', p_expected_revision,
    'email', v_email, 'role', p_role
  );
  v_replay := private.team_begin(p_business_id, p_operation_id, 'invite', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;

  if not public.has_business_role(p_business_id, array['owner']::public.business_member_role[]) then
    raise exception using errcode = 'P0001', message = 'permission_denied';
  end if;

  v_staff := private.team_lock_staff(p_business_id, p_staff_id, p_expected_revision);
  if v_staff.user_id is not null or exists (
    select 1 from public.business_members bm
    join auth.users u on u.id = bm.user_id
    where bm.business_id = p_business_id and pg_catalog.lower(u.email) = v_email
  ) then
    raise exception using errcode = 'P0001', message = 'access_exists';
  end if;

  update private.team_invitations i
  set status = 'revoked'
  where i.staff_id = v_staff.id and i.status = 'pending';

  insert into private.team_invitations (
    business_id, staff_id, email, role, token_hash, expires_at, created_by
  ) values (
    p_business_id, v_staff.id, v_email, p_role, p_token_hash,
    pg_catalog.now() + interval '7 days', (select auth.uid())
  );

  update public.staff_members s set revision = s.revision + 1 where s.id = v_staff.id;

  return private.team_finish(p_business_id, p_operation_id, 'invite', v_payload, v_staff.id);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Her agenda
-- ---------------------------------------------------------------------------

-- Her appointments between two instants (62 days at most), with the name
-- and contact of each customer: never a customer's private columns.
create function public.practitioner_agenda(p_business_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_staff uuid := private.practitioner_staff(p_business_id);
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if v_staff is null then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '62 days' then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'range';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', a.id,
      'version', a.version,
      'status', a.status,
      'startsAt', a.starts_at,
      'endsAt', a.ends_at,
      'durationMinutes', a.duration_minutes_snapshot,
      'serviceName', a.service_name_snapshot,
      'options', a.options_snapshot,
      'internalNotes', a.internal_notes,
      'client', pg_catalog.jsonb_build_object(
        'id', c.id, 'firstName', c.first_name, 'lastName', c.last_name,
        'email', c.email, 'phone', c.phone
      )
    ) order by a.starts_at, a.id)
    from public.appointments a
    join public.clients c on c.id = a.client_id and c.business_id = a.business_id
    where a.business_id = p_business_id and a.staff_id = v_staff
      and a.starts_at < p_to and a.ends_at > p_from
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.practitioner_agenda(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.practitioner_agenda(uuid, timestamptz, timestamptz) to authenticated;
