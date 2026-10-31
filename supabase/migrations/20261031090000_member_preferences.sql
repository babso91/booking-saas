-- Personal preferences of a professional, per business she belongs to
-- (docs/MEMBER_PREFERENCES_CONTRACT.md).
--
-- What they are: how HER professional area looks to HER (style, ambiance,
-- light or dark, accent, animations). Not the business's branding (logo,
-- photos, mini-site), which belongs to the business and is shared by its
-- members: that will be another table, owned by the business.
--
-- One row per membership (business_id, user_id), deleted with it. No row:
-- the defaults below, as version 0. The database is the source of truth;
-- what a device remembers (cookie) is a cache for the first paint only.
--
-- Writes go through public.save_member_preferences only:
--   * the member is auth.uid(), never a parameter: nobody can write anyone
--     else's preferences, whatever business id or user id is sent;
--   * the business must be one of hers (is_business_member);
--   * a write is a patch (only the fields that changed) based on the
--     version the device last read: applied if the row is still at that
--     version; nothing to do if the row already has those values (a retried
--     save); otherwise 'stale', nothing written, and the current row is
--     returned so that the device can re-apply its own change on it.
-- Members only read their own row (RLS); no DML is granted to the API
-- roles.
--
-- Every value is checked against a closed list
-- (private.member_preferences_valid, used by the table's constraint and by
-- the save function). A new style or ambiance is a migration that replaces
-- that one function with a wider list: the styles share these fields (no
-- table, no column per style).

-- The closed lists, in one place: the table's constraint and the save
-- function both use it.
create function private.member_preferences_valid(
  p_style text,
  p_ambiance text,
  p_color_mode text,
  p_accent text,
  p_motion text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_style in ('classique', 'studio', 'ecrin', 'carnet')
    and p_ambiance in ('atelier', 'lin', 'sauge')
    and p_color_mode in ('light', 'dark', 'system')
    -- Her accent (her signature colour in Studio): '#RRGGBB' in capitals,
    -- or null for the style's own.
    and (p_accent is null or p_accent ~ '^#[0-9A-F]{6}$')
    and p_motion in ('standard', 'discrete', 'none'),
    false)
$$;

revoke all on function private.member_preferences_valid(text, text, text, text, text) from public;

create table public.member_preferences (
  business_id uuid not null,
  user_id uuid not null,
  style text not null default 'classique',
  ambiance text not null default 'atelier',
  color_mode text not null default 'light',
  accent text,
  motion text not null default 'standard',
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, user_id),
  foreign key (business_id, user_id)
    references public.business_members (business_id, user_id)
    on delete cascade,
  constraint member_preferences_values check (
    private.member_preferences_valid(style, ambiance, color_mode, accent, motion))
);

create index member_preferences_user_idx
  on public.member_preferences (user_id);

-- The version is the database's, on every write path (the save function,
-- and the service role of a future import alike): 1 on creation, + 1 when
-- a preference really changes, unchanged otherwise. The member and business
-- of a row never change.
create function private.member_preferences_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := pg_catalog.now();
    new.updated_at := pg_catalog.now();
    return new;
  end if;

  if new.business_id is distinct from old.business_id
    or new.user_id is distinct from old.user_id then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

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

