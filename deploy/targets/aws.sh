#!/usr/bin/env bash
# Deploys this company to AWS App Runner from its kit:  deploy/aws.sh <version>
# Not yet tested in CI: read it before running it. DRY_RUN=1 prints the commands.
#
# Builds this company's image (the shared image plus this kit) and pushes it to ECR, keeps each secret in
# Secrets Manager as fleet/<company>/<NAME>, and creates or updates the App Runner service. Uploaded files
# go to the S3 connection in company.json (App Runner has no lasting disk). Needs the AWS CLI and Docker,
# and read access to the shared image (docker login to its registry first).
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/targets/kit-lib.sh
. "$here/kit-lib.sh"
load_kit "${1:-}"
need_tool aws "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
need_tool docker "https://docs.docker.com/get-docker/"
need_secrets
SERVICE="fleet-$COMPANY"
ACCOUNT="$(capture '<account>' aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
IMAGE="$REGISTRY/$SERVICE:$VERSION"

say "Image $IMAGE"
exists aws ecr describe-repositories --repository-names "$SERVICE" --region "$REGION" \
  || run aws ecr create-repository --repository-name "$SERVICE" --region "$REGION" --image-scanning-configuration scanOnPush=true
if [ "$DRY_RUN" != 1 ]; then aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"; fi
run docker build --build-arg IMAGE="$SHARED_IMAGE" -t "$IMAGE" "$kit"
run docker push "$IMAGE"

say "Secrets (Secrets Manager, fleet/$COMPANY/<NAME>)"
secrets_json=""
for name in $(kit_vars secret); do
  id="fleet/$COMPANY/$name"
  printf '+ store %s (value hidden)\n' "$id"
  if [ "$DRY_RUN" != 1 ]; then
    if exists aws secretsmanager describe-secret --secret-id "$id" --region "$REGION"; then
      printf '%s' "${!name}" | aws secretsmanager put-secret-value --secret-id "$id" --secret-string file:///dev/stdin --region "$REGION" >/dev/null
    else
      printf '%s' "${!name}" | aws secretsmanager create-secret --name "$id" --secret-string file:///dev/stdin --region "$REGION" >/dev/null
    fi
  fi
  arn="$(capture "arn:aws:secretsmanager:$REGION:$ACCOUNT:secret:$id" aws secretsmanager describe-secret --secret-id "$id" --region "$REGION" --query ARN --output text)"
  secrets_json="$secrets_json${secrets_json:+,}$(json "$name"):$(json "$arn")"
done
env_json=""
for name in $(kit_vars plain); do env_json="$env_json${env_json:+,}$(json "$name"):$(json "${!name:-}")"; done

say "Roles"
trust() { printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"%s"},"Action":"sts:AssumeRole"}]}' "$1"; }
if ! exists aws iam get-role --role-name "$SERVICE-ecr"; then
  run aws iam create-role --role-name "$SERVICE-ecr" --assume-role-policy-document "$(trust build.apprunner.amazonaws.com)"
  run aws iam attach-role-policy --role-name "$SERVICE-ecr" --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
fi
if ! exists aws iam get-role --role-name "$SERVICE-run"; then
  run aws iam create-role --role-name "$SERVICE-run" --assume-role-policy-document "$(trust tasks.apprunner.amazonaws.com)"
fi
# The service reads only this company's secrets.
policy="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"arn:aws:secretsmanager:$REGION:$ACCOUNT:secret:fleet/$COMPANY/*\"}]}"
run aws iam put-role-policy --role-name "$SERVICE-run" --policy-name secrets --policy-document "$policy"

say "App Runner service $SERVICE"
source_json="{\"ImageRepository\":{\"ImageIdentifier\":$(json "$IMAGE"),\"ImageRepositoryType\":\"ECR\",\"ImageConfiguration\":{\"Port\":\"3000\",\"RuntimeEnvironmentVariables\":{$env_json},\"RuntimeEnvironmentSecrets\":{$secrets_json}}},\"AutoDeploymentsEnabled\":false,\"AuthenticationConfiguration\":{\"AccessRoleArn\":\"arn:aws:iam::$ACCOUNT:role/$SERVICE-ecr\"}}"
health='{"Protocol":"HTTP","Path":"/api/v1/health/ready","Interval":10,"Timeout":5,"HealthyThreshold":1,"UnhealthyThreshold":5}'
instance="{\"Cpu\":\"1024\",\"Memory\":\"2048\",\"InstanceRoleArn\":\"arn:aws:iam::$ACCOUNT:role/$SERVICE-run\"}"
list_query="ServiceSummaryList[?ServiceName=='$SERVICE'].ServiceArn"
arn="$(capture '' aws apprunner list-services --region "$REGION" --query "$list_query" --output text)"
if [ -n "$arn" ] && [ "$arn" != None ]; then
  run aws apprunner update-service --service-arn "$arn" --source-configuration "$source_json" --health-check-configuration "$health" --instance-configuration "$instance" --region "$REGION"
else
  run aws apprunner create-service --service-name "$SERVICE" --source-configuration "$source_json" --health-check-configuration "$health" --instance-configuration "$instance" --region "$REGION"
  arn="$(capture '<service arn>' aws apprunner list-services --region "$REGION" --query "$list_query" --output text)"
fi

say "Domain $DOMAIN"
domains="$(capture '' aws apprunner describe-custom-domains --service-arn "$arn" --region "$REGION" --query 'CustomDomains[].DomainName' --output text)"
case " $domains " in *" $DOMAIN "*) ;; *) run aws apprunner associate-custom-domain --service-arn "$arn" --domain-name "$DOMAIN" --region "$REGION" ;; esac

say "Done: $COMPANY"
printf 'Add the DNS records listed by: aws apprunner describe-custom-domains --service-arn %s --region %s\n' "$arn" "$REGION"
printf 'Check: curl -fsS https://%s/api/v1/health/ready\n' "$DOMAIN"
