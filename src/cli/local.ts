import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Environment, type Problem, type Profile, appSource, checkProfile, companyFileOf, folderAttachments, json, kitEntries, namedFiles,
} from '../profile/index.js';
import { run, stream } from './proc.js';

/**
 * A company's copy on this computer (platform design §5.5, "New prospect, demo"): from its profile and one of
 * its environments, made into the same kit the vendor would hand over, then started. Two ways to start it:
 *
 * - docker: the kit's own docker-compose.yml, as start.sh does it, with the copy's database in Docker. What a
 *   vendor's laptop uses, and what the CI runs.
 * - node: this checkout's server run directly, against a MongoDB already running here. For a computer without
 *   Docker, such as a developer's; the copy is the same app, applying the same profile, but not in a container.
 *
 * Everything a run needs is kept in the company's .build/<environment>/ folder, which the workspace never
 * commits: the kit, the settings file with the copy's own sign-in key and first owner password, and the
 * demonstration's sign-ins. They are a local copy's, with made-up data; nothing else is stored.
 */

export type Engine = 'docker' | 'node';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_WAIT_MS = Number(process.env.FLEET_UP_WAIT_MS ?? 8 * 60_000);

export interface LocalCopy { dir: string; profile: Profile; environment: Environment }
export interface SignIn { role: string; login: string; password: string }
export interface SignIns { owner: { email: string; password?: string }; logins: SignIn[]; at: string; note?: string }
export interface RunState {
  state: 'stopped' | 'starting' | 'running' | 'unhealthy';
  engine?: Engine; url?: string; startedAt?: string; detail?: string;
}

/** The folder a run keeps its kit and settings in. */
export const buildDir = (copy: LocalCopy) => join(copy.dir, '.build', copy.environment.name);
const kitDir = (copy: LocalCopy) => join(buildDir(copy), 'kit');
const runFile = (copy: LocalCopy) => join(buildDir(copy), 'run.json');
const signInsFile = (copy: LocalCopy) => join(buildDir(copy), 'sign-ins.json');
const logFile = (copy: LocalCopy) => join(buildDir(copy), 'app.log');
/** The same project name start.sh uses, so a copy started either way is the same copy. */
export const composeProject = (copy: LocalCopy) => (copy.environment.target === 'local' ? `fleet-${copy.profile.company.key}-local` : `fleet-${copy.profile.company.key}`);
export const portOf = (copy: LocalCopy) => (copy.environment.target === 'local' ? copy.environment.port : 3000);
export const urlOf = (copy: LocalCopy) => `http://localhost:${portOf(copy)}`;
/** The node engine's database: one per company and environment, all named fleet_studio_… so they're easy to find. */
export const databaseOf = (copy: LocalCopy) => `fleet_studio_${copy.profile.company.key.replace(/-/g, '_')}_${copy.environment.name.replace(/-/g, '_')}`;
export const companyName = (p: Profile) => p.company.tradingName || p.company.legalName;

