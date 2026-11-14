-- Her team (docs/TEAM_CONTRACT.md), lot 1.
--
-- Two things are kept apart: a staff profile (public.staff_members: a person
-- her clients may book, for the services assigned to her; no account or
-- email needed) and access to the software (public.business_members, which
-- already exists, reached through an invitation). A profile links to at most
-- one account (staff_members.user_id).
--
-- Lot 1 limits, on purpose:
--   - scheduling stays one agenda per business (the exclusion constraint on
--     appointments is unchanged): a profile and its services are recorded,
--     appointments carry a staff_id, but public slots are not yet computed
--     per person;
--   - the 'practitioner' role is not granted: every RLS policy written so
--     far opens the whole business to any member, so a practitioner account
--     would see what an admin sees. Invitations take role 'admin' only until
--     a capability lot narrows those policies (sendInvite answers
--     role_unavailable for 'practitioner');
--   - the invitation email is not sent from here: the server generates the
--     token, stores only its SHA-256 and hands the link to the email
--     transport once one is validated.
--
-- Every write: one operation_id (a replay answers the stored response, a
-- different command under the same id is idempotency_conflict), the
-- profile's expected revision (version_conflict), the business schedule
-- lock (bookings and team changes never interleave; two owners revoking each
-- other cannot both succeed), owner/admin role checked in the database.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.staff_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  bookable boolean not null default true,
  user_id uuid references public.profiles (id) on delete set null,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  unique (business_id, user_id)
);

create index staff_members_business_idx
  on public.staff_members (business_id, created_at, id);

create table public.staff_services (
  staff_id uuid not null,
  business_id uuid not null,
  service_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (staff_id, service_id),
  foreign key (staff_id, business_id)
    references public.staff_members (id, business_id) on delete cascade,
  foreign key (service_id, business_id)
    references public.services (id, business_id) on delete cascade
);

create index staff_services_service_idx
  on public.staff_services (business_id, service_id);

alter table public.appointments
  add column staff_id uuid,
  add constraint appointments_staff_fkey
    foreign key (staff_id, business_id)
    references public.staff_members (id, business_id);

create index appointments_staff_upcoming_idx
  on public.appointments (staff_id, starts_at)
  where status = 'confirmed' and staff_id is not null;

create table private.team_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  staff_id uuid not null,
  email extensions.citext not null,
  role text not null check (role in ('admin', 'practitioner')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked')),
  expires_at timestamptz not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id) on delete set null,
  foreign key (staff_id, business_id)
    references public.staff_members (id, business_id) on delete cascade
);

create unique index team_invitations_one_pending
  on private.team_invitations (staff_id) where status = 'pending';
create index team_invitations_staff_idx
  on private.team_invitations (staff_id, created_at desc);

create table private.team_requests (
  business_id uuid not null references public.businesses (id) on delete cascade,
  operation_id uuid not null,
  kind text not null,
  fingerprint text not null,
  response jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, operation_id)
);

revoke all on private.team_invitations from public, anon, authenticated;
revoke all on private.team_requests from public, anon, authenticated;

create trigger staff_members_set_updated_at
  before update on public.staff_members
  for each row execute function public.set_updated_at();

-- Read under RLS by owners and admins; every write goes through the
-- functions below.
alter table public.staff_members enable row level security;
alter table public.staff_services enable row level security;

revoke all on public.staff_members from anon, authenticated;
revoke all on public.staff_services from anon, authenticated;
grant select on public.staff_members to authenticated;
grant select on public.staff_services to authenticated;

create policy "Owners and admins read the team"
  on public.staff_members for select to authenticated
  using (public.has_business_role(business_id, array['owner', 'admin']::public.business_member_role[]));

create policy "Owners and admins read service assignments"
  on public.staff_services for select to authenticated
  using (public.has_business_role(business_id, array['owner', 'admin']::public.business_member_role[]));

-- ---------------------------------------------------------------------------
-- Profiles for existing accounts, and for every new member
-- ---------------------------------------------------------------------------

