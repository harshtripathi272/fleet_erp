import { z } from 'zod';
import { address, baseShape, code, email, integer, money, name, objectId, phone, text, toUpdateSchema } from '../../core/masters/zod.js';
import { APPROVAL_SUBJECTS, CHANNELS } from './models/approvalPolicy.model.js';
import { BRANCH_TYPES } from './models/branch.model.js';
import { RESET_POLICIES } from './models/numberingSeries.model.js';

export const branchShape = {
  code, name, description: text(500).optional(),
  type: z.enum(BRANCH_TYPES),
  parentBranchId: objectId.optional(),
  placeId: objectId.optional(),
  address: address.optional(),
  phone: phone.optional(),
  email: email.optional(),
  managerUserId: objectId.optional(),
  cashLimit: money.optional(),
  ...baseShape,
};

export const numberingSeriesShape = {
  code, name, description: text(500).optional(),
  entity: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/, 'A master key such as "drivers", or a document such as "trips"'),
  branchId: objectId.optional(),
  prefix: z.string().trim().max(12).regex(/^[A-Z0-9._\-/]*$/, 'Uppercase letters, digits, ".", "_", "-" or "/"').optional(),
  pattern: z.string().trim().min(5).max(60),
  padding: integer(1, 10).optional(),
  resetPolicy: z.enum(RESET_POLICIES).optional(),
  nextNumber: integer(1, 1e9).optional(),
  ...baseShape,
};

const level = z.strictObject({
  level: integer(1, 10),
  minAmountMinor: z.number().int().min(0).max(1e13),
  approverRoleId: objectId.optional(),
  approverUserId: objectId.optional(),
  escalateAfterHours: integer(1, 720).optional(),
  channels: z.array(z.enum(CHANNELS)).min(1).max(4).refine((c) => new Set(c).size === c.length, 'Channels must be unique').optional(),
});

export const approvalPolicyShape = {
  code, name, description: text(500).optional(),
  subject: z.enum(APPROVAL_SUBJECTS),
  currencyId: objectId,
  levels: z.array(level).min(1).max(10),
  requireReasonAboveBudget: z.boolean().optional(),
  ...baseShape,
};

export const createBranchSchema = z.strictObject(branchShape);
export const updateBranchSchema = toUpdateSchema(branchShape);
export const createNumberingSeriesSchema = z.strictObject(numberingSeriesShape);
export const updateNumberingSeriesSchema = toUpdateSchema(numberingSeriesShape);
export const createApprovalPolicySchema = z.strictObject(approvalPolicyShape);
export const updateApprovalPolicySchema = toUpdateSchema(approvalPolicyShape);
