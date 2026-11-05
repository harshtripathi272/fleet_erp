#!/usr/bin/env bash
# Deploys this company to Fly.io from its kit:  deploy/fly.sh <version>
# Not yet tested in CI: read it before running it. DRY_RUN=1 prints the commands.
#
# Creates the app and a volume for uploaded files, sets the secrets with `fly secrets import` (values on
# standard input, never on a command line) and deploys this company's image, built by Fly's builder. The
# shared image must be readable by the builder (a public image, or one copied to registry.fly.io).
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/targets/kit-lib.sh
. "$here/kit-lib.sh"
load_kit "${1:-}"
need_tool fly "https://fly.io/docs/flyctl/install/"
need_secrets
APP="fleet-$COMPANY"
config="$kit/fly.toml"
{
  printf '# Written by deploy/fly.sh from company.json.\napp = %s\nprimary_region = %s\n\n' "$(json "$APP")" "$(json "$REGION")"
  printf '[build]\n  dockerfile = "Dockerfile"\n  [build.args]\n    IMAGE = %s\n\n' "$(json "$SHARED_IMAGE")"
  printf '[env]\n'
  for name in $(kit_vars plain); do printf '  %s = %s\n' "$name" "$(json "${!name:-}")"; done
  printf '\n# Uploaded files.\n[[mounts]]\n  source = "files"\n  destination = "/data"\n\n'
  printf '# One machine, always on: the timed work (rates, escalations) runs inside it.\n'
  printf '[http_service]\n  internal_port = 3000\n  force_https = true\n  auto_stop_machines = "off"\n  min_machines_running = 1\n\n'
  printf '  [[http_service.checks]]\n    method = "GET"\n    path = "/api/v1/health/ready"\n    interval = "15s"\n    timeout = "5s"\n    grace_period = "30s"\n\n'
  printf '[[vm]]\n  memory = "1gb"\n  cpus = 1\n'
} > "$config"

say "App $APP"
exists fly status --app "$APP" || run fly apps create "$APP"
if [ "$DRY_RUN" = 1 ] || ! fly volumes list --app "$APP" 2>/dev/null | grep -q files; then
  run fly volumes create files --app "$APP" --region "$REGION" --size 10 --yes
fi

say "Secrets"
printf '+ fly secrets import --app %s --stage (values hidden)\n' "$APP"
if [ "$DRY_RUN" != 1 ]; then
  for name in $(kit_vars secret); do printf '%s=%s\n' "$name" "${!name}"; done | fly secrets import --app "$APP" --stage
fi

say "Deploy"
run fly deploy --app "$APP" --config "$config" --remote-only --ha=false
if [ -n "${DOMAIN:-}" ]; then
  run fly certs add "$DOMAIN" --app "$APP"
  printf 'Add the DNS records shown by: fly certs show %s --app %s\n' "$DOMAIN" "$APP"
fi
printf 'Check: curl -fsS %s/api/v1/health/ready\n' "${APP_URL:-https://$APP.fly.dev}"
