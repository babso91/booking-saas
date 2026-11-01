-- Personal preferences of a professional, per business she belongs to
-- (docs/MEMBER_PREFERENCES_CONTRACT.md).
--
-- What they are: how HER professional area looks to HER (style, ambiance,
-- light or dark, accent, animations). Not the business's branding (logo,
-- photos, mini-site), which belongs to the business and is shared by its
-- members: that will be another table, owned by the business.
--
-- One row per membership (business_id, user_id), deleted with it. No row:
-- the defaults below, version 0. The database is the source of truth; what
-- a device remembers (cookie) is a cache for the first paint only.
--
-- Identities a device must compare its answers with:
--   * the context: her membership (business_members.id). Leaving a business
--     and joining it again is a new membership, so a new context: nothing
--     a device knew of the previous one applies to it;
--   * the incarnation: a row's own id (random, fixed for its life). A row
--     deleted and created again (a new membership, or an administrator) is
--     another incarnation; its versions start again at 1 and are never
--     compared with the previous one's;
--   * the version: within one incarnation, + 1 per real change.
--
-- Reads and writes for the app go through two functions, for auth.uid()
-- only (the member is never a parameter), in a business she belongs to:
--   * read_member_preferences: her membership, and her row or the defaults;
--   * save_member_preferences: a patch (only the fields she changed), for
--     the membership her device knows (else 'context_changed'), based on
--     the (incarnation, version) her device read: applied if the row is
--     still that one; nothing to do if it already has those values (a
--     retried save); otherwise 'stale', nothing written, and the row as it
--     is now is returned so that the device can apply her change on it.
-- Members also read their own row directly (RLS); no DML is granted to the
-- API roles anon and authenticated. The service role keeps the
-- administrative rights Supabase gives it (every table privilege, and RLS
-- bypassed): the app never uses it for preferences, and whatever writes
-- with it still meets the closed lists, the version and incarnation
-- trigger and the membership foreign key.
--
-- Every value is checked against a closed list: one domain per field, used
-- by the table's columns and by the save function. A new style or ambiance
-- is a migration that widens one domain's constraint: the styles share
-- these fields (no table, no column per style).

create domain public.member_preference_style as text
  constraint member_preference_style
    check (value in ('classique', 'studio', 'ecrin', 'carnet'));
create domain public.member_preference_ambiance as text
  constraint member_preference_ambiance
    check (value in ('atelier', 'lin', 'sauge'));
create domain public.member_preference_color_mode as text
  constraint member_preference_color_mode
    check (value in ('light', 'dark', 'system'));
-- Her accent (her signature colour in Studio): '#RRGGBB' in capitals, or
-- null for the style's own.
create domain public.member_preference_accent as text
  constraint member_preference_accent
    check (value ~ '^#[0-9A-F]{6}$');
create domain public.member_preference_motion as text
  constraint member_preference_motion
    check (value in ('standard', 'discrete', 'none'));

create table public.member_preferences (
  business_id uuid not null,
  user_id uuid not null,
  incarnation uuid not null default gen_random_uuid(),
  style public.member_preference_style not null default 'classique',
  ambiance public.member_preference_ambiance not null default 'atelier',
  color_mode public.member_preference_color_mode not null default 'light',
  accent public.member_preference_accent,
  motion public.member_preference_motion not null default 'standard',
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, user_id),
  foreign key (business_id, user_id)
    references public.business_members (business_id, user_id)
    on delete cascade
);

create index member_preferences_user_idx
  on public.member_preferences (user_id);

-- Version and incarnation are the database's, on every write path (the
-- save function, the service role alike): a new row is a new incarnation at
-- version 1; an update keeps its incarnation, and moves its version by one
-- when a preference really changes. The member and business of a row never
-- change.
create function private.member_preferences_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.incarnation := gen_random_uuid();
    new.version := 1;
    new.created_at := pg_catalog.now();
    new.updated_at := pg_catalog.now();
    return new;
  end if;

  if new.business_id is distinct from old.business_id
    or new.user_id is distinct from old.user_id then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  new.incarnation := old.incarnation;
  new.created_at := old.created_at;
  if (new.style, new.ambiance, new.color_mode, new.accent, new.motion)
    is distinct from
     (old.style, old.ambiance, old.color_mode, old.accent, old.motion) then
    new.version := old.version + 1;
    new.updated_at := pg_catalog.now();
  else
    new.version := old.version;
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

