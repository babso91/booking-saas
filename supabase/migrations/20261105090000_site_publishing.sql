-- Mini-sites: one site per business, a private draft, immutable published
-- versions, restoration, public read of the published version only
-- (docs/SITE_PUBLISHING_CONTRACT.md).
--
-- The site is presentation only: the catalogue and the booking stay where
-- they are (services, get_public_catalog, the public booking routes).
--
-- Writes go through functions executable by the service only: the server
-- validates a configuration (schema, registry, texts, colours, readability:
-- src/features/sites/) before calling them, with the acting member, whose
-- membership the database checks again. Members read their own site
-- under RLS; the public reads the published version only.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique
    references public.businesses (id) on delete cascade,
  -- Her plan's rights, applied when rendering; set by the service only.
  plan text not null default 'core' check (plan in ('core', 'signature')),
  -- The draft (private). Revision 0: no draft yet.
  draft_schema_version integer check (draft_schema_version >= 1),
  draft_config jsonb,
  draft_revision integer not null default 0 check (draft_revision >= 0),
  -- The version this draft was restored from, until she changes it.
  draft_restored_from uuid,
  draft_updated_at timestamptz,
  draft_updated_by uuid references public.profiles (id) on delete set null,
  published_version_id uuid,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  constraint sites_draft_complete check (
    (draft_revision = 0) = (draft_config is null)
    and (draft_config is null) = (draft_schema_version is null)
  ),
  constraint sites_draft_document check (
    draft_config is null
    or (
      pg_catalog.jsonb_typeof(draft_config) = 'object'
      and pg_catalog.octet_length(draft_config::text) <= 262144
    )
  )
);

create table public.site_versions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null,
  business_id uuid not null,
  number integer not null check (number >= 1),
  schema_version integer not null check (schema_version >= 1),
  config jsonb not null check (pg_catalog.jsonb_typeof(config) = 'object'),
  published_at timestamptz not null default now(),
  published_by uuid references public.profiles (id) on delete set null,
  restored_from uuid,
  unique (site_id, number),
  unique (id, site_id),
  foreign key (site_id, business_id)
    references public.sites (id, business_id) on delete cascade
);

alter table public.sites
  add constraint sites_published_version_fkey
    foreign key (published_version_id, id)
    references public.site_versions (id, site_id);

-- Her photos (metadata). Only these can be referenced by a configuration;
-- the upload pipeline (storage, verification) comes with the next PR.
create table public.site_assets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  content_type text check (
    content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')
  ),
  byte_size integer check (byte_size > 0),
  width integer check (width > 0),
  height integer check (height > 0),
  created_at timestamptz not null default now(),
  unique (id, business_id)
);

-- A published version never changes. It goes only with its site (the
-- business deleted): published_by may then be set null by its profile's
-- deletion, nothing else.
create function private.site_version_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.sites s where s.id = old.site_id) then
      raise exception using errcode = 'P0001', message = 'site_version_immutable';
    end if;
    return old;
  end if;
  if (new.id, new.site_id, new.business_id, new.number, new.schema_version,
      new.config, new.published_at, new.restored_from)
    is distinct from
     (old.id, old.site_id, old.business_id, old.number, old.schema_version,
      old.config, old.published_at, old.restored_from) then
    raise exception using errcode = 'P0001', message = 'site_version_immutable';
  end if;
  return new;
end;
$$;

revoke all on function private.site_version_immutable() from public;

create trigger site_versions_immutable
  before update or delete on public.site_versions
  for each row execute function private.site_version_immutable();

-- RLS: members read their own; nothing is written through the API.
alter table public.sites enable row level security;
alter table public.site_versions enable row level security;
alter table public.site_assets enable row level security;

create policy sites_select_member on public.sites
  for select to authenticated using (public.is_business_member(business_id));
create policy site_versions_select_member on public.site_versions
  for select to authenticated using (public.is_business_member(business_id));
create policy site_assets_select_member on public.site_assets
  for select to authenticated using (public.is_business_member(business_id));

revoke all on public.sites from public, anon, authenticated;
revoke all on public.site_versions from public, anon, authenticated;
revoke all on public.site_assets from public, anon, authenticated;
grant select on public.sites to authenticated;
grant select on public.site_versions to authenticated;
grant select on public.site_assets to authenticated;

