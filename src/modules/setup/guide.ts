import { providerFor } from '../../core/connections/index.js';
import { type CompanyFile, type Target, secretSettings } from './companyFile.js';
import { appSource, envTemplate, kitName } from './kit.js';

/**
 * What the set-up screen tells someone deploying: what each platform asks for, every environment variable with what
 * it's for and where to get it, and each step, with this company's own values already in the commands. The app
 * never holds a secret; this says what to do with them.
 */

export interface TargetField {
  /** Shown under "More options": what most companies leave alone. A new setting is one more entry here. */
  advanced?: boolean;
  key: string; label: string; hint?: string; type: 'text' | 'number' | 'choice'; required?: boolean; placeholder?: string; choices?: { value: string; label: string }[]; default?: string | number; min?: number; max?: number }

const GCP_REGIONS: [string, string][] = [
  ['africa-south1', 'Johannesburg'], ['asia-south1', 'Mumbai'], ['asia-south2', 'Delhi'], ['asia-southeast1', 'Singapore'], ['asia-east1', 'Taiwan'], ['asia-northeast1', 'Tokyo'],
  ['australia-southeast1', 'Sydney'], ['europe-west1', 'Belgium'], ['europe-west2', 'London'], ['europe-west3', 'Frankfurt'], ['europe-west4', 'Netherlands'], ['me-central1', 'Doha'], ['me-west1', 'Tel Aviv'],
  ['northamerica-northeast1', 'Montréal'], ['southamerica-east1', 'São Paulo'], ['us-central1', 'Iowa'], ['us-east1', 'South Carolina'], ['us-west1', 'Oregon'],
];
const choices = (list: [string, string][]) => list.map(([value, label]) => ({ value, label: `${label} (${value})` }));

const DOMAIN: TargetField = { key: 'domain', label: "The company's address", hint: 'The web address people will use, without https://. You point it at the platform at the end.', type: 'text', placeholder: 'fleet.acme.example' };
// With the app's source in the package, the image is built from it (#103) and none is named.
const IMAGE: TargetField = appSource()
  ? { key: 'image', label: 'App image (optional)', hint: "Leave empty: the package carries the app's source, and the image is built from it. Name one only to run an image already built elsewhere.", type: 'text', placeholder: 'ghcr.io/acme/fleet-erp' }
  : { key: 'image', label: 'App image', hint: 'Where the shared image lives, without its version. deploy/build-image.sh in the repository makes one.', type: 'text', required: true, placeholder: 'ghcr.io/acme/fleet-erp' };

