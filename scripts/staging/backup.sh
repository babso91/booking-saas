#!/usr/bin/env bash
# Logical backup of the hosted staging database, BEFORE any migration.
# Read-only on the source: pg_dump, pg_dumpall --roles-only and SELECTs in
# read-only transactions. No Docker, no Supabase CLI, no API token.
#
#   read -rs SOURCE_DB_URL && export SOURCE_DB_URL   # staging, Session pooler string
#   scripts/staging/backup.sh
#
# Needs the PostgreSQL 17 client tools (macOS: brew install postgresql@17)
# and Node 20+. The dump commands and their filters are those the Supabase
# CLI (2.118.0) runs for `supabase db dump` (printed by its --dry-run),
# executed here with the local pg_dump instead of a Docker container.
#
# Produces backups/staging-<UTC>/ (mode 700, git-ignored). It holds personal
# data and secrets (Auth password hashes, the anti-abuse HMAC keys, encrypted
# calendar tokens): keep it on this machine only, delete it after the beta.
#   roles.sql            role settings (platform roles filtered, as the CLI)
#   schema.sql           schemas of ours (tables, functions, RLS, triggers)
#   history-schema.sql   supabase_migrations, absent from the plain dumps
#   data.sql             data: auth, storage (index), public, private
#   history.sql          the migration history rows
#   acl.sql              exact privileges, replayed LAST on restore
#   fingerprint.txt      per-table row count + md5, taken after the dumps
#   acl-fingerprint.txt  normalized privileges
#   inventory.txt        counts
#   manifest.txt         source ref and host, tools, time (no password)
#   SHA256SUMS
# Not included: Storage FILES (the script stops if the bucket index is not
# empty), Auth settings and templates (non-secret snapshot in the audit's
# auth.json), API keys and SMTP password (never exported).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

: "${SOURCE_DB_URL:?export SOURCE_DB_URL (staging connection string, Session pooler)}"
check_url SOURCE_DB_URL "$SOURCE_DB_URL"
EXPECTED="${EXPECT_SOURCE_REF:-$STAGING_REF}"
REF=$(url_ref "$SOURCE_DB_URL")
[[ "$REF" == "$EXPECTED" ]] || die "SOURCE_DB_URL names '$REF', not the staging project '$EXPECTED'"
use_pg_tools
export SQL_DB_URL="$SOURCE_DB_URL"
sql() { node "$HERE/sql.mjs" "$HERE/$1"; }

