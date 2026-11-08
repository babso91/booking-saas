-- Fingerprint of every table that holds data of ours or of Auth/Storage:
-- row count and md5 of the rows in a stable order. Run on the source and
-- on a restored copy: the two outputs must be identical (diff).
-- Read-only; nothing is printed but counts and hashes.
select n.nspname || '.' || c.relname as "table",
  (pg_catalog.xpath('/row/c/text()', pg_catalog.query_to_xml(pg_catalog.format(
    'select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text as "rows",
  (pg_catalog.xpath('/row/h/text()', pg_catalog.query_to_xml(pg_catalog.format(
    'select coalesce(md5(string_agg(t::text, %L order by t::text)), %L) as h from %I.%I t',
    E'\n', '-', n.nspname, c.relname), false, true, '')))[1]::text as "md5"
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname in ('public', 'private', 'auth', 'storage', 'supabase_migrations')
  and not (n.nspname = 'storage' and c.relname in ('buckets_vectors', 'vector_indexes', 'migrations'))
  and not (n.nspname = 'auth' and c.relname = 'schema_migrations')
order by 1;
