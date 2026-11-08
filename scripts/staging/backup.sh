#!/usr/bin/env bash
# Logical backup of the hosted staging database, BEFORE any migration.
# Read-only on the remote side (pg_dump through the Supabase CLI).
#
#   SUPABASE_ACCESS_TOKEN=…  SUPABASE_DB_PASSWORD=…  scripts/staging/backup.sh
#
# Produces, in backups/staging-<UTC timestamp>/ (git-ignored, contains data:
# keep it off the repository and off shared drives, delete after the beta):
#   roles.sql   cluster roles
#   schema.sql  schemas (public, private, storage, auth, …)
#   data.sql    data, with COPY statements
#   SHA256SUMS
# Storage FILES are not in a database dump: inventory.sql counts them; if the
# count is not 0, download them separately before migrating.
#
# Restore (only on a decision, into a NEW empty project preferably): see
# docs/STAGING_BETA_RUNBOOK.md, "Retour arrière".
set -euo pipefail

REF="${STAGING_PROJECT_REF:-osvlzlnwjnmjscpubawa}"
SB="npx --no-install supabase"
OUT="backups/staging-$(date -u +%Y%m%dT%H%M%SZ)"

: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN}"
: "${SUPABASE_DB_PASSWORD:?export SUPABASE_DB_PASSWORD}"

umask 077
mkdir -p "$OUT"
$SB link --project-ref "$REF" --password "$SUPABASE_DB_PASSWORD" >/dev/null

$SB db dump --linked --password "$SUPABASE_DB_PASSWORD" --role-only -f "$OUT/roles.sql"
$SB db dump --linked --password "$SUPABASE_DB_PASSWORD" -f "$OUT/schema.sql"
$SB db dump --linked --password "$SUPABASE_DB_PASSWORD" --data-only --use-copy -f "$OUT/data.sql"
$SB migration list --linked --password "$SUPABASE_DB_PASSWORD" > "$OUT/migration-list.txt"

(cd "$OUT" && sha256sum roles.sql schema.sql data.sql migration-list.txt > SHA256SUMS)

for f in roles.sql schema.sql data.sql; do
  [[ -s "$OUT/$f" ]] || { echo "EMPTY DUMP: $OUT/$f — do not migrate" >&2; exit 1; }
done
ls -l "$OUT"
echo "Backup in $OUT. Check it restores (runbook, step 2.3) before migrating."
