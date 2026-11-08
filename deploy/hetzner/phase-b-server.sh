#!/usr/bin/env bash
# Phase B on the server, one sub-command at a time, from the Mac:
#   ssh vps-luminys 'bash -s' -- <cmd> < deploy/hetzner/phase-b-server.sh
# Commands:
#   maintenance  stop ONLY the old app container (Caddy then answers 502 on
#                this domain only); records the other sites' status first
#   activate     after the migrations: keep the current files as
#                *.before-cutover, put the *.next files in place, start the
#                new app + cron, then the Caddyfile (same inode) + caddy reload
#   check        smoke checks without writing any data
#   rollback     ONLY BEFORE THE MIGRATIONS: the previous files, the
#                before-cutover image, caddy reload
# Never touches the Luminys containers (only `caddy reload` inside caddy),
# nor mailpit / email-hook (profile `email`, never named).
set -euo pipefail

CMD="${1:?usage: phase-b-server.sh maintenance|activate|check|rollback}"
P=/opt/booking-saas-staging
L=/opt/luminys
DOMAIN=booking-saas-staging.duckdns.org
cd "$P"
section() { printf '\n===== %s\n' "$*"; }
die() { echo "STOP: $*"; exit 1; }
caddy_id() { docker compose -p luminys ps -q caddy; }

# The other sites of the Caddyfile (n8n., stats., …): their status must not
# change (compared before/after, recorded in /root).
other_sites() {
  grep -E '^[a-zA-Z0-9.*-]+\.[a-z]{2,}( |,).*\{\s*$' "$L/Caddyfile" | awk '{print $1}' | tr -d ',' | grep -v "^$DOMAIN$" || true
}
site_status() {
  for s in $(other_sites); do
    printf '%s %s\n' "$s" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$s/" || echo error)"
  done
}

case "$CMD" in
maintenance)
  section "B1 other sites before"
  site_status | tee /root/booking-cutover-sites-before.txt
  section "B1 stop the old app only"
  docker compose stop app
  docker compose ps --format 'table {{.Service}}\t{{.Status}}'
  echo "https://$DOMAIN/ now answers $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/") (502 expected: maintenance)"
  section "B1 other sites after"
  site_status | tee /root/booking-cutover-sites-after-b1.txt
  diff /root/booking-cutover-sites-before.txt /root/booking-cutover-sites-after-b1.txt && echo "other sites: unchanged"
  echo "B1 DONE"
  ;;

activate)
  for f in runtime.env.next compose.yaml.next .env.next Caddyfile.next; do [ -s "$f" ] || die "$f missing (phase A)"; done
  docker image inspect "booking-saas-staging:$(sed -n 's/^RELEASE_SHA=//p' .env.next)" >/dev/null || die "new image missing"
  section "B6 keep the current files"
  for f in runtime.env compose.yaml .env; do cp -p "$f" "$f.before-cutover"; done
  cp -p "$L/Caddyfile" "$P/Caddyfile.before-cutover"
  ls -l ./*.before-cutover
  section "B6 new app and cron"
  cp runtime.env.next runtime.env && cp compose.yaml.next compose.yaml && cp .env.next .env
  chmod 600 runtime.env compose.yaml .env
  docker compose up -d app cron
  for i in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ] && break
    sleep 5
  done
  docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ] || die "the new app is not healthy (rollback is no longer possible after the migrations: see logs)"
  section "B6 Caddyfile in place (same inode) and reload"
  inode=$(stat -c %i "$L/Caddyfile")
  cat "$P/Caddyfile.next" >"$L/Caddyfile"
  chmod 600 "$L/Caddyfile"
  [ "$(stat -c %i "$L/Caddyfile")" = "$inode" ] || die "the Caddyfile inode changed"
  docker exec "$(caddy_id)" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
  docker exec "$(caddy_id)" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "caddy reloaded (no restart): $(docker compose -p luminys ps caddy --format '{{.Status}}')"
  section "B6 other sites after"
  site_status | tee /root/booking-cutover-sites-after-b6.txt
  diff /root/booking-cutover-sites-before.txt /root/booking-cutover-sites-after-b6.txt && echo "other sites: unchanged"
  echo "B6 DONE"
  ;;

check)
  section "B7 checks (no data written)"
  app=$(docker compose ps -q app)
  echo "image: $(docker inspect -f '{{.Config.Image}}' "$app"), health: $(docker inspect -f '{{.State.Health.Status}}' "$app")"
  echo "health (inside): $(docker exec "$app" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>console.log(t))")"
  echo "https://$DOMAIN/ without password: $(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/") (401 expected)"
  echo "/staging/auth-email (hook, GET): $(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/staging/auth-email") (unchanged route, not 401)"
  # Ingress, without writing: an invalid body reaches validation (400)
  # through Caddy only if Caddy added the right secret and address; sent
  # straight to the app with a forged secret it is refused first (503).
  pw_note="(through Caddy needs the Basic credentials: done from the Mac, see README)"
  direct=$(docker exec "$app" node -e "fetch('http://127.0.0.1:3000/api/bookings',{method:'POST',headers:{'content-type':'application/json','x-booking-client-ip':'203.0.113.9','x-booking-proxy-secret':'forged'},body:'{}'}).then(r=>r.json()).then(j=>console.log(j.error&&j.error.code))")
  echo "booking straight to the app with a forged secret: $direct (booking_unavailable expected)"
  n=$(docker exec "$(caddy_id)" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null | grep -o 'X-Booking-Client-Ip\|X-Booking-Proxy-Secret' | sort -u | wc -l)
  echo "ingress headers in Caddy's loaded config: $n of 2 (values not shown)"
  [ "$n" = 2 ] || echo "WARNING: Caddy does not add the ingress headers"
  echo "ingress through Caddy: $pw_note"
  section "B7 cron"
  docker compose logs --since 30m cron 2>&1 | tail -5
  section "B7 every service"
  docker compose ps --format 'table {{.Service}}\t{{.Status}}'
  docker compose -p luminys ps --format 'table {{.Service}}\t{{.Status}}'
  site_status
  echo "B7 DONE"
  ;;

rollback)
  section "ROLLBACK (only valid before the migrations)"
  [ -s compose.yaml.before-cutover ] || { docker compose start app; echo "old app restarted (nothing else had changed)"; exit 0; }
  docker compose rm -sf cron 2>/dev/null || true
  for f in runtime.env compose.yaml .env; do cp -p "$f.before-cutover" "$f"; done
  docker compose up -d app
  inode=$(stat -c %i "$L/Caddyfile")
  cat "$P/Caddyfile.before-cutover" >"$L/Caddyfile"
  [ "$(stat -c %i "$L/Caddyfile")" = "$inode" ] || die "the Caddyfile inode changed"
  docker exec "$(caddy_id)" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
  echo "ROLLBACK DONE"
  ;;

*) die "unknown command $CMD" ;;
esac