const random = (n: number) => randomBytes(n * 2).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; } };
/** The value of one line of a .env file. */
export const envValue = (text: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.replace(/^"(.*)"$/, '$1');

/** Whether something answers on the port: a copy can't start on a port another program holds. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function ready(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/v1/health/ready`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

/** Waits for the copy to answer its health check, as Cloud Run's startup probe and start.sh do. */
export async function waitReady(url: string, log: (line: string) => void, alive: () => boolean = () => true): Promise<boolean> {
  const until = Date.now() + MAX_WAIT_MS;
  let said = 0;
  while (Date.now() < until) {
    if (await ready(url)) return true;
    if (!alive()) return false;
    if (Date.now() - said > 30_000) { said = Date.now(); log(`Waiting for ${url} to answer…`); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Writes the environment's kit into .build/<environment>/kit: what `fleet kit` zips, unpacked. The settings
 * file (.env) is made once, with a new sign-in key and the owner's first password, and kept after that:
 * changing the key would sign everyone out.
 */
export function writeKit(copy: LocalCopy): { problems: Problem[]; dir: string } {
  const attachments = folderAttachments(copy.dir, copy.profile);
  const problems = checkProfile(copy.profile, copy.environment, attachments);
  const dir = kitDir(copy);
  if (problems.length) return { problems, dir };
  const file = companyFileOf(copy.profile, copy.environment);
  const named = new Set(namedFiles(copy.profile));
  const entries = kitEntries(file, new Map([...attachments].filter(([p]) => named.has(p))), { purpose: copy.environment.purpose, trialEnds: copy.environment.trialEnds });
  // Files the profile no longer names don't stay behind.
  for (const sub of ['files', 'data', 'deploy']) rmSync(join(dir, sub), { recursive: true, force: true });
  const prefix = `${file.company.key}-kit/`;
  for (const e of entries) {
    const path = join(dir, e.path.slice(prefix.length));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, e.data);
    if (e.executable) chmodSync(path, 0o755);
  }
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) {
    const template = readFileSync(join(dir, '.env.example'), 'utf8');
    const filled = template.replace(/^JWT_SECRET=$/m, `JWT_SECRET=${random(48)}`).replace(/^OWNER_PASSWORD=$/m, `OWNER_PASSWORD=Fleet${random(10)}7`);
    writeFileSync(envPath, filled, { mode: 0o600 });
  }
  return { problems: [], dir };
}

/** The settings a kit's .env still needs someone to fill in (a server's e-mail password, a connection's key). */
export const unfilled = (envText: string) => [...envText.matchAll(/^([A-Z][A-Z0-9_]*)=$/gm)].map((m) => m[1]!);

/* ---------- docker ---------- */

const compose = (copy: LocalCopy, args: string[]) => ['compose', '--project-name', composeProject(copy), ...args];
const dockerEnv = (copy: LocalCopy): NodeJS.ProcessEnv => ({ ...process.env, PORT: String(portOf(copy)) });

async function upDocker(copy: LocalCopy, log: (line: string) => void): Promise<void> {
  const dir = kitDir(copy);
  const missing = unfilled(readFileSync(join(dir, '.env'), 'utf8'));
  // A server's copy can't start without them. A copy on this computer starts anyway, as start.sh does: only the
  // connection that needs the key doesn't work until it's filled in.
  if (missing.length && copy.environment.target === 'compose') throw new Error(`Fill in ${missing.join(', ')} in ${join(dir, '.env')}, then start it again. They are this copy's secrets; nothing else keeps them.`);
  if (missing.length) log(`Not filled in: ${missing.join(', ')}. What needs them doesn't work in this copy until they are, in ${join(dir, '.env')}.`);
  if (!appSource()) throw new Error("This checkout has no git history, so the kit can't carry the app's source to build from.");
  log(`Building and starting ${composeProject(copy)} with Docker. The first time takes a few minutes.`);
  const code = await stream('docker', compose(copy, ['up', '-d', '--build', ...(copy.environment.target === 'compose' && process.env.FLEET_UP_SERVICES ? process.env.FLEET_UP_SERVICES.split(',') : [])]), { cwd: dir, env: dockerEnv(copy) }, log);
  if (code !== 0) throw new Error(code === 127 ? 'Docker is not installed.' : `docker compose up stopped (exit ${code}). The lines above say why.`);
}

/* ---------- node ---------- */

/** Where the node engine's copies find MongoDB: this computer's, unless Studio or the CLI is told another. */
export const localMongo = () => (process.env.FLEET_LOCAL_MONGODB_URI ?? 'mongodb://127.0.0.1:27017').replace(/\/+$/, '');
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

async function upNode(copy: LocalCopy, log: (line: string) => void): Promise<number> {
  if (copy.environment.target !== 'local') throw new Error('Only a copy on this computer (target local) runs without Docker.');
  const dir = buildDir(copy);
  const kit = kitDir(copy);
  const settings = readFileSync(join(kit, '.env'), 'utf8');
  // The app's screens, built once: the server serves web/dist when it is there.
  if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) {
    log("Building the app's screens first (once, about a minute).");
    const code = await stream(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '--prefix', 'web'], { cwd: ROOT, env: process.env }, log);
    if (code !== 0) throw new Error("The app's screens didn't build. The lines above say why.");
  }
  // The profile and its environment as they are, with the files they name: format 2, applied on start.
  const app = join(dir, 'app');
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'profile.json'), json(copy.profile));
  writeFileSync(join(app, 'environment.json'), json(copy.environment));
  for (const [path, body] of folderAttachments(copy.dir, copy.profile)) { mkdirSync(dirname(join(app, path)), { recursive: true }); writeFileSync(join(app, path), body); }
  const port = portOf(copy);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, SYSTEMROOT: process.env.SYSTEMROOT, TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'info',
    APP_URL: `http://localhost:${port}`, MONGODB_URI: `${localMongo()}/${databaseOf(copy)}`,
    COMPANY_CONFIG: join(app, 'profile.json'), COPY_PURPOSE: copy.environment.purpose,
    ...(copy.environment.trialEnds ? { TRIAL_ENDS: copy.environment.trialEnds } : {}),
    OWNER_EMAIL: copy.profile.owner.email, OWNER_PASSWORD: envValue(settings, 'OWNER_PASSWORD'), JWT_SECRET: envValue(settings, 'JWT_SECRET'),
    FILE_STORAGE: 'local', FILE_STORAGE_DIR: join(dir, 'uploads'), CONSOLE_ENABLED: 'false', IN_PROCESS_JOBS: 'true', DRIVER_PHONE_SIMULATOR: 'true',
    APP_VERSION: appSource()?.version,
  };
  // Run from the copy's own folder, so no .env of this checkout is read into it.
  const out = openSync(logFile(copy), 'a');
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(ROOT, 'src', 'server.ts')], { cwd: dir, env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  closeSync(out);
  child.unref();
  log(`Started the server from this checkout (process ${child.pid}), with its database ${databaseOf(copy)} at ${localMongo()}.`);
  return child.pid!;
}