export const TARGET_FIELDS: Record<Target, TargetField[]> = {
  gcp: [
    { key: 'projectId', label: 'Google Cloud project', hint: 'The project ID, not its name: the top of the Google Cloud console shows it.', type: 'text', required: true, placeholder: 'acme-fleet-prod' },
    { key: 'region', label: 'Region', hint: 'Closest to the people using it. Pick the same area for the database.', type: 'choice', choices: choices(GCP_REGIONS), default: 'africa-south1' },
    { ...DOMAIN, hint: "The web address people will use, without https://. Leave empty to use Google's own address (…run.app) for now." },
    { key: 'domainMode', label: 'How the address connects', hint: "A load balancer works in every region but costs about US$20 a month. A domain mapping is free, but isn't offered in every region.", type: 'choice', default: 'lb', choices: [{ value: 'lb', label: 'Load balancer (works everywhere)' }, { value: 'mapping', label: 'Domain mapping (free, some regions)' }, { value: 'none', label: "None: use Google's address" }] },
    { key: 'egress', label: 'Outgoing address', hint: 'A fixed address lets MongoDB Atlas allow only this app, and costs a little. Open needs Atlas to accept connections from anywhere.', type: 'choice', default: 'static', choices: [{ value: 'static', label: 'Fixed (recommended)' }, { value: 'open', label: 'Open' }] },
    { key: 'minInstances', label: 'Always running', hint: '0 sleeps when nobody is using it: cheapest, with a few seconds to wake up. 1 is always ready.', type: 'number', default: 0, min: 0, max: 10 },
    { key: 'maxInstances', label: 'At most', hint: 'Above 1, the deploy guide also asks for Redis, so sign-in limits are shared. 1 is enough to start.', type: 'number', default: 1, min: 1, max: 10 },
    { key: 'cpu', label: 'CPUs for each instance', hint: 'Raise it if screens get slow under load, not before.', type: 'choice', default: '1', advanced: true, choices: [{ value: '1', label: '1 CPU' }, { value: '2', label: '2 CPUs' }, { value: '4', label: '4 CPUs' }] },
    { key: 'memory', label: 'Memory for each instance', hint: '512 MB suits a small company. Raise it if the app restarts under load, or for large files and PDFs.', type: 'choice', default: '512Mi', advanced: true, choices: [{ value: '512Mi', label: '512 MB' }, { value: '1Gi', label: '1 GB' }, { value: '2Gi', label: '2 GB' }, { value: '4Gi', label: '4 GB' }, { value: '8Gi', label: '8 GB' }] },
    { key: 'schedulerRegion', label: 'Scheduled jobs run from', hint: 'Leave empty: it uses the nearest region that offers scheduling. Only needed if that one is refused.', type: 'text', placeholder: 'europe-west1', advanced: true },
    { key: 'alertEmail', label: 'Alerts go to', hint: "E-mailed when it's down, logging errors, or near its budget. Empty: the owner.", type: 'text', placeholder: 'it@acme.example' },
    { key: 'monthlyBudget', label: 'Monthly budget', hint: "In the billing account's own currency. An e-mail at half, 90% and all of it; nothing is stopped.", type: 'number', default: 50, min: 1, max: 1000000 },
  ],
  compose: [
    { ...DOMAIN, required: true, hint: 'The server must already answer on this address: the certificate is fetched from it on first start.' },
    IMAGE,
    { key: 'certificateEmail', label: 'E-mail for the certificate', hint: "Let's Encrypt writes here if the certificate has a problem.", type: 'text', placeholder: 'it@acme.example' },
    { key: 'backupDays', label: 'Keep backups for', hint: 'Days of nightly database backups on the server. Copy them elsewhere too.', type: 'number', default: 14, min: 1, max: 365 },
  ],
  aws: [
    { key: 'region', label: 'Region', type: 'choice', default: 'af-south-1', choices: choices([['af-south-1', 'Cape Town'], ['ap-south-1', 'Mumbai'], ['ap-southeast-1', 'Singapore'], ['eu-central-1', 'Frankfurt'], ['eu-west-1', 'Ireland'], ['eu-west-2', 'London'], ['us-east-1', 'N. Virginia'], ['us-west-2', 'Oregon']]) },
    { ...DOMAIN, required: true }, IMAGE,
  ],
  azure: [
    { key: 'location', label: 'Location', type: 'choice', default: 'southafricanorth', choices: choices([['southafricanorth', 'Johannesburg'], ['centralindia', 'Pune'], ['southeastasia', 'Singapore'], ['northeurope', 'Ireland'], ['westeurope', 'Netherlands'], ['uksouth', 'London'], ['eastus', 'Virginia'], ['westus2', 'Washington']]) },
    { key: 'resourceGroup', label: 'Resource group', hint: 'Leave empty to name it after the company.', type: 'text' },
    { ...DOMAIN, required: true }, IMAGE,
  ],
  render: [
    { key: 'region', label: 'Region', type: 'choice', default: 'frankfurt', choices: choices([['frankfurt', 'Frankfurt'], ['oregon', 'Oregon'], ['ohio', 'Ohio'], ['virginia', 'Virginia'], ['singapore', 'Singapore']]) },
    DOMAIN, IMAGE,
  ],
  fly: [
    { key: 'region', label: 'Region', type: 'choice', default: 'jnb', choices: choices([['jnb', 'Johannesburg'], ['bom', 'Mumbai'], ['sin', 'Singapore'], ['fra', 'Frankfurt'], ['lhr', 'London'], ['iad', 'Virginia'], ['sjc', 'California']]) },
    DOMAIN, IMAGE,
  ],
  railway: [{ ...DOMAIN, required: true }, IMAGE],
  local: [{ key: 'port', label: 'Address on this computer', hint: 'It opens at http://localhost and this number. Pick another if something already uses it.', type: 'number', default: 8080, min: 1024, max: 65535 }],
};

