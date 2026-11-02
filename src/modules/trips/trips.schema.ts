import { z } from 'zod';
import { baseShape, code, idList, integer, money, name, objectId, text, toUpdateSchema } from '../../core/masters/zod.js';
import { CARGO_KINDS } from '../fleet/models/trailerType.model.js';
import { EXPENSE_PER } from './models/expense.model.js';
import { ADVANCE_BASES, CANCEL_APPLIES } from './models/policies.model.js';
import { WAITING_COUNTS_AS } from './models/stopType.model.js';
import { STAGE_EVENTS } from './models/tripStage.model.js';

const kmPerL = z.number().positive().max(15);

export const tripTypeShape = {
  code, name, description: text(500).optional(),
  cargoKind: z.enum(CARGO_KINDS),
  loadTypeId: objectId.optional(),
  requiredDocumentTypeIds: idList(30).optional(),
  printLayoutId: objectId.optional(),
  isDefault: z.boolean().optional(),
  ...baseShape,
};

export const tripStageShape = {
  tripTypeId: objectId,
  code, name, description: text(500).optional(),
  order: integer(1, 50),
  actorRoleId: objectId.optional(),
  requiredDocumentTypeIds: idList(30).optional(),
  notifyTemplateId: objectId.optional(),
  reopenable: z.boolean().optional(),
  isFinal: z.boolean().optional(),
  completesOn: z.enum(STAGE_EVENTS).optional(),
  ...baseShape,
};

export const stopTypeShape = {
  code, name, description: text(500).optional(),
  waitingCountsAs: z.enum(WAITING_COUNTS_AS).optional(),
  requiresDocumentTypeId: objectId.optional(),
  ...baseShape,
};

export const expenseCategoryShape = {
  code, name, description: text(500).optional(),
  ledgerCode: z.string().trim().regex(/^[A-Za-z0-9.\-/]{1,20}$/, 'Ledger code: letters, digits, ".", "-" or "/"').optional(),
  receiptRequired: z.boolean().optional(),
  maxWithoutApproval: money.optional(),
  ...baseShape,
};

export const expenseItemShape = {
  code, name, description: text(500).optional(),
  categoryId: objectId,
  defaultAmount: money.optional(),
  per: z.enum(EXPENSE_PER).optional(),
  receiptRequired: z.boolean().optional(),
  ...baseShape,
};

export const fuelTypeShape = { code, name, description: text(500).optional(), unitId: objectId, densityKgPerL: z.number().min(0.5).max(1.5).optional(), ...baseShape };

export const fuelNormShape = {
  vehicleTypeId: objectId.optional(),
  vehicleModelId: objectId.optional(),
  kmPerLLoaded: kmPerL,
  kmPerLEmpty: kmPerL,
  reservePercent: z.number().min(0).max(50).optional(),
  ...baseShape,
};

export const tripBudgetShape = {
  code, name, description: text(500).optional(),
  routeId: objectId,
  vehicleTypeId: objectId.optional(),
  currencyId: objectId,
  fuelL: z.number().min(0).max(100000).optional(),
  cashItems: z.array(z.strictObject({ expenseItemId: objectId, amountMinor: z.number().int().min(0).max(1e13) })).max(50),
  ...baseShape,
};

export const advancePolicyShape = {
  code, name, description: text(500).optional(),
  basis: z.enum(ADVANCE_BASES),
  perDayAmount: money.optional(),
  fixedAmount: money.optional(),
  maxAmount: money,
  capOnCashHeld: money.optional(),
  approvalPolicyId: objectId.optional(),
  paymentMethodIds: idList(20).optional(),
  ...baseShape,
};

export const cancellationReasonShape = {
  code, name, description: text(500).optional(),
  appliesTo: z.array(z.enum(CANCEL_APPLIES)).min(1).max(3).refine((v) => new Set(v).size === v.length, 'Values must be unique'),
  chargeableToCustomer: z.boolean().optional(),
  ...baseShape,
};

export const createTripTypeSchema = z.strictObject(tripTypeShape);
export const updateTripTypeSchema = toUpdateSchema(tripTypeShape);
export const createTripStageSchema = z.strictObject(tripStageShape);
export const updateTripStageSchema = toUpdateSchema(tripStageShape);
export const createStopTypeSchema = z.strictObject(stopTypeShape);
export const updateStopTypeSchema = toUpdateSchema(stopTypeShape);
export const createExpenseCategorySchema = z.strictObject(expenseCategoryShape);
export const updateExpenseCategorySchema = toUpdateSchema(expenseCategoryShape);
export const createExpenseItemSchema = z.strictObject(expenseItemShape);
export const updateExpenseItemSchema = toUpdateSchema(expenseItemShape);
export const createFuelTypeSchema = z.strictObject(fuelTypeShape);
export const updateFuelTypeSchema = toUpdateSchema(fuelTypeShape);
export const createFuelNormSchema = z.strictObject(fuelNormShape);
export const updateFuelNormSchema = toUpdateSchema(fuelNormShape);
export const createTripBudgetSchema = z.strictObject(tripBudgetShape);
export const updateTripBudgetSchema = toUpdateSchema(tripBudgetShape);
export const createAdvancePolicySchema = z.strictObject(advancePolicyShape);
export const updateAdvancePolicySchema = toUpdateSchema(advancePolicyShape);
export const createCancellationReasonSchema = z.strictObject(cancellationReasonShape);
export const updateCancellationReasonSchema = toUpdateSchema(cancellationReasonShape);

export const estimateQuerySchema = z.strictObject({
  routeId: objectId,
  vehicleId: objectId.optional(),
  vehicleTypeId: objectId.optional(),
}).refine((q) => !(q.vehicleId && q.vehicleTypeId), 'Give a vehicle or a vehicle type, not both');
export type EstimateQuery = z.infer<typeof estimateQuerySchema>;
