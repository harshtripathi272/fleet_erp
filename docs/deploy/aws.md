# AWS

> **Not yet tested in CI.** The script follows AWS's documentation but has not been run end to end. Read it before running it, and report what you had to change.

| Piece | Service |
| --- | --- |
| App | **App Runner**, from this company's image in ECR |
| Database | **MongoDB Atlas** on AWS in the same region (recommended), or **Amazon DocumentDB** (MongoDB-compatible; check the features used, such as transactions and partial indexes) |
| Secrets | **Secrets Manager**, as `fleet/<company>/<NAME>` |
| Uploaded files | **S3**, through a storage connection in `company.json` (App Runner has no lasting disk; the kit refuses to build without one) |
| Scheduled work | Approval escalation runs inside the app. The exchange-rate fetch needs an hourly run of `node dist/jobs/fetchRates.js`, for example an EventBridge Scheduler rule starting an ECS task with the same image (not in the script yet) |

## Deploy

```bash
unzip acme-haulage-kit.zip && cd acme-haulage-kit
cp .env.example .env      # the SECRET lines, including the S3 keys
DRY_RUN=1 deploy/aws.sh 1a2b3c4
deploy/aws.sh 1a2b3c4
```

The script:
1. builds the company image (the shared image plus the kit) and pushes it to ECR;
2. stores each secret in Secrets Manager;
3. makes two roles: one that pulls the image, and one that reads only this company's secrets;
4. creates or updates the App Runner service with the health check on `/api/v1/health/ready`;
5. asks App Runner for the custom domain. Add the DNS records it lists.

## Upgrade

Run `deploy/aws.sh <new version>`. Roll back with the old version.

## Do

- **Put the database in the same region,** with its access list limited to App Runner's outgoing addresses. A VPC connector with a NAT gateway gives a fixed one.
- **Turn on S3 versioning** on the files bucket.
- **Keep one instance** unless `REDIS_URL` is set (ElastiCache).

## Don't

- **Don't store uploaded files on App Runner's disk:** it is wiped.
- **Don't give the instance role more than `secretsmanager:GetSecretValue` on `fleet/<company>/*`.**
