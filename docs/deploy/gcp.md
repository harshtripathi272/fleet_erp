# Google Cloud

**Cloud Run** for the app, **MongoDB Atlas** for the database, **Secret Manager** for secrets, **Cloud Storage** for uploaded files and the kit, and **Cloud Scheduler** for the hourly jobs. The full runbook (database, network, domain, the refusals, cost) is [../deploy-gcp.md](../deploy-gcp.md). This page is what the kit adds.

## Deploy from a kit

```bash
unzip acme-haulage-kit.zip && cd acme-haulage-kit
cp .env.example .env            # MONGODB_URI, SMTP_PASS and each CONNECTION_* key
DRY_RUN=1 deploy/gcp.sh 1a2b3c4 # read every command first
deploy/gcp.sh 1a2b3c4
```

`deploy/gcp.sh` runs the repository's `new-company.sh` with the kit's settings (`deploy/kit.env`, written from `company.json`) and `KIT_DIR` set to the kit. On top of what `new-company.sh` always does, it:

- copies `company.json`, `files/` and `data/` into `gs://<bucket>/kit/`;
- mounts the bucket read-only at `/mnt/bucket` (a Cloud Storage volume, second-generation environment);
- sets `COMPANY_CONFIG=/mnt/bucket/kit/company.json`, so the service applies it on start.

The JWT secret is generated once and kept. Each `CONNECTION_*` key goes to Secret Manager as `<company>-connection-<name>`.

## Tested

- **In CI:** the image applies a kit on start (the Compose job uses the same image and the same `COMPANY_CONFIG`).
- **By dry run:** `DRY_RUN=1` prints every command.
- **Not run against a real project from the kit yet.** The volume flags (`--add-volume`, `--clear-volumes`) are the newest part. Check the first run's output.

## Change something, or upgrade

Run `deploy/gcp.sh <version>` again, with the new `company.json` or the new version.
- Every step checks what exists first.
- The kit in the bucket is replaced; files left out of the kit are removed from `kit/files` and `kit/data`.
- To only move to a new image, `deploy/update-company.sh deploy/kit.env <version>` from the kit also works.

## Do

- **Keep `EGRESS=static`** and allow only the NAT address in Atlas.
- **Use Atlas M10 or above** for a company's real data, with continuous backups on.
- **Let bucket versioning stay on:** it is the backup of uploaded files.

## Don't

- **Don't give the service account more than its own secrets and bucket.**
- **Don't set `MAX_INSTANCES` above 1 without `REDIS_URL`** (Memorystore).
- **Don't put `.env` in the bucket:** `deploy/gcp.sh` copies only `company.json`, `files/` and `data/`.
