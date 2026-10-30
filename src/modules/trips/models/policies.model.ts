import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, moneySchema, masterModel } from '../../../core/masters/schema.js';

export const ADVANCE_BASES = ['route_budget', 'per_day', 'fixed'] as const;
export const CANCEL_APPLIES = ['trip', 'order', 'request'] as const;

const advancePolicySchema = masterSchema({
  ...codeNameFields,
  basis: { type: String, enum: ADVANCE_BASES, required: true },
  perDayAmount: moneySchema,
  fixedAmount: moneySchema,
  maxAmount: { type: moneySchema, required: true },
  capOnCashHeld: moneySchema,
  approvalPolicyId: { type: ObjectId, ref: 'ApprovalPolicy' },
  paymentMethodIds: { type: [{ type: ObjectId, ref: 'PaymentMethod' }], default: undefined },
});
uniqueIndex(advancePolicySchema, { code: 1 });
export const AdvancePolicy = masterModel('AdvancePolicy', advancePolicySchema);

const cancellationReasonSchema = masterSchema({
  ...codeNameFields,
  appliesTo: { type: [String], enum: CANCEL_APPLIES, required: true },
  chargeableToCustomer: { type: Boolean, default: false },
});
uniqueIndex(cancellationReasonSchema, { code: 1 });
export const CancellationReason = masterModel('CancellationReason', cancellationReasonSchema);
