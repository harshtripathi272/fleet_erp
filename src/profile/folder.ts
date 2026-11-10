import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Environment, environmentSchema } from './environment.js';
import { namedFiles } from './check.js';
import { type Problem, type Read, problemsOf, readAny } from './migrate.js';
import { type Profile, profileSchema } from './schema.js';

/**
 * A company as a folder (platform design §5.1), the way Studio's workspace and the fleet CLI keep it:
 *
 *   <key>/profile.json             the company (format 2)
 *   <key>/environments/<name>.json one per copy: demo-local, trial, production…
 *   <key>/files/, <key>/data/      the logos and spreadsheets the profile names
 */
export const PROFILE_FILE = 'profile.json';
export const ENVIRONMENTS_DIR = 'environments';

/** Pretty JSON with a final newline, as every file Studio and the CLI write. */
export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const parse = (path: string): { value?: unknown; problem?: Problem } => {
  try { return { value: JSON.parse(readFileSync(path, 'utf8')) }; } catch (err) { return { problem: { path: basename(path), message: `Not valid JSON: ${(err as Error).message}` } }; }
};

export interface FolderEnvironment { name: string; raw: unknown; environment?: Environment; problems: Problem[] }
export interface Folder { dir: string; raw: unknown; profile?: Profile; problems: Problem[]; environments: FolderEnvironment[] }

/** Reads a company folder: its profile and every environment, each checked, with what is wrong where. */
export function readFolder(dir: string): Folder {
  const path = join(dir, PROFILE_FILE);
  if (!existsSync(path)) return { dir, raw: undefined, problems: [{ path: PROFILE_FILE, message: `No ${PROFILE_FILE} in ${dir}` }], environments: [] };
  const read = parse(path);
  const parsed = read.problem ? undefined : profileSchema.safeParse(read.value);
  const envDir = join(dir, ENVIRONMENTS_DIR);
  const environments = existsSync(envDir)
    ? readdirSync(envDir).filter((n) => n.endsWith('.json')).sort().map((n): FolderEnvironment => {
      const name = n.slice(0, -'.json'.length);
      const e = parse(join(envDir, n));
      if (e.problem) return { name, raw: undefined, problems: [{ ...e.problem, path: `environments.${name}` }] };
      const env = environmentSchema.safeParse(e.value);
      const problems = env.success ? [] : problemsOf(env.error, ['environments', name]);
      if (env.success && env.data.name !== name) problems.push({ path: `environments.${name}.name`, message: `The file is ${n} but names itself "${env.data.name}"` });
      return { name, raw: e.value, environment: env.success ? env.data : undefined, problems };
    })
    : [];
  return {
    dir, raw: read.value,
    profile: parsed?.success ? parsed.data : undefined,
    problems: read.problem ? [read.problem] : parsed && !parsed.success ? problemsOf(parsed.error) : [],
    environments,
  };
}

/** The files a profile names that are in its folder, by their path in the profile (files/logo.png). */
export function folderAttachments(dir: string, profile: Pick<Profile, 'brand' | 'data'>): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const name of namedFiles(profile)) if (existsSync(join(dir, name))) out.set(name, readFileSync(join(dir, name)));
  return out;
}

/** Writes a profile and its environments into a folder, with the files given. Returns the paths written. */
export function writeFolder(dir: string, profile: Profile, environments: Environment[], attachments: Map<string, Buffer> = new Map()): string[] {
  const written: string[] = [];
  const put = (path: string, data: string | Buffer) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), data); written.push(path); };
  put(PROFILE_FILE, json(profile));
  for (const e of environments) put(`${ENVIRONMENTS_DIR}/${e.name}.json`, json(e));
  for (const [path, body] of attachments) put(path, body);
  return written;
}

/**
 * Reads what a person points the CLI at: a format-1 company.json, a profile.json, or a company folder. A
 * profile.json is read as its folder. `environment` picks one of the folder's environments.
 */
export function readTarget(path: string): ({ kind: 'file'; dir: string; read: Read } | { kind: 'folder'; folder: Folder }) {
  const isDir = existsSync(path) && !path.endsWith('.json');
  if (isDir || basename(path) === PROFILE_FILE) return { kind: 'folder', folder: readFolder(isDir ? path : dirname(path)) };
  const read = parse(path);
  if (read.problem) return { kind: 'file', dir: dirname(path), read: { ok: false, problems: [read.problem] } };
  const value = read.value as { format?: unknown };
  // A profile under another name, with no folder of environments around it.
  return { kind: 'file', dir: dirname(path), read: readAny(value) };
}
