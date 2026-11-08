#!/usr/bin/env bash
# Read-only audit of the hosted staging project. Changes nothing remotely:
# `migration list`, `db push --dry-run` and SELECT queries only.
#
#   SUPABASE_ACCESS_TOKEN=…  SUPABASE_DB_PASSWORD=…  scripts/staging/preflight.sh
#   scripts/staging/preflight.sh --after     # post-migration checks too
#
# Secrets come from the environment only: never written, never printed.
# Run from the repository root, on main (1965f8a or later).
set -euo pipefail

REF="${STAGING_PROJECT_REF:-osvlzlnwjnmjscpubawa}"
SB="npx --no-install supabase"
OUT="${OUT_DIR:-backups/staging-audit-$(date -u +%Y%m%dT%H%M%SZ)}"

: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN (supabase.com/dashboard/account/tokens)}"
: "${SUPABASE_DB_PASSWORD:?export SUPABASE_DB_PASSWORD (Project settings > Database)}"

mkdir -p "$OUT"
echo "Audit of $REF into $OUT (git $(git rev-parse --short HEAD))"

# Linking only writes supabase/.temp locally (git-ignored).
$SB link --project-ref "$REF" --password "$SUPABASE_DB_PASSWORD" >/dev/null

echo "== Migrations: local files vs hosted history"
$SB migration list --linked --password "$SUPABASE_DB_PASSWORD" | tee "$OUT/migration-list.txt"

echo "== What db push WOULD apply (dry run, nothing applied)"
$SB db push --linked --dry-run --password "$SUPABASE_DB_PASSWORD" 2>&1 | tee "$OUT/push-dry-run.txt"

echo "== Inventory (counts only)"
$SB db query --linked -f scripts/staging/inventory.sql | tee "$OUT/inventory.txt"

if [[ "${1:-}" == "--after" ]]; then
  echo "== Post-migration checks (every row must be ok = true)"
  $SB db query --linked -f scripts/staging/postcheck.sql | tee "$OUT/postcheck.txt"
fi

echo
echo "Expected before migrating: hosted history ends at 20261103090000, and the"
echo "dry run lists exactly 20261105, 20261106, 20261107, 20261108, in that order."
echo "Anything else (a remote-only version, a gap, another order): STOP, no repair."
