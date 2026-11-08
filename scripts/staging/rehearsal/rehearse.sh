#!/usr/bin/env bash
# Rehearses the staging upgrade on the LOCAL stack only (npx supabase start):
# the database is reset to staging's level (24 migrations, 20261016090000),
# filled like staging, backed up, then upgraded to 35 and checked.
# Never touches a hosted project. Erases the local database.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
HERE=scripts/staging
DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
STATUS="$(mktemp)"

npx --no-install supabase db reset --version 20261016090000
npx --no-install supabase status -o json > "$STATUS"
node "$HERE/rehearsal/seed-staging-like.mjs" "$STATUS"

BACKUP_DIR=backups/rehearsal-old-state BACKUP_DB_URL="$DB" "$HERE/backup.sh"

npx --no-install supabase migration up --local
checks=$(SQL_DB_URL="$DB" node "$HERE/sql.mjs" "$HERE/postcheck.sql")
echo "$checks"
[[ $(grep -cE '[|](t|true)$' <<<"$checks") -eq 13 ]] || { echo "POSTCHECK FAILED" >&2; exit 1; }
node "$HERE/rehearsal/smoke-after-upgrade.mjs" "$STATUS"
echo "REHEARSAL OK (restore of the old-state backup: run restore.sh against a blank stack)"
