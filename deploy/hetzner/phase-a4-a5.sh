#!/usr/bin/env bash
# Phase A, steps 4 and 5 — run ON the server, from the Mac:
#   ssh vps-luminys 'bash -s' -- <sha> < deploy/hetzner/phase-a4-a5.sh | tee ~/phase-a4-a5.log
# Prepares and VALIDATES, activates nothing. Every file is written NEXT TO
# the current one (*.next); the running containers, the live Caddyfile and
# the Luminys project are not touched. Secret values never leave the server
# and are never printed.
#
# Prerequisite: the Supabase server key written by the operator in
#   /opt/booking-saas-staging/secrets/service-role.key   (mode 600)
# (see README: ssh -t … read -rs …).
set -euo pipefail

SHA="${1:?usage: phase-a4-a5.sh <sha>}"
P=/opt/booking-saas-staging
L=/opt/luminys
DOMAIN=booking-saas-staging.duckdns.org
REF=osvlzlnwjnmjscpubawa
cd "$P"
section() { printf '\n===== %s\n' "$*"; }
die() { echo "STOP: $*"; exit 1; }

docker image inspect "booking-saas-staging:$SHA" >/dev/null 2>&1 || die "image booking-saas-staging:$SHA missing (run A1-A3)"
docker image inspect booking-saas-staging:before-cutover >/dev/null 2>&1 || die "rollback image before-cutover missing"

# ---------------------------------------------------------------- A4
section "A4 server key (checked, never printed)"
KEYFILE="$P/secrets/service-role.key"
[ -s "$KEYFILE" ] || die "$KEYFILE missing: write it first (README, step A4)"
chmod 600 "$KEYFILE"
KEY=$(tr -d '\r\n' <"$KEYFILE")
case "$KEY" in
  eyJ*) auth=(-H "apikey: $KEY" -H "Authorization: Bearer $KEY") ;;
  sb_secret_*) auth=(-H "apikey: $KEY") ;;
  *) die "the key is neither a service_role JWT nor an sb_secret_ key" ;;
esac
n=$(curl -sS --max-time 10 "${auth[@]}" "https://$REF.supabase.co/rest/v1/businesses?select=id" | grep -o '"id"' | wc -l)
[ "$n" -ge 1 ] || die "the key does not read staging's businesses as the service role"
echo "server key OK: reads $n businesses of $REF (RLS bypassed, as the service role)"

section "A4 runtime.env.next (mode 600)"
grep -E '^NEXT_PUBLIC_(APP_URL|SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY)=' runtime.env >/dev/null || die "runtime.env lacks the NEXT_PUBLIC_* lines"
umask 077
{
  echo "# Booking SaaS $SHA — prepared $(date -u +%FT%TZ) by phase-a4-a5.sh"
  grep -E '^NEXT_PUBLIC_(APP_URL|SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY)=' runtime.env
  echo "SUPABASE_SERVICE_ROLE_KEY=$KEY"
  echo "CRON_SECRET=$(openssl rand -hex 32)"
  echo "BOOKING_PROXY_SECRET=$(openssl rand -hex 32)"
  echo "BOOKING_TRUSTED_INGRESS="
  echo "# Emails: nothing leaves the outbox until a transport is validated."
  echo "EMAIL_TRANSPORT="
} >runtime.env.next
chmod 600 runtime.env.next
grep -q "^NEXT_PUBLIC_APP_URL=https://$DOMAIN$" runtime.env.next || die "NEXT_PUBLIC_APP_URL is not https://$DOMAIN"
echo "runtime.env.next: $(sed -E 's/=.*//' runtime.env.next | grep -v '^#' | tr '\n' ' ')"
PROXY_SECRET=$(sed -n 's/^BOOKING_PROXY_SECRET=//p' runtime.env.next)

