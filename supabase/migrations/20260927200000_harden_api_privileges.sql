-- Hardens the privileges granted to the Data API roles.
--
-- Findings from running the initial foundation on a real Supabase stack:
--
-- 1. Supabase grants ALL on new tables to `anon` and `authenticated` through
--    default privileges. That includes TRUNCATE, which is NOT subject to RLS:
--    any signed-in professional could have emptied a table for every tenant
--    from a code path able to issue it.
-- 2. Supabase also grants EXECUTE on new functions to `anon` and
--    `authenticated` explicitly. `revoke ... from public` in the initial
--    migration therefore left `handle_new_user` (security definer) and the
--    membership helpers executable by anonymous callers.
--
-- The posture becomes "deny by default": anonymous callers never touch tables
-- directly (public flows go through narrow security definer RPCs), signed-in
-- callers keep only DML filtered by RLS, and every new function must be
-- granted explicitly.

revoke all on all tables in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon;
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
-- EXECUTE to PUBLIC is a global built-in default: a per-schema rule cannot
-- remove it, so it is revoked globally for functions created by postgres.
alter default privileges for role postgres
  revoke execute on functions from public;

revoke all on function public.set_updated_at() from anon, authenticated;
revoke all on function public.handle_new_user() from anon, authenticated;
revoke all on function public.is_business_member(uuid) from anon;
revoke all on function public.has_business_role(uuid, public.business_member_role[]) from anon;

-- Internal helpers live outside the API-exposed schemas so they can never be
-- reached through PostgREST, whatever their grants.
create schema if not exists private;
revoke all on schema private from public;
