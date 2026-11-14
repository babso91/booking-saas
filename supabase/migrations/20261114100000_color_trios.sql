-- Colour trios (docs/COLOR_TRIOS_PROPOSAL.md): six ambiances join the closed
-- list her account keeps, and Égyptien becomes the default ambiance.
--
-- Only the list and the default change. Rows that already hold an ambiance
-- keep it; a professional with no row now reads (and first saves from) the
-- Égyptien default, the same as her device (src/features/appearance).
-- The two functions below are the ones of 20261031090000, unchanged but for
-- the default of a missing row (read and save must agree, or a first save
-- from the device's defaults would be judged stale).

alter domain public.member_preference_ambiance
  drop constraint member_preference_ambiance;
alter domain public.member_preference_ambiance
  add constraint member_preference_ambiance
    check (value in (
      'atelier', 'lin', 'sauge',
      'egyptien', 'moka', 'prune', 'neon', 'dune', 'indigo'
    ));

alter table public.member_preferences
  alter column ambiance set default 'egyptien';

create or replace function public.read_member_preferences(p_business_id uuid)
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
      'egyptien'::text, 'light'::text, null::text, 'standard'::text, 0::bigint;
  end if;
end;
$$;

create or replace function public.save_member_preferences(
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
    v_row := row(p_business_id, v_user, null, 'classique', 'egyptien', 'light',
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
