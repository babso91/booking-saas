#!/usr/bin/env bash
# Phase A, steps 1 to 3 — run ON the server, from the Mac:
#   ssh vps-luminys 'bash -s' -- <sha> < deploy/hetzner/phase-a1-a3.sh | tee ~/phase-a1-a3.log
# after the source was copied to /opt/booking-saas-staging/src-<sha>
# (git archive, see README). Changes NOTHING that runs:
#   A1 prints the current Booking SaaS configuration (secrets masked);
#   A2 checks the copied source;
#   A3 tags the current image as …:before-cutover and builds the new image
#      at the lowest CPU and I/O priority. The running containers, Caddy and
#      the Luminys project are not touched. Values never leave the server.
set -euo pipefail

SHA="${1:?usage: phase-a1-a3.sh <sha>}"
PROJECT_DIR=/opt/booking-saas-staging
SRC="$PROJECT_DIR/src-$SHA"
DOMAIN=booking-saas-staging.duckdns.org

mask() {
  sed -E \
    -e 's/(PASSWORD|SECRET|TOKEN|KEY|PASS|AUTH|CREDENTIAL|PRIVATE|DSN|HMAC)([A-Z_]*)([=:] *)([^ ]+)/\1\2\3<masked>/Ig' \
    -e 's/\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{20,}/<bcrypt-hash>/g' \
    -e 's/(Bearer )[^ "]+/\1<masked>/Ig' \
    -e 's/((proxy-secret|secret|authorization|token|password|apikey|hmac)[^ ]*[ :=]+)"?[^ {}"]{8,}"?/\1<masked>/Ig' \
    -e 's/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/<jwt>/g' \
    -e 's/(sb_(secret|publishable)_)[A-Za-z0-9_-]+/\1<masked>/g' \
    -e 's#(postgres(ql)?://[^:/]+:)[^@]+@#\1<masked>@#g'
}
section() { printf '\n===== %s\n' "$*"; }

app_id=$(docker compose -p booking-saas-staging ps -q app)
[ -n "$app_id" ] || { echo "STOP: no running app service in project booking-saas-staging"; exit 1; }

# ---------------------------------------------------------------- A1
section "A1 compose files of booking-saas-staging (masked)"
files=$(docker inspect "$app_id" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
echo "files: $files"
for f in $(echo "$files" | tr ',' ' '); do echo "--- $f"; mask <"$f"; done
ls -la "$PROJECT_DIR"

section "A1 app container"
docker inspect "$app_id" --format 'name={{.Name}} image={{.Config.Image}} imageid={{.Image}}
networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}}(aliases {{$v.Aliases}}) {{end}}
cmd={{json .Config.Cmd}} entrypoint={{json .Config.Entrypoint}} user={{.Config.User}}
labels.revision={{index .Config.Labels "org.opencontainers.image.revision"}}
healthcheck={{json .Config.Healthcheck}}'
echo "env NAMES:"; docker inspect "$app_id" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -E 's/=.*//' | sort | sed 's/^/  /'
echo "public values (not secret, sent to every browser):"
docker inspect "$app_id" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^NEXT_PUBLIC_(APP_URL|SUPABASE_URL)=' | sed 's/^/  /'

section "A1 Caddy: version and the $DOMAIN block (masked)"
caddy_id=$(docker compose -p luminys ps -q caddy)
docker exec "$caddy_id" caddy version
docker inspect "$caddy_id" --format 'mounts={{range .Mounts}}{{.Source}}->{{.Destination}}({{.Mode}}) {{end}}'
awk -v d="$DOMAIN" 'index($0,d)&&/\{/{p=1} p{print} p&&/^\}/{exit}' /opt/luminys/Caddyfile | mask
echo "sha256 of the whole Caddyfile: $(sha256sum /opt/luminys/Caddyfile | cut -c1-16)…"

# ---------------------------------------------------------------- A2
section "A2 source $SRC"
[ -f "$SRC/Dockerfile" ] && [ -f "$SRC/package-lock.json" ] || { echo "STOP: $SRC is not the copied source"; exit 1; }
grep -q 'NEXT_OUTPUT' "$SRC/next.config.ts" || { echo "STOP: $SRC lacks the standalone option"; exit 1; }
ls "$SRC/supabase/migrations" | tail -1

# ---------------------------------------------------------------- A3
section "A3 keep the current image, build the new one (lowest priority)"
current_image=$(docker inspect "$app_id" --format '{{.Image}}')
docker tag "$current_image" booking-saas-staging:before-cutover
echo "current image kept as booking-saas-staging:before-cutover"

envs=$(docker inspect "$app_id" --format '{{range .Config.Env}}{{println .}}{{end}}')
pub() { printf '%s\n' "$envs" | sed -n "s/^$1=//p" | head -1; }
SUPABASE_URL=$(pub NEXT_PUBLIC_SUPABASE_URL)
PUBLISHABLE=$(pub NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
[ -n "$PUBLISHABLE" ] || PUBLISHABLE=$(pub NEXT_PUBLIC_SUPABASE_ANON_KEY)
[ -n "$SUPABASE_URL" ] && [ -n "$PUBLISHABLE" ] || { echo "STOP: Supabase public values not found in the app env (names above)"; exit 1; }
case "$SUPABASE_URL" in *osvlzlnwjnmjscpubawa*) ;; *) echo "STOP: the app does not point at staging"; exit 1 ;; esac

free -h | sed -n 2p
start=$(date +%s)
nice -n 19 ionice -c3 docker build \
  -t "booking-saas-staging:$SHA" \
  --build-arg NEXT_PUBLIC_APP_URL="https://$DOMAIN" \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE" \
  --build-arg GIT_COMMIT="$SHA" \
  "$SRC" 2>&1 | grep -E '^#[0-9]+ (DONE|ERROR|CACHED)|Compiled|Generating static|ERROR|error' | tail -25
echo "build: $(( $(date +%s) - start )) s"
docker image inspect "booking-saas-staging:$SHA" --format 'new image {{.RepoTags}} {{.Size}} bytes, revision {{index .Config.Labels "org.opencontainers.image.revision"}}'
docker run --rm --entrypoint node "booking-saas-staging:$SHA" -e "console.log('node', process.version)"

section "A3 nothing that runs was touched"
docker compose -p booking-saas-staging ps --format 'table {{.Service}}\t{{.Status}}'
docker compose -p luminys ps --format 'table {{.Service}}\t{{.Status}}'
echo "A1-A3 DONE"
