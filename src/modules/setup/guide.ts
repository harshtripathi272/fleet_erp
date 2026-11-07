import { providerFor } from '../../core/connections/index.js';
import { type CompanyFile, type Target, secretSettings } from './companyFile.js';
import { appSource, envTemplate, kitName } from './kit.js';

/**
 * What the set-up screen tells someone deploying: what each platform asks for, every environment variable with what
 * it's for and where to get it, and each step, with this company's own values already in the commands. The app
 * never holds a secret; this says what to do with them.
 */

export interface TargetField { key: string; label: string; hint?: string; type: 'text' | 'number' | 'choice'; required?: boolean; placeholder?: string; choices?: { value: string; label: string }[]; default?: string | number; min?: number; max?: number }

const GCP_REGIONS: [string, string][] = [
  ['africa-south1', 'Johannesburg'], ['asia-south1', 'Mumbai'], ['asia-south2', 'Delhi'], ['asia-southeast1', 'Singapore'], ['asia-east1', 'Taiwan'], ['asia-northeast1', 'Tokyo'],
  ['australia-southeast1', 'Sydney'], ['europe-west1', 'Belgium'], ['europe-west2', 'London'], ['europe-west3', 'Frankfurt'], ['europe-west4', 'Netherlands'], ['me-central1', 'Doha'], ['me-west1', 'Tel Aviv'],
  ['northamerica-northeast1', 'Montréal'], ['southamerica-east1', 'São Paulo'], ['us-central1', 'Iowa'], ['us-east1', 'South Carolina'], ['us-west1', 'Oregon'],
];
const choices = (list: [string, string][]) => list.map(([value, label]) => ({ value, label: `${label} (${value})` }));

const DOMAIN: TargetField = { key: 'domain', label: "The company's address", hint: 'The web address people will use, without https://. You point it at the platform at the end.', type: 'text', placeholder: 'fleet.acme.example' };
const IMAGE: TargetField = { key: 'image', label: 'App image', hint: 'Where the shared image lives, without its version. deploy/build-image.sh in the repository makes one.', type: 'text', required: true, placeholder: 'ghcr.io/acme/fleet-erp' };