export const TARGET_NEEDS: Record<Target, string[]> = {
  gcp: ['A Google account, and a project with billing switched on', 'A MongoDB Atlas database (free to start)', 'Nothing to install: it runs in Google Cloud Shell'],
  compose: ['A Linux server with Docker and 2 GB of memory, reachable from the internet on ports 80 and 443', 'A domain pointing at it', 'Nothing else: the database, HTTPS and backups come in the package'],
  local: ['Docker Desktop, installed and running (free for personal and small-business use)', 'Nothing else: no domain, no e-mail server, no database to make'],
  aws: ['An AWS account, with the aws tool installed and signed in (aws configure)', 'Docker on the computer you deploy from, to build the image', 'A MongoDB Atlas database', 'An S3 bucket and a storage connection for files (App Runner keeps no disk)'],
  azure: ['An Azure subscription, with the az tool installed and signed in (az login)', 'Docker on the computer you deploy from, to build the image', 'A MongoDB Atlas database'],
  render: ['A Render account on a paid plan (a disk for files needs one)', 'A private Git repository to hold this package', 'A MongoDB Atlas database'],
  fly: ['A Fly.io account, with the fly tool installed and signed in (fly auth login)', 'A MongoDB Atlas database'],
  railway: ['A Railway account and a project, with the railway tool installed and linked (railway link)', 'A MongoDB Atlas database'],
};

export interface EnvVar { name: string; value?: string; secret: boolean; why: string; where?: string; generate?: string; automatic?: boolean }
export interface GuideStep { title: string; text?: string; commands?: string[]; link?: { href: string; label: string }; list?: string[] }

/** Where to get a secret that isn't a connection's. */
const WHERE: Record<string, { why: string; where?: string; generate?: string }> = {
  REDIS_URL: { why: 'Lets several running copies of the app share sign-in limits. Needed only above 1 instance.', where: 'Any managed Redis, such as Upstash or Google Memorystore. Copy its address, starting rediss://.' },
  MONGODB_URI: { why: 'The address and password of the company\'s database.', where: 'MongoDB Atlas → your cluster → Connect → Drivers. It starts with mongodb+srv://. Put the database name, such as fleet, before the "?".' },
  JWT_SECRET: { why: 'Signs everyone\'s sign-ins. Changing it later signs everybody out.', generate: 'openssl rand -base64 48' },
  OWNER_PASSWORD: { why: "The owner's first password, since there's no e-mail server to send a link. Used once, when that account is made; it can't change an account afterwards. Change it after signing in.", where: 'Choose one: at least 8 characters, with a letter and a digit. Or make one with the command below.', generate: 'openssl rand -base64 18' },
  SMTP_PASS: { why: 'The password of the e-mail account that sends invitations and password resets.', where: 'Your e-mail provider: an "app password" for Google or Microsoft, or the SMTP key from SES, SendGrid or Mailgun.' },
};

