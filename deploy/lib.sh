# Shared helpers for the deploy scripts. Sourced, not run.
#
# DRY_RUN=1 prints every gcloud command instead of running it, so a new company's set-up can be read
# and checked before anything is created.

set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Prints and runs a command (only prints it in a dry run).
run() {
  printf '+ %s\n' "$*"
  if [ "$DRY_RUN" != 1 ]; then "$@"; fi
}

# Runs a command whose output the script needs; in a dry run, prints it and returns the placeholder.
capture() {
  local placeholder="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then printf '+ %s\n' "$*" >&2; printf '%s' "$placeholder"; else "$@"; fi
}

# True when a resource already exists (always false in a dry run, so every step is shown).
exists() {
  if [ "$DRY_RUN" = 1 ]; then return 1; fi
  "$@" >/dev/null 2>&1
}

need_tool() { command -v "$1" >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ] || fail "$1 is not installed. $2"; }

# Loads a company file (KEY=value lines; see company.env.example) and checks the required keys.
load_company() {
  local file="$1"
  [ -f "$file" ] || fail "No such company file: $file"
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
  for key in PROJECT_ID REGION COMPANY OWNER_EMAIL; do
    [ -n "${!key:-}" ] || fail "$key is missing in $file"
  done
  [[ "$COMPANY" =~ ^[a-z][a-z0-9-]{1,28}[a-z0-9]$ ]] || fail "COMPANY must be 3–30 lowercase letters, digits or hyphens, starting with a letter: $COMPANY"
  [[ "$OWNER_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || fail "OWNER_EMAIL does not look like an e-mail address: $OWNER_EMAIL"

  # Defaults for everything optional. Each is a setting in the company file.
  SERVICE="${SERVICE:-fleet-$COMPANY}"
  SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-fleet-$COMPANY}"
  BUCKET="${BUCKET:-$PROJECT_ID-$COMPANY-files}"
  IMAGE_REPO="${IMAGE_REPO:-$REGION-docker.pkg.dev/$PROJECT_ID/fleet/fleet-erp}"
  DOMAIN="${DOMAIN:-}"
  DOMAIN_MODE="${DOMAIN_MODE:-$([ -n "$DOMAIN" ] && echo lb || echo none)}"
  EGRESS="${EGRESS:-static}"
  NETWORK="${NETWORK:-default}"
  SUBNET="${SUBNET:-default}"
  MIN_INSTANCES="${MIN_INSTANCES:-0}"
  MAX_INSTANCES="${MAX_INSTANCES:-1}"
  CPU="${CPU:-1}"
  MEMORY="${MEMORY:-512Mi}"
  # Optional: without an e-mail server, the first Owner's password comes from OWNER_PASSWORD.
  SMTP_HOST="${SMTP_HOST:-}"
  SMTP_FROM="${SMTP_FROM:-}"
  SMTP_PORT="${SMTP_PORT:-587}"
  SMTP_SECURE="${SMTP_SECURE:-false}"
  SMTP_USER="${SMTP_USER:-}"
  CONSOLE_ENABLED="${CONSOLE_ENABLED:-false}"
  UPLOAD_MAX_MB="${UPLOAD_MAX_MB:-15}"
  REDIS_URL="${REDIS_URL:-}"

  case "$DOMAIN_MODE" in lb|mapping|none) ;; *) fail "DOMAIN_MODE must be lb, mapping or none" ;; esac
  case "$EGRESS" in static|open) ;; *) fail "EGRESS must be static or open" ;; esac
  if [ "$DOMAIN_MODE" != none ] && [ -z "$DOMAIN" ]; then fail "DOMAIN_MODE=$DOMAIN_MODE needs DOMAIN"; fi
  if [ "$MAX_INSTANCES" -gt 1 ] && [ -z "$REDIS_URL" ] && [ "${DRY_RUN:-0}" != 1 ]; then fail "MAX_INSTANCES above 1 needs REDIS_URL, so rate limits are shared"; fi
  # Behind the external load balancer there is one more proxy hop than on Cloud Run alone.
  TRUST_PROXY="${TRUST_PROXY:-$([ "$DOMAIN_MODE" = lb ] && echo 2 || echo 1)}"
  SA_EMAIL="$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"
  # The daily exchange-rate fetch. Cloud Scheduler isn't offered in every region (not africa-south1, as far as
  # we know: check with `gcloud scheduler locations list`); a trigger elsewhere still starts the job here.
  RATES_JOB="${RATES_JOB:-$SERVICE-rates}"
  # Moving up approvals that waited too long: the service scales to zero, so a timer inside it wouldn't run overnight.
  ESCALATION_JOB="${ESCALATION_JOB:-$SERVICE-escalate}"
  # The same for "Service due" reminders (the Maintenance area).
  REMINDERS_JOB="${REMINDERS_JOB:-$SERVICE-service-reminders}"
  SCHEDULER_REGION="${SCHEDULER_REGION:-$([ "$REGION" = africa-south1 ] && echo europe-west1 || echo "$REGION")}"
  # Watching it (#104): who gets the alerts, the monthly budget (in the billing account's currency), and how many
  # errors in 10 minutes count as failing.
  ALERT_EMAIL="${ALERT_EMAIL:-$OWNER_EMAIL}"
  BUDGET_MONTHLY="${BUDGET_MONTHLY:-50}"
  ERROR_ALERT_COUNT="${ERROR_ALERT_COUNT:-5}"
}