create function private.member_display_name(p_user_id uuid, p_business_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.left(coalesce(
    nullif(pg_catalog.btrim(pg_catalog.concat_ws(' ', p.first_name, p.last_name)), ''),
    (select b.name from public.businesses b where b.id = p_business_id),
    'Moi'
  ), 80)
  from (select 1) as one
  left join public.profiles p on p.id = p_user_id;
$$;

revoke all on function private.member_display_name(uuid, uuid) from public;

-- A member without a profile gets one. The first profile of a business is
-- bookable for all its services: today's single agenda, unchanged.
create function private.ensure_member_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first boolean;
  v_staff_id uuid;
begin
  if exists (
    select 1 from public.staff_members s
    where s.business_id = new.business_id and s.user_id = new.user_id
  ) then
    return new;
  end if;

  v_first := not exists (
    select 1 from public.staff_members s where s.business_id = new.business_id
  );

  insert into public.staff_members (business_id, display_name, bookable, user_id)
  values (
    new.business_id,
    private.member_display_name(new.user_id, new.business_id),
    v_first,
    new.user_id
  )
  returning id into v_staff_id;

  if v_first then
    insert into public.staff_services (staff_id, business_id, service_id)
    select v_staff_id, new.business_id, sv.id
    from public.services sv
    where sv.business_id = new.business_id;
  end if;
  return new;
end;
$$;

revoke all on function private.ensure_member_staff() from public;

create trigger business_members_ensure_staff
  after insert on public.business_members
  for each row execute function private.ensure_member_staff();

-- Backfill, oldest member first: the oldest gets the bookable profile.
do $$
declare
  m record;
begin
  for m in
    select bm.* from public.business_members bm
    order by bm.business_id, (bm.role <> 'owner'), bm.created_at, bm.id
  loop
    if not exists (
      select 1 from public.staff_members s
      where s.business_id = m.business_id and s.user_id = m.user_id
    ) then
      insert into public.staff_members (business_id, display_name, bookable, user_id)
      values (
        m.business_id,
        private.member_display_name(m.user_id, m.business_id),
        not exists (select 1 from public.staff_members s where s.business_id = m.business_id),
        m.user_id
      );
    end if;
  end loop;

  insert into public.staff_services (staff_id, business_id, service_id)
  select s.id, s.business_id, sv.id
  from public.staff_members s
  join public.services sv on sv.business_id = s.business_id
  where s.bookable
  on conflict do nothing;
end;
$$;

-- Existing appointments go to that profile. Only staff_id is written: the
-- table's triggers are off for this one statement (inside the migration's
-- transaction), so no version or updated_at changes, no "appointment
-- changed" email is queued and no calendar mirror is re-sent.
alter table public.appointments disable trigger user;

update public.appointments a
set staff_id = s.id
from public.staff_members s
where a.staff_id is null
  and s.business_id = a.business_id
  and s.bookable;

alter table public.appointments enable trigger user;

-- With a single profile in her business (today's case), a new service is
-- hers too: nothing changes for a professional working alone.
create function private.assign_new_service_to_sole_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select pg_catalog.count(*) from public.staff_members s where s.business_id = new.business_id) = 1 then
    insert into public.staff_services (staff_id, business_id, service_id)
    select s.id, new.business_id, new.id
    from public.staff_members s
    where s.business_id = new.business_id
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.assign_new_service_to_sole_staff() from public;

create trigger services_assign_sole_staff
  after insert on public.services
  for each row execute function private.assign_new_service_to_sole_staff();

-- An appointment created without a person goes to the only bookable profile
-- when there is exactly one (every booking path of lot 1); otherwise it
-- stays unassigned, never guessed.
create function private.default_appointment_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if new.staff_id is null then
    select pg_catalog.array_agg(s.id) into v_ids
    from public.staff_members s
    where s.business_id = new.business_id and s.bookable;
    if pg_catalog.cardinality(v_ids) = 1 then
      new.staff_id := v_ids[1];
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.default_appointment_staff() from public;

create trigger appointments_default_staff
  before insert on public.appointments
  for each row execute function private.default_appointment_staff();

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

create function private.team_member_json(p_staff_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', s.id,
    'revision', s.revision,
    'displayName', s.display_name,
    'bookable', s.bookable,
    'serviceIds', coalesce((
      select pg_catalog.jsonb_agg(ss.service_id order by ss.service_id)
      from public.staff_services ss where ss.staff_id = s.id
    ), '[]'::jsonb),
    'access', (
      select pg_catalog.jsonb_build_object('role', bm.role, 'email', u.email::text)
      from public.business_members bm
      join auth.users u on u.id = bm.user_id
      where bm.business_id = s.business_id and bm.user_id = s.user_id
    ),
    'invite', (
      select pg_catalog.jsonb_build_object(
        'status', case
          when i.status = 'pending' and i.expires_at <= pg_catalog.now() then 'expired'
          else i.status end,
        'email', i.email::text,
        'role', i.role,
        'expiresAt', i.expires_at
      )
      from private.team_invitations i
      where i.staff_id = s.id
      order by i.created_at desc, i.id desc
      limit 1
    ),
    'upcomingAppointments', (
      select pg_catalog.count(*)
      from public.appointments a
      where a.staff_id = s.id and a.status = 'confirmed' and a.starts_at > pg_catalog.now()
    )
  )
  from public.staff_members s
  where s.id = p_staff_id;
