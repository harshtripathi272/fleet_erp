import { Router } from 'express';
import { listQuerySchema } from '../../core/masters/query.js';
import { createMasterRouter } from '../../core/masters/router.js';
import { archiveBody } from '../../core/masters/zod.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as ConfigurationController from './configuration.controller.js';
import { createCustomRecordSchema, listCodeParams, recordIdParams, recordParams, updateCustomRecordSchema } from './configuration.schema.js';
import * as C from './configuration.service.js';

const recordQuery = listQuerySchema({ ...C.customRecordDefinition, filters: {} });

const router = Router();
router.use('/lists', createMasterRouter(C.listDefinition, (r) => {
  r.get('/by-code/:code', authorize('lists', 'read'), validate({ params: listCodeParams }), ConfigurationController.listValues);
}));
router.use('/field-definitions', createMasterRouter(C.fieldDefinitionDefinition));
router.use('/custom-masters', createMasterRouter(C.customMasterDefinition, (r) => {
  r.get('/:masterId/records', authorize('custom-records', 'read'), validate({ params: recordParams, query: recordQuery }), ConfigurationController.listRecords);
  r.post('/:masterId/records', authorize('custom-records', 'create'), validate({ params: recordParams, body: createCustomRecordSchema }), ConfigurationController.createRecord);
  r.get('/:masterId/records/:id', authorize('custom-records', 'read'), validate({ params: recordIdParams }), ConfigurationController.getRecord);
  r.patch('/:masterId/records/:id', authorize('custom-records', 'update'), validate({ params: recordIdParams, body: updateCustomRecordSchema }), ConfigurationController.updateRecord);
  r.post('/:masterId/records/:id/archive', authorize('custom-records', 'archive'), validate({ params: recordIdParams, body: archiveBody }), ConfigurationController.archiveRecord);
  r.post('/:masterId/records/:id/restore', authorize('custom-records', 'archive'), validate({ params: recordIdParams }), ConfigurationController.restoreRecord);
  r.delete('/:masterId/records/:id', authorize('custom-records', 'delete'), validate({ params: recordIdParams }), ConfigurationController.removeRecord);
}));
export default router;
