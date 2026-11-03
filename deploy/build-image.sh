#!/usr/bin/env bash
# Builds the image (API, web app and console in one) with Cloud Build and pushes it to Artifact Registry.
# One image serves every company; each company's service runs it with its own settings.
#
#   deploy/build-image.sh <project-id> <region> [version]
#
# version defaults to the current git commit. The image is also tagged `latest`.
# DRY_RUN=1 prints the commands instead of running them.

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$here/lib.sh"

[ $# -ge 2 ] || fail "Usage: deploy/build-image.sh <project-id> <region> [version]"
PROJECT_ID="$1"; REGION="$2"
VERSION="${3:-$(git -C "$here/.." rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
need_tool gcloud "Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"

REPO="$REGION-docker.pkg.dev/$PROJECT_ID/fleet/fleet-erp"

say "APIs"
run gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com --project "$PROJECT_ID"

say "Artifact Registry repository fleet in $REGION"
if ! exists gcloud artifacts repositories describe fleet --location "$REGION" --project "$PROJECT_ID"; then
  run gcloud artifacts repositories create fleet --repository-format docker --location "$REGION" --project "$PROJECT_ID" \
    --description "Marichi Fleet images"
fi

say "Build $REPO:$VERSION"
run gcloud builds submit "$here/.." --project "$PROJECT_ID" --region "$REGION" \
  --tag "$REPO:$VERSION" --ignore-file "$here/gcloudignore"
run gcloud artifacts docker tags add "$REPO:$VERSION" "$REPO:latest" --quiet

say "Done"
printf 'Image: %s:%s\nRoll it out: deploy/update-company.sh <company file> %s:%s\n' "$REPO" "$VERSION" "$REPO" "$VERSION"
