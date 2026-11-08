-- Read-only checks after applying 20261105..20261108 on a hosted project.
-- One SELECT; every row must say ok = true.
-- Usage: scripts/staging/preflight.sh --after (or `supabase db query --linked -f`).

with checks(name, ok) as (
  values
    -- The four migrations, recorded in order after 20261103.
    ('migrations 20261105..08 recorded',
      (select count(*) = 4 from supabase_migrations.schema_migrations
        where version in ('20261105090000', '20261106090000',
                          '20261107090000', '20261108090000'))),
    ('no migration after 20261108 unknown to the repository',
      not exists (select 1 from supabase_migrations.schema_migrations
        where version > '20261108090000')),

    -- 20261105: mini-site tables, RLS on.
    ('sites / site_versions / site_assets with RLS',
      (select count(*) = 3 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relrowsecurity
          and c.relname in ('sites', 'site_versions', 'site_assets'))),
    ('publish_site and get_public_site exist',
      pg_catalog.to_regprocedure('public.get_public_site(text)') is not null
      or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_public_site')),

    -- 20261106: private photos bucket, as the migration declares it.
    ('bucket site-photos private, 10 MB, 4 image types',
      exists (select 1 from storage.buckets
        where id = 'site-photos' and public = false
          and file_size_limit = 10485760
          and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
          and cardinality(allowed_mime_types) = 4)),
    ('no storage policy opens site-photos to API roles',
      not exists (select 1 from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and (qual ilike '%site-photos%' or with_check ilike '%site-photos%'))),
    ('storage.objects has archived_at and is_delete_marker (reconciliation)',
      (select count(*) = 2 from information_schema.columns
        where table_schema = 'storage' and table_name = 'objects'
          and column_name in ('archived_at', 'is_delete_marker'))),
    ('photo maintenance tables exist',
      (select count(*) = 4 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in
          ('site_photo_purges', 'site_photo_conversions',
           'site_photo_orphans', 'site_photo_reconciliation'))),

    -- 20261107: beta gate.
    ('beta tables exist',
      pg_catalog.to_regclass('private.beta_invitations') is not null
      and pg_catalog.to_regclass('private.beta_access') is not null),
    ('every member of an existing business has beta access',
      not exists (select 1 from public.business_members m
        where not exists (select 1 from private.beta_access a
          where a.user_id = m.user_id))),
    ('trigger businesses_require_beta_access installed',
      exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'businesses' and not t.tgisinternal
          and t.tgname ilike '%beta%')),
    ('create_beta_invitation not executable by anon/authenticated',
      not has_function_privilege('anon',
        (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'create_beta_invitation' limit 1),
        'execute')
      and not has_function_privilege('authenticated',
        (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'create_beta_invitation' limit 1),
        'execute')),

    -- 20261108: category move.
    ('move_service_category exists',
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'move_service_category'))
)
select name, ok from checks order by ok, name;
