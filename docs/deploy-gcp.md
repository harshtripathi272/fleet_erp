# A new company's copy on Google Cloud

Each company gets its own copy of the system: its own Cloud Run service, database, file bucket and secrets. One image serves every company. This runbook sets up a copy from nothing. The scripts in [`deploy/`](../deploy) do the Google Cloud part with one command per company.

| Piece | Where it runs | Made by |
| --- | --- | --- |
| The app (API, web app and console in one image) | Cloud Run, one service per company | `deploy/new-company.sh` |
| The image | Artifact Registry, built by Cloud Build | `deploy/build-image.sh` |
| The database | MongoDB Atlas, one cluster or database per company (or MongoDB on a VM) | by hand, step 2 |
| Uploaded documents (`FILE_STORAGE=gcs`) | a Cloud Storage bucket per company | `deploy/new-company.sh` |
| Secrets: database address, JWT secret, SMTP password | Secret Manager | `deploy/new-company.sh` |
| The domain and HTTPS | an external HTTPS load balancer with a Google-managed certificate (or a Cloud Run domain mapping) | `deploy/new-company.sh` |
| The first Owner | created at first start from `OWNER_EMAIL`, who is e-mailed a link | the app |

## What you need

- A Google Cloud project with billing turned on, and the right to create services, secrets, buckets and service accounts in it (Owner or Editor on the project).
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), signed in (`gcloud auth login`), plus `bash` and `openssl`. [Cloud Shell](https://shell.cloud.google.com) has all three. On Windows, use Cloud Shell or Git Bash.
- A MongoDB Atlas account, or a VM for MongoDB (step 2).
- SMTP credentials for outgoing e-mail, for example Mandrill.
- For a custom domain: access to its DNS.

None of these is in the repository. No account, project id or secret is committed; the company file holds only names and addresses.

## 1. Build the image (once per release)

```sh
deploy/build-image.sh <project-id> africa-south1
```

This creates the Artifact Registry repository `fleet` if it's missing, builds the `Dockerfile` with Cloud Build, and tags the image with the git commit, for example `fleet-erp:4fff8a7`. That tag is the version. There's no `latest`: every company runs a named version, so it's always clear what runs where, and a rollback names the version to go back to. Cloud Build uploads only what `deploy/gcloudignore` allows: never `.env` files, `node_modules`, local data or the tests.

## 2. Make the company's database

**MongoDB Atlas (recommended).**

1. Create a project for the company and a cluster in the region closest to the Cloud Run region. An M10 or larger cluster is needed for continuous backups with point-in-time restore. M0 and Flex clusters are for trials only.
2. **Database Access:** add a user with read and write access to the company's database only (for example `fleet_acme`).
3. **Network Access:** add the address the script prints at the end (with `EGRESS=static`, the default). Until you know it, add nothing; the service can't connect yet, and that's harmless.
4. **Backup:** turn on Cloud Backup, and continuous backup on M10+. Keep at least 7 days of snapshots.
5. Copy the connection string (`mongodb+srv://user:password@cluster…/fleet_acme?retryWrites=true&w=majority`). The script stores it in Secret Manager, and nobody needs to keep it anywhere else.

**Or MongoDB on a VM.** For a small company, or where Atlas isn't wanted: a Compute Engine VM (e2-small or larger, with a persistent disk) running MongoDB from the repository's `docker-compose.yml` (only the `mongo` service, with authentication turned on). Use MongoDB 8.2 or later on a recent Linux: MongoDB 8.0 refuses to start on kernel 6.19 and newer ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). Keep it on the VPC's internal address, so it isn't reachable from the internet. Set `EGRESS=static` so the service reaches it through the VPC. Back up with a nightly `mongodump --archive --gzip` copied to a Cloud Storage bucket, and take disk snapshots on a schedule.

## 3. Write the company file

```sh
cp deploy/company.env.example ~/companies/acme.env
```

Fill in `PROJECT_ID`, `REGION`, `COMPANY`, `OWNER_EMAIL`, `SMTP_HOST`, `SMTP_FROM`, and `DOMAIN` if the company has one. Every other setting has a default, listed in the example file. Keep company files outside the repository: they're one company's details.

## 4. Run the script