# The version to deploy: the one given, or the current git commit (the tag build-image.sh gives it).
# Never `latest`, so which version runs where is always known and a rollback names the version.
pick_version() {
  local version="${1:-}"
  [ -n "$version" ] || version="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --short HEAD 2>/dev/null || true)"
  [ -n "$version" ] || fail "Give the version to deploy (the image tag from build-image.sh)"
  [ "$version" != latest ] || fail "Name a version, not latest"
  printf '%s' "$version"
}

# Stops before deploying an image tag that was never built.
need_image() {
  if exists gcloud artifacts docker images describe "$1" --quiet; then return; fi
  [ "$DRY_RUN" = 1 ] || fail "No image $1. Build it first: deploy/build-image.sh $PROJECT_ID $REGION <version>"
}

# Reads a secret value from the named environment variable, or asks for it without echoing it.
read_secret() {
  local var="$1" label="$2" value="${!1:-}"
  if [ -z "$value" ] && [ "$DRY_RUN" != 1 ]; then
    read -r -s -p "$label: " value; printf '\n' >&2
  fi
  [ -n "$value" ] || [ "$DRY_RUN" = 1 ] || fail "$label is required (set $var or type it when asked)"
  printf '%s' "${value:-<$var>}"
}

# Creates a Secret Manager secret if missing and stores a new version from a value on stdin.
# The value never appears on a command line or in the output.
put_secret() {
  local name="$1" value="$2"
  if ! exists gcloud secrets describe "$name" --project "$PROJECT_ID"; then
    run gcloud secrets create "$name" --project "$PROJECT_ID" --replication-policy automatic
  fi
  printf '+ gcloud secrets versions add %s --data-file - (value hidden)\n' "$name"
  if [ "$DRY_RUN" != 1 ]; then printf '%s' "$value" | gcloud secrets versions add "$name" --project "$PROJECT_ID" --data-file - >/dev/null; fi
  run gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT_ID" \
    --member "serviceAccount:$SA_EMAIL" --role roles/secretmanager.secretAccessor --condition None --quiet
}

# Creates a secret only the first time (the JWT secret must not change on re-runs: it would sign everyone out).
put_secret_once() {
  local name="$1" value="$2"
  if exists gcloud secrets describe "$name" --project "$PROJECT_ID"; then
    printf '  %s already exists; kept.\n' "$name"
    run gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT_ID" \
      --member "serviceAccount:$SA_EMAIL" --role roles/secretmanager.secretAccessor --condition None --quiet
  else
    put_secret "$name" "$value"
  fi
}
