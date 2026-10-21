import { z } from 'zod';
import { baseShape, code, idList, money, name, objectId, percent, text, toUpdateSchema } from '../../core/masters/zod.js';
import { PACKAGING } from './models/product.model.js';
import { PRICING_BASES } from './models/productGroup.model.js';
import { ALLOWANCE_KINDS, BEARERS, MEASURED_AT } from './models/shortagePolicy.model.js';
import { POD_EVIDENCE } from './models/podType.model.js';

export const productGroupShape = { code, name, description: text(500).optional(), defaultUnitId: objectId.optional(), pricingBasis: z.enum(PRICING_BASES).optional(), ...baseShape };

export const productShape = {
  code, name, description: text(500).optional(),
  groupId: objectId,
  unitId: objectId,
  hazard: z.strictObject({
    unClass: z.string().trim().regex(/^[1-9](\.[1-6])?$/, 'UN class, e.g. 3 or 2.1'),
    unNumber: z.string().trim().toUpperCase().regex(/^UN\d{4}$/, 'e.g. UN1202').optional(),
    packingGroup: z.enum(['I', 'II', 'III']).optional(),
  }).optional(),
  densityKgPerL: z.number().min(0.3).max(3).optional(),
  volumeCorrected: z.boolean().optional(),
  referenceTemperatureC: z.union([z.literal(15), z.literal(20)]).optional(),
  shortageAllowancePercent: z.number().min(0).max(10).optional(),
  shortagePricePerUnit: money.optional(),
  packaging: z.enum(PACKAGING).optional(),
  allowedTrailerTypeIds: idList(20).optional(),
  ...baseShape,
};

export const loadTypeShape = { code, name, description: text(500).optional(), pricingBasis: z.enum(PRICING_BASES).optional(), multiDropAllowed: z.boolean().optional(), ...baseShape };

export const shortagePolicyShape = {
  code, name, description: text(500).optional(),
  productId: objectId.optional(),
  productGroupId: objectId.optional(),
  allowanceKind: z.enum(ALLOWANCE_KINDS),
  allowanceValue: z.number().min(0).max(1e6),
  measuredAt: z.enum(MEASURED_AT).optional(),
  pricePerUnit: money.optional(),
  bearer: z.enum(BEARERS).optional(),
  driverSharePercent: percent.optional(),
  approvalPolicyId: objectId.optional(),
  ...baseShape,
};

export const podTypeShape = { code, name, description: text(500).optional(), evidence: z.enum(POD_EVIDENCE), requiresPhoto: z.boolean().optional(), ...baseShape };

export const createProductGroupSchema = z.strictObject(productGroupShape);
export const updateProductGroupSchema = toUpdateSchema(productGroupShape);
export const createProductSchema = z.strictObject(productShape);
export const updateProductSchema = toUpdateSchema(productShape);
export const createLoadTypeSchema = z.strictObject(loadTypeShape);
export const updateLoadTypeSchema = toUpdateSchema(loadTypeShape);
export const createShortagePolicySchema = z.strictObject(shortagePolicyShape);
export const updateShortagePolicySchema = toUpdateSchema(shortagePolicyShape);
export const createPodTypeSchema = z.strictObject(podTypeShape);
export const updatePodTypeSchema = toUpdateSchema(podTypeShape);