```sh
MONGODB_URI='mongodb+srv://…' SMTP_PASS='…' deploy/new-company.sh ~/companies/acme.env [version]
```

The version is the image tag from step 1, and defaults to the current git commit. The script stops if that image was never built.

Leave out `MONGODB_URI` and `SMTP_PASS`, and the script asks for them without showing what you type. Run it first with `DRY_RUN=1` to see every command without creating anything.

The script runs these steps in order. Each checks what already exists, so running it again after a failure, or to change a setting, is safe:

1. **APIs:** turns on Cloud Run, Secret Manager, Cloud Storage and IAM, plus Compute Engine for the load balancer or the fixed address.
2. **Service account** `fleet-<company>`: the service runs as it. It may read only this company's secrets and use only this company's bucket.
3. **Bucket** `<project>-<company>-files`, in the same region: private (public access prevention, uniform access), with object versioning, so a deleted or replaced document can be recovered.
4. **Secrets:** `<company>-mongodb-uri`, `<company>-smtp-pass`, and `<company>-jwt-secret`. The JWT secret is generated once with `openssl rand -base64 48` and kept on later runs, because changing it signs everyone out.
5. **Fixed outgoing address** (`EGRESS=static`): a reserved address, a Cloud Router and Cloud NAT. The service sends all its traffic through the VPC (Direct VPC egress), so Atlas sees one address. With `EGRESS=open` this step is skipped, and the Atlas access list has to allow `0.0.0.0/0`.
6. **The Cloud Run service** `fleet-<company>`, with:
   - `NODE_ENV=production` (set in the image);
   - `APP_URL`, `OWNER_EMAIL` and `TRUST_PROXY`;
   - `FILE_STORAGE=gcs` with the bucket;
   - the SMTP settings, and `CONSOLE_ENABLED=false`;
   - the three secrets;
   - one instance at most, by default;
   - a startup check on `GET /api/v1/health/ready`.

   A revision that fails to start never receives traffic.
7. **Domain:**
   - `DOMAIN_MODE=lb`, the default when `DOMAIN` is set: a global external HTTPS load balancer with a Google-managed certificate, and http:// redirected to https://. The service then accepts traffic only through the load balancer.
   - `mapping`: a Cloud Run domain mapping. It's free, but offered only in some regions, and not in `africa-south1`.
   - `none`: the service's own `https://…run.app` address.

At the end the script prints:
- the address;
- the DNS record to add;
- the address to allow in Atlas;
- what happens next for the first Owner.

## 5. Finish

1. **DNS:** add the A record the script printed. The certificate turns active within about an hour of the record resolving. `gcloud compute ssl-certificates describe fleet-<company>-lb-cert --global` shows its status.
2. **Atlas:** allow the printed egress address (`/32`) under Network Access.
3. **Check:** `curl -fsS https://<domain>/api/v1/health/ready` answers `{"success":true,…}` once the database is reachable.
4. **First Owner:** on first start the account for `OWNER_EMAIL` is created and sent a link to choose a password. If the e-mail doesn't arrive, use "Forgot password" on the sign-in page with that address. Nobody else can become the first Owner by signing up, and self sign-up stays off unless the company turns it on.
5. **Company settings:** the Owner signs in and fills in Masters → Company (name, country, base currency, modules). Then come the masters, or the first data from a migration. Sample data is never loaded in production; its route is off there.

## Updating

Build the new version, then roll it out to one company or to every company file in a folder:

```sh
deploy/build-image.sh <project-id> africa-south1            # prints the version, e.g. 9a1c2e4
deploy/update-company.sh ~/companies/acme.env 9a1c2e4
deploy/update-company.sh ~/companies/ 9a1c2e4
```

Without a version, both scripts use the current git commit, and they stop if that image was never built. Cloud Run starts the new revision and checks it before moving traffic; if it fails to start, the old one keeps serving.

**Rollback:** run the same command with the previous version, for example `deploy/update-company.sh ~/companies/acme.env 4fff8a7`.

**Which version runs where:** `gcloud run services describe fleet-<company> --region <region> --format 'value(spec.template.spec.containers[0].image)'` ends with the version.

