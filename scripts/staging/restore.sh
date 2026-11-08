#!/usr/bin/env bash
# Restores a backup made by backup.sh into an EMPTY project, then verifies it.
#
#   TARGET_DB_URL='postgresql://postgres:…@db.<throwaway-ref>.supabase.co:5432/postgres' \
#     scripts/staging/restore.sh backups/staging-<UTC>
#
# Rehearsal: a throwaway project (or a blank local stack). For a real
# recovery, a NEW project, then point the application at it. Never the
# source: the script refuses the staging ref and any non-empty target.
# One transaction: on any error nothing is left behind.
set -euo pipefail

DIR="${1:?usage: restore.sh <backup dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${TARGET_DB_URL:?export TARGET_DB_URL (the EMPTY target project)}"
REF="${STAGING_PROJECT_REF:-osvlzlnwjnmjscpubawa}"

if [[ "$TARGET_DB_URL" == *"$REF"* ]]; then
  echo "TARGET_DB_URL names the staging project itself: refused." >&2
  exit 1
fi
(cd "$DIR" && sha256sum --quiet -c SHA256SUMS) || { echo "checksums differ" >&2; exit 1; }

existing=$(psql "$TARGET_DB_URL" -At -v ON_ERROR_STOP=1 -c \
  "select (to_regclass('public.businesses') is not null)::int + (select count(*) from auth.users)")
if [[ "$existing" != "0" ]]; then
  echo "The target is not empty (tables or accounts found): refused." >&2
  exit 1
fi

# Platform-only grants (on server parameters) cannot be replayed by postgres
# and are not ours.
grep -v '^GRANT SET ON PARAMETER' "$DIR/roles.sql" > "$DIR/roles.restore.sql"

psql --single-transaction -v ON_ERROR_STOP=1 -q \
  --file "$DIR/roles.restore.sql" \
  --file "$DIR/schema.sql" \
  --file "$DIR/history-schema.sql" \
  --command 'SET session_replication_role = replica' \
  --file "$DIR/data.sql" \
  --file "$DIR/history.sql" \
  --command 'SET session_replication_role = origin' \
  --file "$DIR/acl.sql" \
  --dbname "$TARGET_DB_URL"

echo "Restored. Verifying…"
exec "$HERE/verify-restore.sh" "$DIR"