$$;

revoke all on function private.team_member_json(uuid) from public;

create function private.assert_team_access(p_business_id uuid)
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
  if not public.has_business_role(p_business_id, array['owner', 'admin']::public.business_member_role[]) then
    raise exception using errcode = 'P0001', message = 'permission_denied';
  end if;
end;
$$;

revoke all on function private.assert_team_access(uuid) from public;

create function public.get_team(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_team_access(p_business_id);
  return pg_catalog.jsonb_build_object(
    'members', coalesce((
      select pg_catalog.jsonb_agg(private.team_member_json(s.id) order by s.created_at, s.id)
      from public.staff_members s where s.business_id = p_business_id
    ), '[]'::jsonb),
    'services', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('id', sv.id, 'name', sv.name)
        order by sv.display_order, sv.name, sv.id
      )
      from public.services sv where sv.business_id = p_business_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_team(uuid) from public;
grant execute on function public.get_team(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Writing
-- ---------------------------------------------------------------------------

-- Opens a write: access, lock, replay. Returns the stored response of a
-- replay (null for a new operation).
create function private.team_begin(
  p_business_id uuid,
  p_operation_id uuid,
  p_kind text,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_fingerprint text;
  v_existing record;
begin
  perform private.assert_team_access(p_business_id);
  if p_operation_id is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'operationId';
  end if;

  perform private.lock_business_schedule(p_business_id);
  -- Access again under the lock: a member removed meanwhile writes nothing.
  perform private.assert_team_access(p_business_id);

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object('kind', p_kind, 'payload', p_payload)::text, 'UTF8'
  )), 'hex');

  select r.kind, r.fingerprint, r.response into v_existing
  from private.team_requests r
  where r.business_id = p_business_id and r.operation_id = p_operation_id;
  if found then
    if v_existing.fingerprint <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict', hint = 'operationId';
    end if;
    return v_existing.response;
  end if;
  return null;
end;
$$;

revoke all on function private.team_begin(uuid, uuid, text, jsonb) from public;

create function private.team_finish(
  p_business_id uuid,
  p_operation_id uuid,
  p_kind text,
  p_payload jsonb,
  p_staff_id uuid
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_response jsonb := private.team_member_json(p_staff_id);
begin
  insert into private.team_requests (business_id, operation_id, kind, fingerprint, response, created_by)
  values (
    p_business_id, p_operation_id, p_kind,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('kind', p_kind, 'payload', p_payload)::text, 'UTF8'
    )), 'hex'),
    v_response,
    (select auth.uid())
  );
  return v_response;
end;
$$;

revoke all on function private.team_finish(uuid, uuid, text, jsonb, uuid) from public;

-- The profile, locked, at the expected revision. Another business's profile
-- is not_found, like a missing one.
create function private.team_lock_staff(
  p_business_id uuid,
  p_staff_id uuid,
  p_expected_revision integer
)
returns public.staff_members
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_staff public.staff_members;
begin
  select * into v_staff
  from public.staff_members s
  where s.id = p_staff_id and s.business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if p_expected_revision is null or v_staff.revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'version_conflict';
  end if;
  return v_staff;
end;
$$;

revoke all on function private.team_lock_staff(uuid, uuid, integer) from public;

create function private.clean_staff_input(
  p_business_id uuid,
  p_display_name text,
  p_bookable boolean,
  p_service_ids uuid[]
)
returns table (display_name text, service_ids uuid[])
language plpgsql
stable
set search_path = ''
as $$
declare
  v_name text := pg_catalog.btrim(p_display_name);
  v_ids uuid[] := private.sorted_ids(
    array(select distinct u from pg_catalog.unnest(coalesce(p_service_ids, '{}'::uuid[])) u)
  );
begin
  if v_name is null or pg_catalog.char_length(v_name) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'displayName';
  end if;
  if p_bookable is null then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'bookable';
  end if;
  if pg_catalog.cardinality(v_ids) > 200 or exists (
    select 1 from pg_catalog.unnest(v_ids) u(id)
    where not exists (
      select 1 from public.services sv where sv.id = u.id and sv.business_id = p_business_id
    )
  ) then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'serviceIds';
  end if;
  return query select v_name, v_ids;