/** Every server setting for this company, read from the same template the package carries, so the two always agree. */
export function envVars(file: CompanyFile): EnvVar[] {
  const lines = envTemplate(file).split('\n');
  const connectionSecrets = new Map(secretSettings(file).map((s) => [s.name, s.why]));
  const out: EnvVar[] = [];
  for (const [i, line] of lines.entries()) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    if (/^# --- For Docker Compose/.test(lines.slice(0, i).reverse().find((l) => l.startsWith('# ---')) ?? '')) continue;
    const name = m[1]!;
    const secret = (lines[i - 1] ?? '').startsWith('# SECRET.');
    const known = WHERE[name];
    const hint = providerHint(file, name);
    out.push({
      name, secret, value: secret ? undefined : m[2]!.replace(/^"|"$/g, ''),
      why: known?.why ?? connectionSecrets.get(name) ?? (lines[i - 1] ?? '').replace(/^# (SECRET\. )?/, ''),
      ...(known?.where ?? hint ? { where: known?.where ?? hint } : {}),
      ...(known?.generate ? { generate: known.generate } : {}),
    });
  }
  // On Google Cloud the script makes this one itself and keeps it in Secret Manager.
  if (file.deploy.target === 'gcp') out.push({ name: 'JWT_SECRET', secret: true, automatic: true, why: WHERE.JWT_SECRET!.why, where: 'Nothing to do: the deploy script makes it once and keeps it in Secret Manager.' });
  return out;
}

function providerHint(file: CompanyFile, name: string) {
  for (const c of file.connections) {
    const key = Object.entries(c.secrets).find(([, v]) => v === name)?.[0];
    if (key) return providerFor(c.kind, c.provider)?.secrets?.find((s) => s.key === key)?.hint;
    if (c.webhookSecretEnv === name) return 'Any long random text: openssl rand -base64 32. Give the same text to the service, which signs its calls with it.';
  }
  return undefined;
}

/** The exact command that stores one secret on this platform, if someone sets it there by hand. */
export function setCommand(file: CompanyFile, name: string): string | undefined {
  const d = file.deploy;
  const key = file.company.key;
  switch (d.target) {
    case 'gcp': {
      const id = name === 'REDIS_URL' ? `${key}-redis-url` : name === 'MONGODB_URI' ? `${key}-mongodb-uri` : name === 'SMTP_PASS' ? `${key}-smtp-pass` : `${key}-connection-${name.replace(/^CONNECTION_/, '').toLowerCase().replace(/_/g, '-')}`;
      return `printf '%s' 'VALUE' | gcloud secrets create ${id} --data-file=- --project ${d.projectId}`;
    }
    case 'aws': return `aws secretsmanager create-secret --region ${d.region} --name fleet/${key}/${name} --secret-string 'VALUE'`;
    case 'azure': return `az keyvault secret set --vault-name fleet-${key.slice(0, 17)} --name ${name.toLowerCase().replace(/_/g, '-')} --value 'VALUE'`;
    case 'fly': return `fly secrets set ${name}='VALUE' --app fleet-${key}`;
    case 'railway': return `railway variables --set ${name}='VALUE'`;
    case 'render': return undefined;
    case 'compose': return undefined;
    case 'local': return undefined;
  }
}

const unpack = (file: CompanyFile) => `unzip ${kitName(file)} && cd ${file.company.key}-kit`;
const fillIn = (file: CompanyFile): GuideStep => ({
  title: 'Fill in the secrets',
  text: 'Copy the settings file and fill in each line marked SECRET, from the table above. It stays with you: the script hands each value to the platform\'s own secret store, and it never goes back into this app.',
  commands: [unpack(file), 'cp .env.example .env', 'nano .env'],
});
const hasMail = (file: CompanyFile) => Boolean(file.deploy.smtp?.host || file.connections.some((c) => c.kind === 'email' && c.enabled && !providerFor('email', c.provider)?.simulated));
const checkIt = (file: CompanyFile, url: string): GuideStep => ({
  title: 'Check it worked',
  text: `It should answer "mongo":"connected". Then open the address: you should see the company's name and colour. ${hasMail(file)
    ? `${file.owner.email} gets an e-mail to choose a password. If it doesn't arrive, use "Forgot password" on the sign-in page.`
    : `Sign in as ${file.owner.email} with OWNER_PASSWORD, and change it under Your account. With no e-mail server, you set each person's password yourself under Users, and "Forgot password" won't send anything. If the only owner ever forgets theirs, set OWNER_PASSWORD_RESET to a new password, restart, sign in with it, then remove the variable.`}`,
  commands: [`curl -fsS ${url}/api/v1/health/ready`],
});

/** Each step to get this company running on its platform. */
export function guideSteps(file: CompanyFile): GuideStep[] {
  const d = file.deploy;
  const version = '<version>';
  const database: GuideStep = {
    title: 'Make the database',
    text: 'Create a cluster on MongoDB Atlas (a free one is fine to try; M10 or above for real work, for its backups), close to where the app will run. Add a database user, and copy the connection string for the next step.',
    link: { href: 'https://cloud.mongodb.com/', label: 'Open MongoDB Atlas' },
  };
  switch (d.target) {
    case 'gcp': {
      const url = d.domain ? `https://${d.domain}` : 'https://<the address it prints>';
      return [
        {
          title: 'Open Google Cloud Shell', text: `A terminal in your browser, already signed in, with nothing to install. If the project ${d.projectId} doesn't exist yet, create it and link billing first.`,
          link: { href: `https://console.cloud.google.com/?cloudshell=true&project=${d.projectId}`, label: 'Open Cloud Shell' },
          commands: [`gcloud projects create ${d.projectId}`, `gcloud config set project ${d.projectId}`],
        },
        database,
        { title: 'Upload this package', text: `In Cloud Shell's menu (⋮), choose Upload and pick ${kitName(file)}.` },
        fillIn(file),
        {
          title: 'Deploy', text: appSource()
            ? "One command. It builds the app in Cloud Build (a few minutes, the first time), then makes the service account, bucket, secrets, Cloud Run service and scheduled jobs. The first line only prints what it would do, if you'd like to look first. It's safe to run again."
            : "This copy has no source to carry, so deploy an image already built with deploy/build-image.sh: name its version. It's safe to run again.",
          commands: appSource() ? ['DRY_RUN=1 ./deploy.sh', './deploy.sh'] : [`DRY_RUN=1 ./deploy.sh ${version}`, `./deploy.sh ${version}`],
        },
        ...(d.egress === 'static' ? [{ title: 'Let the database accept it', text: 'The script prints a fixed outgoing address. Add it in Atlas, under Network Access.', link: { href: 'https://cloud.mongodb.com/', label: 'Open MongoDB Atlas' } }] : [{ title: 'Let the database accept it', text: 'In Atlas, under Network Access, allow connections from anywhere (0.0.0.0/0), since this app has no fixed address.' }]),
        ...(d.domain && d.domainMode !== 'none' ? [{ title: `Point ${d.domain} at it`, text: d.domainMode === 'lb' ? 'The script prints an IP address. Add an A record for it where the domain is managed. The certificate follows within about an hour.' : 'The script prints the DNS records to add. The certificate follows once they are in place.' }] : []),
        checkIt(file, url),
        ...runningOnGoogle(file),
      ];
    }
    case 'compose': return [
      { title: 'Get a server ready', text: `Any Linux server with Docker, 2 GB of memory, and ports 80 and 443 open (DigitalOcean, Hetzner, your own). Point ${d.domain} at its address, and copy this package over.`, commands: [`scp ${kitName(file)} you@${d.domain}:`], link: { href: 'https://docs.docker.com/engine/install/', label: 'Install Docker on the server' } },
      fillIn(file),
      { title: 'Start it', text: `${appSource() ? 'It builds the app from the source in this package, a few minutes the first time.' : 'Also set FLEET_VERSION in .env to the image version to run.'} The database, HTTPS and nightly backups come with it.`, commands: ['docker compose up -d --build'] },
      checkIt(file, `https://${d.domain}`),
    ];
    case 'local': return [
      { title: 'Install Docker Desktop', text: "Free for personal use and small businesses. Start it once it's installed, and wait until it says it is running.", link: { href: 'https://www.docker.com/products/docker-desktop/', label: 'Get Docker Desktop' } },
      { title: 'Unzip the package and start it', text: `On a Mac, double-click start.command (the first time: right-click it, Open, then Open). On Windows, double-click start.bat. Or in a terminal, the commands below. It builds the app from the source in the package, a few minutes the first time, with its own database and files: the copy you're in now is not touched.`, commands: [unpack(file), './start.sh'] },
      { title: 'Sign in', text: `It opens http://localhost:${d.port}. Sign in as ${file.owner.email} with the password it shows the first time (it is also in .env as OWNER_PASSWORD), and change it under Your account.` },
      { title: 'Stop or start it again', text: 'The data stays between starts. Run start.command, start.bat or ./start.sh again to start it.', commands: [`docker compose --project-name fleet-${file.company.key}-local down`] },
    ];
    default: return platformSteps(file, database);
  }
}

