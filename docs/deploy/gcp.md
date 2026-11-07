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

Run `./deploy.sh` again from a new package (or `deploy/gcp.sh <version>`).
- Every step checks what exists first.
- The kit in the bucket is replaced; files left out of the kit are removed from `kit/files` and `kit/data`.
- **What re-running changes:** only what the company file changed since the last run. A setting changed in the app keeps its value unless the file changes that same setting. Nothing is deleted, and data rows already there are left alone.
- To only move to a new image, `deploy/update-company.sh deploy/kit.env <version>` from the kit also works.

## Running it (#104)

Deploying is one day; this is every day after. The package's guide on screen has each of these with the company's own names. **None of it has been tried against a real Google Cloud project yet.**

**Knowing it's down.** The script makes an uptime check on `https://<address>/api/v1/health/ready`. It runs every 5 minutes and expects `"mongo":"connected"`. An alert policy e-mails `ALERT_EMAIL` (the owner unless set) when the check fails for two minutes.

**Knowing it's failing.** A log metric counts the service's errors, and a second alert e-mails when there are more than `ERROR_ALERT_COUNT` (5) in 10 minutes. To read them:

```bash
gcloud run services logs read fleet-<company> --region <region> --project <project> --limit 100
gcloud logging read 'resource.labels.service_name=fleet-<company> AND severity>=ERROR' --project <project> --limit 50
```

**Cost.**
- **The budget:** `BUDGET_MONTHLY` (50 by default, in the billing account's currency). It e-mails at 50%, 90% and 100%, and stops nothing. Making it needs Billing Account Administrator or Costs Manager; without that, the script says so, and you make it in Billing → Budgets & alerts.
- **What costs money:** Cloud Run while it runs (always, with `MIN_INSTANCES` above 0), the load balancer (`DOMAIN_MODE=lb`), Cloud NAT and its reserved address (`EGRESS=static`), Cloud Storage, Secret Manager, Cloud Scheduler, and the Atlas cluster, billed by MongoDB.
- **No prices:** none were checked against Google's price list for this guide (7 November 2026). Use the [pricing calculator](https://cloud.google.com/products/calculator).

**Backups.**
- **What Atlas keeps:**
  - the free tier keeps no backups, so it isn't for real data;
  - Flex takes a daily snapshot;
  - M10 and above keep scheduled snapshots and can add continuous backup, to restore to a minute.

  Check the tier's page before relying on it.
- **Restore a snapshot:** Atlas → the cluster → Backup → Snapshots → Restore → this cluster. Everything written since that snapshot is lost.
- **A copy of your own:** these are the commands CI runs on every change, against the Compose package: it backs up, deletes the data, restores and checks.

  ```bash
  mongodump --uri "$MONGODB_URI" --gzip --archive=acme-$(date +%F).gz
  mongorestore --uri "$MONGODB_URI" --gzip --archive=acme-<date>.gz --drop
  ```
- **Files:** the bucket keeps every old version. A deleted or overwritten file comes back from its older version:

  ```bash
  gcloud storage ls --all-versions gs://<project>-<company>-files/<path>
  gcloud storage cp gs://<project>-<company>-files/<path>#<generation> gs://<project>-<company>-files/<path>
  ```

**Upgrades and going back.**
1. Take an Atlas snapshot.
2. Make a new package and run `./deploy.sh`. It builds the new version and starts a new revision; the old revision stays.
3. On start, the server moves the database forward.
4. To go back:

   ```bash
   gcloud run revisions list --service fleet-<company> --region <region> --project <project>
   gcloud run services update-traffic fleet-<company> --to-revisions <revision>=100 --region <region> --project <project>
   ```

   If the newer version changed the database, also restore the snapshot from step 1.

## Do

- **Keep `EGRESS=static`** and allow only the NAT address in Atlas.
- **Use Atlas M10 or above** for a company's real data, with continuous backups on.
- **Let bucket versioning stay on:** it is the backup of uploaded files.

## Don't

- **Don't give the service account more than its own secrets and bucket.**
- **Don't set `MAX_INSTANCES` above 1 without `REDIS_URL`** (Memorystore).
- **Don't put `.env` in the bucket:** `deploy/gcp.sh` copies only `company.json`, `files/` and `data/`.