end;
$$;

revoke all on function private.clean_staff_input(uuid, text, boolean, uuid[]) from public;

create function private.set_staff_services(p_staff_id uuid, p_business_id uuid, p_service_ids uuid[])
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  delete from public.staff_services ss
  where ss.staff_id = p_staff_id and not (ss.service_id = any (p_service_ids));
  insert into public.staff_services (staff_id, business_id, service_id)
  select p_staff_id, p_business_id, u.id from pg_catalog.unnest(p_service_ids) u(id)
  on conflict do nothing;
end;
$$;

revoke all on function private.set_staff_services(uuid, uuid, uuid[]) from public;

create function public.create_staff_member(
  p_business_id uuid,
  p_operation_id uuid,
  p_display_name text,
  p_bookable boolean,
  p_service_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean record;
  v_payload jsonb;
  v_replay jsonb;
  v_staff_id uuid;
begin
  -- Access first: another business's ids are never probed through
  -- validation.
  perform private.assert_team_access(p_business_id);
  select * into v_clean from private.clean_staff_input(p_business_id, p_display_name, p_bookable, p_service_ids);
  v_payload := pg_catalog.jsonb_build_object(
    'displayName', v_clean.display_name, 'bookable', p_bookable,
    'serviceIds', pg_catalog.to_jsonb(v_clean.service_ids)
  );
  v_replay := private.team_begin(p_business_id, p_operation_id, 'create', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;

  if (select pg_catalog.count(*) from public.staff_members s where s.business_id = p_business_id) >= 100 then
    raise exception using errcode = 'P0001', message = 'team_limit_reached';
  end if;

  insert into public.staff_members (business_id, display_name, bookable)
  values (p_business_id, v_clean.display_name, p_bookable)
  returning id into v_staff_id;
  perform private.set_staff_services(v_staff_id, p_business_id, v_clean.service_ids);

  return private.team_finish(p_business_id, p_operation_id, 'create', v_payload, v_staff_id);
end;
$$;

create function public.update_staff_member(
  p_business_id uuid,
  p_operation_id uuid,
  p_staff_id uuid,
  p_expected_revision integer,
  p_display_name text,
  p_bookable boolean,
  p_service_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean record;
  v_payload jsonb;
  v_replay jsonb;
  v_staff public.staff_members;
begin
  -- Access first: another business's ids are never probed through
  -- validation.
  perform private.assert_team_access(p_business_id);
  select * into v_clean from private.clean_staff_input(p_business_id, p_display_name, p_bookable, p_service_ids);
  v_payload := pg_catalog.jsonb_build_object(
    'staffId', p_staff_id, 'expectedRevision', p_expected_revision,
    'displayName', v_clean.display_name, 'bookable', p_bookable,
    'serviceIds', pg_catalog.to_jsonb(v_clean.service_ids)
  );
  v_replay := private.team_begin(p_business_id, p_operation_id, 'update', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;

  v_staff := private.team_lock_staff(p_business_id, p_staff_id, p_expected_revision);

  -- Never leave booked appointments without their person: taking her out
  -- of booking waits until her upcoming appointments are moved or cancelled.
  if v_staff.bookable and not p_bookable and exists (
    select 1 from public.appointments a
    where a.staff_id = v_staff.id and a.status = 'confirmed' and a.starts_at > pg_catalog.now()
  ) then
    raise exception using errcode = 'P0001', message = 'upcoming_appointments';
  end if;

  update public.staff_members s
  set display_name = v_clean.display_name,
      bookable = p_bookable,
      revision = s.revision + 1
  where s.id = v_staff.id;
  perform private.set_staff_services(v_staff.id, p_business_id, v_clean.service_ids);

  return private.team_finish(p_business_id, p_operation_id, 'update', v_payload, v_staff.id);
end;
$$;

-- A new invitation for this profile; the previous pending one can no longer
-- be used. The caller (server) generated the token and passes its SHA-256.
create function public.send_team_invitation(
  p_business_id uuid,
  p_operation_id uuid,
  p_staff_id uuid,
  p_expected_revision integer,
  p_email text,
  p_role text,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

  if p_role = 'practitioner' then
    raise exception using errcode = 'P0001', message = 'role_unavailable';
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
$$;

-- Takes the account off the profile (and cancels a pending invitation).
-- The profile and its appointments stay.
create function public.revoke_team_access(
  p_business_id uuid,
  p_operation_id uuid,
  p_staff_id uuid,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := pg_catalog.jsonb_build_object(
    'staffId', p_staff_id, 'expectedRevision', p_expected_revision
  );
  v_replay jsonb;
  v_staff public.staff_members;
  v_role public.business_member_role;
  v_changed boolean := false;
begin
  v_replay := private.team_begin(p_business_id, p_operation_id, 'revoke', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;

  v_staff := private.team_lock_staff(p_business_id, p_staff_id, p_expected_revision);

  if v_staff.user_id is not null then
    select bm.role into v_role
    from public.business_members bm
    where bm.business_id = p_business_id and bm.user_id = v_staff.user_id;

    if v_role is not null then
      -- Only an owner takes away an owner's or an admin's access (an admin
      -- may leave on her own).
      if v_staff.user_id <> (select auth.uid())
         and not public.has_business_role(p_business_id, array['owner']::public.business_member_role[]) then
        raise exception using errcode = 'P0001', message = 'permission_denied';
      end if;
      if v_role = 'owner' and not exists (
        select 1 from public.business_members bm
        where bm.business_id = p_business_id and bm.role = 'owner' and bm.user_id <> v_staff.user_id
      ) then
        raise exception using errcode = 'P0001', message = 'last_owner';
      end if;
      delete from public.business_members bm
      where bm.business_id = p_business_id and bm.user_id = v_staff.user_id;
    end if;

    update public.staff_members s set user_id = null where s.id = v_staff.id;
    v_changed := true;
  end if;

  update private.team_invitations i
  set status = 'revoked'
  where i.staff_id = v_staff.id and i.status = 'pending';
  if found then
    v_changed := true;
  end if;

  if v_changed then
    update public.staff_members s set revision = s.revision + 1 where s.id = v_staff.id;
  end if;

  return private.team_finish(p_business_id, p_operation_id, 'revoke', v_payload, v_staff.id);
end;
$$;

-- The invited person, signed in with the invited address (confirmed),
-- joins the business on the profile. Unknown, used, revoked or expired
-- tokens all answer invitation_invalid.
create function public.accept_team_invitation(p_token_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_invite private.team_invitations;
  v_user_email text;
  v_confirmed timestamptz;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invitation_invalid';
  end if;

  select * into v_invite from private.team_invitations i where i.token_hash = p_token_hash;
  if not found then
    raise exception using errcode = 'P0001', message = 'invitation_invalid';
  end if;

  perform private.lock_business_schedule(v_invite.business_id);

  select * into v_invite from private.team_invitations i where i.id = v_invite.id for update;
  if v_invite.status <> 'pending' or v_invite.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'P0001', message = 'invitation_invalid';
  end if;

  select u.email, u.email_confirmed_at into v_user_email, v_confirmed
  from auth.users u where u.id = v_user;
  if v_confirmed is null or pg_catalog.lower(v_user_email) <> pg_catalog.lower(v_invite.email::text) then
    raise exception using errcode = 'P0001', message = 'invitation_email_mismatch';
  end if;

  -- One business per account in this version.
  if exists (select 1 from public.business_members bm where bm.user_id = v_user) then
    raise exception using errcode = 'P0001', message = 'already_member';
  end if;

  update public.staff_members s
  set user_id = v_user, revision = s.revision + 1
  where s.id = v_invite.staff_id and s.user_id is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'invitation_invalid';
  end if;

  insert into public.business_members (business_id, user_id, role)
  values (v_invite.business_id, v_user, v_invite.role::public.business_member_role);

  update private.team_invitations i
  set status = 'accepted', accepted_at = pg_catalog.now(), accepted_by = v_user
  where i.id = v_invite.id;

  return v_invite.business_id;
end;
$$;

revoke all on function public.create_staff_member(uuid, uuid, text, boolean, uuid[]) from public;
revoke all on function public.update_staff_member(uuid, uuid, uuid, integer, text, boolean, uuid[]) from public;
revoke all on function public.send_team_invitation(uuid, uuid, uuid, integer, text, text, text) from public;
revoke all on function public.revoke_team_access(uuid, uuid, uuid, integer) from public;
revoke all on function public.accept_team_invitation(text) from public;
grant execute on function public.create_staff_member(uuid, uuid, text, boolean, uuid[]) to authenticated;
grant execute on function public.update_staff_member(uuid, uuid, uuid, integer, text, boolean, uuid[]) to authenticated;
grant execute on function public.send_team_invitation(uuid, uuid, uuid, integer, text, text, text) to authenticated;
grant execute on function public.revoke_team_access(uuid, uuid, uuid, integer) to authenticated;
grant execute on function public.accept_team_invitation(text) to authenticated;
