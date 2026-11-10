import { type Engine, type LocalCopy, type RunState, type SignIns, down, logs, readSignIns, reset, status, up } from '../../src/cli/local.js';
import { chooseEngine } from '../../src/cli/tools.js';
import type { Profiles } from './profiles.js';

/**
 * Running a company's copy on this computer from Studio (platform design §5.5): the same runner as `fleet up`,
 * started in the background so the screen can follow it. What a run is doing (starting, stopping, resetting)
 * and what it printed is kept here while Studio runs; the copy itself keeps running when Studio stops.
 */
type Job = 'starting' | 'stopping' | 'removing' | 'resetting';
interface Run { job?: Job; lines: string[]; error?: string; signIns?: SignIns; engine?: Engine }

export class LocalRuns {
  private runs = new Map<string, Run>();
  constructor(private profiles: Profiles) {}

  private run(key: string, env: string): Run {
    const id = `${key}/${env}`;
    let r = this.runs.get(id);
    if (!r) { r = { lines: [] }; this.runs.set(id, r); }
    return r;
  }
  private copy(key: string, env: string): LocalCopy {
    const saved = this.profiles.saved(key, env);
    if (saved.environment.target !== 'local') throw new Error(`${env} runs on ${saved.environment.target}; only a copy on this computer is run from here.`);
    return saved;
  }
  private log(r: Run, line: string) { r.lines.push(line); if (r.lines.length > 400) r.lines.splice(0, r.lines.length - 400); }

  /** In a word, for the Companies table. */
  async state(key: string, env: string): Promise<string> {
    const r = this.runs.get(`${key}/${env}`);
    if (r?.job) return r.job;
    try {
      const e = this.profiles.environments(key).find((x) => x.name === env);
      if (e?.target !== 'local') return '';
      return (await status(this.copy(key, env))).state;
    } catch { return ''; }
  }

  /** Everything the environment's card shows: what it's doing, what it printed, its address and sign-ins. */
  async describe(key: string, env: string): Promise<{ job?: Job; lines: string[]; error?: string; status: RunState; signIns?: SignIns; engine?: Engine }> {
    const r = this.run(key, env);
    const copy = this.copy(key, env);
    return { job: r.job, lines: r.lines.slice(-120), error: r.error, status: await status(copy), signIns: r.signIns ?? readSignIns(copy), engine: r.engine };
  }

  private start(key: string, env: string, job: Job, work: (copy: LocalCopy, r: Run) => Promise<void>) {
    const r = this.run(key, env);
    if (r.job) throw new Error(`It is ${r.job} already.`);
    const copy = this.copy(key, env);
    r.job = job; r.error = undefined; r.lines = [];
    void work(copy, r).catch((err) => { r.error = (err as Error).message; this.log(r, (err as Error).message); }).finally(() => { r.job = undefined; });
  }

  async up(key: string, env: string, asked?: Engine) {
    const { engine, why } = await chooseEngine(asked);
    if (!engine) throw new Error(why);
    this.start(key, env, 'starting', async (copy, r) => {
      r.engine = engine;
      this.log(r, `Starting with ${engine === 'docker' ? 'Docker' : 'Node, from this checkout'}: ${why}.`);
      const out = await up(copy, engine, (line) => this.log(r, line));
      r.signIns = out.signIns;
    });
    return { engine };
  }

  down(key: string, env: string, remove = false) {
    this.start(key, env, remove ? 'removing' : 'stopping', async (copy, r) => {
      await down(copy, { remove }, (line) => this.log(r, line));
      if (remove) r.signIns = undefined;
      this.log(r, remove ? 'Stopped and removed.' : 'Stopped. Its data stays for next time.');
    });
  }

  reset(key: string, env: string) {
    this.start(key, env, 'resetting', async (copy, r) => {
      this.log(r, 'Resetting: everything is removed and the profile applied again, with the sample.');
      r.signIns = await reset(copy);
      this.log(r, 'Reset. New sign-ins below.');
    });
  }

  logs(key: string, env: string, lines = 200) { return logs(this.copy(key, env), lines); }

  /** Waits for whatever the run is doing to finish: for the tests, and for a clean stop. */
  async settle(key: string, env: string, timeoutMs = 10 * 60_000) {
    const until = Date.now() + timeoutMs;
    while (this.runs.get(`${key}/${env}`)?.job && Date.now() < until) await new Promise((res) => setTimeout(res, 250));
    return this.runs.get(`${key}/${env}`);
  }
}
