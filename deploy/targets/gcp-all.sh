#!/usr/bin/env bash
# One command to deploy this company to Google Cloud, made to run in Google Cloud Shell, where gcloud is
# already there and signed in:  ./deploy.sh
#
# It reads .env, builds the app's image from the source in this package (once per version, in Cloud Build), then
# runs deploy/gcp.sh, which makes the service account, bucket, secrets, Cloud Run service and scheduled jobs.
# Run it again at any time: every step checks what exists first. DRY_RUN=1 ./deploy.sh prints every command.
set -euo pipefail
cd "$(dirname "$0")"
DRY_RUN="${DRY_RUN:-0}"
say() { printf '\n== %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
run() { printf '+ %s\n' "$*"; if [ "$DRY_RUN" != 1 ]; then "$@"; fi; }
exists() { if [ "$DRY_RUN" = 1 ]; then return 1; fi; "$@" >/dev/null 2>&1; }

if [ ! -f .env ] && [ "$DRY_RUN" != 1 ]; then
  cp .env.example .env
  fail "Fill in the lines marked SECRET in .env (nano .env), then run ./deploy.sh again"
fi
command -v gcloud >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ] || fail "gcloud isn't here. Open Google Cloud Shell, which has it: https://console.cloud.google.com/?cloudshell=true"

set -a
# shellcheck disable=SC1091
. deploy/kit.env
set +a
VERSION="${1:-${APP_VERSION:-}}"
[ -n "$VERSION" ] || fail "Give the image version: ./deploy.sh <version>"
REPO="${IMAGE_REPO:-$REGION-docker.pkg.dev/$PROJECT_ID/fleet/fleet-erp}"

if [ -f app-source.tar.gz ]; then
  say "The app's image, version $VERSION"
  run gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com --project "$PROJECT_ID"
  if ! exists gcloud artifacts repositories describe fleet --location "$REGION" --project "$PROJECT_ID"; then
    run gcloud artifacts repositories create fleet --repository-format docker --location "$REGION" --project "$PROJECT_ID" --description "Fleet images"
  fi
  if exists gcloud artifacts docker images describe "$REPO:$VERSION" --project "$PROJECT_ID"; then
    printf 'Already built.\n'
  else
    run gcloud builds submit app-source.tar.gz --project "$PROJECT_ID" --region "$REGION" --tag "$REPO:$VERSION"
  fi
fi

exec deploy/gcp.sh "$VERSION"
