#!/usr/bin/env bash
# READ-ONLY inventory of the Hetzner server, before replacing Booking SaaS.
# Changes nothing: lists containers, compose projects, Caddy, networks,
# resources and how the current Booking SaaS container is defined.
# Secrets are never printed: environment VALUES, Caddy password hashes and
# anything that looks like a key or token are masked.
#
# From the Mac:
#   ssh <user>@178.104.91.44 'bash -s' < deploy/hetzner/inventory.sh > hetzner-inventory.txt
# then send hetzner-inventory.txt (check it first: it holds no secret).
set -uo pipefail

mask() {
  sed -E \
    -e 's/(PASSWORD|SECRET|TOKEN|KEY|PASS|AUTH|CREDENTIAL|PRIVATE|DSN|DATABASE_URL|_URL)([A-Z_]*)=([^ ]+)/\1\2=<masked>/Ig' \
    -e 's/\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{20,}/<bcrypt-hash>/g' \
    -e 's/(Bearer )[^ "]+/\1<masked>/Ig' \
    -e 's/((proxy-secret|secret|authorization|token|password|apikey)[^ ]*[ :=]+)"?[^ {}"]{8,}"?/\1<masked>/Ig' \
    -e 's/(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/<jwt>/g' \
    -e 's/(sb_(secret|publishable)_)[A-Za-z0-9_-]+/\1<masked>/g' \
    -e 's/(re_)[A-Za-z0-9_]{10,}/\1<masked>/g' \
    -e 's#(postgres(ql)?://[^:/]+:)[^@]+@#\1<masked>@#g'
}
section() { printf '\n===== %s\n' "$*"; }

section "host"
hostname; uname -m; (grep -E '^(PRETTY_NAME)=' /etc/os-release || true)
uptime
free -h
df -h / /var/lib/docker 2>/dev/null
nproc

section "docker"
docker version --format 'server {{.Server.Version}}' 2>&1
docker compose version 2>&1

section "containers (all)"
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.Networks}}' 2>&1

section "compose projects"
docker compose ls -a 2>&1

section "images (booking, caddy, node)"
docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}\t{{.Size}}' 2>&1 | grep -iE 'REPOSITORY|booking|caddy|node'

section "networks"
docker network ls 2>&1

section "booking container(s): definition (env values masked)"
for c in $(docker ps -a --format '{{.Names}}' | grep -i booking); do
  echo "--- $c"
  docker inspect "$c" --format 'image={{.Config.Image}}
created={{.Created}}
restart={{.HostConfig.RestartPolicy.Name}}
memory_limit={{.HostConfig.Memory}}
ports={{json .HostConfig.PortBindings}}
networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}
compose_project={{index .Config.Labels "com.docker.compose.project"}}
compose_dir={{index .Config.Labels "com.docker.compose.project.working_dir"}}
compose_files={{index .Config.Labels "com.docker.compose.project.config_files"}}
compose_service={{index .Config.Labels "com.docker.compose.service"}}
cmd={{json .Config.Cmd}}
workdir={{.Config.WorkingDir}}
mounts={{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}' 2>&1
  echo "env variable NAMES:"
  docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -E 's/=.*//' | sort | sed 's/^/  /'
done

section "compose file of booking (secrets masked)"
for f in $(docker ps -a --format '{{.Names}}' | grep -i booking | xargs -r -I{} docker inspect {} --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' | tr ',' '\n' | sort -u); do
  echo "--- $f"; [ -r "$f" ] && mask <"$f" || echo "(not readable)"
done

section "caddy: container(s) and config (hashes masked)"
for c in $(docker ps -a --format '{{.Names}}' | grep -i caddy); do
  echo "--- container $c"
  docker inspect "$c" --format 'image={{.Config.Image}} mounts={{range .Mounts}}{{.Source}}->{{.Destination}} {{end}} ports={{json .HostConfig.PortBindings}}' 2>&1
  docker exec "$c" sh -c 'cat /etc/caddy/Caddyfile 2>/dev/null' | mask
done
if command -v caddy >/dev/null 2>&1 || [ -r /etc/caddy/Caddyfile ]; then
  echo "--- host /etc/caddy/Caddyfile"; mask </etc/caddy/Caddyfile 2>/dev/null
  systemctl is-active caddy 2>/dev/null
fi

section "listening ports"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | awk 'NR==1 || /:(80|443|3000|3001|8080|5432|6543) /'

section "systemd services and timers (booking, luminys, caddy, backup)"
systemctl list-units --type=service --no-pager 2>/dev/null | grep -iE 'booking|luminys|caddy|docker|backup'
systemctl list-timers --no-pager 2>/dev/null | grep -iE 'booking|luminys|backup|cron'

section "crontab entries mentioning booking or cron routes (secrets masked)"
(crontab -l 2>/dev/null; cat /etc/cron.d/* 2>/dev/null) | grep -iE 'booking|api/cron|curl' | mask

section "end"
