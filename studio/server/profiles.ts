import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  type Environment, PROFILE_FORMAT, type Problem, type Profile, appSource, checkProfile, companyKey, demoLocal, environmentSchema, json,
  namedFiles, problemsOf, profileKit, profileSchema, readAny,
} from '../../src/profile/index.js';
import { DRAFT_FILE, type Workspace, WorkspaceError } from './workspace.js';

/**
 * Companies as files (platform design §5.1, §6.1): made from a template, imported from a file of either format,
 * edited, checked and saved, one git commit per save. A profile may be saved while it still has problems, as a
 * draft is: what can't be made yet (a kit, a run) says what to fix first.
 */
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
type Raw = Record<string, any>;
export interface Attachment { path: string; data: string }

/** The sections of a profile, in words, for commit messages and the history. */
const SECTION_WORDS: Record<string, string> = {
  company: 'details', regional: 'region', brand: 'brand', watermark: 'watermark', areas: 'areas', operations: 'trip settings', maintenance: 'maintenance',
  workspace: 'words, stages and desks', masters: 'masters', selfSignUp: 'self sign-up', connections: 'connections', connectionRules: 'locked services',
  roles: 'roles', owner: 'owner', staff: 'staff', data: 'data', vendor: 'notes',
};

/** A short name from a company's name: "Acme Haulage Ltd" → acme-haulage-ltd, as the set-up made it. */
export const keyOf = (name: string) => {
  const key = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  return /^[a-z]/.test(key) && key.length >= 3 ? key : `co-${key}`.slice(0, 24).replace(/-+$/, '');
};

export interface Template { key: string; title: string; description: string }
export function templates(): Template[] {
  return readdirSync(TEMPLATES).filter((n) => existsSync(join(TEMPLATES, n, 'profile.json'))).map((key) => {
    const meta = JSON.parse(readFileSync(join(TEMPLATES, key, 'template.json'), 'utf8')) as { title: string; description: string; order?: number };
    return { key, title: meta.title, description: meta.description, order: meta.order ?? 99 };
  }).sort((a, b) => a.order - b.order).map(({ order: _o, ...t }) => t);
}

/** Every problem with a company as it stands: the profile's, each environment's, and what stops each kit. */
export function check(raw: unknown, environments: Raw[], attachments: Map<string, Buffer>): Problem[] {
  const parsed = profileSchema.safeParse(raw);
  const problems: Problem[] = parsed.success ? [] : problemsOf(parsed.error);
  const p = parsed.success ? parsed.data : undefined;
  // What the money screens can't work without, as the set-up asked.
  const regional = (raw as Raw | undefined)?.regional ?? {};
  if (!regional.country) problems.push({ path: 'regional.country', message: 'Choose the country the company works in.' });
  if (!regional.baseCurrency) problems.push({ path: 'regional.baseCurrency', message: 'Choose the currency its books are kept in.' });
  const names = new Set<string>();
  for (const e of environments) {
    const name = String(e?.name ?? '');
    if (names.has(name)) problems.push({ path: `environments.${name}.name`, message: `Two environments are called ${name}` });
    names.add(name);
    const env = environmentSchema.safeParse(e);
    if (!env.success) { problems.push(...problemsOf(env.error, ['environments', name || '(unnamed)'])); continue; }
    // The same missing logo is found for every environment; it is listed once, below.
    if (p) problems.push(...checkProfile(p, env.data, attachments));
  }
  if (p && !environments.length) for (const n of namedFiles(p)) if (!attachments.has(n)) problems.push({ path: n.startsWith('files/') ? 'brand.files' : 'data.files', message: `${n} isn't in the company's folder` });
  return [...new Map(problems.map((x) => [`${x.path}|${x.message}`, x])).values()];
}

export class Profiles {
  constructor(readonly ws: Workspace) {}

