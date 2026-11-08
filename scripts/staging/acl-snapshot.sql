-- Read-only. Prints, as SQL statements (one per row), the exact privileges
-- of the source database for our schemas (public, private): schemas,
-- tables, views, sequences, functions, and the default privileges of the
-- role postgres. backup.sh saves the output as acl.sql; restore.sh applies
-- it LAST.
--
-- Why: pg_dump writes privileges relative to PostgreSQL's built-in
-- defaults, not to a fresh Supabase project's, whose default privileges
-- grant EXECUTE and table access to anon and authenticated. Restored as is,
-- a service-only function (create_beta_invitation, …) becomes executable by
-- anon (verified on a rehearsal: 198 objects differed). This script first
-- revokes everything from the API roles and PUBLIC, then grants back exactly
-- what the source had.

with
api_roles(r) as (values ('PUBLIC'), ('anon'), ('authenticated'), ('service_role')),
objects as (
  select 'FUNCTION' as kind,
    pg_catalog.format('%I.%I(%s)', n.nspname, p.proname,
      pg_catalog.pg_get_function_identity_arguments(p.oid)) as name,
    coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner)) as acl,
    p.proowner as owner
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and not exists (select 1 from pg_catalog.pg_depend d
      where d.objid = p.oid and d.deptype = 'e')
  union all
  select case when c.relkind = 'S' then 'SEQUENCE' else 'TABLE' end,
    pg_catalog.format('%I.%I', n.nspname, c.relname),
    coalesce(c.relacl, pg_catalog.acldefault(
      (case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner)),
    c.relowner
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S')
  union all
  select 'SCHEMA', pg_catalog.format('%I', n.nspname),
    coalesce(n.nspacl, pg_catalog.acldefault('n'::"char", n.nspowner)), n.nspowner
  from pg_catalog.pg_namespace n
  where n.nspname in ('public', 'private')
),
revokes as (
  select 1 as step, o.kind, o.name,
    pg_catalog.format('REVOKE ALL ON %s %s FROM %s;', o.kind, o.name,
      (select string_agg(case when r = 'PUBLIC' then r else quote_ident(r) end, ', ') from api_roles)) as stmt
  from objects o
),
grants as (
  select 2 as step, o.kind, o.name,
    pg_catalog.format('GRANT %s ON %s %s TO %s%s;', a.privilege_type, o.kind, o.name,
      case when a.grantee = 0 then 'PUBLIC' else quote_ident(a.grantee::regrole::text) end,
      case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as stmt
  from objects o
  cross join lateral pg_catalog.aclexplode(o.acl) a
  where a.grantee <> o.owner
),
default_objtypes(t, word) as (
  values ('r', 'TABLES'), ('S', 'SEQUENCES'), ('f', 'FUNCTIONS')
),
default_revokes as (
  select 3 as step, 'DEFAULT' as kind, s.nspname || '/' || d.word as name,
    pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I REVOKE ALL ON %s FROM PUBLIC, anon, authenticated, service_role;',
      s.nspname, d.word) as stmt
  from (values ('public'), ('private')) s(nspname)
  cross join default_objtypes d
),
default_grants as (
  select 4 as step, 'DEFAULT', n.nspname || '/' || d.word,
    pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT %s ON %s TO %s;',
      n.nspname, a.privilege_type, d.word,
      case when a.grantee = 0 then 'PUBLIC' else quote_ident(a.grantee::regrole::text) end)
  from pg_catalog.pg_default_acl da
  join pg_catalog.pg_namespace n on n.oid = da.defaclnamespace
  join default_objtypes d on d.t = da.defaclobjtype
  cross join lateral pg_catalog.aclexplode(da.defaclacl) a
  where da.defaclrole = 'postgres'::regrole and n.nspname in ('public', 'private')
    and a.grantee <> 'postgres'::regrole
)
select stmt from (
  select * from revokes
  union all select * from grants
  union all select * from default_revokes
  union all select * from default_grants
) s
order by step, kind, name, stmt;
