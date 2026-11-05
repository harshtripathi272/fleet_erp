# Render, Fly.io and Railway

> **Not yet tested in CI.** Each script follows the platform's documentation but has not been run end to end. Read it before running it, and report what you had to change.

All three build the kit's `Dockerfile`: the shared image plus the company's `company.json`, `files/` and `data/`. Use MongoDB Atlas for the database. The platforms' builders must be able to pull the shared image: make it readable to them, or copy it to their registry.

| | Render | Fly.io | Railway |
| --- | --- | --- | --- |
| Script | `deploy/render.sh` writes `render.yaml` | `deploy/fly.sh` writes `fly.toml` and deploys | `deploy/railway.sh` sets variables and deploys |
| Secrets | Asked for by Render (`sync: false`) | `fly secrets import`, from standard input | `railway variables`, one at a time |
| Uploaded files | A disk at `/data` | A volume at `/data` | A volume at `/data` (add it in the dashboard first) |
| Exchange-rate fetch | A cron job in `render.yaml` | Not scheduled yet: `fly machine run … --schedule hourly` with `node dist/jobs/fetchRates.js` | Not scheduled yet: a cron service with the same command |
| Address without a domain | `https://fleet-<company>.onrender.com` | `https://fleet-<company>.fly.dev` | Set the domain in `company.json` |

## Deploy

```bash
unzip acme-haulage-kit.zip && cd acme-haulage-kit
cp .env.example .env      # the SECRET lines
deploy/fly.sh 1a2b3c4     # or deploy/render.sh, deploy/railway.sh
```

**Render:** push the folder, without `.env`, to a private repository, then **New → Blueprint** from it, and paste the secrets when asked.

## Upgrade

Run the script again with the new version. On Render, run it, commit the new `render.yaml` and let the Blueprint sync.

## Do

- **Keep one instance:** a disk or volume belongs to one machine.
- **Snapshot the volume** (Fly takes daily snapshots; Render backs up disks) and keep Atlas backups on.

## Don't

- **Don't use a free plan** for a company's real copy: it sleeps, and its disk may not last.
- **Don't commit `.env`** to the repository Render builds from.
