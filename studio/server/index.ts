/**
 * Fleet Studio's server (#133, platform design §5.1 and §9 phase 4): the vendor's tool for many companies, on
 * the vendor's own computer. It listens on 127.0.0.1 only and has no database: each company is a folder of
 * files in the workspace (FLEET_WORKSPACE, default ~/fleet-companies), kept under git. It runs copies on this
 * computer with Docker (or this checkout's server), and holds no secret.
 *
 *   npm run studio            builds the screens and starts it at http://127.0.0.1:4000
 *   STUDIO_PORT=4100 npm run studio
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// The masters, areas, roles and connection providers: what a company is configured from.
import '../../src/app.js';
import { ROOT, type Engine } from '../../src/cli/local.js';
import { run } from '../../src/cli/proc.js';
import { chooseEngine, detectTools } from '../../src/cli/tools.js';
import { appSource } from '../../src/profile/index.js';
import { LocalRuns } from './local.js';
import { Profiles, templates } from './profiles.js';
import { registryRouter } from './registry.js';
import { Workspace, WorkspaceError, defaultWorkspace } from './workspace.js';

const WEB = join(ROOT, 'web', 'dist-studio');

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const handle = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).then((data) => { if (!res.headersSent) res.json({ success: true, data: data ?? null }); }).catch(next);
};
const param = (req: Request, name: string) => String(req.params[name]);

export function createStudio(options: { root?: string; port?: number } = {}) {
  const ws = new Workspace(options.root ?? defaultWorkspace());
  const profiles = new Profiles(ws);
  const runs = new LocalRuns(profiles);
  const app = express();
  app.disable('x-powered-by');

  // Only this computer, and only pages Studio served: another site open in the browser can't drive it.
  app.use((req, res, next) => {
    const host = (req.get('host') ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { res.status(403).json({ success: false, error: { message: 'Fleet Studio answers only on this computer.' } }); return; }
    const origin = req.get('origin');
    if (req.method !== 'GET' && origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) { res.status(403).json({ success: false, error: { message: 'Not from Fleet Studio.' } }); return; }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '40mb' }));

  // What the set-up's steps ask the company app for, answered from the code.
  app.use('/api/v1', registryRouter(profiles));

  const api = express.Router();
  api.get('/tools', handle(async () => {
    const [tools, engine] = await Promise.all([detectTools(), chooseEngine()]);
    return { tools, engine: engine.engine ?? null, engineWhy: engine.why, version: appSource()?.version ?? null };
  }));
  api.get('/workspace', handle(async () => {
    await ws.ensure();
    return { root: ws.root, remote: await ws.remote(), companies: await profiles.list((k, e) => runs.state(k, e)), templates: templates() };
  }));
  api.post('/workspace/open', handle(async () => {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    await run(opener, [ws.root], { timeoutMs: 10_000 });
    return { opened: ws.root };
  }));
  api.post('/companies', handle(async (req) => { await ws.ensure(); return profiles.create(req.body as { name: string; key?: string; template: string }); }));
  api.post('/companies/import', handle(async (req, res) => {
    await ws.ensure();
    const out = await profiles.importFile(req.body as { file: unknown; environment?: unknown });
    if (out.problems.length) res.status(422).json({ success: false, error: { message: 'The file has problems', details: { problems: out.problems.map((p) => `${p.path}: ${p.message}`) } } });
    return out;
  }));
  api.get('/companies/:key', handle((req) => profiles.read(param(req, 'key'))));
  api.put('/companies/:key/draft', handle((req) => { profiles.saveDraft(param(req, 'key'), req.body as { profile: unknown; environments: unknown[] }); return { saved: true }; }));
  api.post('/companies/:key/discard', handle(async (req) => { await profiles.discard(param(req, 'key')); return profiles.read(param(req, 'key')); }));
  api.post('/companies/:key/check', handle((req) => ({ problems: profiles.checkDraft(param(req, 'key'), req.body as { profile: unknown; environments: Record<string, unknown>[] }) })));
  api.post('/companies/:key/save', handle((req) => profiles.save(param(req, 'key'), req.body as { profile: Record<string, unknown>; environments: Record<string, unknown>[] })));
  api.put('/companies/:key/files', handle((req) => { profiles.putFile(param(req, 'key'), req.body as { path: string; data: string }); return { saved: true }; }));
  api.post('/companies/:key/files/remove', handle((req) => { profiles.removeFile(param(req, 'key'), String((req.body as { path: string }).path)); return { removed: true }; }));
  api.get('/companies/:key/history', handle((req) => ws.history(param(req, 'key'))));
  api.post('/companies/:key/remove', handle(async (req) => ({ commit: await profiles.remove(param(req, 'key'), String((req.body as { confirm?: string }).confirm ?? '')) })));

  api.get('/companies/:key/environments/:env/kit', handle((req, res) => {
    const made = profiles.kit(param(req, 'key'), param(req, 'env'));
    if (!made.zip) { res.status(422).json({ success: false, error: { message: 'The kit has problems', details: { problems: made.problems.map((p) => `${p.path}: ${p.message}`) } } }); return; }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${made.name}"`);
    res.send(made.zip);
  }));
  api.get('/companies/:key/environments/:env/run', handle((req) => runs.describe(param(req, 'key'), param(req, 'env'))));
  api.post('/companies/:key/environments/:env/up', handle((req) => runs.up(param(req, 'key'), param(req, 'env'), (req.body as { engine?: Engine })?.engine)));
  api.post('/companies/:key/environments/:env/down', handle((req) => { runs.down(param(req, 'key'), param(req, 'env'), Boolean((req.body as { remove?: boolean })?.remove)); return { started: true }; }));
  api.post('/companies/:key/environments/:env/reset', handle((req) => { runs.reset(param(req, 'key'), param(req, 'env')); return { started: true }; }));
  api.get('/companies/:key/environments/:env/logs', handle((req) => runs.logs(param(req, 'key'), param(req, 'env'), Number(req.query.lines ?? 200))));
  app.use('/api/v1/studio', api);

  app.use('/api', (_req, res) => { res.status(404).json({ success: false, error: { message: 'No such Studio call' } }); });

  // The screens, built by npm run build:studio.
  if (existsSync(WEB)) {
    app.use(express.static(WEB, { index: false }));
    app.get(/.*/, (_req, res) => res.sendFile(join(WEB, 'studio.html')));
  } else {
    app.get('/', (_req, res) => res.type('text').send("Fleet Studio's screens aren't built yet: run npm run studio, which builds them first."));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof WorkspaceError ? err.status : (err as { statusCode?: number }).statusCode ?? 400;
    res.status(status).json({ success: false, error: { message: err.message } });
  });

  return { app, ws, profiles, runs };
}

/** Run as a program: the workspace made if missing, then listening on this computer only. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.STUDIO_PORT ?? 4000);
  const studio = createStudio();
  await studio.ws.ensure();
  studio.app.listen(port, '127.0.0.1', () => {
    console.log(`Fleet Studio: http://127.0.0.1:${port}\nWorkspace: ${studio.ws.root}`);
    if (process.env.STUDIO_OPEN === '1') void run(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [`http://127.0.0.1:${port}`]);
  });
}
