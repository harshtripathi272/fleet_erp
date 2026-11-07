#!/usr/bin/env bash
# Starts this company as a copy of its own on this computer (#103):  ./start.sh   (or double-click start.command)
#
# The first time, it makes .env with a new sign-in key and a first password for the owner, and prints that
# password once. Then it builds the app from the source in this package and starts it with its own database.
# --no-open: don't open the browser (for scripts and CI).
set -euo pipefail
cd "$(dirname "$0")"
open_browser=1
[ "${1:-}" = "--no-open" ] && open_browser=0

fail() { printf '\nError: %s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail "Docker isn't installed. Install Docker Desktop, start it, then run this again: https://www.docker.com/products/docker-desktop/"
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop, wait until it says it is running, then run this again."

set -a
# shellcheck disable=SC1091
. deploy/kit.env
set +a
port="${PORT:-8080}"

if [ ! -f .env ]; then
  cp .env.example .env
  # A fixed amount read first: nothing in the pipe stops early, so pipefail doesn't see tr killed by SIGPIPE.
  random() { head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c "1-$1"; }
  jwt="$(random 48)"
  password="Fleet$(random 10)7"
  # Fill in the two secrets this copy makes itself; nothing else is secret on this computer.
  sed -i.bak -e "s#^JWT_SECRET=.*#JWT_SECRET=${jwt}#" -e "s#^OWNER_PASSWORD=.*#OWNER_PASSWORD=${password}#" .env && rm -f .env.bak
  printf '\nFirst start. Sign in as %s with this password (it is also in .env; change it under Your account):\n\n    %s\n\n' "$OWNER_EMAIL" "$password"
fi

printf 'Building and starting. The first time takes a few minutes.\n'
docker compose --project-name "fleet-${COMPANY}-local" up -d --build

printf 'Waiting for it to answer'
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:${port}/api/v1/health/ready" >/dev/null 2>&1; then
    printf '\nReady: http://localhost:%s\n' "$port"
    if [ "$open_browser" = 1 ]; then (command -v open >/dev/null && open "http://localhost:${port}") || (command -v xdg-open >/dev/null && xdg-open "http://localhost:${port}") || true; fi
    exit 0
  fi
  printf '.'; sleep 2
done
fail "It hasn't answered after four minutes. See why with: docker compose --project-name fleet-${COMPANY}-local logs app"
