import { env } from '../../config/env.js';
import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import { contextOf } from '../../core/masters/controller.js';
import { companyColumns, importableMaster, importRows, leftOutOfImport, templateCsv } from '../../core/masters/import.js';
import { getLayout as readLayout, saveLayout as writeLayout, type LayoutInput } from '../../core/masters/layout.js';
import { getMaster } from '../../core/masters/registry.js';
import { Company } from '../company/company.model.js';
import { FieldDefinition } from '../configuration/models/configuration.model.js';
import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import auditRouter from '../audit/audit.router.js';
import authRouter from '../auth/auth.router.js';
import companyRouter from '../company/company.router.js';
import healthRouter from '../health/health.router.js';
import operationsRouter, { webhookRouter } from '../operations/operations.router.js';
import * as MetaService from './meta.service.js';
import * as Workspace from '../company/workspace.js';
import * as Readiness from './readiness.service.js';
import { loadSampleData, type SampleSize } from './sampleData.js';
import { loadStarterLists } from './starterLists.js';

export const masters = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await MetaService.describeMasters(req.auth));
});

/** The same descriptions without the caller's permissions, for the public models reference. */
export const models = asyncHandler(async (_req, res) => {
  const list = await MetaService.describeMasters();
  ApiResponse.success(res, list.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'permissions'))));
});

export const overview = asyncHandler(async (req, res) => {
  ApiResponse.success(res, {
    system: MetaService.system(),
    limits: MetaService.limits(),
    you: { userId: req.auth!.userId, name: req.auth!.name, email: req.auth!.email, roles: req.auth!.roles, permissions: req.auth!.permissions },
    endpoints: [
      ...MetaService.endpointsOf(healthRouter, '/api/v1/health', false),
      ...MetaService.endpointsOf(authRouter, '/api/v1/auth', false),
      ...MetaService.endpointsOf(companyRouter, '/api/v1/company', true),
      ...MetaService.endpointsOf(auditRouter, '/api/v1/audit-logs', true),
      ...MetaService.endpointsOf(operationsRouter, '/api/v1', true),
      ...MetaService.endpointsOf(webhookRouter, '/api/v1/whatsapp', false),
    ],
  });
});

export const stats = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, await MetaService.stats());
});

/** Development aid: e-mails the API would have sent (only when EXPOSE_RESET_TOKEN=true). */
export const outbox = asyncHandler(async (_req, res) => {
  if (!env.EXPOSE_RESET_TOKEN || env.NODE_ENV === 'production') throw new NotFoundError('Route not found');
  ApiResponse.success(res, MetaService.outbox());
});

/** Loads the sample operation once (outside production). */
export const sampleData = asyncHandler(async (req, res) => {
  if (env.NODE_ENV === 'production') throw new NotFoundError('Route not found');
  ApiResponse.created(res, await loadSampleData(req.auth?.userId, (req.body as { size: SampleSize }).size), 'Sample data loaded');
});

/** The usual lists (#116); a list already there is left as it is. */
export const starterLists = asyncHandler(async (req, res) => {
  const result = await loadStarterLists(req.auth?.userId);
  ApiResponse.created(res, result, result.created ? `Added ${result.created} records` : 'The usual lists were already there');
});

/** What a new company still needs before its first trip (#45). */
export const readiness = asyncHandler(async (_req, res) => ApiResponse.success(res, await Readiness.readiness()));
/** Loading a master from a spreadsheet (#41): it needs the right to create records of that master. */
const importable = (req: Parameters<Parameters<typeof asyncHandler>[0]>[0]) => {
  const key = (req.params as { master: string }).master;
  const def = importableMaster(key);
  if (!req.auth?.can(key, 'create')) throw new ForbiddenError(`You may not add ${def.label.toLowerCase()}`);
  return def;
};
export const importInfo = asyncHandler(async (req, res) => {
  const def = importable(req);
  ApiResponse.success(res, { master: def.key, label: def.label, columns: await companyColumns(def), leftOut: await leftOutOfImport(def) });
});
export const importTemplate = asyncHandler(async (req, res) => {
  const def = importable(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${def.key}-template.csv"`);
  res.send(`\uFEFF${await templateCsv(def)}`);
});
export const importRun = asyncHandler(async (req, res) => {
  const def = importable(req);
  const { rows, dryRun, firstRow } = req.body as { rows: Record<string, string>[]; dryRun: boolean; firstRow?: number };
  const company = await Company.findOne().select('baseCurrencyId').lean<{ baseCurrencyId?: unknown }>();
  const results = await importRows(def, rows, { dryRun, firstRow, baseCurrencyId: company?.baseCurrencyId ? String(company.baseCurrencyId) : undefined }, contextOf(req, def.key));
  const count = (s: string) => results.filter((r) => r.status === s).length;
  ApiResponse.success(res, { results, summary: { ready: count('ready'), exists: count('exists'), invalid: count('invalid'), created: count('created'), failed: count('failed') } });
});
export const areas = asyncHandler(async (_req, res) => ApiResponse.success(res, await MetaService.areas()));

/** The master of masters (#65): this company's changes to one master's definition, for the Customise screen. */
const masterOr404 = (key: string) => {
  const def = getMaster(key);
  if (!def) throw new NotFoundError(`No master "${key}"`);
  return def;
};
export const getLayout = asyncHandler(async (req, res) => ApiResponse.success(res, await readLayout(masterOr404(String(req.params.master)).key)));
export const saveLayout = asyncHandler(async (req, res) => {
  const def = masterOr404(String(req.params.master));
  const ctx = contextOf(req);
  // The company's own fields on this master can be placed among the built-in ones and be list columns (#97).
  const customKeys = (await FieldDefinition.find({ entity: def.key, status: 'active' }).select('key').lean()).map((f) => String(f.key));
  ApiResponse.success(res, await writeLayout(def, req.body as LayoutInput, { actorId: ctx.actorId, requestId: ctx.requestId, customKeys }));
});

/** The company's words, stages and desks (#73), for every signed-in person. */
export const workspace = asyncHandler(async (_req, res) => ApiResponse.success(res, await Workspace.workspace()));
