#!/usr/bin/env bash
# Builds the image (API, web app and console in one) with Cloud Build and pushes it to Artifact Registry.
# One image serves every company; each company's service runs it with its own settings.
#
#   deploy/build-image.sh <project-id> <region> [version]
#
# version defaults to the current git commit. Deploy it with new-company.sh or update-company.sh and the
# same version; there is no `latest`, so every company runs a named version.
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

say "Done"
printf 'Image: %s:%s\nRoll it out: deploy/update-company.sh <company file or folder> %s\n' "$REPO" "$VERSION" "$VERSION"
