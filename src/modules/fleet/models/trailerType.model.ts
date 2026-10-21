import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const CARGO_KINDS = ['liquid_bulk', 'dry_bulk', 'general', 'container', 'abnormal', 'refrigerated', 'livestock'] as const;

const trailerTypeSchema = masterSchema({
  ...codeNameFields,
  cargoKinds: { type: [String], enum: CARGO_KINDS, required: true },
  hasCompartments: { type: Boolean, default: false },
  requiredDocumentTypeIds: { type: [{ type: ObjectId, ref: 'DocumentType' }], default: undefined },
});
uniqueIndex(trailerTypeSchema, { code: 1 });

export const TrailerType = masterModel('TrailerType', trailerTypeSchema);
