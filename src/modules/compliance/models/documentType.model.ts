import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const SUBJECT_KINDS = ['vehicle', 'trailer', 'driver', 'party', 'company'] as const;
export const BLOCKING = ['none', 'dispatch', 'loading', 'border'] as const;

const documentTypeSchema = masterSchema({
  ...codeNameFields,
  appliesTo: { type: String, enum: SUBJECT_KINDS, required: true },
  countryId: { type: ObjectId, ref: 'Country' },
  numberPattern: String,
  hasIssueDate: { type: Boolean, default: true },
  hasExpiryDate: { type: Boolean, default: true },
  reminderDaysBefore: { type: Number, min: 0, max: 365, default: 30 },
  blocking: { type: String, enum: BLOCKING, default: 'none' },
  /** Every subject of this kind needs it (not only types that list it). */
  requiredForAll: { type: Boolean, default: false },
  verifiedByRoleId: { type: ObjectId, ref: 'Role' },
});
uniqueIndex(documentTypeSchema, { code: 1 });

export const DocumentType = masterModel('DocumentType', documentTypeSchema);
