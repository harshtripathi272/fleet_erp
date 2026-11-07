# A server with Docker Compose

Any Linux server with Docker: DigitalOcean, Hetzner, a VM on-premises. One company per server, with everything on it:

- **app:** this company's image, which is the shared image plus its kit;
- **mongo:** MongoDB 8.2, data in a Docker volume;
- **caddy:** HTTPS with a Let's Encrypt certificate, renewed by itself;
- **jobs:** the hourly exchange-rate fetch;
- **backup:** every night, the database and the uploaded files into `backups/`.

Tested end to end in CI (the `kit` job in `.github/workflows/check.yml`).

## What you need

- A server with 2 GB of memory and 20 GB of disk to start, Docker Engine 24 or later, and ports 80 and 443 open.
- The company's address (`deploy.domain`) pointing at the server (a DNS A record).
- Read access to the shared image from the server: `docker login` to its registry (for Artifact Registry: `gcloud auth configure-docker africa-south1-docker.pkg.dev`).

## Deploy

```bash
unzip acme-haulage-kit.zip && cd acme-haulage-kit
cp .env.example .env
nano .env                  # the SECRET lines, and FLEET_VERSION
docker compose up -d --build
docker compose logs -f app # "Company file applied", then "Server started"
curl -fsS https://fleet.acme-haulage.example/api/v1/health/ready
```

`MONGODB_URI` defaults to the bundled database. For MongoDB Atlas instead, set its connection string; the `mongo` service can then be left out with `docker compose up -d --build app caddy jobs backup`.

## Change something

1. Edit `company.json` (or rebuild the package from Set up a company and copy the new files over).
2. Run `docker compose up -d --build`.

Only what the file changed is applied.

## Upgrade

1. Set `FLEET_VERSION` in `.env` to the new tag.
2. Run `docker compose up -d --build`.

To roll back, set the old tag and run it again. Back up first: `docker compose exec backup sh -c 'mongodump --uri="$MONGODB_URI" --gzip --archive=/backups/before-upgrade.gz'`.

## Backups and restore

- **Every night,** `backups/db-<time>.gz` (the database) and `backups/files-<time>.tar.gz` (uploaded files), kept `BACKUP_DAYS` days.
- **Restore the database:**

  ```bash
  docker compose exec backup mongorestore --uri="$MONGODB_URI" --gzip --archive=/backups/db-<time>.gz --drop
  ```

- **Restore the files:**

  ```bash
  docker compose run --rm -v "$PWD/backups:/backups" app sh -c 'tar -xzf /backups/files-<time>.tar.gz -C /data'
  ```

## Do

- **Copy `backups/` off the server** every day (rsync, restic, or the provider's snapshots). A backup on the same disk is lost with the disk.
- **Keep the server patched,** and let only ports 22, 80 and 443 in.
- **Watch the disk:** backups and uploads grow.

## Don't

- **Don't publish MongoDB's port.** The compose file keeps it inside Docker's network.
- **Don't publish port 3000 beyond `127.0.0.1`:** everyone comes in through Caddy.
- **Don't run `docker compose down -v`:** `-v` deletes the database volume.
