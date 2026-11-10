/**
 * The fleet CLI (#133, platform design §5.1): the vendor's commands for a company's profile.
 *
 *   npm run fleet -- check   <company>            checks the profile and its environments
 *   npm run fleet -- kit     <company> [--env <name>] [--out <folder>]
 *   npm run fleet -- migrate <company.json> [--out <folder>] [--force]
 *   npm run fleet -- up      <company> [--env <name>] [--engine docker|node]
 *   npm run fleet -- down    <company> [--env <name>] [--remove]
 *   npm run fleet -- status  <company> [--env <name>]
 *   npm run fleet -- logs    <company> [--env <name>] [--lines <n>]
 *
 * <company> is a company folder (profile.json and environments/), its profile.json, or a format-1 company.json.
 * `npm run kit -- company.json` is `fleet kit`, as before. None of it needs a database.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// The masters' definitions, so a data file's master can be checked.
import '../app.js';
import {
  type Environment, type Problem, type Profile, checkProfile, folderAttachments, migrate1to2, namedFiles, profileKit, readTarget, writeFolder,
} from '../profile/index.js';
import { type LocalCopy, type SignIns, down, logs, status, up } from './local.js';
import { chooseEngine } from './tools.js';

const USAGE = `Usage: npm run fleet -- <command> <company> [options]

  check   <company>                          check the profile, its environments and the files they name
  kit     <company> [--env <name>] [--out <folder>]
                                              make an environment's kit (a zip)
  migrate <company.json> [--out <folder>]    turn a format-1 company file into profile.json and environments/
  up      <company> [--env <name>] [--engine docker|node]
                                              run a local or Docker Compose environment on this computer
  down    <company> [--env <name>] [--remove] stop it; --remove also deletes its database and files
  status  <company> [--env <name>]           whether it runs
  logs    <company> [--env <name>] [--lines <n>]

<company> is a company folder (profile.json and environments/), its profile.json, or a format-1 company.json.`;

class Stop extends Error {}
const fail = (message: string): never => { throw new Stop(message); };
const listed = (problems: Problem[]) => problems.map((p) => `  ${p.path}: ${p.message}`).join('\n');

interface Args { command?: string; path?: string; flags: Map<string, string | true> }
function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (['env', 'out', 'engine', 'lines'].includes(name) && next !== undefined && !next.startsWith('--')) { flags.set(name, next); i++; } else flags.set(name, true);
  }
  return { command: rest[0], path: rest[1], flags };
}
const flag = (args: Args, name: string) => { const v = args.flags.get(name); return typeof v === 'string' ? v : undefined; };

/** The company and the environment a command is about, read from what the person pointed at. */
interface Company { dir: string; profile: Profile; environments: Environment[]; format1?: true }
function company(path: string): Company {
  const target = readTarget(resolve(path));
  if (target.kind === 'file') {
    if (!target.read.ok) fail(`${path} has problems:\n${listed(target.read.problems)}`);
    const read = target.read as Extract<typeof target.read, { ok: true }>;
    return { dir: target.dir, profile: read.profile, environments: read.environment ? [read.environment] : [], ...(read.format === 1 ? { format1: true as const } : {}) };
  }
  const f = target.folder;
  const problems = [...f.problems, ...f.environments.flatMap((e) => e.problems)];
  if (!f.profile || problems.length) fail(`${f.dir} has problems:\n${listed(problems)}`);
  return { dir: f.dir, profile: f.profile!, environments: f.environments.map((e) => e.environment!) };
}
function environmentOf(c: Company, name?: string): Environment {
  if (name) return c.environments.find((e) => e.name === name) ?? fail(`${c.profile.company.key} has no environment "${name}". It has: ${c.environments.map((e) => e.name).join(', ') || 'none'}.`);
  if (c.environments.length === 1) return c.environments[0]!;
  if (!c.environments.length) return fail(`${c.profile.company.key} has no environment yet: add environments/<name>.json, for example demo-local.`);
  return fail(`${c.profile.company.key} has ${c.environments.length} environments: name one with --env (${c.environments.map((e) => e.name).join(', ')}).`);
}

async function check(args: Args) {
  const c = company(args.path!);
  const attachments = folderAttachments(c.dir, c.profile);
  const chosen = flag(args, 'env') ? [environmentOf(c, flag(args, 'env'))] : c.environments;
  const problems = chosen.flatMap((e) => checkProfile(c.profile, e, attachments));
  // Without an environment, the files the profile names are still checked.
  if (!chosen.length) for (const name of namedFiles(c.profile)) if (!attachments.has(name)) problems.push({ path: name, message: `${name} is not in ${c.dir}` });
  const unique = [...new Map(problems.map((p) => [`${p.path}|${p.message}`, p])).values()];
  if (unique.length) fail(`${c.profile.company.legalName} has problems:\n${listed(unique)}`);
  console.log(`${c.profile.company.legalName} is ready${chosen.length ? ` for ${chosen.map((e) => e.name).join(', ')}` : ''}: revision ${c.profile.revision}.`);
}

