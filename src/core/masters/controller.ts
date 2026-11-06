import type { Request } from 'express';
import { ApiResponse, buildPaginationMeta } from '../response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as MasterService from './service.js';
import type { ListQuery, ServiceContext } from './service.js';
import type { MasterDefinition, Plain } from './types.js';

/** Request facts the services need, without passing `req` into them. */
export function contextOf(req: Request, resource?: string): ServiceContext {
  return {
    actorId: req.auth?.userId,
    requestId: req.requestId,
    canSeeSensitive: resource ? req.auth?.can(resource, 'sensitive') ?? false : false,
    roles: req.auth ? req.auth.roles : undefined,
  };
}

const idOf = (req: Request) => (req.params as { id: string }).id;

/** Standard handlers for one master: list, get, create, update, archive, restore, delete, usage, history. */
export function createMasterController(def: MasterDefinition) {
  return {
    list: asyncHandler(async (req, res) => {
      const result = await MasterService.list(def, req.query as unknown as ListQuery, contextOf(req, def.key));
      ApiResponse.paginated(res, result.data, buildPaginationMeta(result.total, result.page, result.limit));
    }),
    get: asyncHandler(async (req, res) => {
      ApiResponse.success(res, await MasterService.getById(def, idOf(req), contextOf(req, def.key)));
    }),
    create: asyncHandler(async (req, res) => {
      ApiResponse.created(res, await MasterService.create(def, req.body as Plain, contextOf(req, def.key)), `${def.singular} created`);
    }),
    update: asyncHandler(async (req, res) => {
      ApiResponse.success(res, await MasterService.update(def, idOf(req), req.body as Plain, contextOf(req, def.key)), `${def.singular} updated`);
    }),
    archive: asyncHandler(async (req, res) => {
      const { reason } = req.body as { reason?: string };
      ApiResponse.success(res, await MasterService.archive(def, idOf(req), reason, contextOf(req, def.key)), `${def.singular} archived`);
    }),
    restore: asyncHandler(async (req, res) => {
      ApiResponse.success(res, await MasterService.restore(def, idOf(req), contextOf(req, def.key)), `${def.singular} restored`);
    }),
    remove: asyncHandler(async (req, res) => {
      await MasterService.remove(def, idOf(req), contextOf(req, def.key));
      ApiResponse.noContent(res);
    }),
    usage: asyncHandler(async (req, res) => {
      ApiResponse.success(res, await MasterService.usage(def, idOf(req)));
    }),
    history: asyncHandler(async (req, res) => {
      const { page, limit } = req.query as unknown as { page: number; limit: number };
      const result = await MasterService.history(def, idOf(req), page, limit);
      ApiResponse.paginated(res, result.data, buildPaginationMeta(result.total, result.page, result.limit));
    }),
  };
}