revoke all on function private.member_preferences_version() from public;

create trigger member_preferences_version
  before insert or update on public.member_preferences
  for each row execute function private.member_preferences_version();

alter table public.member_preferences enable row level security;

-- Her own row, in a business she is (still) a member of. Nobody else's:
-- not her business's other members, not its owner.
create policy "member_preferences_select_own"
  on public.member_preferences for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.is_business_member(business_id)
  );

revoke all on public.member_preferences from public, anon, authenticated;
grant select on public.member_preferences to authenticated;

-- The caller's membership of p_business_id: unauthenticated without a
-- user, forbidden if she is not a member.
create function private.member_preferences_membership(p_business_id uuid)
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
  if v_membership is null then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return v_membership;
end;
$$;

revoke all on function private.member_preferences_membership(uuid) from public;

-- The fields a patch may carry, and their JSON types.
create function private.member_preferences_patch_valid(p_changes jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_changes is not null
    and pg_catalog.jsonb_typeof(p_changes) = 'object'
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_changes) as c(key, value)
      where not (
        (c.key in ('style', 'ambiance', 'color_mode', 'motion')
          and pg_catalog.jsonb_typeof(c.value) = 'string')
        or (c.key = 'accent'
          and pg_catalog.jsonb_typeof(c.value) in ('string', 'null'))
      )
    )
$$;

revoke all on function private.member_preferences_patch_valid(jsonb) from public;

