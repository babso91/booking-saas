-- Read-only. The privileges of our schemas (public, private) in a
-- normalized form (one line per object, grants sorted), including the
-- default privileges of postgres. Run on the source and on a restored copy:
-- the outputs must be identical (diff). Used by verify-restore.sh.
with objects as (
  select 'function' as kind,
    n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as name,
    coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner)) as acl, p.proowner as owner
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  select 'relation', n.nspname || '.' || c.relname,
    coalesce(c.relacl, pg_catalog.acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner)),
    c.relowner
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S')
  union all
  select 'schema', n.nspname, coalesce(n.nspacl, pg_catalog.acldefault('n'::"char", n.nspowner)), n.nspowner
  from pg_catalog.pg_namespace n where n.nspname in ('public', 'private')
  union all
  select 'default', n.nspname || '/' || da.defaclobjtype::text, da.defaclacl, da.defaclrole
  from pg_catalog.pg_default_acl da join pg_catalog.pg_namespace n on n.oid = da.defaclnamespace
  where da.defaclrole = 'postgres'::regrole and n.nspname in ('public', 'private')
)
select o.kind || '|' || o.name || '|' || coalesce((
  select string_agg(g.entry, ',' order by g.entry)
  from (
    select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
      || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end as entry
    from pg_catalog.aclexplode(o.acl) a
  ) g), '')
from objects o
order by 1;
