#!/usr/bin/env bash
# Rolls a version out to one company's copy, or to every company file in a folder:
#
#   deploy/update-company.sh companies/acme.env [version]
#   deploy/update-company.sh companies/ [version]
#
# version is the image tag from build-image.sh; it defaults to the current git commit, never `latest`.
# A rollback is the same command with the previous version. Settings and secrets are left as they are;
# to change those, edit the company file and run new-company.sh again.
# Cloud Run starts the new revision, waits for /api/v1/health/ready, then moves traffic to it. If the new
# revision fails to start, the old one keeps serving.
# DRY_RUN=1 prints the commands instead of running them.

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$here/lib.sh"

[ $# -ge 1 ] || fail "Usage: deploy/update-company.sh <company file or folder> [version]"
VERSION="$(pick_version "${2:-}")"
need_tool gcloud "Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"

update_one() {
  ( # each company in its own subshell, so one file's settings never leak into the next
    load_company "$1"
    image="$IMAGE_REPO:$VERSION"
    say "$COMPANY: $image"
    need_image "$image"
    run gcloud run deploy "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --image "$image"
    # The rate-fetch job runs the same version as the service.
    if [ "$DRY_RUN" = 1 ] || exists gcloud run jobs describe "$RATES_JOB" --project "$PROJECT_ID" --region "$REGION"; then
      run gcloud run jobs update "$RATES_JOB" --project "$PROJECT_ID" --region "$REGION" --image "$image"
    fi
    if [ "$DRY_RUN" = 1 ] || exists gcloud run jobs describe "$ESCALATION_JOB" --project "$PROJECT_ID" --region "$REGION"; then
      run gcloud run jobs update "$ESCALATION_JOB" --project "$PROJECT_ID" --region "$REGION" --image "$image"
    fi
    if [ "$DRY_RUN" = 1 ] || exists gcloud run jobs describe "$REMINDERS_JOB" --project "$PROJECT_ID" --region "$REGION"; then
      run gcloud run jobs update "$REMINDERS_JOB" --project "$PROJECT_ID" --region "$REGION" --image "$image"
    fi
  )
}

if [ -d "$1" ]; then
  shopt -s nullglob
  files=("$1"/*.env)
  [ ${#files[@]} -gt 0 ] || fail "No .env company files in $1"
  for f in "${files[@]}"; do update_one "$f"; done
else
  update_one "$1"
fi
