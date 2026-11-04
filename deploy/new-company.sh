#!/usr/bin/env bash
# Sets up a new company's copy on Google Cloud, from nothing, in one command:
#
#   MONGODB_URI='mongodb+srv://…' SMTP_PASS='…' deploy/new-company.sh companies/acme.env [version]
#
# version is the image tag from build-image.sh; it defaults to the current git commit.
# The company file holds the settings (see deploy/company.env.example). Secrets come from the
# environment or are asked for, and go straight into Secret Manager. Every step checks what exists
# first, so the script can be run again after a failure or to change a setting.
# DRY_RUN=1 prints the commands instead of running them.
#
# What it creates, all named after COMPANY:
#   a service account that can read only this company's secrets and bucket;
#   a Cloud Storage bucket for uploaded documents (FILE_STORAGE=gcs), private, with versioning;
#   secrets for the database address, the JWT secret (generated once) and the SMTP password;
#   optionally a fixed outgoing address (Cloud NAT) for the MongoDB Atlas access list;
#   the Cloud Run service, in production mode, with the first Owner from OWNER_EMAIL;
#   optionally the domain, through an HTTPS load balancer or a Cloud Run domain mapping.
# The database itself (an Atlas cluster, or MongoDB on a VM) is made first, by hand: docs/deploy-gcp.md.

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$here/lib.sh"