/**
 * Running it on Google Cloud, every day after deploying (#104), with this company's own names in the commands.
 * Nothing here has been tried against a real Google Cloud project yet; the restore was done, in CI, on Compose.
 */
export function runningOnGoogle(file: CompanyFile): GuideStep[] {
  const d = file.deploy;
  if (d.target !== 'gcp') return [];
  const service = `fleet-${file.company.key}`;
  const at = `--region ${d.region} --project ${d.projectId}`;
  const bucket = `${d.projectId}-${file.company.key}-files`;
  return [
    {
      title: "Running it: knowing it's down or failing",
      text: `The script set up two alerts, e-mailed to ${d.alertEmail ?? file.owner.email}: the address's health check failing for two minutes, and more than 5 errors in the log in 10 minutes. Each e-mail says what to read. To read the log yourself:`,
      commands: [`gcloud run services logs read ${service} ${at} --limit 100`, `gcloud logging read 'resource.labels.service_name=${service} AND severity>=ERROR' --project ${d.projectId} --limit 50`],
      link: { href: `https://console.cloud.google.com/run/detail/${d.region}/${service}/logs?project=${d.projectId}`, label: 'Open the log' },
    },
    {
      title: 'Running it: what it costs',
      text: `A budget of ${d.monthlyBudget} a month (in the billing account's currency) sends an e-mail at half, 90% and all of it; nothing is stopped. What costs money: Cloud Run while it runs (${d.minInstances > 0 ? `always, since ${d.minInstances} instance stays running` : 'only while someone uses it, since it sleeps when idle'}), ${d.domainMode === 'lb' ? 'the load balancer for the domain (a fixed monthly charge), ' : ''}${d.egress === 'static' ? 'the fixed outgoing address (Cloud NAT and a reserved address), ' : ''}Cloud Storage for files, Secret Manager, Cloud Scheduler, and the database, billed by MongoDB. No prices are given here: none were checked against Google's price list for this guide (7 November 2026), so use the calculator with these choices.`,
      link: { href: 'https://cloud.google.com/products/calculator', label: 'Google Cloud pricing calculator' },
    },
    {
      title: 'Running it: backups and restoring them',
      list: [
        "MongoDB Atlas keeps the database's backups. The free tier keeps none, so it is not for a company's real data. Flex takes a snapshot every day. M10 and above keep the snapshots you schedule and can restore to any minute with continuous backup, at extra cost. Check the tier's page before relying on it.",
        'To restore a snapshot: Atlas → the cluster → Backup → Snapshots → Restore → this cluster. Everything written since that snapshot is lost, so take a fresh one first if you can.',
        'A copy of your own, any time, from a computer with the MongoDB database tools (these exact commands are run on every CI run, against the Docker Compose package):',
        `mongodump --uri "<MONGODB_URI>" --gzip --archive=${file.company.key}-$(date +%F).gz`,
        `mongorestore --uri "<MONGODB_URI>" --gzip --archive=${file.company.key}-<date>.gz --drop`,
        `Uploaded files keep every old version in gs://${bucket}. A deleted or overwritten file comes back from its older version:`,
        `gcloud storage ls --all-versions gs://${bucket}/<path>   then   gcloud storage cp gs://${bucket}/<path>#<generation> gs://${bucket}/<path>`,
      ],
    },
    {
      title: 'Running it: upgrades and going back a version',
      text: 'To upgrade, make a new package (Set up a company, or Package this company) and run ./deploy.sh from it, as the first time. It builds the new version and starts it; the old one stays, ready to go back to. On start, the server moves the database forward to the new version. Going back to an older version afterwards is safe unless the new one changed the database: then restore the snapshot taken before the upgrade. Take one before every upgrade.',
      commands: [`gcloud run revisions list --service ${service} ${at}`, `gcloud run services update-traffic ${service} --to-revisions <revision>=100 ${at}`],
    },
    {
      title: 'Running it: changing the company later',
      text: "Running a new package again applies only what its company file changed since the last time. A setting someone has since changed in the app keeps its value, unless the file changes that same setting again. Nothing is deleted: a connection, role or person left out of the file stays, and a data row that's already there is left alone. To remove something, do it in the app.",
    },
  ];
}

