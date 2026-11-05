-- Mini-site photos: real storage, verification, private preview, public
-- serving limited to the published version, and revocation
-- (docs/SITE_PUBLISHING_CONTRACT.md § 8).
--
-- Files live in the PRIVATE bucket site-photos, under
-- <business_id>/<asset_id>/: `original` and the WebP derivatives
-- `w480.webp`, `w828.webp`, `w1200.webp`. No storage policy is granted to
-- the API roles: the browser uploads its original with a signed upload URL
-- the server issued after checking membership; only the service reads.
--
-- A photo's life: pending (uploaded, not verified) → ready (verified,
-- derivatives made) → revoked (final). Revoking never touches a published
-- version (history stays immutable): the photo is no longer served, its
-- files are deleted, and every render (public, preview, a restored old
-- version) shows its place without a photo. A revoked photo never comes
-- back: a new upload is a new asset.

-- ---------------------------------------------------------------------------
-- Bucket (private)
-- ---------------------------------------------------------------------------

do $$
begin
  if pg_catalog.to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'site-photos', 'site-photos', false, 10485760,
      array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Assets: their life
-- ---------------------------------------------------------------------------

alter table public.site_assets
  drop constraint site_assets_status_check,
  add constraint site_assets_status_check
    check (status in ('pending', 'ready', 'revoked')),
  drop constraint site_assets_content_type_check,
  -- The REAL type, found by decoding the file (not the one declared).
  add constraint site_assets_content_type_check
    check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  add column created_by uuid references public.profiles (id) on delete set null,
  add column revoked_at timestamptz,
  add column revoked_reason text check (revoked_reason in ('owner', 'privacy')),
  add constraint site_assets_revocation_complete check (
    (status = 'revoked') = (revoked_at is not null)
    and (revoked_at is null) = (revoked_reason is null)
  ),
  add constraint site_assets_ready_complete check (
    status <> 'ready'
    or (content_type is not null and width is not null and height is not null)
  );

create index site_assets_pending_idx
  on public.site_assets (business_id, created_at)
  where status = 'pending';

