import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getMaster } from '../../core/masters/registry.js';
import { AREAS } from '../company/areaList.js';
import { type CompanyFile, type Target, COMPANY_FILE_FORMAT, secretSettings } from './companyFile.js';
import { type ZipEntry, zip } from './zip.js';

/**
 * The company kit (#76): one zip that deploys one company. It holds the company file, the files it names,
 * a settings template with every secret left blank, the deploy script for the chosen target and a README
 * written for that company. Nothing in it is a secret value.
 */
const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));
const deployFile = (path: string) => readFileSync(DEPLOY + path, 'utf8');

export const TARGET_LABEL: Record<Target, string> = {
  gcp: 'Google Cloud (Cloud Run)',
  compose: 'A server with Docker Compose',
  aws: 'AWS (App Runner)',
  azure: 'Azure (Container Apps)',
  render: 'Render',
  fly: 'Fly.io',
  railway: 'Railway',
  local: 'This computer',
};
/** Tested end to end in CI; the others have a script and a guide, not yet run there. */
export const TESTED_TARGETS: Target[] = ['compose', 'gcp', 'local'];
/** What's been run for real, in words for the screen. Google Cloud's script has only had a dry run so far. */
export const TARGET_STATE: Record<Target, 'tested' | 'dry-run' | 'script'> = { compose: 'tested', local: 'tested', gcp: 'dry-run', aws: 'script', azure: 'script', render: 'script', fly: 'script', railway: 'script' };
/** Where uploaded files live on each target. Containers on the rest lose their disk on restart. */
const DISK: Partial<Record<Target, string>> = { compose: '/data/files', local: '/data/files', azure: '/data/files', render: '/data/files', fly: '/data/files', railway: '/data/files' };

/** Problems that stop a kit being built, in words for whoever wrote the file. */
export function checkKit(file: CompanyFile, attachments: Map<string, Buffer>): string[] {
  const problems: string[] = [];
  for (const [slot, name] of Object.entries(file.brand.files)) {
    if (!name) continue;
    const body = attachments.get(name);
    if (!body) problems.push(`brand.files.${slot}: ${name} is not in the kit`);
    else if (!isImage(body)) problems.push(`brand.files.${slot}: ${name} is not a PNG, JPEG or WebP image`);
  }
  for (const [i, f] of file.data.files.entries()) {
    if (!attachments.has(f.file)) problems.push(`data.files.${i}: ${f.file} is not in the kit`);
    const def = getMaster(f.master);
    if (!def) problems.push(`data.files.${i}: no master "${f.master}"`);
    else if (def.managed?.create) problems.push(`data.files.${i}: ${def.label} are created on their own screen, not imported`);
  }
  // Google allows 30 characters for a service account, and the script's is fleet-<short name>.
  if (file.deploy.target === 'gcp' && file.company.key.length > 24) problems.push(`company.key: on Google Cloud the short name can be at most 24 characters; "${file.company.key}" has ${file.company.key.length}`);
  const storage = file.connections.find((c) => c.kind === 'storage' && c.enabled);
  if (file.deploy.target === 'aws' && !storage) problems.push('deploy: on AWS uploaded files need a storage connection (Amazon S3), switched on: App Runner has no lasting disk');
  // A package with the app's source builds its own image (#103); one without needs an image built beforehand.
  if (file.deploy.target !== 'gcp' && !appSource() && !file.deploy.image) problems.push('deploy.image: name the shared image to run, without its version (where deploy/build-image.sh pushed it)');
  if (NEEDS_DOMAIN.includes(file.deploy.target) && !file.deploy.domain) problems.push(`deploy.domain: on ${TARGET_LABEL[file.deploy.target]} the company's address is needed before the first start, for password links`);
  if (file.deploy.target === 'gcp' && file.deploy.domainMode !== 'none' && !file.deploy.domain) problems.push(`deploy.domain: domainMode ${file.deploy.domainMode} needs a domain`);
  return problems;
}

