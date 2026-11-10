import { Socket } from 'node:net';
import { type Engine, localMongo } from './local.js';
import { firstLine, run } from './proc.js';

/**
 * What is installed on this computer, and signed in where it matters (platform design §6.1, the Tools line):
 * Node, Docker (installed, and running), git, the Google Cloud CLI and who it's signed in as, and the MongoDB a
 * copy can run against without Docker. Each is a word and a state, with what to do when it's missing.
 */

export interface Tool { key: string; label: string; state: 'ok' | 'missing' | 'stopped' | 'optional'; detail: string; fix?: string; link?: string }

/** Whether something answers on host:port within a second. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Where the node engine's MongoDB is, as host and port. */
export function mongoAddress(): { host: string; port: number } {
  const m = /^mongodb:\/\/(?:[^@/]+@)?([^:/,]+)(?::(\d+))?/.exec(localMongo());
  return { host: m?.[1] ?? '127.0.0.1', port: Number(m?.[2] ?? 27017) };
}

export async function dockerState(): Promise<'running' | 'stopped' | 'missing'> {
  if (!(await firstLine('docker', ['--version']))) return 'missing';
  return (await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 })).code === 0 ? 'running' : 'stopped';
}

export async function mongoAnswers(): Promise<boolean> {
  const { host, port } = mongoAddress();
  return answers(host, port);
}

/**
 * How a copy on this computer is started: what FLEET_ENGINE says, else Docker when it runs, else this checkout's
 * server when a MongoDB answers. Undefined, with the reason, when neither can.
 */
export async function chooseEngine(asked?: string): Promise<{ engine?: Engine; why: string }> {
  const wanted = asked ?? process.env.FLEET_ENGINE;
  if (wanted === 'docker' || wanted === 'node') return { engine: wanted, why: `asked for ${wanted}` };
  const docker = await dockerState();
  if (docker === 'running') return { engine: 'docker', why: 'Docker is running' };
  if (await mongoAnswers()) return { engine: 'node', why: `Docker ${docker === 'missing' ? "isn't installed" : "isn't running"}, so it runs from this checkout against the MongoDB at ${localMongo()}` };
  return { why: docker === 'missing' ? `Docker isn't installed, and no MongoDB answers at ${localMongo()}. Install Docker Desktop and start it.` : `Docker is installed but not running, and no MongoDB answers at ${localMongo()}. Start Docker Desktop.` };
}

export async function detectTools(): Promise<Tool[]> {
  const [docker, dockerVersion, compose, git, gcloud, mongo] = await Promise.all([
    dockerState(), firstLine('docker', ['--version']), firstLine('docker', ['compose', 'version', '--short']),
    firstLine('git', ['--version']), firstLine('gcloud', ['--version']), mongoAnswers(),
  ]);
  const account = gcloud ? (await run('gcloud', ['config', 'get-value', 'account'], { timeoutMs: 10_000 })).stdout.trim() : '';
  return [
    { key: 'node', label: 'Node', state: 'ok', detail: process.version },
    docker === 'running'
      ? { key: 'docker', label: 'Docker', state: 'ok', detail: `running${compose ? `, Compose ${compose}` : ''}` }
      : docker === 'stopped'
        ? { key: 'docker', label: 'Docker', state: 'stopped', detail: `installed (${dockerVersion?.replace(/^Docker version /, '').split(',')[0] ?? ''}), not running`, fix: 'Start Docker Desktop, and wait until it says it is running.' }
        : { key: 'docker', label: 'Docker', state: 'missing', detail: 'not installed', fix: 'Needed to run a copy on this computer in its own container.', link: 'https://www.docker.com/products/docker-desktop/' },
    git ? { key: 'git', label: 'git', state: 'ok', detail: git.replace(/^git version /, '') } : { key: 'git', label: 'git', state: 'missing', detail: 'not installed', fix: 'Studio keeps every company in a git folder: each save is a commit.', link: 'https://git-scm.com/downloads' },
    gcloud
      ? { key: 'gcloud', label: 'gcloud', state: account ? 'ok' : 'stopped', detail: account ? `signed in as ${account}` : 'installed, not signed in', ...(account ? {} : { fix: 'Run gcloud auth login, once.' }) }
      : { key: 'gcloud', label: 'gcloud', state: 'optional', detail: 'not installed', fix: 'Only for deploying to Google Cloud, which Studio does not do yet.', link: 'https://cloud.google.com/sdk/docs/install' },
    { key: 'mongodb', label: 'MongoDB', state: mongo ? 'ok' : 'optional', detail: mongo ? `answering at ${localMongo()}` : `not answering at ${localMongo()}`, fix: mongo ? 'Used to run a copy without Docker.' : 'Only needed to run a copy without Docker.' },
  ];
}