section "A4 compose.yaml.next and .env.next"
printf 'RELEASE_SHA=%s\n' "$SHA" >.env.next
chmod 600 .env.next
python3 - "$SHA" <<'PY'
import re, sys
src = open("compose.yaml").read()
# app: health on /api/health (no page rendering every minute).
old_hc = "fetch('http://127.0.0.1:3000/', {signal: AbortSignal.timeout(5000)})"
assert src.count(old_hc) == 1, "app healthcheck not found"
out = src.replace(old_hc, "fetch('http://127.0.0.1:3000/api/health', {signal: AbortSignal.timeout(5000)})")
# cron: same image, internal network only, calls app with CRON_SECRET.
cron = '''
  # Scheduled jobs: calls app over the private network (never through Caddy,
  # no public bypass). Photos every 15 min, emails every 5 min (a no-op while
  # EMAIL_TRANSPORT is empty).
  cron:
    image: booking-saas-staging:${RELEASE_SHA:?Set the verified release SHA}
    pull_policy: never
    restart: unless-stopped
    init: true
    user: "1000:1000"
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 96m
    cpus: 0.10
    pids_limit: 16
    env_file: ./runtime.env
    entrypoint: ["node", "-e"]
    command:
      - |
        const base = "http://booking-saas-staging-app:3000/api/cron/";
        const auth = { Authorization: "Bearer " + process.env.CRON_SECRET };
        const run = async (job) => {
          try {
            const r = await fetch(base + job, { headers: auth, signal: AbortSignal.timeout(70000) });
            console.log(new Date().toISOString(), job, r.status);
          } catch (e) { console.log(new Date().toISOString(), job, "error", e.message); }
        };
        setTimeout(() => run("site-photos"), 60000);
        setInterval(() => run("site-photos"), 15 * 60000);
        setInterval(() => run("emails"), 5 * 60000);
    depends_on:
      app:
        condition: service_healthy
    networks:
      proxy: {}
    logging:
      driver: json-file
      options:
        max-size: "2m"
        max-file: "2"
'''
anchor = "\n  # Private capture only."
assert out.count(anchor) == 1, "mailpit anchor not found"
out = out.replace(anchor, cron + anchor)
open("compose.yaml.next", "w").write(out)
PY
chmod 600 compose.yaml.next
docker compose -f compose.yaml.next --env-file .env.next config -q && echo "compose.yaml.next: valid"
docker compose -f compose.yaml.next --env-file .env.next config --images | sort -u | sed 's/^/  image: /'
diff <(docker compose -f compose.yaml --env-file .env --profile email config --format json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(json.dumps({k:v for k,v in d["services"].items() if k!="app"},sort_keys=True))') \
     <(docker compose -f compose.yaml.next --env-file .env.next --profile email config --format json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(json.dumps({k:v for k,v in d["services"].items() if k not in ("app","cron")},sort_keys=True))') \
  >/dev/null || die "mailpit or email-hook would change"
echo "mailpit and email-hook: identical ($(docker compose -f compose.yaml.next --env-file .env.next --profile email config --services | tr '\n' ' '))"

# ---------------------------------------------------------------- A5
section "A5 Caddyfile.next (live Caddyfile untouched)"
python3 - "$L/Caddyfile" "$P/Caddyfile.next" "$DOMAIN" "$PROXY_SECRET" <<'PY'
import sys
live, out, domain, secret = sys.argv[1:]
text = open(live).read()
start = text.index(domain + " {")
# the block ends at the first line that is exactly "}" after its start
end = text.index("\n}\n", start) + 3
block = text[start:end]
anchor = "reverse_proxy booking-saas-staging-app:3000 {"
assert block.count(anchor) == 1, "app reverse_proxy not found in the block"
indent = block[block.index(anchor) - 16:block.index(anchor)]
indent = indent[indent.rfind("\n") + 1:] if "\n" in indent else "                "
inner = indent + "    "
lines = (
    f"\n{inner}# Trusted ingress (src/lib/client-identity.ts): the TCP peer and the"
    f"\n{inner}# proxy secret, REPLACING anything the client sent."
    f"\n{inner}header_up X-Booking-Client-Ip {{remote_host}}"
    f"\n{inner}header_up X-Booking-Proxy-Secret \"{secret}\""
)
new_block = block.replace(anchor, anchor + lines, 1)
open(out, "w").write(text[:start] + new_block + text[end:])
# everything outside the booking block must be byte-identical
new = open(out).read()
ns = new.index(domain + " {"); ne = new.index("\n}\n", ns) + 3
assert text[:start] == new[:ns] and text[end:] == new[ne:], "other blocks changed"
print("n8n., stats. and every other block: byte-identical outside the booking block")
PY
chmod 600 "$P/Caddyfile.next"
echo "diff (secret masked):"
diff "$L/Caddyfile" "$P/Caddyfile.next" | sed -E 's/(X-Booking-Proxy-Secret )"[^"]+"/\1"<masked>"/' || true

caddy_id=$(docker compose -p luminys ps -q caddy)
cp "$P/Caddyfile.next" "$L/data/caddy-config/.Caddyfile.booking-validate"
if docker exec "$caddy_id" caddy validate --config /config/.Caddyfile.booking-validate --adapter caddyfile 2>&1 | tail -1 | grep -q "Valid configuration"; then
  echo "Caddyfile.next: Valid configuration (validated by the running Caddy $(docker exec "$caddy_id" caddy version | cut -d' ' -f1))"
else
  docker exec "$caddy_id" caddy validate --config /config/.Caddyfile.booking-validate --adapter caddyfile 2>&1 | tail -5
  rm -f "$L/data/caddy-config/.Caddyfile.booking-validate"
  die "Caddyfile.next does not validate"
fi
rm -f "$L/data/caddy-config/.Caddyfile.booking-validate"
echo "live Caddyfile inode $(stat -c %i "$L/Caddyfile"), mode $(stat -c %a "$L/Caddyfile"), sha256 $(sha256sum "$L/Caddyfile" | cut -c1-16)… (unchanged)"

section "A4-A5 nothing that runs was touched"
docker compose -p booking-saas-staging ps --format 'table {{.Service}}\t{{.Status}}'
docker compose -p luminys ps --format 'table {{.Service}}\t{{.Status}}'
ls -l "$P"/runtime.env.next "$P"/compose.yaml.next "$P"/.env.next "$P"/Caddyfile.next
echo "A4-A5 DONE"
