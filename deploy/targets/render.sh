#!/usr/bin/env bash
# Writes render.yaml for this company:  deploy/render.sh <version>
# Not yet tested in CI: read it before running it.
#
# Render builds this kit's Dockerfile, so the folder goes in a private Git repository (without .env) and
# becomes a Blueprint in Render's dashboard. Secrets are left for Render to ask for (sync: false). The shared
# image must be readable by Render: add its registry under Render's registry credentials.
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/targets/kit-lib.sh
. "$here/kit-lib.sh"
load_kit "${1:-}"
out="$kit/render.yaml"
{
  printf '# Written by deploy/render.sh from company.json. A Blueprint: Render -> New -> Blueprint.\n'
  printf 'services:\n  - type: web\n    name: fleet-%s\n    runtime: docker\n    dockerfilePath: ./Dockerfile\n' "$COMPANY"
  printf '    region: %s\n    plan: standard\n    healthCheckPath: /api/v1/health/ready\n' "$REGION"
  printf '    # Uploaded files. A service with a disk runs as one instance.\n'
  printf '    disk:\n      name: files\n      mountPath: /data\n      sizeGB: 10\n'
  printf '    envVars:\n      - key: IMAGE\n        value: %s\n' "$(json "$SHARED_IMAGE")"
  for name in $(kit_vars plain); do printf '      - key: %s\n        value: %s\n' "$name" "$(json "${!name:-}")"; done
  for name in $(kit_vars secret); do printf '      - key: %s\n        sync: false\n' "$name"; done
  if [ -n "${DOMAIN:-}" ]; then printf '    domains:\n      - %s\n' "$DOMAIN"; fi
  # The exchange-rate fetch, hourly: it fetches once a day, after the time set in the app.
  printf '  - type: cron\n    name: fleet-%s-rates\n    runtime: docker\n    dockerfilePath: ./Dockerfile\n    region: %s\n' "$COMPANY" "$REGION"
  printf '    schedule: "5 * * * *"\n    dockerCommand: node dist/jobs/fetchRates.js\n    envVars:\n      - key: IMAGE\n        value: %s\n' "$(json "$SHARED_IMAGE")"
  for name in $(kit_vars plain); do printf '      - key: %s\n        value: %s\n' "$name" "$(json "${!name:-}")"; done
  for name in $(kit_vars secret); do printf '      - key: %s\n        sync: false\n' "$name"; done
} > "$out"
say "Wrote render.yaml"
printf 'Next: commit this folder (not .env) to a private repository, then Render -> New -> Blueprint -> that repository.\n'
printf 'Render asks for: %s\n' "$(kit_vars secret | tr '\n' ' ')"
printf 'Check: curl -fsS %s/api/v1/health/ready\n' "${APP_URL:-https://fleet-$COMPANY.onrender.com}"
