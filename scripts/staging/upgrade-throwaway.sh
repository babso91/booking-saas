#!/usr/bin/env bash
# Upgrades the THROWAWAY project restored by restore.sh from staging's level
# (24 migrations, 20261016090000) to the 35 of the repository, then runs the
# post-checks. Rehearsal of the staging upgrade on real Supabase hosting.
#
#   (same TARGET_REF and TARGET_DB_URL as restore.sh)
#   scripts/staging/upgrade-throwaway.sh
#
# Refuses staging, refuses a target whose history is not exactly staging's
# observed level, shows the dry run, asks for the ref, then applies.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
cd "$HERE/../.."

: "${TARGET_REF:?export TARGET_REF (the throwaway project ref)}"
: "${TARGET_DB_URL:?export TARGET_DB_URL (the throwaway project, Session pooler)}"
check_url TARGET_DB_URL "$TARGET_DB_URL"
[[ "$(url_ref "$TARGET_DB_URL")" == "$TARGET_REF" ]] || die "TARGET_DB_URL does not name TARGET_REF"
[[ "$TARGET_REF" != "$STAGING_REF" && "$TARGET_DB_URL" != *"$STAGING_REF"* ]] ||
  die "this script never touches staging"
use_pg_tools
git diff --quiet 1965f8a -- supabase/migrations || die "supabase/migrations differs from main (1965f8a)"

LEVEL_SQL="select case when pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then 'no history'
  else (pg_catalog.xpath('/row/l/text()', pg_catalog.query_to_xml(
    'select count(*) || ''|'' || max(version) as l from supabase_migrations.schema_migrations',
    false, true, '')))[1]::text end"
level=$(psql "$TARGET_DB_URL" -At -v ON_ERROR_STOP=1 -c "$LEVEL_SQL")
[[ "$level" == "24|20261016090000" ]] || die "the target is at '$level', not staging's level 24|20261016090000"

echo "Dry run (nothing applied):"
npx --no-install supabase db push --db-url "$TARGET_DB_URL" --dry-run
confirm_ref "Apply the 11 migrations to the THROWAWAY project $TARGET_REF." "$TARGET_REF"
npx --no-install supabase db push --db-url "$TARGET_DB_URL" --yes

checks=$(SQL_DB_URL="$TARGET_DB_URL" node "$HERE/sql.mjs" "$HERE/postcheck.sql")
echo "$checks"
level=$(psql "$TARGET_DB_URL" -At -v ON_ERROR_STOP=1 -c "$LEVEL_SQL")
[[ "$level" == "35|20261108090000" ]] || die "after the upgrade the target is at '$level'"
[[ $(grep -cE '[|](t|true)$' <<<"$checks") -eq 13 ]] || die "post-checks failed"
echo "UPGRADE REHEARSED: 35 migrations, 13/13 post-checks."
