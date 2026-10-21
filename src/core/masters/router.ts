import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { createMasterController } from './controller.js';
import { listQuerySchema, pageQuery } from './query.js';
import { registerMaster } from './registry.js';
import type { MasterDefinition } from './types.js';
import { archiveBody, idParams } from './zod.js';

/**
 * Registers a master and builds its router. `extend` adds custom endpoints
 * before the generic `/:id` routes so paths such as `/convert` are not taken as ids.
 */
export function createMasterRouter(def: MasterDefinition, extend?: (router: Router) => void): Router {
  registerMaster(def);
  const router = Router();
  const c = createMasterController(def);
  extend?.(router);
  router.get('/', authorize(def.key, 'read'), validate({ query: listQuerySchema(def) }), c.list);
  if (!def.managed?.create) router.post('/', authorize(def.key, 'create'), validate({ body: def.createSchema }), c.create);
  router.get('/:id', authorize(def.key, 'read'), validate({ params: idParams }), c.get);
  if (!def.managed?.update) router.patch('/:id', authorize(def.key, 'update'), validate({ params: idParams, body: def.updateSchema }), c.update);
  if (!def.managed?.archive) {
    router.post('/:id/archive', authorize(def.key, 'archive'), validate({ params: idParams, body: archiveBody }), c.archive);
    router.post('/:id/restore', authorize(def.key, 'archive'), validate({ params: idParams }), c.restore);
  }
  if (!def.managed?.delete) router.delete('/:id', authorize(def.key, 'delete'), validate({ params: idParams }), c.remove);
  router.get('/:id/usage', authorize(def.key, 'read'), validate({ params: idParams }), c.usage);
  router.get('/:id/history', authorize(def.key, 'read'), validate({ params: idParams, query: pageQuery }), c.history);
  def.router = router;
  return router;
}