-- Saves a patch of the caller's preferences in p_business_id.
--   p_expected_version: the version her device read (0: no row yet).
--   p_changes: {style?, ambiance?, color_mode?, accent?, motion?}, only the
--     fields she changed; any other key, or a value of another JSON type,
--     is refused (invalid_preferences), and so is a value outside the
--     closed lists, whatever the version.
-- Returns the row as it now is, with:
--   'saved'     the patch was applied (version + 1, or 1 if created);
--   'unchanged' the row already had these values (whatever the version:
--               a retried save, or two devices agreeing); nothing written;
--   'stale'     the row moved since p_expected_version and differs from the
--               patch: nothing written. A row that does not exist yet is
--               returned as the defaults, version 0.
-- Errors: unauthenticated, forbidden (not her business), invalid_input
-- (missing version), invalid_preferences.
create function public.save_member_preferences(
  p_business_id uuid,
  p_expected_version bigint,
  p_changes jsonb
)
returns table (
  status text,
  style text,
  ambiance text,
  color_mode text,
  accent text,
  motion text,
  version bigint,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_row public.member_preferences;
  v_next public.member_preferences;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'unauthenticated';
  end if;
  if p_business_id is null or not public.is_business_member(p_business_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'invalid_input';
  end if;
  if not private.member_preferences_patch_valid(p_changes) then
    raise exception using errcode = '22023', message = 'invalid_preferences';
  end if;

  select * into v_row
  from public.member_preferences p
  where p.business_id = p_business_id and p.user_id = v_user
  for update;

  if not found then
    -- No row yet: the defaults, version 0. Two first saves at once: one
    -- inserts, the other waits on the key and then reads its row.
    v_row := row(p_business_id, v_user, 'classique', 'atelier', 'light',
      null, 'standard', 0, null, null)::public.member_preferences;
  end if;

  v_next := v_row;
  if p_changes ? 'style' then v_next.style := p_changes ->> 'style'; end if;
  if p_changes ? 'ambiance' then v_next.ambiance := p_changes ->> 'ambiance'; end if;
  if p_changes ? 'color_mode' then v_next.color_mode := p_changes ->> 'color_mode'; end if;
  if p_changes ? 'accent' then v_next.accent := p_changes ->> 'accent'; end if;
  if p_changes ? 'motion' then v_next.motion := p_changes ->> 'motion'; end if;

  if not private.member_preferences_valid(v_next.style, v_next.ambiance,
      v_next.color_mode, v_next.accent, v_next.motion) then
    raise exception using errcode = '22023', message = 'invalid_preferences';
  end if;

  if (v_next.style, v_next.ambiance, v_next.color_mode, v_next.accent, v_next.motion)
    is not distinct from
     (v_row.style, v_row.ambiance, v_row.color_mode, v_row.accent, v_row.motion) then
    return query select 'unchanged'::text, v_row.style, v_row.ambiance,
      v_row.color_mode, v_row.accent, v_row.motion, v_row.version, v_row.updated_at;
    return;
  end if;

  if v_row.version <> p_expected_version then
    return query select 'stale'::text, v_row.style, v_row.ambiance,
      v_row.color_mode, v_row.accent, v_row.motion, v_row.version, v_row.updated_at;
    return;
  end if;

  if v_row.version = 0 then
    insert into public.member_preferences as p
      (business_id, user_id, style, ambiance, color_mode, accent, motion)
    values (p_business_id, v_user, v_next.style, v_next.ambiance,
      v_next.color_mode, v_next.accent, v_next.motion)
    on conflict on constraint member_preferences_pkey do nothing
    returning p.* into v_row;

    if not found then
      -- Another first save won: this one was based on version 0, which no
      -- longer is the row's.
      select * into v_row
      from public.member_preferences p
      where p.business_id = p_business_id and p.user_id = v_user
      for update;
      return query select
        case when (v_row.style, v_row.ambiance, v_row.color_mode, v_row.accent, v_row.motion)
          is not distinct from
          (v_next.style, v_next.ambiance, v_next.color_mode, v_next.accent, v_next.motion)
        then 'unchanged' else 'stale' end,
        v_row.style, v_row.ambiance, v_row.color_mode, v_row.accent,
        v_row.motion, v_row.version, v_row.updated_at;
      return;
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
  end if;

  return query select 'saved'::text, v_row.style, v_row.ambiance,
    v_row.color_mode, v_row.accent, v_row.motion, v_row.version, v_row.updated_at;
end;
$$;

revoke all on function public.save_member_preferences(uuid, bigint, jsonb) from public, anon;
grant execute on function public.save_member_preferences(uuid, bigint, jsonb) to authenticated;
