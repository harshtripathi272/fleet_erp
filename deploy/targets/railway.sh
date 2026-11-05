#!/usr/bin/env bash
# Deploys this company to Railway from its kit:  deploy/railway.sh <version>
# Not yet tested in CI: read it before running it. DRY_RUN=1 prints the commands.
#
# Run it in this folder once it is linked to a Railway project and service (railway link). Add a volume
# mounted at /data in the dashboard before the first deploy, for uploaded files. Railway builds this kit's
# Dockerfile with the IMAGE variable; the shared image must be readable by Railway's builder.
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/targets/kit-lib.sh
. "$here/kit-lib.sh"
load_kit "${1:-}"
need_tool railway "https://docs.railway.com/guides/cli"
need_secrets

say "Variables"
args=(--set "IMAGE=$SHARED_IMAGE" --skip-deploys)
for name in $(kit_vars plain); do args+=(--set "$name=${!name:-}"); done
run railway variables "${args[@]}"
# The Railway CLI takes values only on its command line, so each secret is set without printing it.
for name in $(kit_vars secret); do
  printf '+ railway variables --set %s=... (value hidden)\n' "$name"
  if [ "$DRY_RUN" != 1 ]; then railway variables --set "$name=${!name}" --skip-deploys >/dev/null; fi
done

say "Deploy"
run railway up --detach "$kit"
if [ -n "${DOMAIN:-}" ]; then printf 'Add the domain: railway domain %s\n' "$DOMAIN"; fi
printf 'Check: curl -fsS https://%s/api/v1/health/ready\n' "${DOMAIN:-<the Railway address>}"
