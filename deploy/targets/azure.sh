#!/usr/bin/env bash
# Deploys this company to Azure Container Apps from its kit:  deploy/azure.sh <version>
# Not yet tested in CI: read it before running it. DRY_RUN=1 prints the commands.
#
# A resource group with: a container registry holding this company's image, a Key Vault for the secrets
# (read by the app's own identity), an Azure Files share mounted at /data for uploaded files, the container
# app, and two scheduled jobs (daily exchange rates, approval escalation). Needs the Azure CLI and Docker,
# and read access to the shared image (docker login to its registry first).
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/targets/kit-lib.sh
. "$here/kit-lib.sh"
load_kit "${1:-}"
need_tool az "https://learn.microsoft.com/cli/azure/install-azure-cli"
need_tool docker "https://docs.docker.com/get-docker/"
need_secrets
APP="fleet-$COMPANY"
# Registry and storage names take only letters and digits, and are unique across Azure.
short="$(printf '%s' "$COMPANY" | tr -d '-' | cut -c1-16)"
REGISTRY="fleet$short"
VAULT="fleet-${COMPANY:0:17}"
STORAGE="fleet$short"
IMAGE="$REGISTRY.azurecr.io/$APP:$VERSION"
in_group() { run az "$@" --resource-group "$RESOURCE_GROUP"; }

say "Resource group $RESOURCE_GROUP ($LOCATION)"
run az group create --name "$RESOURCE_GROUP" --location "$LOCATION"

say "Image $IMAGE"
exists az acr show --name "$REGISTRY" --resource-group "$RESOURCE_GROUP" || in_group acr create --name "$REGISTRY" --sku Basic
run az acr login --name "$REGISTRY"
run docker build --build-arg IMAGE="$SHARED_IMAGE" -t "$IMAGE" "$kit"
run docker push "$IMAGE"

say "Identity, and its access to the image and the secrets"
exists az identity show --name "$APP" --resource-group "$RESOURCE_GROUP" || in_group identity create --name "$APP"
IDENTITY="$(capture '<identity id>' az identity show --name "$APP" --resource-group "$RESOURCE_GROUP" --query id --output tsv)"
PRINCIPAL="$(capture '<principal id>' az identity show --name "$APP" --resource-group "$RESOURCE_GROUP" --query principalId --output tsv)"
run az role assignment create --assignee "$PRINCIPAL" --role AcrPull --scope "$(capture '<registry id>' az acr show --name "$REGISTRY" --query id --output tsv)"
exists az keyvault show --name "$VAULT" || in_group keyvault create --name "$VAULT" --location "$LOCATION" --enable-rbac-authorization true
run az role assignment create --assignee "$PRINCIPAL" --role "Key Vault Secrets User" --scope "$(capture '<vault id>' az keyvault show --name "$VAULT" --query id --output tsv)"

say "Secrets in Key Vault $VAULT"
secret_refs=()
secret_envs=()
for name in $(kit_vars secret); do
  ref="$(printf '%s' "$name" | tr 'A-Z_' 'a-z-')"
  printf '+ az keyvault secret set --vault-name %s --name %s (value hidden)\n' "$VAULT" "$ref"
  if [ "$DRY_RUN" != 1 ]; then printf '%s' "${!name}" | az keyvault secret set --vault-name "$VAULT" --name "$ref" --file /dev/stdin >/dev/null; fi
  secret_refs+=("$ref=keyvaultref:https://$VAULT.vault.azure.net/secrets/$ref,identityref:$IDENTITY")
  secret_envs+=("$name=secretref:$ref")
done
plain_envs=()
for name in $(kit_vars plain); do plain_envs+=("$name=${!name:-}"); done

say "File share for uploaded files"
exists az storage account show --name "$STORAGE" --resource-group "$RESOURCE_GROUP" \
  || in_group storage account create --name "$STORAGE" --sku Standard_ZRS --kind StorageV2 --min-tls-version TLS1_2
