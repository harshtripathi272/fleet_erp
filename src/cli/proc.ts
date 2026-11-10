import { execFile, spawn } from 'node:child_process';

/**
 * Running the tools the CLI and Studio drive (docker, git, gcloud) with execFile and spawn: never through a
 * shell, so nothing a person types is ever read as a command.
 */

export interface Ran { code: number; stdout: string; stderr: string }

/** Runs a command to the end and gives back what it printed. A missing command is code 127, not an exception. */
export function run(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 60_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : (err as { code?: string }).code === 'ENOENT' ? 127 : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (code === 127 ? `${cmd} is not installed` : '') });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Runs a long command, telling `onLine` each line it prints as it prints it (a build, a compose up). */
export function stream(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, windowsHide: true });
    let rest = '';
    const take = (chunk: Buffer) => {
      const text = rest + chunk.toString('utf8');
      const lines = text.split(/\r?\n|\r/);
      rest = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => { onLine((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} is not installed` : err.message); resolve(127); });
    child.on('close', (code) => { if (rest.trim()) onLine(rest); resolve(code ?? 1); });
  });
}

/** The first line a command prints, or undefined when it is missing or fails: for "is it installed, which version". */
export async function firstLine(cmd: string, args: string[], timeoutMs = 8000): Promise<string | undefined> {
  const r = await run(cmd, args, { timeoutMs });
  return r.code === 0 ? (r.stdout || r.stderr).trim().split('\n')[0]?.trim() || undefined : undefined;
}