  private profilePath(key: string) { return join(this.ws.dir(key), 'profile.json'); }
  rawProfile(key: string): Raw | undefined { return this.ws.readJson(this.profilePath(key)) as Raw | undefined; }
  environments(key: string): Raw[] {
    const dir = join(this.ws.dir(key), 'environments');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => (this.ws.readJson(join(dir, n)) as Raw | undefined) ?? { name: n.slice(0, -5), broken: true });
  }
  /** The files in the company's folder, by their path in the profile. */
  attachments(key: string): Map<string, Buffer> {
    return new Map(this.ws.files(key).map((f) => [f.path, readFileSync(join(this.ws.dir(key), f.path))]));
  }

  /** The Companies table: each company with its environments, what's wrong, and when it last changed. */
  async list(running: (key: string, env: string) => Promise<string>) {
    return Promise.all(this.ws.keys().map(async (key) => {
      const p = this.rawProfile(key) ?? {};
      const envs = this.environments(key);
      return {
        key, legalName: String(p.company?.legalName ?? key), tradingName: p.company?.tradingName ?? null, revision: Number(p.revision ?? 1), notes: p.vendor?.notes ?? null,
        problems: check(p, envs, this.attachments(key)).length,
        environments: await Promise.all(envs.map(async (e) => ({ name: String(e.name), purpose: e.purpose ?? null, target: e.target ?? null, trialEnds: e.trialEnds ?? null, state: await running(key, String(e.name)) }))),
        changedAt: await this.ws.lastChanged(key),
        draft: existsSync(join(this.ws.dir(key), DRAFT_FILE)),
      };
    }));
  }

  /** The ports every company's copies on this computer use, so a new one gets a free one. */
  private usedPorts(): Set<number> {
    return new Set(this.ws.keys().flatMap((k) => this.environments(k)).filter((e) => e.target === 'local').map((e) => Number(e.port ?? 8080)));
  }
  nextPort() { const used = this.usedPorts(); let port = 8080; while (used.has(port)) port += 1; return port; }

  /** A new company from a template: its name, its short name, a demonstration on this computer, one commit. */
  async create(input: { name: string; key?: string; template: string }) {
    const name = input.name.trim();
    if (!name) throw new WorkspaceError("The company's name is needed.");
    const key = input.key?.trim() || keyOf(name);
    if (!companyKey.safeParse(key).success) throw new WorkspaceError('The short name is 3–30 lowercase letters, digits or hyphens, starting with a letter.');
    if (this.ws.has(key)) throw new WorkspaceError(`There is already a company called ${key}. Choose another short name.`, 409);
    const template = templates().find((t) => t.key === input.template) ?? (() => { throw new WorkspaceError(`No template "${input.template}"`); })();
    const base = JSON.parse(readFileSync(join(TEMPLATES, template.key, 'profile.json'), 'utf8').replaceAll('template.test', `${key}.test`)) as Raw;
    const profile = { ...base, format: PROFILE_FORMAT, revision: 1, appVersion: appSource()?.version, company: { ...base.company, key, legalName: name } };
    const dir = this.ws.dir(key);
    mkdirSync(join(dir, 'environments'), { recursive: true });
    writeFileSync(join(dir, 'profile.json'), json(profile));
    const env = demoLocal(this.nextPort());
    writeFileSync(this.ws.environmentPath(key, env.name), json(env));
    // A template's own files (a logo) come with it.
    for (const sub of ['files', 'data']) {
      const from = join(TEMPLATES, template.key, sub);
      if (existsSync(from)) for (const n of readdirSync(from)) { mkdirSync(join(dir, sub), { recursive: true }); writeFileSync(join(dir, sub, n), readFileSync(join(from, n))); }
    }
    await this.ws.commit([key], `${key}: created from the template "${template.title}"`);
    return { key };
  }

  /** A company file of either format: format 1 becomes a profile and its environment, as `fleet migrate` does. */
  async importFile(input: { file: unknown; environment?: unknown; attachments?: Attachment[] }) {
    const read = readAny(input.file, input.environment);
    if (!read.ok) return { problems: read.problems };
    const key = read.profile.company.key;
    if (this.ws.has(key)) throw new WorkspaceError(`There is already a company called ${key}. Rename it in the file, or remove that one first.`, 409);
    const dir = this.ws.dir(key);
    mkdirSync(join(dir, 'environments'), { recursive: true });
    writeFileSync(join(dir, 'profile.json'), json({ ...read.profile, appVersion: read.profile.appVersion ?? appSource()?.version }));
    const env = read.environment ?? demoLocal(this.nextPort());
    writeFileSync(this.ws.environmentPath(key, env.name), json(env));
    for (const a of input.attachments ?? []) { const path = this.ws.attachmentPath(key, a.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(a.data, 'base64')); }
    await this.ws.commit([key], `${key}: imported from a format-${read.format} file`);
    return { key, problems: [], migrated: read.format === 1 };
  }

  /** One company as Studio edits it: the profile and environments as saved, its files, and any unsaved changes. */
  read(key: string) {
    if (!this.ws.has(key)) throw new WorkspaceError(`No company called ${key}`, 404);
    const draft = this.ws.readJson(join(this.ws.dir(key), DRAFT_FILE)) as { profile: Raw; environments: Raw[]; at: string } | undefined;
    const attachments: Attachment[] = [];
    const skipped: string[] = [];
    for (const f of this.ws.files(key)) {
      // A snapshot of records can be large; the screens don't show it, so it isn't sent.
      if (f.size > 5 * 1024 * 1024) { skipped.push(f.path); continue; }
      attachments.push({ path: f.path, data: readFileSync(join(this.ws.dir(key), f.path)).toString('base64') });
    }
    return { key, profile: this.rawProfile(key), environments: this.environments(key), attachments, skipped, draft: draft ?? null, folder: this.ws.dir(key) };
  }

  saveDraft(key: string, body: { profile: unknown; environments: unknown[] }) {
    if (!this.ws.has(key)) throw new WorkspaceError(`No company called ${key}`, 404);
    writeFileSync(join(this.ws.dir(key), DRAFT_FILE), json({ ...body, at: new Date().toISOString() }));
  }

  /** Throws the unsaved changes away, files included: the folder is as it was last saved. */
  async discard(key: string) {
    rmSync(join(this.ws.dir(key), DRAFT_FILE), { force: true });
    await this.ws.restore(key);
  }

  putFile(key: string, a: Attachment) {
    const path = this.ws.attachmentPath(key, a.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(a.data, 'base64'));
  }
  removeFile(key: string, path: string) { rmSync(this.ws.attachmentPath(key, path), { force: true }); }

  /**
   * Saves the company: the profile as the next revision, its environments, and the files in its folder, in one
   * commit that says which sections changed. Returns what is still wrong, if anything.
   */
  async save(key: string, body: { profile: Raw; environments: Raw[] }) {
    if (!this.ws.has(key)) throw new WorkspaceError(`No company called ${key}`, 404);
    const before = (await this.ws.committed(key, 'profile.json')) as Raw | undefined;
    if (!body.profile || typeof body.profile !== 'object') throw new WorkspaceError('No profile to save.');
    if (body.profile.company?.key !== key) throw new WorkspaceError(`The short name stays ${key}: a company with another short name is a new company.`);
    for (const e of body.environments) if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(e?.name ?? ''))) throw new WorkspaceError(`"${String(e?.name ?? '')}" can't be an environment's name: 2–31 lowercase letters, digits or hyphens, starting with a letter.`);
    const names = body.environments.map((e) => String(e.name));
    if (new Set(names).size !== names.length) throw new WorkspaceError('Two environments have the same name.');
    const revision = Math.max(Number(before?.revision ?? 0), Number(this.rawProfile(key)?.revision ?? 0)) + 1;
    const { revision: _r, format: _f, ...rest } = body.profile;
    const profile = { format: PROFILE_FORMAT, revision, ...rest, appVersion: appSource()?.version ?? rest.appVersion };
    writeFileSync(this.profilePath(key), json(profile));
    const envDir = join(this.ws.dir(key), 'environments');
    mkdirSync(envDir, { recursive: true });
    for (const n of readdirSync(envDir)) if (n.endsWith('.json') && !names.includes(n.slice(0, -5))) rmSync(join(envDir, n));
    for (const e of body.environments) writeFileSync(this.ws.environmentPath(key, String(e.name)), json({ format: 2, ...e }));
    rmSync(join(this.ws.dir(key), DRAFT_FILE), { force: true });
    const changed = Object.keys(SECTION_WORDS).filter((s) => !isDeepStrictEqual(before?.[s], profile[s as keyof typeof profile]));
    const message = `${key}: revision ${revision}${changed.length ? ` — ${changed.map((s) => SECTION_WORDS[s]).join(', ')}` : ''}`;
    const commit = await this.ws.commit([key], message);
    return { revision, commit, message, problems: check(profile, body.environments, this.attachments(key)) };
  }

  /** What is wrong with a company as it stands on screen, unsaved changes included. */
  checkDraft(key: string, body: { profile: unknown; environments: Raw[] }) {
    return check(body.profile, body.environments, this.attachments(key));
  }

  /** The profile and one environment as saved, checked: what a kit or a run is made from. */
  saved(key: string, envName: string): { profile: Profile; environment: Environment; dir: string } {
    const parsed = profileSchema.safeParse(this.rawProfile(key));
    if (!parsed.success) throw new WorkspaceError(`Fix the company first:\n${problemsOf(parsed.error).map((p) => `${p.path}: ${p.message}`).join('\n')}`, 422);
    const env = environmentSchema.safeParse(this.ws.readJson(this.ws.environmentPath(key, envName)));
    if (!env.success) throw new WorkspaceError(`Fix the ${envName} environment first:\n${problemsOf(env.error).map((p) => `${p.path}: ${p.message}`).join('\n')}`, 422);
    return { profile: parsed.data, environment: env.data, dir: this.ws.dir(key) };
  }

  kit(key: string, envName: string) {
    const { profile, environment } = this.saved(key, envName);
    return profileKit(profile, environment, this.attachments(key));
  }

  async remove(key: string, confirm: string) {
    if (!this.ws.has(key)) throw new WorkspaceError(`No company called ${key}`, 404);
    if (confirm !== key) throw new WorkspaceError(`Type ${key} to remove it.`);
    return this.ws.remove(key, `${key}: removed`);
  }

}