-- ---------------------------------------------------------------------------
-- Checks shared by the writes
-- ---------------------------------------------------------------------------

-- The acting member (the server passes the session's user): a member of
-- the business, or forbidden.
-- Her membership is checked AND held until the write commits: the row is
-- locked FOR SHARE, so removing her from the business waits for the write
-- in progress (and a write started after her removal began waits for it,
-- then finds no membership). The check and the mutation are one moment.
create function private.assert_site_actor(p_business_id uuid, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_business_id is null or p_actor is null then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  perform 1 from public.business_members m
  where m.business_id = p_business_id and m.user_id = p_actor
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end;
$$;

revoke all on function private.assert_site_actor(uuid, uuid) from public;

-- Every photo a configuration refers to ({ "asset": uuid } anywhere, and
-- the keys of content.focals) is a ready photo of this business.
create function private.assert_site_assets(p_business_id uuid, p_config jsonb)
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
      where a.id = u.id and a.business_id = p_business_id and a.status = 'ready'
    )
  ) then
    raise exception using errcode = 'P0001', message = 'site_asset_unavailable', hint = 'config';
  end if;
end;
$$;

revoke all on function private.assert_site_assets(uuid, jsonb) from public;

create function private.assert_site_document(p_schema_version integer, p_config jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_schema_version is distinct from 1
    or p_config is null
    or pg_catalog.jsonb_typeof(p_config) <> 'object'
    or pg_catalog.octet_length(p_config::text) > 262144 then
    raise exception using errcode = '22023', message = 'invalid_site_config', hint = 'config';
  end if;
end;
$$;

revoke all on function private.assert_site_document(integer, jsonb) from public;

-- ---------------------------------------------------------------------------
-- Writes (the service, for a member)
-- ---------------------------------------------------------------------------

-- Saves the draft if it is still at `p_expected_revision` (0: no draft
-- yet; the site is created). A retry finding the draft already as given
-- answers its revision; otherwise stale_site_draft. Writing what is there
-- changes nothing.
create function public.save_site_draft(
  p_business_id uuid,
  p_actor uuid,
  p_expected_revision integer,
  p_schema_version integer,
  p_config jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites%rowtype;
begin
  perform private.assert_site_actor(p_business_id, p_actor);
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'expectedRevision';
  end if;
  perform private.assert_site_document(p_schema_version, p_config);

  insert into public.sites (business_id) values (p_business_id)
  on conflict (business_id) do nothing;

  select s.* into v_site
  from public.sites s
  where s.business_id = p_business_id
  for update;

  -- Her photos, checked under the site's lock: a photo deleted while this
  -- save waited for the lock (its deletion holds that lock) is seen gone.
  perform private.assert_site_assets(p_business_id, p_config);

  if v_site.draft_config = p_config and v_site.draft_schema_version = p_schema_version then
    return v_site.draft_revision;
  end if;
  if v_site.draft_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_site_draft', hint = 'expectedRevision';
  end if;

  update public.sites s
  set draft_schema_version = p_schema_version,
      draft_config = p_config,
      draft_revision = s.draft_revision + 1,
      draft_restored_from = null,
      draft_updated_at = pg_catalog.now(),
      draft_updated_by = p_actor
  where s.id = v_site.id
  returning s.draft_revision into v_site.draft_revision;

  return v_site.draft_revision;
end;
$$;

-- Publishes the draft at `p_expected_revision`: a new immutable version
-- (the next number of this site) and the switch of published_version_id,
-- in one transaction. The draft already published as it is: answers that
-- version (created false), nothing written.
create function public.publish_site(
  p_business_id uuid,
  p_actor uuid,
  p_expected_revision integer
)
returns table (version_id uuid, number integer, published_at timestamptz, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_site public.sites%rowtype;
  v_current public.site_versions%rowtype;
  v_version public.site_versions%rowtype;
begin
  perform private.assert_site_actor(p_business_id, p_actor);

  select s.* into v_site
  from public.sites s
  where s.business_id = p_business_id
  for update;

  if not found or v_site.draft_revision = 0 then
    raise exception using errcode = 'P0002', message = 'site_not_found';
  end if;
  if v_site.draft_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_site_draft', hint = 'expectedRevision';
  end if;

  select v.* into v_current
  from public.site_versions v
  where v.id = v_site.published_version_id;

  if found
    and v_current.config = v_site.draft_config
    and v_current.schema_version = v_site.draft_schema_version then
    return query select v_current.id, v_current.number, v_current.published_at, false;
    return;
  end if;

  perform private.assert_site_document(v_site.draft_schema_version, v_site.draft_config);
  perform private.assert_site_assets(p_business_id, v_site.draft_config);

  insert into public.site_versions (
    site_id, business_id, number, schema_version, config, published_by, restored_from
  )
  values (
    v_site.id,
    p_business_id,
    (select coalesce(max(v.number), 0) + 1 from public.site_versions v where v.site_id = v_site.id),
    v_site.draft_schema_version,
    v_site.draft_config,
    p_actor,
    v_site.draft_restored_from
  )
  returning * into v_version;

  update public.sites s
  set published_version_id = v_version.id
  where s.id = v_site.id;

  return query select v_version.id, v_version.number, v_version.published_at, true;
end;
$$;

-- Copies a published version of her site into the draft (if still at
-- `p_expected_revision`). Nothing of the history is rewritten; publishing
-- it creates a new version, restored_from that one.
create function public.restore_site_version(
  p_business_id uuid,
  p_actor uuid,
  p_version_id uuid,
  p_expected_revision integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites%rowtype;
  v_version public.site_versions%rowtype;
begin
  perform private.assert_site_actor(p_business_id, p_actor);

  select s.* into v_site
  from public.sites s
  where s.business_id = p_business_id
  for update;

  select v.* into v_version
  from public.site_versions v
  where v.id = p_version_id and v.site_id = v_site.id;

  if v_site.id is null or v_version.id is null then
    raise exception using errcode = 'P0002', message = 'site_version_not_found', hint = 'versionId';
  end if;

  if v_site.draft_restored_from = v_version.id
    and v_site.draft_config = v_version.config
    and v_site.draft_schema_version = v_version.schema_version then
    return v_site.draft_revision;
  end if;
  if v_site.draft_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_site_draft', hint = 'expectedRevision';
  end if;

  update public.sites s
  set draft_schema_version = v_version.schema_version,
      draft_config = v_version.config,
      draft_revision = s.draft_revision + 1,
      draft_restored_from = v_version.id,
      draft_updated_at = pg_catalog.now(),
      draft_updated_by = p_actor
  where s.id = v_site.id
  returning s.draft_revision into v_site.draft_revision;

  return v_site.draft_revision;
end;
$$;

-- Her plan, set by the service (no billing yet): never by her nor by a
-- browser. Nothing of her draft or her versions changes.
create function public.set_site_plan(p_business_id uuid, p_plan text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_plan is null or p_plan not in ('core', 'signature') then
    raise exception using errcode = '22023', message = 'invalid_input', hint = 'plan';
  end if;
  if not exists (select 1 from public.businesses b where b.id = p_business_id) then
    raise exception using errcode = 'P0002', message = 'business_not_found';
  end if;
  insert into public.sites (business_id, plan) values (p_business_id, p_plan)
  on conflict (business_id) do update set plan = excluded.plan;
end;
$$;

revoke all on function public.save_site_draft(uuid, uuid, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.publish_site(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.restore_site_version(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.set_site_plan(uuid, text) from public, anon, authenticated;
grant execute on function public.save_site_draft(uuid, uuid, integer, integer, jsonb) to service_role;
grant execute on function public.publish_site(uuid, uuid, integer) to service_role;
grant execute on function public.restore_site_version(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.set_site_plan(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Public read: the published version only
-- ---------------------------------------------------------------------------

-- Her published site and her CURRENT plan (the renderer applies its rights
-- to the published configuration, then the readability net). Never the
-- draft. business_not_found / site_not_published otherwise.
create function public.get_public_site(p_slug text)
returns table (
  version_id uuid,
  number integer,
  published_at timestamptz,
  plan text,
  schema_version integer,
  config jsonb
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
  select v.id, v.number, v.published_at, s.plan, v.schema_version, v.config
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
