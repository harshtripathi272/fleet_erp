#!/usr/bin/env bash
# Deploys this company to Google Cloud from its kit:  deploy/gcp.sh <version>
#
# The repository's new-company.sh, run with this kit: it copies company.json, files/ and data/ into the
# company's bucket, which the Cloud Run service mounts and applies on start. Run it again to change anything:
# every step checks what exists first. DRY_RUN=1 prints the commands.
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/targets/kit-lib.sh
. "$here/kit-lib.sh"
load_kit "${1:-}"
need_secrets
KIT_DIR="$kit" exec "$here/new-company.sh" "$here/kit.env" "$VERSION"