run az storage share-rm create --storage-account "$STORAGE" --name files --quota 50 --resource-group "$RESOURCE_GROUP"
exists az containerapp env show --name "$APP-env" --resource-group "$RESOURCE_GROUP" || in_group containerapp env create --name "$APP-env" --location "$LOCATION"
printf '+ az containerapp env storage set --name %s-env --storage-name files (account key hidden)\n' "$APP"
if [ "$DRY_RUN" != 1 ]; then
  key="$(az storage account keys list --account-name "$STORAGE" --resource-group "$RESOURCE_GROUP" --query '[0].value' --output tsv)"
  az containerapp env storage set --name "$APP-env" --resource-group "$RESOURCE_GROUP" --storage-name files \
    --azure-file-account-name "$STORAGE" --azure-file-account-key "$key" --azure-file-share-name files --access-mode ReadWrite >/dev/null
fi

say "Container app $APP"
if exists az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP"; then
  in_group containerapp secret set --name "$APP" --secrets "${secret_refs[@]}"
  in_group containerapp update --name "$APP" --image "$IMAGE" --set-env-vars "${plain_envs[@]}" "${secret_envs[@]}"
else
  in_group containerapp create --name "$APP" --environment "$APP-env" --image "$IMAGE" \
    --registry-server "$REGISTRY.azurecr.io" --registry-identity "$IDENTITY" --user-assigned "$IDENTITY" \
    --target-port 3000 --ingress external --min-replicas 1 --max-replicas 1 --cpu 1 --memory 2Gi \
    --secrets "${secret_refs[@]}" --env-vars "${plain_envs[@]}" "${secret_envs[@]}"
fi
# The volume and the start-up check are set from YAML: the CLI has no flags for them.
spec="$(mktemp)"
trap 'rm -f "$spec"' EXIT
printf '%s\n' \
  'properties:' \
  '  template:' \
  '    volumes:' \
  '      - name: files' \
  '        storageName: files' \
  '        storageType: AzureFile' \
  '    containers:' \
  "      - name: $APP" \
  "        image: $IMAGE" \
  '        volumeMounts:' \
  '          - volumeName: files' \
  '            mountPath: /data' \
  '        probes:' \
  '          - type: Startup' \
  '            httpGet: { path: /api/v1/health/ready, port: 3000 }' \
  '            periodSeconds: 5' \
  '            failureThreshold: 24' > "$spec"
in_group containerapp update --name "$APP" --yaml "$spec"

say "Scheduled jobs"
for job in "rates|5 * * * *|dist/jobs/fetchRates.js" "escalate|*/15 * * * *|dist/jobs/escalate.js"; do
  IFS='|' read -r key cron script <<< "$job"
  if exists az containerapp job show --name "$APP-$key" --resource-group "$RESOURCE_GROUP"; then
    in_group containerapp job update --name "$APP-$key" --image "$IMAGE"
  else
    in_group containerapp job create --name "$APP-$key" --environment "$APP-env" --trigger-type Schedule --cron-expression "$cron" \
      --image "$IMAGE" --registry-server "$REGISTRY.azurecr.io" --registry-identity "$IDENTITY" --mi-user-assigned "$IDENTITY" \
      --replica-timeout 300 --replica-retry-limit 0 --cpu 0.5 --memory 1Gi --command node --args "$script" \
      --secrets "${secret_refs[@]}" --env-vars "${plain_envs[@]}" "${secret_envs[@]}"
  fi
done

say "Done: $COMPANY"
FQDN="$(capture '<app address>' az containerapp show --name "$APP" --resource-group "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn --output tsv)"
printf 'Domain: add a CNAME %s -> %s and the TXT record that this asks for:\n' "$DOMAIN" "$FQDN"
printf '  az containerapp hostname add --hostname %s --name %s --resource-group %s\n' "$DOMAIN" "$APP" "$RESOURCE_GROUP"
printf 'then: az containerapp hostname bind --hostname %s --name %s --resource-group %s --environment %s-env --validation-method CNAME\n' "$DOMAIN" "$APP" "$RESOURCE_GROUP" "$APP"
printf 'Check: curl -fsS https://%s/api/v1/health/ready\n' "$DOMAIN"
