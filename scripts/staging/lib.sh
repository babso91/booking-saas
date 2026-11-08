# Shared helpers of the staging scripts. Sourced, never run.
# Portable: bash 3.2 (macOS) and Linux; BSD and GNU sed/grep/awk.

STAGING_REF="osvlzlnwjnmjscpubawa"
PG_MAJOR=17

die() {
  echo "STOP: $*" >&2
  exit 1
}

# PostgreSQL client tools of the server's major version (17): pg_dump must
# not be older than the server, and a newer one may write SQL that a 17
# server or psql does not read. PG_BIN may point at their folder, e.g.
#   export PG_BIN="$(brew --prefix postgresql@17)/bin"
use_pg_tools() {
  if [[ -n "${PG_BIN:-}" ]]; then
    PATH="$PG_BIN:$PATH"
  elif [[ -d /usr/lib/postgresql/$PG_MAJOR/bin ]]; then
    PATH="/usr/lib/postgresql/$PG_MAJOR/bin:$PATH"
  elif command -v brew >/dev/null 2>&1 && [[ -d "$(brew --prefix "postgresql@$PG_MAJOR" 2>/dev/null)/bin" ]]; then
    PATH="$(brew --prefix "postgresql@$PG_MAJOR")/bin:$PATH"
  fi
  export PATH
  local tool version
  for tool in pg_dump pg_dumpall psql; do
    command -v "$tool" >/dev/null 2>&1 ||
      die "$tool not found. On macOS: brew install postgresql@$PG_MAJOR"
    version=$("$tool" --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)*.*/\1/')
    [[ "$version" == "$PG_MAJOR" ]] ||
      die "$tool is version $version, $PG_MAJOR expected. On macOS: export PG_BIN=\"\$(brew --prefix postgresql@$PG_MAJOR)/bin\""
  done
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$1" >/dev/null; else shasum -a 256 -c "$1" >/dev/null; fi
}

# A connection string's host and port, without the password.
url_host() { printf '%s' "$1" | sed -E 's#^[a-z]+://[^@]*@##; s#/.*$##; s#\?.*$##'; }
url_user() { printf '%s' "$1" | sed -E 's#^[a-z]+://##; s#[:@].*$##'; }

# Supabase: the direct host db.<ref>.supabase.co is IPv6 only; the session
# pooler (aws-…pooler.supabase.com:5432, user postgres.<ref>) works over
# IPv4. The transaction pooler (port 6543) cannot run pg_dump: refused.
check_url() {
  local label="$1" url="$2"
  [[ "$url" == postgres://* || "$url" == postgresql://* ]] || die "$label is not a postgresql:// connection string"
  [[ "$url" != *"[YOUR-PASSWORD]"* ]] || die "$label still contains [YOUR-PASSWORD]"
  [[ "$(url_host "$url")" != *:6543 ]] || die "$label uses the transaction pooler (port 6543): take the Session pooler string (port 5432)"
}

# The project ref a Supabase connection string names (direct host or
# pooler user), or the host:port of any other server (local rehearsal).
url_ref() {
  local host user
  host=$(url_host "$1")
  user=$(url_user "$1")
  case "$host" in
    db.*.supabase.co*) printf '%s' "$host" | sed -E 's#^db\.([a-z0-9]+)\.supabase\.co.*#\1#' ;;
    *pooler.supabase.com*) printf '%s' "${user#postgres.}" ;;
    *) printf '%s' "$host" ;;
  esac
}

# Asks the operator to type `expected` (a project ref) before going on.
# CONFIRM_REF=<ref> answers it without a terminal (local rehearsal only).
confirm_ref() {
  local what="$1" expected="$2" answer
  if [[ -n "${CONFIRM_REF:-}" ]]; then
    [[ "$CONFIRM_REF" == "$expected" ]] || die "CONFIRM_REF does not match $expected"
    return 0
  fi
  [[ -t 0 ]] || die "confirmation needs a terminal (or CONFIRM_REF)"
  printf '%s\nType the project ref to continue (%s): ' "$what" "$expected" >&2
  read -r answer
  [[ "$answer" == "$expected" ]] || die "not confirmed"
}

# Role settings of a roles.sql (backup.sh) that a restore may replay.
# On Supabase, postgres is not a superuser: supautils reserves the platform
# roles, and only anon, authenticated, authenticator and service_role
# accept `ALTER ROLE … SET` from it. The CLI's role dump re-enables some
# settings of every platform role (statement_timeout, pgrst.*, …), reserved
# ones included (`ALTER ROLE "supabase_admin" …`): those belong to the
# platform of each project and are left to it. Our migrations create and
# alter no role: any other line (a role of ours) stops the restore.
API_ROLES='anon|authenticated|authenticator|service_role'
PLATFORM_ROLES='anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin'

# Prints the replayable lines; dies on a line that is not the platform's.
role_settings_to_replay() {
  local file="$1" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "" | SET\ * | RESET\ *) printf '%s\n' "$line" ;;
      *)
        if printf '%s' "$line" | grep -Eq "^ALTER ROLE \"($API_ROLES)\" SET "; then
          printf '%s\n' "$line"
        elif printf '%s' "$line" | grep -Eq "^(ALTER ROLE \"($PLATFORM_ROLES)\" |GRANT SET ON PARAMETER )"; then
          echo "  left to the platform: $(printf '%s' "$line" | sed -E 's/ TO .*//')" >&2
        else
          die "roles.sql holds a line that is not the platform's: $line"
        fi
        ;;
    esac
  done <"$file"
}
