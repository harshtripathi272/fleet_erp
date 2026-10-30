import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const WAITING_COUNTS_AS = ['loading', 'offloading', 'border', 'rest', 'none'] as const;

const stopTypeSchema = masterSchema({
  ...codeNameFields,
  waitingCountsAs: { type: String, enum: WAITING_COUNTS_AS, default: 'none' },
  requiresDocumentTypeId: { type: ObjectId, ref: 'DocumentType' },
});
uniqueIndex(stopTypeSchema, { code: 1 });

export const StopType = masterModel('StopType', stopTypeSchema);