const isImage = (b: Buffer) => (b[0] === 0xff && b[1] === 0xd8)
  || b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  || (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP');

/**
 * The app's source at this copy's commit, so a Google Cloud package needs no image built beforehand: Cloud Build
 * makes it from this. Absent where there's no repository (the server's own image), and the guide then asks for one.
 */
let source: { version: string; body: Buffer } | null | undefined;
export function appSource() {
  if (source !== undefined) return source;
  try {
    const cwd = fileURLToPath(new URL('../../../', import.meta.url));
    const version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const body = execFileSync('git', ['archive', '--format=tar.gz', 'HEAD'], { cwd, maxBuffer: 300 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    source = { version, body };
  } catch { source = null; }
  return source;
}

const quote = (v: string) => (/[\s<>"'#$`\\]/.test(v) ? `"${v.replace(/(["\\$`])/g, '\\$1')}"` : v);
const productName = (file: CompanyFile) => file.brand.productName ?? file.company.tradingName ?? file.company.legalName;
/** The public address: the domain, or the platform's own address when it is known before the first deploy. */
const appUrl = (file: CompanyFile) => {
  if (file.deploy.target === 'local') return `http://localhost:${file.deploy.port}`;
  if (file.deploy.domain) return `https://${file.deploy.domain}`;
  if (file.deploy.target === 'fly') return `https://fleet-${file.company.key}.fly.dev`;
  if (file.deploy.target === 'render') return `https://fleet-${file.company.key}.onrender.com`;
  return '';
};
/** Platforms whose own address is only known after the service exists: the company's domain is needed. */
const NEEDS_DOMAIN: Target[] = ['compose', 'aws', 'azure', 'railway'];

/** The e-mail server: the deploy's SMTP settings, or the switched-on SMTP connection's. */
function smtpOf(file: CompanyFile) {
  if (file.deploy.smtp) return file.deploy.smtp;
  const c = file.connections.find((x) => x.kind === 'email' && x.enabled && x.provider === 'smtp');
  const s = (c?.settings ?? {}) as { host?: string; port?: number; secure?: boolean; user?: string; from?: string };
  return { host: s.host ?? '', port: s.port ?? 587, secure: Boolean(s.secure), user: s.user, from: s.from ?? '' };
}

/**
 * Every server setting (src/config/env.ts), grouped: what the company file decides, the secrets to fill in,
 * and the rest at their defaults. Values with spaces are quoted so both Docker Compose and bash read them.
 */
export function envTemplate(file: CompanyFile): string {
  const target = file.deploy.target;
  const smtp = smtpOf(file);
  const disk = DISK[target];
  const set = (key: string, value: string | number | boolean | undefined) => `${key}=${value === undefined ? '' : quote(String(value))}`;
  const secrets = secretSettings(file);
  const lines = [
    `# ${productName(file)}: the server's settings. Copy this file to .env and fill in every line marked SECRET.`,
    '# Never commit .env, send it by e-mail or paste it in a chat. company.json and this template hold no secret values.',
    '',
    '# --- From company.json (change them there and build the kit again) ---',
    // This computer runs in development mode: production refuses a plain http://localhost address.
    set('NODE_ENV', target === 'local' ? 'development' : 'production'),
    target === 'gcp' ? '# APP_URL is set by the deploy script (the domain, or the Cloud Run address).' : set('APP_URL', appUrl(file)),
    set('OWNER_EMAIL', file.owner.email),
    set('COMPANY_CONFIG', '/kit/company.json'),
    // Written only with an e-mail server: an empty one would be refused when the server starts.
    ...(smtp.host ? [set('SMTP_HOST', smtp.host), set('SMTP_PORT', smtp.port), set('SMTP_SECURE', smtp.secure), smtp.user ? set('SMTP_USER', smtp.user) : '# SMTP_USER=', set('SMTP_FROM', smtp.from)]
      : ['# SMTP_HOST=, SMTP_PORT=, SMTP_SECURE=, SMTP_USER=, SMTP_FROM=: no e-mail server, so nobody gets e-mails from this copy.']),
    set('TRUST_PROXY', target === 'gcp' && file.deploy.domainMode === 'lb' ? 2 : 1),
    target === 'gcp' ? set('FILE_STORAGE', 'gcs') : set('FILE_STORAGE', 'local'),
    disk ? set('FILE_STORAGE_DIR', disk) : '# FILE_STORAGE_DIR=data/files',
    target === 'gcp' ? '# GCS_BUCKET is set by the deploy script.' : '# GCS_BUCKET=',
    set('CONSOLE_ENABLED', false),
    // A real company's copy makes no packages for other companies; a demonstration copy can.
    set('SETUP_PACKAGES', file.purpose === 'demo'),
    // A copy on this computer keeps the simulated driver phones, to try the driver's side.
    set('DRIVER_PHONE_SIMULATOR', target === 'local'),
    // Cloud Run and Container Apps scale to nothing and run the timed work as scheduled jobs instead.
    set('IN_PROCESS_JOBS', target === 'gcp' || target === 'azure' ? false : true),
    '',
    '# --- SECRET: fill these in ---',
    target === 'compose' || target === 'local'
      ? '# SECRET. The bundled database is mongodb://mongo:27017/fleet. For MongoDB Atlas, its connection string.'
      : '# SECRET. The connection string of the company\'s own database (MongoDB Atlas, or the platform\'s MongoDB).',
    set('MONGODB_URI', target === 'compose' || target === 'local' ? 'mongodb://mongo:27017/fleet' : ''),
    target === 'local' ? '# SECRET. Made by start.sh or start.bat the first time; never changed (it would sign everyone out).' : '# SECRET. At least 32 random characters, made once and never changed (it would sign everyone out): openssl rand -base64 48',
    target === 'gcp' ? '# JWT_SECRET is generated by the deploy script and kept in Secret Manager.' : set('JWT_SECRET', ''),
    ...(smtp.user ? ['# SECRET. The password of the e-mail account above.', set('SMTP_PASS', '')] : ['# SMTP_PASS= (only with SMTP_USER)']),
    ...(smtp.host && target !== 'local' ? ['# OWNER_PASSWORD= (only without an e-mail server)'] : [`# SECRET. The first password for ${file.owner.email}, at least 8 characters with a letter and a digit. Used once, when that account is made; change it after signing in.${target === 'local' ? ' start.sh or start.bat makes one the first time.' : ''}`, set('OWNER_PASSWORD', '')]),
    ...(file.deploy.target === 'gcp' && file.deploy.maxInstances > 1 ? ['# SECRET. Redis, which more than one instance needs so sign-in limits are shared: its rediss:// address.', set('REDIS_URL', '')] : []),
    ...secrets.flatMap((s) => [`# SECRET. ${s.why}.`, set(s.name, '')]),
    '',
    '# --- Defaults: change only with a reason ---',
    '# HOST=0.0.0.0',
    '# PORT=3000',
    '# LOG_LEVEL=info',
    '# SHUTDOWN_TIMEOUT_MS=10000',
    '# More than one instance needs Redis, so sign-in limits are shared between them.',
    '# REDIS_URL=redis://…',
    '# ACCESS_TOKEN_TTL_SECONDS=900',
    '# REFRESH_TOKEN_TTL_DAYS=30',
    '# PASSWORD_RESET_TTL_MINUTES=30',
    '# LOGIN_MAX_FAILURES=5',
    '# LOGIN_LOCK_MINUTES=15',
    '# PASSWORD_HASH_COST=15',
    '# EXPOSE_RESET_TOKEN=false (refused in production)',
    '# CORS_ORIGINS= (only when the web app is served from another address)',
    '# RATE_FEED_API_KEY= (SECRET; only for an exchange-rate feed set up before connections)',
    '# WEB_DIR= (the built web app; the image has it)',
    '# UPLOAD_MAX_MB=15',
    '# MARICHI_TALKS_WEBHOOK_SECRET= (SECRET; WhatsApp through Marichi Talks, once connected)',
  ];
  if (target === 'compose') {
    lines.push(
      '',
      '# --- For Docker Compose (not read by the server) ---',
      ...(appSource()
        ? ['# The image is built from the source in this package (Dockerfile): no image to name.', `FLEET_VERSION=${appSource()!.version}`]
        : ['# The image and the version to run. Never "latest", so a rollback can name the version before.', set('FLEET_IMAGE', file.deploy.image), set('FLEET_VERSION', '')]),
      set('DOMAIN', file.deploy.domain),
      set('CERTIFICATE_EMAIL', file.deploy.target === 'compose' ? file.deploy.certificateEmail ?? file.owner.email : ''),
      set('BACKUP_DAYS', file.deploy.target === 'compose' ? file.deploy.backupDays : 14),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The non-secret settings the deploy script reads, from the company file. */
function kitEnv(file: CompanyFile): string {
  const d = file.deploy;
  const smtp = smtpOf(file);
  const pairs: [string, string | number | boolean | undefined][] = [['COMPANY', file.company.key], ['OWNER_EMAIL', file.owner.email], ['IMAGE_REPO', d.image], ['DOMAIN', d.domain]];
  if (d.target === 'gcp') {
    pairs.push(['PROJECT_ID', d.projectId], ['REGION', d.region], ['DOMAIN_MODE', d.domain ? d.domainMode : 'none'], ['EGRESS', d.egress],
      ['MIN_INSTANCES', d.minInstances], ['MAX_INSTANCES', d.maxInstances], ['CPU', d.cpu], ['MEMORY', d.memory], ['SCHEDULER_REGION', d.schedulerRegion],
      ['SMTP_HOST', smtp.host], ['SMTP_PORT', smtp.port], ['SMTP_SECURE', smtp.secure], ['SMTP_USER', smtp.user], ['SMTP_FROM', smtp.from],
      ['ALERT_EMAIL', d.alertEmail ?? file.owner.email], ['BUDGET_MONTHLY', d.monthlyBudget]);
  } else if (d.target === 'local') pairs.push(['PORT', d.port]);
  else if (d.target === 'aws' || d.target === 'render' || d.target === 'fly') pairs.push(['REGION', d.region]);
  else if (d.target === 'azure') pairs.push(['LOCATION', d.location], ['RESOURCE_GROUP', d.resourceGroup ?? `fleet-${file.company.key}`]);
  // The version of the source the package carries: the scripts build and tag that, with nothing to name.
  pairs.push(['APP_VERSION', appSource()?.version]);
  return [
    `# ${file.company.legalName}: where it is deployed. Written from company.json by \`npm run kit\`; no secrets.`,
    ...pairs.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${quote(String(v))}`),
    '',
  ].join('\n');
}

/** The files each target's kit carries, from deploy/ and deploy/targets/. */
function targetFiles(target: Target): ZipEntry[] {
  const script = (path: string, as = path) => ({ path: as, data: deployFile(path), executable: true });
  const common = [script('targets/kit-lib.sh', 'deploy/kit-lib.sh')];
  switch (target) {
    case 'gcp': return [script('lib.sh', 'deploy/lib.sh'), script('new-company.sh', 'deploy/new-company.sh'), script('update-company.sh', 'deploy/update-company.sh'), ...common, script('targets/gcp.sh', 'deploy/gcp.sh')];
    case 'compose': return [{ path: 'docker-compose.yml', data: deployFile('targets/compose/docker-compose.yml') }, { path: 'Caddyfile', data: deployFile('targets/compose/Caddyfile') }, ...common, script('targets/compose/backup.sh', 'deploy/backup.sh')];
    case 'local': return [
      { path: 'docker-compose.yml', data: deployFile('targets/local/docker-compose.yml') },
      script('targets/local/start.sh', 'start.sh'), script('targets/local/start.command', 'start.command'),
      { path: 'start.bat', data: deployFile('targets/local/start.bat').replace(/\r?\n/g, '\r\n') },
    ];
    default: return [...common, script(`targets/${target}.sh`, `deploy/${target}.sh`)];
  }
}

/** The kit as a list of files, in the order a person reads them. */
export function kitEntries(file: CompanyFile, attachments: Map<string, Buffer>): ZipEntry[] {
  const kitDir = `${file.company.key}-kit`;
  const entries: ZipEntry[] = [
    { path: 'README.md', data: readme(file) },
    { path: 'company.json', data: `${JSON.stringify(file, null, 2)}\n` },
    { path: '.env.example', data: envTemplate(file) },
    { path: 'deploy/kit.env', data: kitEnv(file) },
    // The company's own image: built from the app's source in this package (#103), or the shared image plus this kit.
    { path: 'Dockerfile', data: deployFile(appSource() ? 'targets/Dockerfile.source' : 'targets/Dockerfile.kit') },
    { path: '.dockerignore', data: '.env\n.env.*\n!.env.example\nbackups\n*.zip\n' },
    { path: '.gitignore', data: '.env\nbackups/\n' },
    ...targetFiles(file.deploy.target),
    ...(file.deploy.target === 'gcp' ? [{ path: 'deploy.sh', data: deployFile('targets/gcp-all.sh'), executable: true }] : []),
    ...(appSource() ? [{ path: 'app-source.tar.gz', data: appSource()!.body }] : []),
    // The Dockerfile copies both folders, so they are there even when empty.
    { path: 'files/.keep', data: '' },
    { path: 'data/.keep', data: '' },
    ...[...attachments].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, data })),
  ];
  return entries.map((e) => ({ ...e, path: `${kitDir}/${e.path}` }));
}

export const buildKit = (file: CompanyFile, attachments: Map<string, Buffer>) => zip(kitEntries(file, attachments));
export const kitName = (file: CompanyFile) => `${file.company.key}-kit.zip`;

/** The README for this company: what to fill in, the exact commands, and how to check it worked. */
function readme(file: CompanyFile): string {
  const d = file.deploy;
  const name = file.company.tradingName ?? file.company.legalName;
  const secrets = secretSettings(file);
  const smtp = smtpOf(file);
  const areas = (file.areas ?? AREAS.filter((a) => a.defaultOn).map((a) => a.key)).map((k) => AREAS.find((a) => a.key === k)?.name ?? k);
  const url = appUrl(file) || (d.target === 'gcp' ? 'the Cloud Run address the script prints' : "the platform's address");
  const tested = TESTED_TARGETS.includes(d.target) ? '' : `\n> **Not yet tested in CI.** The ${TARGET_LABEL[d.target]} script follows the platform's documentation but has not been run end to end by our CI. Read it before running it, and report what you had to change.\n`;
  const fill = [
    '- `MONGODB_URI`: the database.' + (d.target === 'compose' ? ' Leave it as it is to use the database in this kit.' : ''),
    d.target === 'gcp' ? '' : '- `JWT_SECRET`: `openssl rand -base64 48`, once. Changing it later signs everyone out.',
    smtp.user ? `- \`SMTP_PASS\`: the password of ${smtp.user} on ${smtp.host}.` : '',
    ...secrets.map((s) => `- \`${s.name}\`: ${s.why}.`),
  ].filter(Boolean).join('\n');

  const steps: Record<Target, string> = {
    local: `A copy of its own on this computer, with its own database and files: the copy this package came from is not touched. It needs [Docker Desktop](https://www.docker.com/products/docker-desktop/), installed and running.

- **Mac:** unzip, then double-click \`start.command\`. The first time, macOS may ask you to allow it: right-click it, choose Open, then Open.
- **Windows:** unzip, then double-click \`start.bat\`.
- **Linux, or a terminal:**

\`\`\`bash
unzip ${kitName(file)} && cd ${file.company.key}-kit
./start.sh
\`\`\`

The first start builds the app from the source in this package, which takes a few minutes. It makes \`.env\` with a new sign-in key and a first password for ${file.owner.email}, shows that password once (it stays in \`.env\`), then opens ${appUrl(file)}. Stop it with \`docker compose --project-name fleet-${file.company.key}-local down\`; the data stays for next time.`,
    compose: `On a server with Docker (2 GB of memory is enough to start), with ports 80 and 443 open and \`${d.domain}\` pointing at it:

\`\`\`bash
unzip ${kitName(file)} && cd ${file.company.key}-kit
cp .env.example .env
# fill in the SECRET lines${appSource() ? '' : ' and FLEET_VERSION (the image version to run)'}
docker compose up -d --build
\`\`\`

Caddy gets the HTTPS certificate on the first request. The database, uploaded files and nightly backups (in \`backups/\`, kept ${d.target === 'compose' ? d.backupDays : 14} days) live in Docker volumes on this server. Copy \`backups/\` somewhere else too: a backup on the same disk is lost with the disk.`,
    gcp: `In [Google Cloud Shell](https://console.cloud.google.com/?cloudshell=true&project=${d.target === 'gcp' ? d.projectId : ''}), which already has everything it needs: upload this zip, then

\`\`\`bash
unzip ${kitName(file)} && cd ${file.company.key}-kit
cp .env.example .env      # fill in the SECRET lines: nano .env
DRY_RUN=1 ./deploy.sh     # optional: prints every command first
./deploy.sh
\`\`\`

It builds the app's image in Cloud Build, then makes the service account, the bucket, the secrets, the Cloud Run service and its scheduled jobs, and copies this kit into the bucket, where the service reads it. Run it again at any time: each step checks what exists first.`,
    aws: `With the AWS CLI signed in and Docker running:

\`\`\`bash
unzip ${kitName(file)} && cd ${file.company.key}-kit
cp .env.example .env      # fill in the SECRET lines
deploy/aws.sh <version>
\`\`\`

It builds this company's image (the shared image plus this kit), pushes it to ECR, stores the secrets in Secrets Manager and creates the App Runner service. Uploaded files go to the S3 connection in company.json.`,
    azure: `With the Azure CLI signed in:

\`\`\`bash
unzip ${kitName(file)} && cd ${file.company.key}-kit
cp .env.example .env      # fill in the SECRET lines
deploy/azure.sh <version>
\`\`\`

It builds this company's image in a container registry, keeps the secrets in Key Vault, mounts an Azure Files share for uploaded files, and creates the container app and its scheduled jobs.`,
    render: `\`\`\`bash
unzip ${kitName(file)} && cd ${file.company.key}-kit
cp .env.example .env      # fill in the SECRET lines
deploy/render.sh <version>
\`\`\`

It writes \`render.yaml\` (a web service with a disk for uploaded files). Put this folder in a private Git repository without \`.env\`, create a Blueprint from it in Render, and paste the SECRET values when Render asks for them.`,
    fly: `With flyctl signed in:

\`\`\`bash
unzip ${kitName(file)} && cd ${file.company.key}-kit
cp .env.example .env      # fill in the SECRET lines
deploy/fly.sh <version>
\`\`\`

It creates the app and a volume for uploaded files, sets the secrets with \`fly secrets\`, and deploys this company's image.`,
    railway: `With the Railway CLI signed in and linked to a project:

\`\`\`bash
unzip ${kitName(file)} && cd ${file.company.key}-kit
cp .env.example .env      # fill in the SECRET lines
deploy/railway.sh <version>
\`\`\`

It sets the variables and deploys this company's image. Add a volume mounted at \`/data\` in the Railway dashboard before the first deploy.`,
  };

  return `# ${name}: deployment kit

Made from \`company.json\` (format ${COMPANY_FILE_FORMAT}) for **${TARGET_LABEL[d.target]}**.
${file.purpose === 'demo' || file.data.sample !== 'none' ? '\n> **This copy holds made-up data.** It is for showing and trying the app, and its sign-in page says so too.\n' : ''}${tested}
## What's in it

| File | What it is |
| --- | --- |
| \`company.json\` | The company: details, brand, regional settings, areas, connections, roles, people and data. No secrets. |
| \`.env.example\` | Every server setting. Copy it to \`.env\` and fill in the lines marked SECRET. |
| \`deploy/\` | The deploy script for ${TARGET_LABEL[d.target]} and its settings (\`deploy/kit.env\`). |
| \`Dockerfile\` | This company's image: the shared image plus this kit. |
${d.target === 'compose' ? '| `docker-compose.yml`, `Caddyfile` | The app, MongoDB, HTTPS and nightly backups on one server. |\n' : ''}| \`files/\`, \`data/\` | The brand's files and the spreadsheets imported on first start. |

## 1. Fill in the secrets

In \`.env\`:

${fill}

Never commit \`.env\`, send it by e-mail or paste it in a chat.${d.target === 'compose' ? '' : ' Once deployed, the values live in the platform\'s secret store; delete `.env` from your computer.'}

## 2. Deploy

${steps[d.target]}

## 3. Check it worked

\`\`\`bash
curl -fsS ${appUrl(file) || '<address>'}/api/v1/health/ready
\`\`\`

It answers \`"mongo":"connected"\`. Then:

- **The log** says \`Company file applied\`, with a line for each step. A step that failed says why.
- **${url}** shows ${productName(file)}, with its logo and colour.
- **${file.owner.email}** gets an e-mail to choose a password. If it doesn't arrive, check the e-mail settings, then use "Forgot password" with that address.
- **Signed in as the owner:**
  - the areas on are ${areas.join(', ')};
  - ${file.data.files.length ? `the data from ${file.data.files.map((f) => `\`${f.file}\``).join(', ')} is in;` : 'there is no data yet: import it from Masters;'}
  - Masters → Connections shows ${file.connections.length ? file.connections.map((c) => c.name).join(', ') : 'only the Simulated stand-ins'}.

## Changing something later

Edit \`company.json\` (or use Set up a company), build the package again, and deploy again.
- **Only what changed in the file is applied.** A setting changed in the app since then keeps its value, unless the file changes that same setting.
- **Nothing is ever deleted.** A data row already there is left alone.

## Upgrading

${appSource() ? 'Make a new package and deploy it with the same command: it builds the new version from its source.' : 'Deploy the new version with the same command and the new `<version>`.'} The server moves the database forward on start. To roll back, deploy the version before. Back up the database first: a newer version may have changed it.
${d.target === 'gcp' ? `
## Running it

- **Down or failing:** the script set up an uptime check and an alert on errors in the log, e-mailed to ${d.alertEmail ?? file.owner.email}. Read the log with \`gcloud run services logs read fleet-${file.company.key} --region ${d.region} --project ${d.projectId} --limit 100\`.
- **Cost:** a budget of ${d.monthlyBudget} a month (the billing account's currency) e-mails at half, 90% and all of it. No prices are given: check them in Google's pricing calculator.
- **Backups:** MongoDB Atlas keeps the database's (the free tier keeps none). Uploaded files keep every old version in the bucket.
- **Going back a version:** \`gcloud run services update-traffic fleet-${file.company.key} --to-revisions <revision>=100 --region ${d.region} --project ${d.projectId}\`. If the newer version changed the database, restore the snapshot taken before it.

The deploy guide on the Set up a company screen, and docs/deploy/gcp.md in the repository, have each of these step by step. None of it has been tried against a real Google Cloud project yet.
` : ''}
## Do

- **Use a managed database with backups** (MongoDB Atlas M10 or above, or the platform's), or keep this kit's nightly backups and copy them off the server.
- **Set up e-mail before the first start,** so the owner's invitation goes out.
- **Run the check above after every deploy.**

## Don't

- **Don't put a password or key in \`company.json\`.** It names server settings; the values go in \`.env\` or the platform's secret store.
- **Don't switch the simulators on** (\`DRIVER_PHONE_SIMULATOR\`): production refuses to start with them.
- **Don't load the sample data** in a company's real copy: \`data.sample\` is for demonstrations.
- **Don't run more than one instance without \`REDIS_URL\`.**
- **Don't deploy \`latest\`:** name the version, so you know what runs and what to roll back to.
`;
}