/** AWS, Azure, Render, Fly and Railway: each one's own steps. Their scripts have been written, not yet run for real. */
function platformSteps(file: CompanyFile, database: GuideStep): GuideStep[] {
  const d = file.deploy;
  const key = file.company.key;
  const built = appSource() ? 'It builds the app from the source in this package.' : 'Name the image version to run.';
  const run = (script: string) => (appSource() ? [`DRY_RUN=1 deploy/${script}.sh`, `deploy/${script}.sh`] : [`DRY_RUN=1 deploy/${script}.sh <version>`, `deploy/${script}.sh <version>`]);
  const untested = "This script has been written from the platform's documentation but not yet run against a real account, so read each step as it goes.";
  switch (d.target) {
    case 'aws': return [
      database,
      { title: 'Make the bucket for files', text: `App Runner keeps no disk, so uploaded files go to S3. Make a bucket in ${d.region}, an IAM user that may use only it, and add a storage connection (Amazon S3) to the company file before building the package.`, link: { href: 'https://s3.console.aws.amazon.com/s3/bucket/create', label: 'Create an S3 bucket' } },
      fillIn(file),
      { title: 'Deploy', text: `${built} It pushes the image to ECR, keeps each secret in Secrets Manager as fleet/${key}/<NAME>, and creates the App Runner service. ${untested}`, commands: run('aws') },
      { title: `Point ${d.domain} at it`, text: 'The script asks App Runner for the domain and prints the command that lists the DNS records to add.' },
      checkIt(file, `https://${d.domain}`),
    ];
    case 'azure': return [
      database,
      fillIn(file),
      { title: 'Deploy', text: `${built} It makes a resource group, a container registry, a Key Vault for the secrets, a file share for uploads, the container app and its two scheduled jobs. ${untested}`, commands: ['az login', ...run('azure')] },
      { title: `Point ${d.domain} at it`, text: 'The script prints the CNAME and TXT records to add, then the command that binds the domain with a free certificate.' },
      checkIt(file, `https://${d.domain}`),
    ];
    case 'render': return [
      database,
      fillIn(file),
      { title: 'Write the blueprint', text: `It writes render.yaml: a web service built from this package's Dockerfile, with a disk for uploaded files and the hourly rates job. ${untested}`, commands: run('render') },
      { title: 'Put the package in a private repository', text: 'Without .env: it stays on your computer.', commands: ['git init && git add -A && git commit -m "Fleet package"', 'git remote add origin <your private repository>', 'git push -u origin main'] },
      { title: 'Create the Blueprint', text: 'In Render: New → Blueprint → that repository. Render asks for each secret: paste them from .env.', link: { href: 'https://dashboard.render.com/select-repo?type=blueprint', label: 'New Blueprint' } },
      checkIt(file, d.domain ? `https://${d.domain}` : `https://fleet-${key}.onrender.com`),
    ];
    case 'fly': return [
      database,
      fillIn(file),
      { title: 'Deploy', text: `${built.replace('It builds', "Fly's builder builds")} It creates the app and a volume for files, sets the secrets from .env, and deploys. ${untested}`, commands: ['fly auth login', ...run('fly')] },
      ...(d.domain ? [{ title: `Point ${d.domain} at it`, text: `The script asks Fly for a certificate and prints the DNS records: fly certs show ${d.domain} --app fleet-${key}.` }] : []),
      checkIt(file, d.domain ? `https://${d.domain}` : `https://fleet-${key}.fly.dev`),
    ];
    default: return [
      database,
      { title: 'Make the project and its volume', text: 'In Railway: a new project with an empty service, and a volume on it mounted at /data, for uploaded files. Then link this folder to it.', commands: ['railway login', 'railway link'], link: { href: 'https://railway.com/new', label: 'New Railway project' } },
      fillIn(file),
      { title: 'Deploy', text: `${built.replace('It builds', "Railway builds")} The script sets the variables and deploys. ${untested}`, commands: run('railway') },
      { title: `Point ${d.domain} at it`, text: 'Add the domain in Railway, and the record it shows where the domain is managed.', commands: [`railway domain ${d.domain}`] },
      checkIt(file, `https://${d.domain}`),
    ];
  }
}

export const deployGuide = (file: CompanyFile) => ({
  env: envVars(file).map((v) => ({ ...v, ...(v.secret && !v.automatic ? { command: setCommand(file, v.name) } : {}) })),
  steps: guideSteps(file),
  envFile: envTemplate(file),
  hasSource: Boolean(appSource()),
});
