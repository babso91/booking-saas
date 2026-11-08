-- Read-only inventory of a hosted project, before (and after) a migration.
-- One SELECT, every name schema-qualified (the Management API's read-only
-- endpoint runs it as supabase_read_only_user and requires that).
-- Usage: node scripts/staging/audit.mjs (or psql against a local stack).
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
    ('storage.buckets'), ('storage.objects')
),
counts as (
  select 'rows' as section, t.name as item,
    case
      when pg_catalog.to_regclass(t.name) is null then 'absent'
      else (pg_catalog.xpath('/row/c/text()', pg_catalog.query_to_xml(
        pg_catalog.format('select count(*) as c from %s', t.name),
        false, true, '')))[1]::text
    end as value
  from tables t
),
migrations as (
  select 'migration' as section, m.version as item,
    coalesce(m.name, '') as value
  from supabase_migrations.schema_migrations m
),
buckets as (
  select 'bucket' as section, b.id as item,
    pg_catalog.format('public=%s limit=%s types=%s objects=%s',
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
  select 'extension' as section, e.extname::text as item, e.extversion as value
  from pg_catalog.pg_extension e
),
emails as (
  -- 20261019 queues a reminder for every future confirmed appointment with a
  -- client email, and the outbox may already hold pending emails: what an
  -- email transport would send once enabled.
  select 'email' as section, 'pending in outbox' as item,
    case when pg_catalog.to_regclass('public.email_events') is null then 'absent'
      else (pg_catalog.xpath('/row/c/text()', pg_catalog.query_to_xml(
        'select count(*) as c from public.email_events where status = ''pending''',
        false, true, '')))[1]::text end as value
  union all
  select 'email', 'future confirmed appointments',
    (select count(*)::text from public.appointments a
      where a.status = 'confirmed' and a.starts_at > pg_catalog.now())
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
union all select * from emails
order by 1, 2;