To change a setting, edit the company file and run `new-company.sh` again. To replace a secret, for example after the SMTP password changes, run `new-company.sh` with the new value; the service picks up `:latest` on its next revision. The JWT secret isn't replaced on re-runs. To rotate it on purpose, add a new version with `gcloud secrets versions add <company>-jwt-secret` and redeploy; everyone signs in again.

## Backups and restore

- **Database:**
  - **Atlas:** Cloud Backup snapshots, plus point-in-time restore on M10 and larger. To restore, use Atlas → Backup → Restore, into the same cluster or a new one. For a new cluster, store its connection string with `new-company.sh` and redeploy.
  - **VM:** the nightly `mongodump` in a bucket, plus disk snapshots. To restore, run `mongorestore --archive --gzip`.
- **Uploaded documents:** the bucket keeps every object's earlier versions. `gcloud storage ls -a gs://<bucket>/<key>` lists them, and `gcloud storage cp` with the version number restores one. For a second copy in another region, schedule a Storage Transfer Service job to a backup bucket.
- **Secrets:** Secret Manager keeps every version. The database address can be rebuilt from Atlas; the JWT secret only signs sign-ins, so losing it only signs everyone out.
- **Settings:** the company file, kept outside the repository, together with the version in use (see Updating).

Test a restore once per company before go-live: restore the latest snapshot into a scratch cluster, and sign in to a scratch service pointed at it.

## What production refuses, and what it adds

The app checks its own settings at start-up and won't start with an unsafe one. Cloud Run then keeps the previous revision serving, and the reason is in the logs (`gcloud run services logs read fleet-<company> --region <region>`). The checks come from #18; the tests are in `tests/hardening.test.ts`.

**Refused in production:**
- the development `JWT_SECRET`, or one shorter than 32 characters;
- no `SMTP_HOST`;
- no `OWNER_EMAIL`;
- an `APP_URL` that is local or not `https://`;
- `EXPOSE_RESET_TOKEN=true`;
- the simulators on (`DRIVER_PHONE_SIMULATOR=true`);
- `TRUST_PROXY=true`: give the number of proxies instead (the script sets 1 on Cloud Run, 2 behind the load balancer);
- `CORS_ORIGINS` with a path, a `*` or `http://`;
- `FILE_STORAGE=gcs` without `GCS_BUCKET`.

**Added in production:**
- HSTS, a content security policy, and `Cache-Control: no-store` on API answers;
- self sign-up off by default;
- sign-in rate limits per address and per account, and account lockout after `LOGIN_MAX_FAILURES` wrong passwords;
- uploads: images and PDFs only, at most `UPLOAD_MAX_MB` each and 60 per person per 10 minutes;
- documents served only to the people allowed to see them;
- no passwords, tokens or masked fields in logs.

**Settings the script sets for every company:** `TRUST_PROXY`, `CONSOLE_ENABLED=false` and `FILE_STORAGE=gcs` (Cloud Run's disk is wiped on restart). Also one instance by default: sign-in rate limits are kept in memory, so more than one instance needs `REDIS_URL` (Memorystore), which the script insists on.

## Costs, roughly, per company

Check the current prices.

- **Cloud Run:** with `MIN_INSTANCES=0` and light office use, usually within the free tier to a few dollars a month. `MIN_INSTANCES=1` avoids the first-request delay after idle time, for roughly US$10–15.
- **Load balancer:** about US$18 a month, plus traffic.
- **Cloud NAT and the reserved address:** a few dollars a month.
- **Atlas:**
  - M10, with backups: from about US$60 a month;
  - Flex: lower, but without point-in-time restore.
- **Storage and Secret Manager:** cents.

## Running the image locally

To check a release before rolling it out:

```sh
docker build -t fleet-erp .
docker run --rm -p 3000:3000 --env-file prod-like.env fleet-erp
```

Here `prod-like.env` holds the production settings above, with `MONGODB_URI` pointing at a reachable MongoDB, `FILE_STORAGE=local`, and an SMTP server (a local catcher such as Mailpit works). Then `curl -fsS http://127.0.0.1:3000/api/v1/health/ready`. With `APP_URL` set to an `https://` address the app starts normally on plain http locally; only the links in e-mails use `APP_URL`.
