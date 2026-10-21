import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, moneySchema, masterModel } from '../../../core/masters/schema.js';

export const RECOVERY_KINDS = ['shortage', 'damage', 'loan', 'unreturned_advance', 'fine', 'other'] as const;

const recoveryRuleSchema = masterSchema({
  ...codeNameFields,
  kind: { type: String, enum: RECOVERY_KINDS, required: true },
  maxPercentPerSettlement: { type: Number, min: 0, max: 100 },
  maxAmountPerSettlement: moneySchema,
  requiresApproval: { type: Boolean, default: true },
  approvalPolicyId: { type: ObjectId, ref: 'ApprovalPolicy' },
});
uniqueIndex(recoveryRuleSchema, { code: 1 });

export const RecoveryRule = masterModel('RecoveryRule', recoveryRuleSchema);
