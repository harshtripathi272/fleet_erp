import { Schema } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const APPROVAL_SUBJECTS = ['fuel_request', 'cash_advance', 'expense', 'trip_budget', 'shortage_waiver', 'settlement', 'driver_recovery'] as const;
export const CHANNELS = ['app', 'whatsapp', 'sms', 'email'] as const;

const levelSchema = new Schema({
  level: { type: Number, required: true, min: 1, max: 10 },
  minAmountMinor: { type: Number, required: true, min: 0 },
  approverRoleId: { type: ObjectId, ref: 'Role' },
  approverUserId: { type: ObjectId, ref: 'User' },
  escalateAfterHours: { type: Number, min: 1, max: 720 },
  channels: { type: [String], enum: CHANNELS, default: ['app'] },
}, { _id: false });

const approvalPolicySchema = masterSchema({
  ...codeNameFields,
  subject: { type: String, enum: APPROVAL_SUBJECTS, required: true },
  currencyId: { type: ObjectId, ref: 'Currency', required: true },
  levels: { type: [levelSchema], required: true },
  requireReasonAboveBudget: { type: Boolean, default: true },
});
uniqueIndex(approvalPolicySchema, { code: 1 });
approvalPolicySchema.index({ subject: 1, currencyId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });

export const ApprovalPolicy = masterModel('ApprovalPolicy', approvalPolicySchema);