export const TARGET_FIELDS: Record<Target, TargetField[]> = {
  gcp: [
    { key: 'projectId', label: 'Google Cloud project', hint: 'The project ID, not its name: the top of the Google Cloud console shows it.', type: 'text', required: true, placeholder: 'acme-fleet-prod' },
    { key: 'region', label: 'Region', hint: 'Closest to the people using it. Pick the same area for the database.', type: 'choice', choices: choices(GCP_REGIONS), default: 'africa-south1' },
    { ...DOMAIN, hint: "The web address people will use, without https://. Leave empty to use Google's own address (…run.app) for now." },
    { key: 'domainMode', label: 'How the address connects', hint: "A load balancer works in every region but costs about US$20 a month. A domain mapping is free, but isn't offered in every region.", type: 'choice', default: 'lb', choices: [{ value: 'lb', label: 'Load balancer (works everywhere)' }, { value: 'mapping', label: 'Domain mapping (free, some regions)' }, { value: 'none', label: "None: use Google's address" }] },
    { key: 'egress', label: 'Outgoing address', hint: 'A fixed address lets MongoDB Atlas allow only this app, and costs a little. Open needs Atlas to accept connections from anywhere.', type: 'choice', default: 'static', choices: [{ value: 'static', label: 'Fixed (recommended)' }, { value: 'open', label: 'Open' }] },
    { key: 'minInstances', label: 'Always running', hint: '0 sleeps when nobody is using it: cheapest, with a few seconds to wake up. 1 is always ready.', type: 'number', default: 0, min: 0, max: 10 },
    { key: 'maxInstances', label: 'At most', hint: 'Above 1 also needs Redis, so sign-in limits are shared. 1 is enough for a company of this size to start.', type: 'number', default: 1, min: 1, max: 10 },
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
};

export const TARGET_NEEDS: Record<Target, string[]> = {
  gcp: ['A Google account, and a project with billing switched on', 'A MongoDB Atlas database (free to start)', 'Nothing to install: it runs in Google Cloud Shell'],
  compose: ['A server with Docker, reachable from the internet', 'A domain pointing at it'],
  aws: ['An AWS account, and the aws tool signed in', 'A MongoDB Atlas database', 'An S3 bucket for files'],
  azure: ['An Azure subscription, and the az tool signed in', 'A MongoDB Atlas database'],
  render: ['A Render account', 'A MongoDB Atlas database'],
  fly: ['A Fly.io account, and the fly tool signed in', 'A MongoDB Atlas database'],
  railway: ['A Railway account, and the railway tool signed in', 'A MongoDB Atlas database'],
};

export interface EnvVar { name: string; value?: string; secret: boolean; why: string; where?: string; generate?: string; automatic?: boolean }
export interface GuideStep { title: string; text?: string; commands?: string[]; link?: { href: string; label: string }; list?: string[] }

/** Where to get a secret that isn't a connection's. */
const WHERE: Record<string, { why: string; where?: string; generate?: string }> = {
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
      const id = name === 'MONGODB_URI' ? `${key}-mongodb-uri` : name === 'SMTP_PASS' ? `${key}-smtp-pass` : `${key}-connection-${name.replace(/^CONNECTION_/, '').toLowerCase().replace(/_/g, '-')}`;
      return `printf '%s' 'VALUE' | gcloud secrets create ${id} --data-file=- --project ${d.projectId}`;
    }
    case 'aws': return `aws secretsmanager create-secret --region ${d.region} --name fleet/${key}/${name} --secret-string 'VALUE'`;
    case 'azure': return `az keyvault secret set --vault-name fleet-${key.slice(0, 17)} --name ${name.toLowerCase().replace(/_/g, '-')} --value 'VALUE'`;
    case 'fly': return `fly secrets set ${name}='VALUE' --app fleet-${key}`;
    case 'railway': return `railway variables --set ${name}='VALUE'`;
    case 'render': return undefined;
    case 'compose': return undefined;
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
    : `Sign in as ${file.owner.email} with OWNER_PASSWORD, and change it under Your account. With no e-mail server, you set each person's password yourself under Users, and "Forgot password" won't send anything.`}`,
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
      ];
    }
    case 'compose': return [
      { title: 'Get a server ready', text: `Any server with Docker, 2 GB of memory, and ports 80 and 443 open. Point ${d.domain} at it, and copy this package over.`, commands: [`scp ${kitName(file)} you@${d.domain}:`] },
      fillIn(file),
      { title: 'Start it', text: 'Also set FLEET_VERSION in .env to the image version to run. The database, HTTPS and nightly backups come with it.', commands: ['docker compose up -d'] },
      checkIt(file, `https://${d.domain}`),
    ];
    default: {
      const url = d.domain ? `https://${d.domain}` : d.target === 'fly' ? `https://fleet-${file.company.key}.fly.dev` : d.target === 'render' ? `https://fleet-${file.company.key}.onrender.com` : 'https://<the address it prints>';
      return [
        database,
        fillIn(file),
        { title: 'Deploy', text: 'Name the image version to run. This platform\'s script has been written but not yet run for real, so check each step as it goes.', commands: [`DRY_RUN=1 deploy/${d.target}.sh ${version}`, `deploy/${d.target}.sh ${version}`] },
        checkIt(file, url),
      ];
    }
  }
}

export const deployGuide = (file: CompanyFile) => ({
  env: envVars(file).map((v) => ({ ...v, ...(v.secret && !v.automatic ? { command: setCommand(file, v.name) } : {}) })),
  steps: guideSteps(file),
  envFile: envTemplate(file),
  hasSource: Boolean(appSource()),
});
