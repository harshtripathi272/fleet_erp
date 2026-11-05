# Deploying a company

Each company runs its own copy: its own database, files and address. A developer sets the company up once and gets **one kit** that deploys it (#76).

## 1. Make the company file

Either:

- **On screen:** Masters → **Company kit**, on an installation where the company was set up (its details, brand, areas, connections and roles). Add the owner, the staff, the data files and where it runs, then **Download kit**.
- **By hand:** write `company.json` next to its `files/` and `data/` folders, then:

  ```bash
  npm run kit -- companies/acme/company.json
  ```

  An example is `tests/fixtures/kit/company.json`. Every problem is listed with its place in the file.

The company file never holds a secret. A password or key is named by the server setting that holds it (`CONNECTION_*`, `SMTP_PASS`). The kit's `.env.example` asks for each one.

## 2. Deploy the kit

Unzip it and follow its `README.md`, which is written for that company and that platform.

| Platform | Guide | Tested in CI |
| --- | --- | --- |
| A server with Docker Compose (DigitalOcean, Hetzner, on-premises) | [compose.md](compose.md) | Yes, end to end |
| Google Cloud (Cloud Run, Atlas, Secret Manager, Cloud Storage, Cloud Scheduler) | [gcp.md](gcp.md) | Script dry run; the kit applied in the image |
| AWS (App Runner, Atlas or DocumentDB, Secrets Manager, S3) | [aws.md](aws.md) | Not yet |
| Azure (Container Apps, Atlas or Cosmos DB for MongoDB, Key Vault, Azure Files) | [azure.md](azure.md) | Not yet |
| Render, Fly.io or Railway | [render-fly-railway.md](render-fly-railway.md) | Not yet |

## What happens on first start

With `COMPANY_CONFIG` pointing at `company.json`, the server applies it before it takes requests, in this order:

1. The company record.
2. The sample data, if asked for.
3. The data files, in the file's order.
4. Regional settings, brand, areas and options.
5. Roles and connections.
6. The owner and the staff, each invited by e-mail.
7. The brand's files.

The log has a `Company file` line for each step and ends with `Company file applied`. A step that fails says why, and the start carries on; a company file that isn't valid stops the start.

**Applying it again** (every start) does nothing unless the file or one of its files changed:
- Then only what changed in the file is set. A setting changed in the app since then keeps its value, unless the file changes that same setting again.
- Records are found by their code, key or e-mail. They're created when missing and never deleted.
- A data file is read again only when it changes, and rows already there are left alone.

## Upgrading a company

1. **Back up the database** (Atlas: a snapshot; Compose: `backups/`).
2. **Deploy the new version** with the same command and the new image tag. The server moves the data forward on start.
3. **Run the smoke test:** `curl -fsS https://<address>/api/v1/health/ready`, then sign in.
4. **To roll back,** deploy the previous tag. If the new version changed the data, restore the backup too.

Never deploy `latest`: name the version, so you know what runs and what to roll back to.

## Do and don't, on every platform

**Do:**
- Keep secrets in the platform's secret store (Secret Manager, Secrets Manager, Key Vault, Fly secrets) or in `.env` on the server only.
- Use a database with backups: MongoDB Atlas M10 or above, or the kit's nightly backups copied off the server.
- Set up e-mail before the first start, so the owner's invitation goes out.
- Run the smoke test after every deploy.
- Run more than one instance only with `REDIS_URL` set.

**Don't:**
- Don't commit `.env`, send it by e-mail or paste it in a chat.
- Don't switch on the simulators (`DRIVER_PHONE_SIMULATOR`) in production: the server refuses to start.
- Don't load the sample data in a company's real copy.
- Don't keep uploaded files on a container's own disk. Use a volume, a bucket or a storage connection.
- Don't use a free database tier for a company's real data: no backups, and it pauses.
