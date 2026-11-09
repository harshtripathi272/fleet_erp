import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';
import { CARGO_KINDS } from '../../fleet/models/trailerType.model.js';

const tripTypeSchema = masterSchema({
  ...codeNameFields,
  cargoKind: { type: String, enum: CARGO_KINDS, required: true },
  loadTypeId: { type: ObjectId, ref: 'LoadType' },
  /** The type a new consignment on a trip of this type starts as (#135). */
  defaultConsignmentTypeId: { type: ObjectId, ref: 'ConsignmentType' },
  requiredDocumentTypeIds: { type: [{ type: ObjectId, ref: 'DocumentType' }], default: undefined },
  printLayoutId: { type: ObjectId, ref: 'PrintLayout' },
  isDefault: { type: Boolean, default: false },
});
uniqueIndex(tripTypeSchema, { code: 1 });
tripTypeSchema.index({ isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true, status: 'active' } });

export const TripType = masterModel('TripType', tripTypeSchema);
