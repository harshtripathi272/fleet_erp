import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

/** One step of a trip type's workflow, e.g. Plan → Funding → Loading → Transit → Offloading → Close. */
const tripStageSchema = masterSchema({
  tripTypeId: { type: ObjectId, ref: 'TripType', required: true },
  code: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: String,
  order: { type: Number, required: true, min: 1, max: 50 },
  actorRoleId: { type: ObjectId, ref: 'Role' },
  requiredDocumentTypeIds: { type: [{ type: ObjectId, ref: 'DocumentType' }], default: undefined },
  notifyTemplateId: { type: ObjectId, ref: 'MessageTemplate' },
  reopenable: { type: Boolean, default: false },
  isFinal: { type: Boolean, default: false },
});
tripStageSchema.index({ tripTypeId: 1, code: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
tripStageSchema.index({ tripTypeId: 1, order: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
tripStageSchema.index({ tripTypeId: 1, isFinal: 1 }, { unique: true, partialFilterExpression: { isFinal: true, status: 'active' } });

export const TripStage = masterModel('TripStage', tripStageSchema);
