# Shared by a company kit's deploy scripts. Sourced, not run.
#
# Reads deploy/kit.env (from company.json, no secrets) and .env (the secrets, filled in by whoever deploys).
# DRY_RUN=1 prints every command instead of running it.

set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
run() { printf '+ %s\n' "$*"; if [ "$DRY_RUN" != 1 ]; then "$@"; fi; }
capture() { local placeholder="$1"; shift; if [ "$DRY_RUN" = 1 ]; then printf '+ %s\n' "$*" >&2; printf '%s' "$placeholder"; else "$@"; fi; }
exists() { if [ "$DRY_RUN" = 1 ]; then return 1; fi; "$@" >/dev/null 2>&1; }
need_tool() { command -v "$1" >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ] || fail "$1 is not installed. $2"; }

# Loads the kit's settings and the version: deploy/<target>.sh [version], never "latest". A package with the app's
# source (#103) builds that, and its version (APP_VERSION) is the default.
load_kit() {
  set -a
  # shellcheck disable=SC1091
  . "$kit/deploy/kit.env"
  # shellcheck disable=SC1091
  if [ -f "$kit/.env" ]; then . "$kit/.env"; fi
  set +a
  VERSION="${1:-${APP_VERSION:-}}"
  [ -n "$VERSION" ] || fail "Give the version to deploy (the shared image's tag), e.g. deploy/$(basename "$0") 1a2b3c4"
  [ "$VERSION" != latest ] || fail "Name a version, not latest"
  # Google Cloud's script has its own default (the project's registry); with the source, nothing is pulled.
  SHARED_IMAGE="${IMAGE_REPO:-}:$VERSION"
}

# The server settings named in .env.example: "secret" ones (marked "# SECRET." on the line above) or "plain".
# The Docker Compose section at the end is not the server's and is left out.
kit_vars() {
  awk -v want="$1" '
    /^# --- For Docker Compose/ { exit }
    /^[A-Z][A-Z0-9_]*=/ { name = substr($0, 1, index($0, "=") - 1); secret = (prev ~ /^# SECRET\./); if ((want == "secret") == secret) print name }
    { prev = $0 }
  ' "$kit/.env.example"
}

# Every secret must have a value before anything is created.
need_secrets() {
  local missing=()
  for name in $(kit_vars secret); do [ -n "${!name:-}" ] || missing+=("$name"); done
  [ "${#missing[@]}" = 0 ] || [ "$DRY_RUN" = 1 ] || fail "Fill in ${missing[*]} in .env (or set them in the shell)"
}

# A JSON string, for the platforms that take their settings as JSON.
json() { local v="${1//\/\\}"; v="${v//\"/\\\"}"; printf '"%s"' "$v"; }
