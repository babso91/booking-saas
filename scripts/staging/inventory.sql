-- Read-only inventory of a hosted project, before (and after) a migration.
-- Runs one SELECT: no write, no lock beyond what a SELECT takes.
-- Usage: scripts/staging/preflight.sh (or `supabase db query --linked -f`).
--
-- Output: one row per fact (section, item, value). Counts only: no row
-- content, no email, no personal data.

with
tables(name) as (
  values
    ('auth.users'), ('auth.sessions'),
    ('public.businesses'), ('public.business_members'), ('public.profiles'),
    ('public.services'), ('public.service_categories'), ('public.business_hours'),
    ('public.appointments'), ('public.clients'), ('public.email_events'),
    ('public.sites'), ('public.site_versions'), ('public.site_assets'),
    ('private.beta_invitations'), ('private.beta_access'),
    ('storage.objects')
),
counts as (
  select 'rows' as section, t.name as item,
    case
      when pg_catalog.to_regclass(t.name) is null then 'absent'
      else (xpath('/row/c/text()', query_to_xml(
        format('select count(*) as c from %s', t.name), false, true, '')))[1]::text
    end as value
  from tables t
),
migrations as (
  select 'migration' as section, version as item, coalesce(name, '') as value
  from supabase_migrations.schema_migrations
),
buckets as (
  select 'bucket' as section, b.id as item,
    format('public=%s limit=%s types=%s objects=%s',
      b.public, b.file_size_limit, b.allowed_mime_types,
      (select count(*) from storage.objects o where o.bucket_id = b.id)) as value
  from storage.buckets b
),
storage_columns as (
  -- 20261106 (photo reconciliation) reads these two columns of
  -- storage.objects: they must exist on the hosted Storage version.
  select 'storage_column' as section, c.column_name::text as item,
    'present' as value
  from information_schema.columns c
  where c.table_schema = 'storage' and c.table_name = 'objects'
    and c.column_name in ('archived_at', 'is_delete_marker')
),
extensions as (
  select 'extension' as section, extname::text as item, extversion as value
  from pg_extension
),
server as (
  select 'server' as section, 'postgres' as item,
    pg_catalog.current_setting('server_version') as value
)
select * from server
union all select * from migrations
union all select * from counts
union all select * from buckets
union all select * from storage_columns
union all select * from extensions
order by 1, 2;
