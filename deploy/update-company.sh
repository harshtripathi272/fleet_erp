#!/usr/bin/env bash
# Rolls a new image out to one company's copy, or to every company file in a folder:
#
#   deploy/update-company.sh companies/acme.env [image]
#   deploy/update-company.sh companies/ [image]
#
# image defaults to the IMAGE in the company file (or its default, the `latest` tag). Settings and
# secrets are left as they are; to change those, edit the company file and run new-company.sh again.
# Cloud Run starts the new revision, waits for /api/v1/health/ready, then moves traffic to it. If the new
# revision fails to start, the old one keeps serving.
# DRY_RUN=1 prints the commands instead of running them.

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$here/lib.sh"

[ $# -ge 1 ] || fail "Usage: deploy/update-company.sh <company file or folder> [image]"
need_tool gcloud "Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"

update_one() {
  ( # each company in its own subshell, so one file's settings never leak into the next
    load_company "$1"
    image="${2:-$IMAGE}"
    say "$COMPANY: $image"
    run gcloud run deploy "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --image "$image"
  )
}

if [ -d "$1" ]; then
  shopt -s nullglob
  files=("$1"/*.env)
  [ ${#files[@]} -gt 0 ] || fail "No .env company files in $1"
  for f in "${files[@]}"; do update_one "$f" "${2:-}"; done
else
  update_one "$1" "${2:-}"
fi
