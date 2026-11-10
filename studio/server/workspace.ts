import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { companyKey, environmentName } from '../../src/profile/index.js';
import { run } from '../../src/cli/proc.js';

/**
 * Studio's workspace (platform design §5.1, decision 4): one folder holding one folder per company, kept under
 * git so every save is a commit and the history is the git log. Meant to be the team's private
 * fleet-companies repository; it holds company names, e-mails and logos, never a secret.
 *
 *   <workspace>/<key>/profile.json, environments/*.json, files/, data/
 *   <workspace>/<key>/.build/          what a run on this computer keeps (never committed)
 *   <workspace>/<key>/.studio-draft.json  unsaved changes, so a reload loses nothing (never committed)
 */
export const DRAFT_FILE = '.studio-draft.json';
const IGNORE = ['.build/', DRAFT_FILE, '.env', '*.env', '.DS_Store', ''].join('\n');

export const defaultWorkspace = () => resolve(process.env.FLEET_WORKSPACE ?? join(homedir(), 'fleet-companies'));

export class WorkspaceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface Commit { hash: string; short: string; at: string; author: string; message: string; files: string[] }

export class Workspace {
  /** Git runs one command at a time here: two companies saved at once must not race for the index. */
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}

  private git(args: string[], input?: string) {
    const next = this.queue.then(() => run('git', args, { cwd: this.root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, input, timeoutMs: 60_000 }));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Makes the folder and its git repository when they aren't there yet. */
  async ensure() {
    mkdirSync(this.root, { recursive: true });
    if (!existsSync(join(this.root, '.git'))) {
      const init = await this.git(['init', '-q']);
      if (init.code !== 0) throw new WorkspaceError(init.code === 127 ? "git isn't installed: Studio keeps every company in a git folder." : `git init failed: ${init.stderr}`, 500);
    }
    const ignore = join(this.root, '.gitignore');
    if (!existsSync(ignore)) {
      writeFileSync(ignore, `# Written by Fleet Studio: what a run on this computer keeps, and unsaved changes, stay out of the history.\n${IGNORE}`);
      await this.commit(['.gitignore'], 'Fleet Studio workspace');
    }
  }

  /** The folder of one company, by its short name. Nothing outside the workspace can be named. */
  dir(key: string) {
    if (!companyKey.safeParse(key).success) throw new WorkspaceError(`"${key}" isn't a company's short name`, 404);
    return join(this.root, key);
  }
  has(key: string) { return existsSync(join(this.dir(key), 'profile.json')); }
  keys() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory() && companyKey.safeParse(e.name).success && existsSync(join(this.root, e.name, 'profile.json'))).map((e) => e.name).sort();
  }
  environmentPath(key: string, name: string) {
    if (!environmentName.safeParse(name).success) throw new WorkspaceError(`"${name}" isn't an environment's name`, 404);
    return join(this.dir(key), 'environments', `${name}.json`);
  }
  /** A file the profile names (files/logo.png, data/vehicles.csv), inside the company's folder. */
  attachmentPath(key: string, path: string) {
    if (!/^(files|data)\/[A-Za-z0-9._-]{1,80}$/.test(path) || path.includes('..')) throw new WorkspaceError(`"${path}" isn't a file in files/ or data/`);
    return join(this.dir(key), path);
  }

  readJson(path: string): unknown {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
  }

  /** Commits what changed under the paths given, with one message. Nothing changed: no commit. */
  async commit(paths: string[], message: string): Promise<string | null> {
    // A path just removed with git rm is already staged, and there's nothing left of it to add.
    const present = paths.filter((p) => existsSync(join(this.root, p)));
    if (present.length) {
      const add = await this.git(['add', '-A', '--', ...present]);
      if (add.code !== 0) throw new WorkspaceError(`git add failed: ${add.stderr}`, 500);
    }
    const staged = await this.git(['diff', '--cached', '--quiet', '--', ...paths]);
    if (staged.code === 0) return null;
    // The person's own git name when they have one; otherwise the commit says it came from Studio.
    const named = (await this.git(['config', 'user.email'])).stdout.trim();
    const who = named ? [] : ['-c', 'user.name=Fleet Studio', '-c', 'user.email=studio@localhost'];
    const done = await this.git([...who, 'commit', '-q', '-F', '-', '--', ...paths], message);
    if (done.code !== 0) throw new WorkspaceError(`git commit failed: ${done.stderr || done.stdout}`, 500);
    return (await this.git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
  }

  /** The company's history, newest first: each save and what it touched. */
  async history(key: string, limit = 100): Promise<Commit[]> {
    this.dir(key);
    const out = await this.git(['log', `-n${limit}`, '--format=%x1e%H%x1f%h%x1f%aI%x1f%an%x1f%s', '--name-only', '--', key]);
    if (out.code !== 0) return [];
    return out.stdout.split('\x1e').filter((b) => b.trim()).map((block) => {
      const [head, ...files] = block.split('\n');
      const [hash, short, at, author, message] = head!.split('\x1f');
      return { hash: hash!, short: short!, at: at!, author: author!, message: message!, files: files.filter(Boolean).map((f) => f.slice(key.length + 1)) };
    });
  }

  async lastChanged(key: string): Promise<string | null> {
    return (await this.git(['log', '-1', '--format=%aI', '--', key])).stdout.trim() || null;
  }

  /** The profile as last committed, for saying which sections a save changed. */
  async committed(key: string, path: string): Promise<unknown> {
    const out = await this.git(['show', `HEAD:${key}/${path}`]);
    if (out.code !== 0) return undefined;
    try { return JSON.parse(out.stdout); } catch { return undefined; }
  }

  /** Puts the company's folder back as it was last saved: files added since are removed. What a run keeps stays. */
  async restore(key: string) {
    this.dir(key);
    await this.git(['checkout', 'HEAD', '--', key]);
    await this.git(['clean', '-fdq', '--', key]);
  }

  /** Removes a company. Its history stays in git, so it can be brought back. */
  async remove(key: string, message: string) {
    const dir = this.dir(key);
    // What a run keeps (.build) and unsaved changes aren't in git: they go too.
    await this.git(['rm', '-rq', '--ignore-unmatch', '--', key]);
    rmSync(dir, { recursive: true, force: true });
    const hash = await this.commit([key], message);
    return hash;
  }

  async remote(): Promise<string | null> {
    const out = await this.git(['remote', 'get-url', 'origin']);
    return out.code === 0 ? out.stdout.trim() : null;
  }

  /** Every file in the company's files/ and data/ folders, with its size. */
  files(key: string): { path: string; size: number }[] {
    const out: { path: string; size: number }[] = [];
    for (const sub of ['files', 'data']) {
      const dir = join(this.dir(key), sub);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const s = statSync(join(dir, name));
        if (s.isFile() && !name.startsWith('.')) out.push({ path: `${sub}/${name}`, size: s.size });
      }
    }
    return out;
  }
}