async function kit(args: Args) {
  const c = company(args.path!);
  const out = flag(args, 'out') ? resolve(flag(args, 'out')!) : c.dir;
  const attachments = folderAttachments(c.dir, c.profile);
  const environment = environmentOf(c, flag(args, 'env'));
  const made = profileKit(c.profile, environment, attachments);
  if (!made.zip) fail(`The kit was not built:\n${made.problems.map((p) => `  ${c.format1 ? p.path.replace(`environments.${environment.name}`, 'deploy') : p.path}: ${p.message}`).join('\n')}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, made.name!), made.zip!);
  console.log(`Wrote ${join(out, made.name!)}: ${c.profile.company.legalName}, for ${environment.target}${c.format1 ? '' : ` (${environment.name})`}. Next: README.md inside it.`);
}

async function migrate(args: Args) {
  const target = readTarget(resolve(args.path!));
  if (target.kind !== 'file') fail(`${args.path} is already a company folder: nothing to migrate.`);
  const t = target as Extract<typeof target, { kind: 'file' }>;
  if (!t.read.ok) fail(`${args.path} has problems:\n${listed(t.read.problems)}`);
  const read = t.read as Extract<typeof t.read, { ok: true }>;
  if (read.format !== 1) fail(`${args.path} is already format 2.`);
  const { profile, environment } = migrate1to2(read.file!);
  const out = flag(args, 'out') ? resolve(flag(args, 'out')!) : t.dir;
  if (existsSync(join(out, 'profile.json')) && !args.flags.has('force')) fail(`${join(out, 'profile.json')} is already there. Use --force to write over it.`);
  writeFolder(out, profile, [environment]);
  // The files it names come along, when the new folder is somewhere else.
  if (out !== t.dir) for (const name of namedFiles(profile)) if (existsSync(join(t.dir, name))) { mkdirSync(dirname(join(out, name)), { recursive: true }); cpSync(join(t.dir, name), join(out, name)); }
  console.log(`Wrote ${join(out, 'profile.json')} and ${join(out, 'environments', `${environment.name}.json`)}: ${profile.company.legalName}, revision 1.`);
}

function copyOf(args: Args): LocalCopy {
  const c = company(args.path!);
  const environment = environmentOf(c, flag(args, 'env'));
  if (environment.target !== 'local' && environment.target !== 'compose') fail(`${environment.name} runs on ${environment.target}: fleet up runs a local or Docker Compose environment. A cloud one is deployed with its kit (fleet kit).`);
  return { dir: c.dir, profile: c.profile, environment };
}

function printSignIns(s: SignIns | undefined) {
  if (!s) return;
  console.log(`\nSign in as the owner, ${s.owner.email}${s.owner.password ? `, with ${s.owner.password}` : ''}.`);
  if (s.logins.length) {
    console.log('Sign-ins for showing it around (one per desk, and a driver):');
    for (const l of s.logins) console.log(`  ${l.role.padEnd(28)} ${l.login.padEnd(36)} ${l.password}`);
  } else if (s.note) console.log(s.note);
}

async function upCommand(args: Args) {
  const copy = copyOf(args);
  const { engine, why } = await chooseEngine(flag(args, 'engine'));
  if (!engine) fail(why);
  console.log(`Starting ${copy.profile.company.key} (${copy.environment.name}) with ${engine}: ${why}.`);
  const result = await up(copy, engine!, (line) => console.log(line));
  printSignIns(result.signIns);
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.command || args.flags.has('help') || args.command === 'help') { console.log(USAGE); return args.command ? 0 : 1; }
  if (!args.path) { console.error(USAGE); return 1; }
  try {
    switch (args.command) {
      case 'check': await check(args); break;
      case 'kit': await kit(args); break;
      case 'migrate': await migrate(args); break;
      case 'up': await upCommand(args); break;
      case 'down': { const copy = copyOf(args); await down(copy, { remove: args.flags.has('remove') }, (l) => console.log(l)); console.log(`${copy.profile.company.key} (${copy.environment.name}) is stopped${args.flags.has('remove') ? ' and removed' : ''}.`); break; }
      case 'status': { const s = await status(copyOf(args)); console.log(`${s.state}${s.url ? ` at ${s.url}` : ''}${s.engine ? ` (${s.engine})` : ''}${s.detail ? `: ${s.detail}` : ''}`); break; }
      case 'logs': { for (const line of await logs(copyOf(args), Number(flag(args, 'lines') ?? 100))) console.log(line); break; }
      default: console.error(`No command "${args.command}".\n\n${USAGE}`); return 1;
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Stop ? err.message : (err as Error).message);
    return 1;
  }
}

// Run as a command, not when imported (Studio and the tests import it).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