state=$(psql "$SOURCE_DB_URL" -At -v ON_ERROR_STOP=1 -c "begin transaction read only" -c "
  select pg_catalog.current_setting('server_version') || ', ' ||
    (select count(*) from supabase_migrations.schema_migrations) || ' migrations, last ' ||
    (select max(version) from supabase_migrations.schema_migrations) || ', ' ||
    (select count(*) from auth.users) || ' accounts'" -c "commit" | sed -n 2p)
confirm_ref "Backup (read-only) of $REF at $(url_host "$SOURCE_DB_URL"): PostgreSQL $state." "$REF"

umask 077
OUT="${BACKUP_DIR:-backups/staging-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"

# Storage files are not in a SQL dump: refuse to call this a backup if any.
objects=$(sql inventory.sql | awk -F'|' '$1=="rows" && $2=="storage.objects" {print $3}')
[[ "$objects" == "0" ]] || die "storage.objects counts '$objects' files: download them first (runbook § 2.1)"

PLATFORM_SCHEMAS='information_schema|pg_*|_analytics|_realtime|_supavisor|auth|etl|extensions|pgbouncer|realtime|storage|supabase_functions|supabase_migrations|cron|dbdev|graphql|graphql_public|net|pgmq|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault'
PLATFORM_ROLES='anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin'

# The CLI's rewrites of a schema dump (idempotent CREATEs, platform objects
# commented out, comments dropped).
schema_filter() {
  local schemas="$1"
  sed -E 's/^\\(un)?restrict .*$/-- &/' |
    sed -E 's/^CREATE SCHEMA "/CREATE SCHEMA IF NOT EXISTS "/' |
    sed -E 's/^CREATE TABLE "/CREATE TABLE IF NOT EXISTS "/' |
    sed -E 's/^CREATE SEQUENCE "/CREATE SEQUENCE IF NOT EXISTS "/' |
    sed -E 's/^CREATE VIEW "/CREATE OR REPLACE VIEW "/' |
    sed -E 's/^CREATE FUNCTION "/CREATE OR REPLACE FUNCTION "/' |
    sed -E 's/^CREATE TRIGGER "/CREATE OR REPLACE TRIGGER "/' |
    sed -E 's/^CREATE PUBLICATION "supabase_realtime/-- &/' |
    sed -E 's/^CREATE EVENT TRIGGER /-- &/' |
    sed -E 's/^         WHEN TAG IN /-- &/' |
    sed -E 's/^   EXECUTE FUNCTION /-- &/' |
    sed -E 's/^ALTER EVENT TRIGGER /-- &/' |
    sed -E 's/^ALTER PUBLICATION "supabase_realtime_/-- &/' |
    sed -E 's/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /-- &/' |
    sed -E 's/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- &/' |
    sed -E 's/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/-- &/' |
    sed -E "s/^GRANT (.+) ON (.+) \"($schemas)\"/-- &/" |
    sed -E "s/^REVOKE (.+) ON (.+) \"($schemas)\"/-- &/" |
    sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/\1;/' |
    sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/\1;/' |
    sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/\1;/' |
    sed -E 's/^COMMENT ON EXTENSION (.+)/-- &/' |
    sed -E 's/^CREATE POLICY "cron_job_/-- &/' |
    sed -E 's/^ALTER TABLE "cron"/-- &/' |
    sed -E 's/^SET transaction_timeout = 0;/-- &/' |
    sed -E '/^--/d'
}
data_filter() { sed -E 's/^\\(un)?restrict .*$/-- &/'; }

echo "Dumping roles…"
{
  pg_dumpall --dbname="$SOURCE_DB_URL" --roles-only --role postgres \
    --quote-all-identifier --no-role-passwords --no-comments |
    sed -E 's/^\\(un)?restrict .*$/-- &/' |
    sed -E "s/^CREATE ROLE \"($PLATFORM_ROLES)\"/-- &/" |
    sed -E "s/^ALTER ROLE \"($PLATFORM_ROLES)\"/-- &/" |
    sed -E 's/ (NOSUPERUSER|NOREPLICATION)//g' |
    sed -E 's/^-- (.* SET "(pgaudit.*|pgrst.*|session_replication_role|statement_timeout|track_io_timing)" .*)/\1/' |
    sed -E "s/GRANT \".*\" TO \"($PLATFORM_ROLES)\"/-- &/" |
    sed -E '/^--/d' | uniq
  echo "RESET ALL;"
} >"$OUT/roles.sql"

echo "Dumping schemas…"
pg_dump --dbname="$SOURCE_DB_URL" --schema-only --quote-all-identifier --role postgres \
  --exclude-schema "$PLATFORM_SCHEMAS" | schema_filter "$PLATFORM_SCHEMAS" >"$OUT/schema.sql"
pg_dump --dbname="$SOURCE_DB_URL" --schema-only --quote-all-identifier --role postgres \
  --schema=supabase_migrations | schema_filter "" >"$OUT/history-schema.sql"

echo "Dumping data…"
{
  printf 'SET session_replication_role = replica;\n\n'
  pg_dump --dbname="$SOURCE_DB_URL" --data-only --quote-all-identifier --role postgres \
    --exclude-schema 'information_schema|pg_*|graphql|graphql_public|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault|etl|extensions|pgbouncer|realtime|supabase_migrations|_analytics|_realtime|_supavisor' \
    --exclude-table auth.schema_migrations --exclude-table storage.migrations \
    --exclude-table supabase_functions.migrations \
    --exclude-table storage.buckets_vectors --exclude-table storage.vector_indexes \
    --schema '*' | data_filter
  echo "RESET ALL;"
} >"$OUT/data.sql"
{
  printf 'SET session_replication_role = replica;\n\n'
  pg_dump --dbname="$SOURCE_DB_URL" --data-only --quote-all-identifier --role postgres \
    --schema supabase_migrations | data_filter
  echo "RESET ALL;"
} >"$OUT/history.sql"

echo "Privileges and fingerprints…"
sql acl-snapshot.sql >"$OUT/acl.sql"
sql fingerprint.sql >"$OUT/fingerprint.txt"
sql acl-fingerprint.sql >"$OUT/acl-fingerprint.txt"
sql inventory.sql >"$OUT/inventory.txt"
{
  echo "source_ref=$REF"
  echo "source_host=$(url_host "$SOURCE_DB_URL")"
  echo "source_state=$state"
  echo "pg_dump=$(pg_dump --version)"
  echo "taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$OUT/manifest.txt"

for f in roles.sql schema.sql history-schema.sql data.sql history.sql acl.sql fingerprint.txt acl-fingerprint.txt; do
  [[ -s "$OUT/$f" ]] || die "$OUT/$f is empty: not a backup"
done
grep -q 'CREATE TABLE IF NOT EXISTS "supabase_migrations"."schema_migrations"' "$OUT/history-schema.sql" ||
  die "migration history schema missing"
grep -q 'COPY "auth"."users"' "$OUT/data.sql" || die "Auth accounts missing from data.sql"

(cd "$OUT" && sha256 ./*.sql ./*.txt >SHA256SUMS)
ls -l "$OUT"
echo
echo "Backup written to $OUT ($state)."
echo "Not verified yet: restore it on a throwaway project (restore.sh)."
