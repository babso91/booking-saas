#!/usr/bin/env bash
# Compares a restored database with the fingerprints taken at backup time.
#
#   TARGET_DB_URL=… scripts/staging/verify-restore.sh backups/staging-<UTC>
#
# Passes only if, for every table of ours, Auth, Storage (index) and the
# migration history, the row count and the md5 of the rows are identical,
# and the privileges of our schemas are identical. Read-only. Prints counts
# and hashes only.
set -euo pipefail

DIR="${1:?usage: verify-restore.sh <backup dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
: "${TARGET_DB_URL:?export TARGET_DB_URL}"
use_pg_tools
export SQL_DB_URL="$TARGET_DB_URL"

status=0
node "$HERE/sql.mjs" "$HERE/fingerprint.sql" >"$DIR/restored-fingerprint.txt"
if diff -u "$DIR/fingerprint.txt" "$DIR/restored-fingerprint.txt"; then
  echo "data: identical ($(wc -l <"$DIR/fingerprint.txt" | tr -d ' ') tables, migration history included)"
else
  echo "DATA DIFFERS" >&2
  status=1
fi

node "$HERE/sql.mjs" "$HERE/acl-fingerprint.sql" >"$DIR/restored-acl-fingerprint.txt"
if diff -u "$DIR/acl-fingerprint.txt" "$DIR/restored-acl-fingerprint.txt"; then
  echo "privileges: identical ($(wc -l <"$DIR/acl-fingerprint.txt" | tr -d ' ') objects)"
else
  echo "PRIVILEGES DIFFER (a service-only function may be open to anon)" >&2
  status=1
fi

if [[ $status -eq 0 ]]; then echo "RESTORE VERIFIED"; else echo "RESTORE NOT VERIFIED" >&2; fi
exit $status
