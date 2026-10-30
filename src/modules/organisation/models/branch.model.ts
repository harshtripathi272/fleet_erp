import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, addressSchema, masterSchema, moneySchema, masterModel } from '../../../core/masters/schema.js';

export const BRANCH_TYPES = ['head_office', 'branch', 'yard', 'workshop', 'depot'] as const;

const branchSchema = masterSchema({
  ...codeNameFields,
  type: { type: String, enum: BRANCH_TYPES, required: true },
  parentBranchId: { type: ObjectId, ref: 'Branch' },
  placeId: { type: ObjectId, ref: 'Place' },
  address: { type: addressSchema, default: undefined },
  phone: String,
  email: String,
  managerUserId: { type: ObjectId, ref: 'User' },
  cashLimit: moneySchema,
});
uniqueIndex(branchSchema, { code: 1 });
/** Only one active head office. */
branchSchema.index({ type: 1 }, { unique: true, partialFilterExpression: { type: 'head_office', status: 'active' } });

export const Branch = masterModel('Branch', branchSchema);
