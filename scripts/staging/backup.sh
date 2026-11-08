#!/usr/bin/env bash
# Logical backup of the hosted staging database, BEFORE any migration.
# Read-only on the source (pg_dump through the Supabase CLI, and SELECTs).
#
#   SUPABASE_ACCESS_TOKEN=…  SUPABASE_DB_PASSWORD=…  scripts/staging/backup.sh
#   BACKUP_DB_URL=postgresql://…  scripts/staging/backup.sh   # rehearsal on a local stack
#
# The token is the read-only one of the audit (database:read, projects:read);
# the database password is needed by pg_dump only. Both stay in your shell:
# never in a file, a chat, a ticket or a log.
#
# Produces backups/staging-<UTC>/ (git-ignored, mode 700). It holds personal
# data and secrets (Auth password hashes, the anti-abuse HMAC keys, encrypted
# calendar tokens): keep it on this machine only, delete it after the beta.
#   roles.sql            roles settings (platform-only grants filtered on restore)
#   schema.sql           schemas of ours (tables, functions, RLS policies, …)
#   history-schema.sql   supabase_migrations (absent from the plain dumps)
#   data.sql             data: auth, storage (index), public, private
#   history.sql          the migration history rows
#   acl.sql              exact privileges, replayed LAST on restore
#   fingerprint.txt      per-table row count + md5, taken right after the dump
#   acl-fingerprint.txt  normalized privileges
#   inventory.txt        counts (scripts/staging/inventory.sql)
#   SHA256SUMS
# Not included, by design or by nature: Storage FILES (the script stops if
# the bucket index is not empty: see the runbook), Auth settings and email
# templates (snapshot in the audit's auth.json, secrets re-entered by hand),
# API keys and SMTP password (never exported).
set -euo pipefail

REF="${STAGING_PROJECT_REF:-osvlzlnwjnmjscpubawa}"
SB="npx --no-install supabase"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${BACKUP_DIR:-backups/staging-$(date -u +%Y%m%dT%H%M%SZ)}"

if [[ -n "${BACKUP_DB_URL:-}" ]]; then
  SRC=(--db-url "$BACKUP_DB_URL")
  export SQL_DB_URL="$BACKUP_DB_URL"
else
  : "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (read-only token)}"
  : "${SUPABASE_DB_PASSWORD:?export SUPABASE_DB_PASSWORD (Project settings > Database)}"
  $SB link --project-ref "$REF" --password "$SUPABASE_DB_PASSWORD" >/dev/null
  SRC=(--linked --password "$SUPABASE_DB_PASSWORD")
fi
sql() { node "$HERE/sql.mjs" "$HERE/$1"; }

umask 077
mkdir -p "$OUT"

# Storage files are not in a SQL dump: refuse to call this a backup if any.
objects=$(sql inventory.sql | awk -F'|' '$1=="rows" && $2=="storage.objects" {print $3}')
if [[ "$objects" != "0" ]]; then
  echo "storage.objects counts '$objects' files: download them first (runbook § 2.1)." >&2
  exit 1
fi

$SB db dump "${SRC[@]}" --role-only -f "$OUT/roles.sql"
$SB db dump "${SRC[@]}" -f "$OUT/schema.sql"
$SB db dump "${SRC[@]}" -s supabase_migrations -f "$OUT/history-schema.sql"
# The two vector tables of Storage are platform-owned, unused (0 rows,
# checked by fingerprint.txt) and refused to postgres on restore.
$SB db dump "${SRC[@]}" --data-only --use-copy \
  -x storage.buckets_vectors -x storage.vector_indexes -f "$OUT/data.sql"
$SB db dump "${SRC[@]}" --data-only --use-copy -s supabase_migrations -f "$OUT/history.sql"

sql acl-snapshot.sql > "$OUT/acl.sql"
sql fingerprint.sql > "$OUT/fingerprint.txt"
sql acl-fingerprint.sql > "$OUT/acl-fingerprint.txt"
sql inventory.sql > "$OUT/inventory.txt"

for f in roles.sql schema.sql history-schema.sql data.sql history.sql acl.sql fingerprint.txt acl-fingerprint.txt; do
  [[ -s "$OUT/$f" ]] || { echo "EMPTY: $OUT/$f — not a backup" >&2; exit 1; }
done
grep -q 'CREATE TABLE IF NOT EXISTS "supabase_migrations"."schema_migrations"' "$OUT/history-schema.sql" \
  || { echo "migration history schema missing" >&2; exit 1; }

(cd "$OUT" && sha256sum ./*.sql ./*.txt > SHA256SUMS)
ls -l "$OUT"
echo
echo "Backup written to $OUT."
echo "It is NOT verified yet: restore it on a throwaway project (restore.sh)."
