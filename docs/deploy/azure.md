# Azure

> **Not yet tested in CI.** The script follows Azure's documentation but has not been run end to end. Read it before running it, and report what you had to change.

| Piece | Service |
| --- | --- |
| App | **Container Apps**, from this company's image in Azure Container Registry |
| Database | **MongoDB Atlas** on Azure (recommended), or **Cosmos DB for MongoDB (vCore)**: check it supports the features used |
| Secrets | **Key Vault**, read by the app's own managed identity |
| Uploaded files | An **Azure Files** share mounted at `/data` |
| Scheduled work | Two **Container Apps jobs**: the exchange-rate fetch every hour, approval escalation every 15 minutes |

## Deploy

```bash
unzip acme-haulage-kit.zip && cd acme-haulage-kit
cp .env.example .env      # the SECRET lines
DRY_RUN=1 deploy/azure.sh 1a2b3c4
deploy/azure.sh 1a2b3c4
```

The script makes the following in one resource group (`fleet-<company>` unless `company.json` names one):
- the registry;
- an identity that can pull the image and read the vault;
- the vault and its secrets;
- the storage account and its share;
- the Container Apps environment, the app (one replica, start-up check on `/api/v1/health/ready`) and the two jobs.

It then prints the DNS records and the commands that add the company's domain with a managed certificate.

## Upgrade

Run `deploy/azure.sh <new version>`: the app and both jobs move to it. Roll back with the old version.

## Do

- **Use zone-redundant storage** for the share (the script asks for `Standard_ZRS`) and turn on share snapshots.
- **Keep one replica** unless `REDIS_URL` is set (Azure Cache for Redis).

## Don't

- **Don't put secrets in the app's plain settings:** the script only sets Key Vault references.
- **Don't scale the app to zero:** a sign-in after a cold start waits on the image pull.
