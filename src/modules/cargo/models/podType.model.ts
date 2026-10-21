import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { masterSchema, masterModel } from '../../../core/masters/schema.js';

export const POD_EVIDENCE = ['signed_note', 'stamp', 'photo', 'e_signature', 'otp'] as const;

const podTypeSchema = masterSchema({
  ...codeNameFields,
  evidence: { type: String, enum: POD_EVIDENCE, required: true },
  requiresPhoto: { type: Boolean, default: false },
});
uniqueIndex(podTypeSchema, { code: 1 });

export const PodType = masterModel('PodType', podTypeSchema);