[ $# -ge 1 ] && [ $# -le 2 ] || fail "Usage: deploy/new-company.sh <company file> [version]"
load_company "$1"
IMAGE="$IMAGE_REPO:$(pick_version "${2:-}")"
need_tool gcloud "Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"
need_tool openssl "It generates the JWT secret."

printf 'Company %s in project %s (%s). Image: %s. Domain: %s (%s). Egress: %s.\n' "$COMPANY" "$PROJECT_ID" "$REGION" "$IMAGE" "${DOMAIN:-none}" "$DOMAIN_MODE" "$EGRESS"
need_image "$IMAGE"

MONGODB_URI_VALUE="$(read_secret MONGODB_URI 'MongoDB connection string for this company')"
case "$MONGODB_URI_VALUE" in mongodb://*|mongodb+srv://*|'<MONGODB_URI>') ;; *) fail "MONGODB_URI must start with mongodb:// or mongodb+srv://" ;; esac
SMTP_PASS_VALUE=""
if [ -n "$SMTP_USER" ]; then SMTP_PASS_VALUE="$(read_secret SMTP_PASS 'SMTP password')"; fi

say "APIs"
apis="run.googleapis.com secretmanager.googleapis.com storage.googleapis.com iam.googleapis.com cloudscheduler.googleapis.com"
if [ "$DOMAIN_MODE" = lb ] || [ "$EGRESS" = static ]; then apis="$apis compute.googleapis.com"; fi
# shellcheck disable=SC2086
run gcloud services enable $apis --project "$PROJECT_ID"

say "Service account $SA_EMAIL"
if ! exists gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID"; then
  run gcloud iam service-accounts create "$SERVICE_ACCOUNT" --project "$PROJECT_ID" \
    --display-name "Marichi Fleet: $COMPANY"
fi

say "Bucket gs://$BUCKET for uploaded documents"
if ! exists gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT_ID"; then
  run gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT_ID" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi
# Versioning keeps a deleted or overwritten document recoverable (the backup for uploaded files).
run gcloud storage buckets update "gs://$BUCKET" --versioning
# The service only stores, reads and deletes objects in its own bucket.
run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member "serviceAccount:$SA_EMAIL" --role roles/storage.objectAdmin

say "Secrets"
put_secret "$COMPANY-mongodb-uri" "$MONGODB_URI_VALUE"
put_secret_once "$COMPANY-jwt-secret" "$( [ "$DRY_RUN" = 1 ] && echo '<generated>' || openssl rand -base64 48 | tr -d '\n')"
secrets="MONGODB_URI=$COMPANY-mongodb-uri:latest,JWT_SECRET=$COMPANY-jwt-secret:latest"
if [ -n "$SMTP_USER" ]; then
  put_secret "$COMPANY-smtp-pass" "$SMTP_PASS_VALUE"
  secrets="$secrets,SMTP_PASS=$COMPANY-smtp-pass:latest"
fi
# The exchange-rate provider's key, only when one is given (the provider itself is chosen in the app).
if [ -n "${RATE_FEED_API_KEY:-}" ]; then
  put_secret "$COMPANY-rate-feed-key" "$RATE_FEED_API_KEY"
  secrets="$secrets,RATE_FEED_API_KEY=$COMPANY-rate-feed-key:latest"
elif exists gcloud secrets describe "$COMPANY-rate-feed-key" --project "$PROJECT_ID"; then
  secrets="$secrets,RATE_FEED_API_KEY=$COMPANY-rate-feed-key:latest"
fi

egress_flags=()
if [ "$EGRESS" = static ]; then
  say "Fixed outgoing address (Cloud NAT) for the database access list"
  if ! exists gcloud compute addresses describe "$SERVICE-egress" --region "$REGION" --project "$PROJECT_ID"; then
    run gcloud compute addresses create "$SERVICE-egress" --region "$REGION" --project "$PROJECT_ID"
  fi
  if ! exists gcloud compute routers describe "$SERVICE-router" --region "$REGION" --project "$PROJECT_ID"; then
    run gcloud compute routers create "$SERVICE-router" --network "$NETWORK" --region "$REGION" --project "$PROJECT_ID"
  fi
  if ! exists gcloud compute routers nats describe "$SERVICE-nat" --router "$SERVICE-router" --region "$REGION" --project "$PROJECT_ID"; then
    run gcloud compute routers nats create "$SERVICE-nat" --router "$SERVICE-router" --region "$REGION" --project "$PROJECT_ID" \
      --nat-custom-subnet-ip-ranges "$SUBNET" --nat-external-ip-pool "$SERVICE-egress"
  fi
  # Direct VPC egress: all outgoing traffic leaves through the subnet, and so through the NAT address.
  egress_flags=(--network "$NETWORK" --subnet "$SUBNET" --vpc-egress all-traffic)
  EGRESS_IP="$(capture '<egress address>' gcloud compute addresses describe "$SERVICE-egress" --region "$REGION" --project "$PROJECT_ID" --format 'value(address)')"
fi

say "Cloud Run service $SERVICE"
if [ -n "$DOMAIN" ]; then
  APP_URL="https://$DOMAIN"
else
  # The Cloud Run address is known before the first deploy: https://<service>-<project number>.<region>.run.app
  PROJECT_NUMBER="$(capture '<project number>' gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
  APP_URL="https://$SERVICE-$PROJECT_NUMBER.$REGION.run.app"
fi
# Production refuses to start without these (see the refusals in docs/deploy-gcp.md).
env_vars="APP_URL=$APP_URL,OWNER_EMAIL=$OWNER_EMAIL,TRUST_PROXY=$TRUST_PROXY,FILE_STORAGE=gcs,GCS_BUCKET=$BUCKET"
env_vars="$env_vars,SMTP_HOST=$SMTP_HOST,SMTP_PORT=$SMTP_PORT,SMTP_SECURE=$SMTP_SECURE,CONSOLE_ENABLED=$CONSOLE_ENABLED,UPLOAD_MAX_MB=$UPLOAD_MAX_MB"
[ -z "$SMTP_USER" ] || env_vars="$env_vars,SMTP_USER=$SMTP_USER"
[ -z "$REDIS_URL" ] || env_vars="$env_vars,REDIS_URL=$REDIS_URL"
# The settings go in a YAML file, since values such as SMTP_FROM hold spaces and angle brackets.
env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT
IFS=',' read -r -a pairs <<< "$env_vars"
for pair in "${pairs[@]}" "SMTP_FROM=$SMTP_FROM"; do
  value="${pair#*=}"
  printf "%s: '%s'\n" "${pair%%=*}" "${value//\'/\'\'}" >> "$env_file"
done
sed 's/^/  /' "$env_file"
ingress=all
[ "$DOMAIN_MODE" != lb ] || ingress=internal-and-cloud-load-balancing
run gcloud run deploy "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --image "$IMAGE" --service-account "$SA_EMAIL" \
  --env-vars-file "$env_file" \
  --set-secrets "$secrets" \
  --min-instances "$MIN_INSTANCES" --max-instances "$MAX_INSTANCES" --cpu "$CPU" --memory "$MEMORY" \
  --ingress "$ingress" --allow-unauthenticated \
  --startup-probe "httpGet.path=/api/v1/health/ready,initialDelaySeconds=5,periodSeconds=5,failureThreshold=24" \
  "${egress_flags[@]}"

say "Daily exchange rates: Cloud Run job $RATES_JOB, started every hour by Cloud Scheduler ($SCHEDULER_REGION)"
# The job fetches only when due (after the fetch time set in the app, until a fetch that day succeeds),
# so starting it hourly keeps the app's setting the only fetch time and retries a failure the next hour.
run gcloud run jobs deploy "$RATES_JOB" --project "$PROJECT_ID" --region "$REGION" \
  --image "$IMAGE" --service-account "$SA_EMAIL" \
  --env-vars-file "$env_file" --set-secrets "$secrets" \
  --command node --args dist/jobs/fetchRates.js \
  --tasks 1 --max-retries 0 --task-timeout 300s --cpu 1 --memory 512Mi \
  "${egress_flags[@]}"
# The scheduler starts the job as the company's own service account, which may start only this job.
run gcloud run jobs add-iam-policy-binding "$RATES_JOB" --project "$PROJECT_ID" --region "$REGION" \
  --member "serviceAccount:$SA_EMAIL" --role roles/run.invoker --quiet
schedule_verb=create
if exists gcloud scheduler jobs describe "$RATES_JOB-hourly" --location "$SCHEDULER_REGION" --project "$PROJECT_ID"; then schedule_verb=update; fi
run gcloud scheduler jobs "$schedule_verb" http "$RATES_JOB-hourly" --project "$PROJECT_ID" --location "$SCHEDULER_REGION" \
  --schedule "5 * * * *" --time-zone UTC --http-method POST \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$RATES_JOB:run" \
  --oauth-service-account-email "$SA_EMAIL" --oauth-token-scope https://www.googleapis.com/auth/cloud-platform

dns=""
if [ "$DOMAIN_MODE" = lb ]; then
  say "HTTPS load balancer for $DOMAIN"
  lb="$SERVICE-lb"
  if ! exists gcloud compute addresses describe "$lb-ip" --global --project "$PROJECT_ID"; then
    run gcloud compute addresses create "$lb-ip" --global --project "$PROJECT_ID"
  fi
  if ! exists gcloud compute network-endpoint-groups describe "$lb-neg" --region "$REGION" --project "$PROJECT_ID"; then
    run gcloud compute network-endpoint-groups create "$lb-neg" --region "$REGION" --project "$PROJECT_ID" \
      --network-endpoint-type serverless --cloud-run-service "$SERVICE"
  fi
  if ! exists gcloud compute backend-services describe "$lb-backend" --global --project "$PROJECT_ID"; then
    run gcloud compute backend-services create "$lb-backend" --global --project "$PROJECT_ID" --load-balancing-scheme EXTERNAL_MANAGED
    run gcloud compute backend-services add-backend "$lb-backend" --global --project "$PROJECT_ID" \
      --network-endpoint-group "$lb-neg" --network-endpoint-group-region "$REGION"
  fi
  if ! exists gcloud compute url-maps describe "$lb-map" --project "$PROJECT_ID"; then
    run gcloud compute url-maps create "$lb-map" --project "$PROJECT_ID" --default-service "$lb-backend"
  fi
  if ! exists gcloud compute ssl-certificates describe "$lb-cert" --global --project "$PROJECT_ID"; then
    run gcloud compute ssl-certificates create "$lb-cert" --global --project "$PROJECT_ID" --domains "$DOMAIN"
  fi
  if ! exists gcloud compute target-https-proxies describe "$lb-https" --project "$PROJECT_ID"; then
    run gcloud compute target-https-proxies create "$lb-https" --project "$PROJECT_ID" --url-map "$lb-map" --ssl-certificates "$lb-cert"
  fi
  if ! exists gcloud compute forwarding-rules describe "$lb-https-rule" --global --project "$PROJECT_ID"; then
    run gcloud compute forwarding-rules create "$lb-https-rule" --global --project "$PROJECT_ID" --load-balancing-scheme EXTERNAL_MANAGED \
      --address "$lb-ip" --target-https-proxy "$lb-https" --ports 443
  fi
  # Plain http:// on the domain redirects to https://.
  if ! exists gcloud compute url-maps describe "$lb-redirect" --project "$PROJECT_ID"; then
    redirect="$(mktemp)"
    printf 'name: %s\ndefaultUrlRedirect:\n  httpsRedirect: true\n  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT\n' "$lb-redirect" > "$redirect"
    run gcloud compute url-maps import "$lb-redirect" --global --project "$PROJECT_ID" --source "$redirect" --quiet
    rm -f "$redirect"
  fi
  if ! exists gcloud compute target-http-proxies describe "$lb-http" --project "$PROJECT_ID"; then
    run gcloud compute target-http-proxies create "$lb-http" --project "$PROJECT_ID" --url-map "$lb-redirect"
  fi
  if ! exists gcloud compute forwarding-rules describe "$lb-http-rule" --global --project "$PROJECT_ID"; then
    run gcloud compute forwarding-rules create "$lb-http-rule" --global --project "$PROJECT_ID" --load-balancing-scheme EXTERNAL_MANAGED \
      --address "$lb-ip" --target-http-proxy "$lb-http" --ports 80
  fi
  LB_IP="$(capture '<load balancer address>' gcloud compute addresses describe "$lb-ip" --global --project "$PROJECT_ID" --format 'value(address)')"
  dns="Add a DNS A record: $DOMAIN -> $LB_IP. The certificate becomes active within about an hour of the record resolving."
elif [ "$DOMAIN_MODE" = mapping ]; then
  say "Domain mapping for $DOMAIN"
  if ! exists gcloud beta run domain-mappings describe --domain "$DOMAIN" --region "$REGION" --project "$PROJECT_ID"; then
    run gcloud beta run domain-mappings create --service "$SERVICE" --domain "$DOMAIN" --region "$REGION" --project "$PROJECT_ID"
  fi
  dns="Add the DNS records listed by: gcloud beta run domain-mappings describe --domain $DOMAIN --region $REGION --project $PROJECT_ID"
fi

say "Done: $COMPANY"
printf 'Address: %s\n' "$APP_URL"
[ -z "$dns" ] || printf '%s\n' "$dns"
if [ "$EGRESS" = static ]; then printf 'Database access list: allow only %s/32 (Atlas: Network Access).\n' "$EGRESS_IP"; fi
printf 'First Owner: %s gets an e-mail with a link to choose a password. If it does not arrive, use "Forgot password" with that address.\n' "$OWNER_EMAIL"
printf 'Check: curl -fsS %s/api/v1/health/ready\n' "$APP_URL"