-- Her membership of p_business_id, and her preferences there: her row, or
-- the defaults with no incarnation and version 0.
-- Errors: unauthenticated, forbidden (not her business).
create function public.read_member_preferences(p_business_id uuid)
returns table (
  membership_id uuid,
  incarnation uuid,
  style text,
  ambiance text,
  color_mode text,
  accent text,
  motion text,
  version bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership uuid := private.member_preferences_membership(p_business_id);
begin
  return query
    select v_membership, p.incarnation, p.style::text, p.ambiance::text,
      p.color_mode::text, p.accent::text, p.motion::text, p.version
    from public.member_preferences p
    where p.business_id = p_business_id and p.user_id = auth.uid();
  if not found then
    return query select v_membership, null::uuid, 'classique'::text,
      'atelier'::text, 'light'::text, null::text, 'standard'::text, 0::bigint;
  end if;
end;
$$;

revoke all on function public.read_member_preferences(uuid) from public, anon;
grant execute on function public.read_member_preferences(uuid) to authenticated;

-- Saves a patch of the caller's preferences in p_business_id.
--   p_membership_id: the membership her device is synchronising (the
--     context); another one (she left and joined again) is refused with
--     'context_changed', nothing written.
--   p_expected_incarnation, p_expected_version: the state her device read
--     (null and 0: no row).
--   p_changes: {style?, ambiance?, color_mode?, accent?, motion?}, only the
--     fields she changed; any other key, a value of another JSON type, or a
--     value outside the closed lists is refused (invalid_preferences),
--     whatever the state.
-- Returns her membership and her row as it now is, with:
--   'saved'     the patch was applied (a new incarnation at version 1 if
--               there was no row, else version + 1);
--   'unchanged' the row already had these values (whatever the state her
--               device read: a retried save, or two devices agreeing);
--   'stale'     the row is not the one her device read (another version,
--               another incarnation, or none any more) and differs from the
--               patch: nothing written.
-- Errors: unauthenticated, forbidden, context_changed, invalid_input,
-- invalid_preferences.
create function public.save_member_preferences(
  p_business_id uuid,
  p_membership_id uuid,
  p_expected_incarnation uuid,
  p_expected_version bigint,
  p_changes jsonb
)
returns table (
  status text,
  membership_id uuid,
  incarnation uuid,
  style text,
  ambiance text,
  color_mode text,
  accent text,
  motion text,
  version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_membership uuid;
  v_found boolean;
  v_row public.member_preferences;
  v_next public.member_preferences;
  v_status text;
begin
  v_membership := private.member_preferences_membership(p_business_id);
  if p_membership_id is null
    or p_expected_version is null or p_expected_version < 0
    or (p_expected_incarnation is null) <> (p_expected_version = 0) then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  if p_membership_id <> v_membership then
    raise exception using errcode = 'P0001', message = 'context_changed';
  end if;
  if not private.member_preferences_patch_valid(p_changes) then
    raise exception using errcode = '22023', message = 'invalid_preferences';
  end if;

  select * into v_row
  from public.member_preferences p
  where p.business_id = p_business_id and p.user_id = v_user
  for update;
  v_found := found;

  if not v_found then
    -- No row: the defaults, no incarnation, version 0.
    v_row := row(p_business_id, v_user, null, 'classique', 'atelier', 'light',
      null, 'standard', 0, null, null)::public.member_preferences;
  end if;

  v_next := v_row;
  begin
    if p_changes ? 'style' then
      v_next.style := (p_changes ->> 'style')::public.member_preference_style;
    end if;
    if p_changes ? 'ambiance' then
      v_next.ambiance := (p_changes ->> 'ambiance')::public.member_preference_ambiance;
    end if;
    if p_changes ? 'color_mode' then
      v_next.color_mode := (p_changes ->> 'color_mode')::public.member_preference_color_mode;
    end if;
    if p_changes ? 'accent' then
      v_next.accent := (p_changes ->> 'accent')::public.member_preference_accent;
    end if;
    if p_changes ? 'motion' then
      v_next.motion := (p_changes ->> 'motion')::public.member_preference_motion;
    end if;
  exception when check_violation then
    raise exception using errcode = '22023', message = 'invalid_preferences';
  end;

  if (v_next.style, v_next.ambiance, v_next.color_mode, v_next.accent, v_next.motion)
    is not distinct from
     (v_row.style, v_row.ambiance, v_row.color_mode, v_row.accent, v_row.motion) then
    v_status := 'unchanged';
  elsif v_row.incarnation is distinct from p_expected_incarnation
    or v_row.version <> p_expected_version then
    v_status := 'stale';
  elsif not v_found then
    -- Two first saves at once: one inserts, the other waits on the key,
    -- then answers on the row the first one created.
    insert into public.member_preferences as p
      (business_id, user_id, style, ambiance, color_mode, accent, motion)
    values (p_business_id, v_user, v_next.style, v_next.ambiance,
      v_next.color_mode, v_next.accent, v_next.motion)
    on conflict on constraint member_preferences_pkey do nothing
    returning p.* into v_row;

    if found then
      v_status := 'saved';
    else
      select * into v_row
      from public.member_preferences p
      where p.business_id = p_business_id and p.user_id = v_user
      for update;
      v_status := case
        when (v_row.style, v_row.ambiance, v_row.color_mode, v_row.accent, v_row.motion)
          is not distinct from
          (v_next.style, v_next.ambiance, v_next.color_mode, v_next.accent, v_next.motion)
        then 'unchanged' else 'stale' end;
    end if;
  else
    update public.member_preferences p
    set style = v_next.style,
        ambiance = v_next.ambiance,
        color_mode = v_next.color_mode,
        accent = v_next.accent,
        motion = v_next.motion
    where p.business_id = p_business_id and p.user_id = v_user
    returning p.* into v_row;
    v_status := 'saved';
  end if;

  return query select v_status, v_membership, v_row.incarnation,
    v_row.style::text, v_row.ambiance::text, v_row.color_mode::text,
    v_row.accent::text, v_row.motion::text, v_row.version;
end;
$$;

revoke all on function public.save_member_preferences(uuid, uuid, uuid, bigint, jsonb) from public, anon;
grant execute on function public.save_member_preferences(uuid, uuid, uuid, bigint, jsonb) to authenticated;