-- A configuration may refer to her ready photos, and to her revoked ones
-- (an old version restored: rendered without the photo). Never to a
-- pending one, another business's, or one that does not exist.
create or replace function private.assert_site_assets(p_business_id uuid, p_config jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_refs text[];
  v_ids uuid[];
begin
  select coalesce(pg_catalog.array_agg(ref), '{}')
  into v_refs
  from (
    select pg_catalog.jsonb_path_query(p_config, 'lax $.**.asset') #>> '{}' as ref
    union all
    select pg_catalog.jsonb_object_keys(
      case when pg_catalog.jsonb_typeof(p_config #> '{content,focals}') = 'object'
        then p_config #> '{content,focals}' else '{}'::jsonb end
    )
  ) refs;

  begin
    v_ids := v_refs::uuid[];
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_site_config', hint = 'config';
  end;

  if exists (
    select 1 from pg_catalog.unnest(v_ids) as u(id)
    where u.id is null or not exists (
      select 1 from public.site_assets a
      where a.id = u.id
        and a.business_id = p_business_id
        and a.status in ('ready', 'revoked')
    )
  ) then
    raise exception using errcode = 'P0001', message = 'site_asset_unavailable', hint = 'config';
  end if;
end;
$$;

-- The photos a configuration refers to that cannot be shown (revoked):
-- the renderer draws their places without a photo.
create function private.site_unavailable_assets(p_business_id uuid, p_config jsonb)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(distinct a.id order by a.id), '{}')
  from public.site_assets a
  where a.business_id = p_business_id
    and a.status <> 'ready'
    and a.id::text in (
      select pg_catalog.lower(pg_catalog.jsonb_path_query(p_config, 'lax $.**.asset') #>> '{}')
      union all
      select pg_catalog.lower(pg_catalog.jsonb_object_keys(
        case when pg_catalog.jsonb_typeof(p_config #> '{content,focals}') = 'object'
          then p_config #> '{content,focals}' else '{}'::jsonb end
      ))
    );
$$;

revoke all on function private.site_unavailable_assets(uuid, jsonb) from public;

-- Whether a configuration refers to this photo.
create function private.site_config_refers_to(p_config jsonb, p_asset_id uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1
    from pg_catalog.jsonb_path_query(p_config, 'lax $.**.asset') as ref
    where pg_catalog.lower(ref #>> '{}') = p_asset_id::text
  ) or (
    pg_catalog.jsonb_typeof(p_config #> '{content,focals}') = 'object'
    and exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_config #> '{content,focals}') as key
      where pg_catalog.lower(key) = p_asset_id::text
    )
  );
$$;

revoke all on function private.site_config_refers_to(jsonb, uuid) from public;

-- ---------------------------------------------------------------------------
-- Writes (the service, for a member)
-- ---------------------------------------------------------------------------

-- A new photo, pending until its file is verified. At most 20 pending
-- uploads per business over the last 24 hours (abuse).
create function public.create_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_content_type text,
  p_byte_size integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  if p_content_type is null
    -- HEIC (HEVC) cannot be decoded by the server: refused here, the
    -- studio lets iOS convert to JPEG (contract § 8).
    or p_content_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/avif') then
    raise exception using errcode = '22023', message = 'site_photo_unsupported', hint = 'contentType';
  end if;
  if p_byte_size is null or p_byte_size not between 1 and 10485760 then
    raise exception using errcode = '22023', message = 'site_photo_too_large', hint = 'byteSize';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('site_assets:' || p_business_id::text, 0)
  );
  if (
    select count(*) from public.site_assets a
    where a.business_id = p_business_id
      and a.status = 'pending'
      and a.created_at > pg_catalog.now() - interval '24 hours'
  ) >= 20 then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  insert into public.site_assets (business_id, status, byte_size, created_by)
  values (p_business_id, 'pending', p_byte_size, p_actor)
  returning id into v_id;
  return v_id;
end;
$$;

-- The file was verified by the server (real type, size, dimensions) and its
-- derivatives were made: the photo is ready. Only a pending photo.
create function public.confirm_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_asset_id uuid,
  p_content_type text,
  p_byte_size integer,
  p_width integer,
  p_height integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  select a.status into v_status
  from public.site_assets a
  where a.id = p_asset_id and a.business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'site_photo_not_found', hint = 'assetId';
  end if;
  if v_status = 'ready' then
    return;
  end if;
  if v_status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'site_photo_revoked', hint = 'assetId';
  end if;
  update public.site_assets a
  set status = 'ready',
      content_type = p_content_type,
      byte_size = p_byte_size,
      width = p_width,
      height = p_height
  where a.id = p_asset_id;
end;
$$;

-- A pending photo whose file was refused: forgotten.
create function public.discard_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_asset_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  delete from public.site_assets a
  where a.id = p_asset_id and a.business_id = p_business_id and a.status = 'pending';
end;
$$;

-- Deletes a photo nothing refers to: not the draft, not any published
-- version (site_asset_in_use: revoke it instead). A revoked photo stays as
-- a record (its files are already gone), so it can never come back.
create function public.delete_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_asset_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('site_assets:' || p_business_id::text, 0)
  );
  select a.status into v_status
  from public.site_assets a
  where a.id = p_asset_id and a.business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'site_photo_not_found', hint = 'assetId';
  end if;
  if v_status = 'revoked' then
    return 'revoked';
  end if;
  -- The draft and the history are read under the site's row lock: a save
  -- or a publication cannot add a reference meanwhile.
  perform 1 from public.sites s where s.business_id = p_business_id for update;
  if exists (
    select 1 from public.sites s
    where s.business_id = p_business_id
      and s.draft_config is not null
      and private.site_config_refers_to(s.draft_config, p_asset_id)
  ) or exists (
    select 1 from public.site_versions v
    where v.business_id = p_business_id
      and private.site_config_refers_to(v.config, p_asset_id)
  ) then
    raise exception using errcode = 'P0001', message = 'site_asset_in_use', hint = 'assetId';
  end if;
  delete from public.site_assets a where a.id = p_asset_id;
  return 'deleted';
end;
$$;

-- Revokes a photo, whatever refers to it. Final and idempotent; the first
-- reason stays. Nothing published is rewritten: every render shows its
-- places without a photo. The caller then deletes its files.
create function private.revoke_site_asset(p_business_id uuid, p_asset_id uuid, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.site_assets a
  set status = 'revoked',
      revoked_at = coalesce(a.revoked_at, pg_catalog.now()),
      revoked_reason = coalesce(a.revoked_reason, p_reason)
  where a.id = p_asset_id and a.business_id = p_business_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'site_photo_not_found', hint = 'assetId';
  end if;
end;
$$;

revoke all on function private.revoke_site_asset(uuid, uuid, text) from public;

-- Her request, from the studio.
create function public.revoke_site_asset(
  p_business_id uuid,
  p_actor uuid,
  p_asset_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  perform private.revoke_site_asset(p_business_id, p_asset_id, 'owner');
end;
$$;

-- A privacy request (the person in the photo, or a deletion request)
-- handled by the service: no acting member.
create function public.revoke_site_asset_for_privacy(
  p_business_id uuid,
  p_asset_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.revoke_site_asset(p_business_id, p_asset_id, 'privacy');
end;
$$;

-- ---------------------------------------------------------------------------
-- Serving (the service, for the proxies)
-- ---------------------------------------------------------------------------

-- The public proxy: the business of `p_slug` if this photo is ready and
-- referred to by its PUBLISHED version; null otherwise (a draft's photo, a
-- revoked one, another business's: never served).
create function public.public_site_photo(p_slug text, p_asset_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.business_id
  from public.site_assets a
  join public.sites s on s.business_id = a.business_id
  join public.site_versions v on v.id = s.published_version_id
  where a.id = p_asset_id
    and a.status = 'ready'
    and a.business_id = private.business_id_by_slug(p_slug)
    and private.site_config_refers_to(v.config, p_asset_id);
$$;

-- The studio's preview: a ready photo of HER business, published or not.
create function public.member_site_photo(p_business_id uuid, p_actor uuid, p_asset_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  return exists (
    select 1 from public.site_assets a
    where a.id = p_asset_id and a.business_id = p_business_id and a.status = 'ready'
  );
end;
$$;

-- The public read now says which of the published version's photos cannot
-- be shown (revoked since): drawn without a photo.
drop function public.get_public_site(text);

create function public.get_public_site(p_slug text)
returns table (
  version_id uuid,
  number integer,
  published_at timestamptz,
  plan text,
  schema_version integer,
  config jsonb,
  unavailable_assets uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_id uuid := private.business_id_by_slug(p_slug);
begin
  if v_business_id is null then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;

  return query
  select v.id, v.number, v.published_at, s.plan, v.schema_version, v.config,
         private.site_unavailable_assets(v_business_id, v.config)
  from public.sites s
  join public.site_versions v on v.id = s.published_version_id
  where s.business_id = v_business_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'site_not_published';
  end if;
end;
$$;

revoke all on function public.get_public_site(text) from public;
grant execute on function public.get_public_site(text) to anon, authenticated, service_role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.create_site_asset(uuid, uuid, text, integer)',
    'public.confirm_site_asset(uuid, uuid, uuid, text, integer, integer, integer)',
    'public.discard_site_asset(uuid, uuid, uuid)',
    'public.delete_site_asset(uuid, uuid, uuid)',
    'public.revoke_site_asset(uuid, uuid, uuid)',
    'public.revoke_site_asset_for_privacy(uuid, uuid)',
    'public.public_site_photo(text, uuid)',
    'public.member_site_photo(uuid, uuid, uuid)'
  ] loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute pg_catalog.format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;