/* ---------- the copy ---------- */

/** What the run file remembers: how it was started, so another program (Studio, a terminal) can see and stop it. */
interface RunRecord { engine: Engine; pid?: number; port: number; startedAt: string }

/** Builds the kit and starts the copy; resolves once it answers, or throws with the reason. */
export async function up(copy: LocalCopy, engine: Engine, log: (line: string) => void): Promise<{ url: string; signIns?: SignIns }> {
  if (engine === 'node' && copy.environment.target !== 'local') throw new Error(`${copy.environment.name} runs with Docker Compose, which needs Docker: only a copy on this computer (target local) runs without it.`);
  const now = await status(copy);
  if (now.state === 'running') { log(`Already running at ${now.url}.`); return { url: now.url!, signIns: readSignIns(copy) }; }
  const port = portOf(copy);
  if (!(await portFree(port))) throw new Error(`Something else on this computer is using port ${port}. Stop it, or give this environment another port.`);
  const { problems } = writeKit(copy);
  if (problems.length) throw new Error(`It can't start yet:\n${problems.map((p) => `  ${p.path}: ${p.message}`).join('\n')}`);
  log(`Kit written to ${kitDir(copy)}.`);
  const record: RunRecord = { engine, port, startedAt: new Date().toISOString() };
  if (engine === 'docker') await upDocker(copy, log);
  else record.pid = await upNode(copy, log);
  writeFileSync(runFile(copy), json(record));
  const url = urlOf(copy);
  const ok = await waitReady(url, log, engine === 'node' ? () => alive(record.pid) : undefined);
  if (!ok) {
    const tail = (await logs(copy, 30)).join('\n');
    throw new Error(`It didn't answer at ${url}.${tail ? `\nThe copy's last lines:\n${tail}` : ''}`);
  }
  log(`Ready: ${url}`);
  return { url, signIns: copy.environment.purpose === 'demo' ? await makeSignIns(copy, log) : ownerOnly(copy) };
}

/** Stops the copy. `remove` also deletes its database and files, so the next start begins again. */
export async function down(copy: LocalCopy, options: { remove?: boolean } = {}, log: (line: string) => void = () => undefined): Promise<void> {
  const record = readJson<RunRecord>(runFile(copy));
  const engine = record?.engine ?? 'docker';
  if (engine === 'docker') {
    if (existsSync(kitDir(copy))) {
      const code = await stream('docker', compose(copy, ['down', ...(options.remove ? ['-v'] : [])]), { cwd: kitDir(copy), env: dockerEnv(copy) }, log);
      if (code !== 0) throw new Error(code === 127 ? 'Docker is not installed.' : `docker compose down stopped (exit ${code}).`);
    }
  } else if (record?.pid && alive(record.pid)) {
    try { process.kill(-record.pid, 'SIGTERM'); } catch { process.kill(record.pid, 'SIGTERM'); }
    for (let i = 0; i < 50 && alive(record.pid); i++) await new Promise((r) => setTimeout(r, 200));
    if (alive(record.pid)) process.kill(record.pid, 'SIGKILL');
    log('Stopped.');
  }
  rmSync(runFile(copy), { force: true });
  if (options.remove) {
    if (engine === 'node') await dropDatabase(copy, log);
    rmSync(buildDir(copy), { recursive: true, force: true });
    log('Removed its database, files and settings.');
  }
}

/** The node engine's database, dropped with the MongoDB driver Mongoose brings: the only time Studio opens one. */
async function dropDatabase(copy: LocalCopy, log: (line: string) => void) {
  const { default: mongoose } = await import('mongoose');
  const conn = mongoose.createConnection(`${localMongo()}/${databaseOf(copy)}`, { serverSelectionTimeoutMS: 3000 });
  try { await conn.asPromise(); await conn.dropDatabase(); } catch (err) { log(`Its database could not be removed: ${(err as Error).message}`); } finally { await conn.close().catch(() => undefined); }
}

/** Whether the copy runs, and whether it answers. */
export async function status(copy: LocalCopy): Promise<RunState> {
  const record = readJson<RunRecord>(runFile(copy));
  const url = urlOf(copy);
  if (!record) return { state: 'stopped' };
  if (record.engine === 'node' && !alive(record.pid)) return { state: 'stopped', detail: 'It stopped on its own; its log says why.' };
  if (record.engine === 'docker') {
    const ps = await run('docker', compose(copy, ['ps', '--format', 'json']), { cwd: existsSync(kitDir(copy)) ? kitDir(copy) : undefined, env: dockerEnv(copy), timeoutMs: 15_000 });
    if (ps.code === 127) return { state: 'stopped', engine: 'docker', detail: 'Docker is not installed.' };
    const services = ps.stdout.trim().split('\n').filter(Boolean).flatMap((l) => { try { const v = JSON.parse(l); return Array.isArray(v) ? v : [v]; } catch { return []; } }) as { Service?: string; State?: string }[];
    if (!services.some((s) => s.Service === 'app' && s.State === 'running')) return { state: 'stopped', engine: 'docker' };
  }
  return { state: (await ready(url)) ? 'running' : 'starting', engine: record.engine, url, startedAt: record.startedAt };
}

/** The copy's last lines: the server's log, with "Company file applied" and each step. */
export async function logs(copy: LocalCopy, lines = 200): Promise<string[]> {
  const record = readJson<RunRecord>(runFile(copy));
  if (record?.engine === 'node' || (!record && existsSync(logFile(copy)))) {
    if (!existsSync(logFile(copy))) return [];
    const size = statSync(logFile(copy)).size;
    const text = readFileSync(logFile(copy), 'utf8').slice(Math.max(0, size - 400_000));
    return text.split('\n').filter(Boolean).slice(-lines).map(readable);
  }
  if (!existsSync(kitDir(copy))) return [];
  const out = await run('docker', compose(copy, ['logs', '--no-color', '--tail', String(lines), 'app']), { cwd: kitDir(copy), env: dockerEnv(copy), timeoutMs: 20_000 });
  return (out.stdout + out.stderr).split('\n').filter(Boolean).map((l) => readable(l.replace(/^app-\d+\s+\|\s?/, '').replace(/^[\w-]+\s+\|\s?/, '')));
}

/** A JSON log line as a person reads it: the time, the message and what it was about. */
function readable(line: string): string {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    const time = typeof v.time === 'number' ? new Date(v.time).toLocaleTimeString() : '';
    const level = Number(v.level) >= 50 ? 'error ' : Number(v.level) >= 40 ? 'warning ' : '';
    const extra = ['step', 'outcome', 'detail', 'url'].filter((k) => v[k] !== undefined).map((k) => `${k}: ${String(v[k])}`).join(', ');
    return `${time} ${level}${String(v.msg ?? '')}${extra ? ` (${extra})` : ''}`.trim();
  } catch { return line; }
}

