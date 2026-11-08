#!/usr/bin/env bash
# Restores a backup made by backup.sh into an EMPTY throwaway project, then
# verifies it (verify-restore.sh).
#
#   export TARGET_REF=<ref of the throwaway project>
#   read -rs TARGET_DB_URL && export TARGET_DB_URL   # its Session pooler string
#   scripts/staging/restore.sh backups/staging-<UTC>
#
# Protections against the wrong target, all before any write:
#   - TARGET_REF is required and must be what TARGET_DB_URL names;
#   - neither may be staging, nor the project the backup came from;
#   - the target must be empty (no table of ours, no account);
#   - the operator types the ref to confirm;
#   - checksums of the backup are verified.
# One transaction: on any error nothing is left behind.
set -euo pipefail

DIR="${1:?usage: restore.sh <backup dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

: "${TARGET_REF:?export TARGET_REF (the throwaway project ref)}"
: "${TARGET_DB_URL:?export TARGET_DB_URL (the throwaway project, Session pooler)}"
check_url TARGET_DB_URL "$TARGET_DB_URL"
named=$(url_ref "$TARGET_DB_URL")
[[ "$named" == "$TARGET_REF" ]] || die "TARGET_DB_URL names '$named', not TARGET_REF '$TARGET_REF'"
[[ "$TARGET_REF" != "$STAGING_REF" && "$TARGET_DB_URL" != *"$STAGING_REF"* ]] ||
  die "the target is the staging project itself"
source_ref=$(sed -n 's/^source_ref=//p' "$DIR/manifest.txt")
[[ -n "$source_ref" && "$TARGET_REF" != "$source_ref" ]] || die "the target is the backup's source ($source_ref)"
use_pg_tools

(cd "$DIR" && sha256_check SHA256SUMS) || die "checksums of $DIR differ"

existing=$(psql "$TARGET_DB_URL" -At -v ON_ERROR_STOP=1 -c \
  "select (pg_catalog.to_regclass('public.businesses') is not null)::int + (select count(*) from auth.users)")
[[ "$existing" == "0" ]] || die "the target is not empty (tables or accounts found)"

confirm_ref "Restore $DIR (from $source_ref) INTO the empty project $TARGET_REF at $(url_host "$TARGET_DB_URL")." "$TARGET_REF"

# Platform-only grants (on server parameters) cannot be replayed by
# postgres and are not ours.
grep -v '^GRANT SET ON PARAMETER' "$DIR/roles.sql" >"$DIR/roles.restore.sql"

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