/* ---------- sign-ins ---------- */

const ownerOnly = (copy: LocalCopy): SignIns => ({ owner: { email: copy.profile.owner.email, password: ownerPassword(copy) }, logins: [], at: new Date().toISOString() });
const ownerPassword = (copy: LocalCopy) => (existsSync(join(kitDir(copy), '.env')) ? envValue(readFileSync(join(kitDir(copy), '.env'), 'utf8'), 'OWNER_PASSWORD') : undefined);
export const readSignIns = (copy: LocalCopy): SignIns | undefined => readJson<SignIns>(signInsFile(copy)) ?? (existsSync(join(kitDir(copy), '.env')) ? ownerOnly(copy) : undefined);

/** Signs in to the running copy as its owner, with the first password this run gave it. */
async function ownerToken(copy: LocalCopy): Promise<string> {
  const password = ownerPassword(copy);
  const res = await fetch(`${urlOf(copy)}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: copy.profile.owner.email, password }) });
  if (!res.ok) throw new Error(`Couldn't sign in to the copy as ${copy.profile.owner.email} with its first password (HTTP ${res.status}). If it was changed in the app, reset the demonstration there.`);
  return ((await res.json()) as { data: { accessToken: string } }).data.accessToken;
}

async function call<T>(copy: LocalCopy, path: string, body: unknown): Promise<T> {
  const token = await ownerToken(copy);
  const res = await fetch(`${urlOf(copy)}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const answer = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!res.ok) throw new Error(answer.error?.message ?? `The copy answered HTTP ${res.status}`);
  return answer.data as T;
}

const keep = (copy: LocalCopy, logins: SignIn[], note?: string): SignIns => {
  const kept: SignIns = { owner: { email: copy.profile.owner.email, password: ownerPassword(copy) }, logins, at: new Date().toISOString(), ...(note ? { note } : {}) };
  writeFileSync(signInsFile(copy), json(kept), { mode: 0o600 });
  return kept;
};

/** A demonstration's sign-ins, one per desk and one driver, made by the copy the first time it runs (they're shown once). */
export async function makeSignIns(copy: LocalCopy, log: (line: string) => void = () => undefined): Promise<SignIns> {
  const before = readJson<SignIns>(signInsFile(copy));
  try {
    const made = await call<{ logins: SignIn[] }>(copy, '/installation/demo-logins', {});
    if (made.logins.length) return keep(copy, made.logins);
    return before ?? keep(copy, [], 'Its sign-ins were made before and are shown only once. Reset it for new ones.');
  } catch (err) {
    log(`Sign-ins: ${(err as Error).message}`);
    return before ?? ownerOnly(copy);
  }
}

/** Resets a running demonstration: everything removed and its profile applied again, with new sign-ins. */
export async function reset(copy: LocalCopy): Promise<SignIns> {
  if (copy.environment.purpose !== 'demo') throw new Error('Only a demonstration can be reset.');
  const out = await call<{ logins: SignIn[] }>(copy, '/installation/reset', { confirm: companyName(copy.profile) });
  return keep(copy, out.logins);
}
