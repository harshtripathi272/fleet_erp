import { Types } from 'mongoose';
import { z } from 'zod';
import { ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { idQuery } from '../../core/masters/query.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import { Unit } from '../geography/models/unit.model.js';
import * as S from './cargo.schema.js';
import { LoadType } from './models/loadType.model.js';
import { PodType } from './models/podType.model.js';
import { Product } from './models/product.model.js';
import { ProductGroup } from './models/productGroup.model.js';
import { ShortagePolicy } from './models/shortagePolicy.model.js';

const push = (errors: Record<string, string[]>, key: string, message: string) => { (errors[key] ??= []).push(message); };

export const productGroupDefinition = defineMaster({
  key: 'product-groups', label: 'Product groups', singular: 'Product group', group: GROUPS.cargo,
  description: 'Fuel, minerals, consumer goods, containers: the default unit and pricing basis for products in the group.',
  model: ProductGroup, createSchema: S.createProductGroupSchema, updateSchema: S.updateProductGroupSchema,
  refs: [{ path: 'defaultUnitId', target: 'units' }],
});

export const productDefinition = defineMaster({
  key: 'products', label: 'Products', singular: 'Product', group: GROUPS.cargo,
  description: 'What is carried: unit, hazard class, density, the reference temperature for volume correction (15 or 20 °C) and the shortage allowance.',
  model: Product, createSchema: S.createProductSchema, updateSchema: S.updateProductSchema,
  refs: [
    { path: 'groupId', target: 'product-groups' }, { path: 'unitId', target: 'units' },
    { path: 'shortagePricePerUnit.currencyId', target: 'currencies' }, { path: 'allowedTrailerTypeIds', target: 'trailer-types' },
  ],
  filters: { groupId: { schema: idQuery, apply: (v: string) => ({ groupId: new Types.ObjectId(v) }), description: 'Product group' } },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    if (data.volumeCorrected) {
      if (!data.referenceTemperatureC) push(errors, 'referenceTemperatureC', 'Volume-corrected products need a reference temperature (15 or 20 °C)');
      if (!data.densityKgPerL) push(errors, 'densityKgPerL', 'Volume correction needs the density');
      const unit = await Unit.findById(data.unitId).select('dimension').lean();
      if (unit && unit.dimension !== 'volume') push(errors, 'unitId', 'Volume-corrected products are measured in a volume unit');
    } else if (data.referenceTemperatureC) {
      push(errors, 'referenceTemperatureC', 'Only volume-corrected products have a reference temperature');
    }
    if (data.shortagePricePerUnit && data.shortageAllowancePercent === undefined) push(errors, 'shortageAllowancePercent', 'Set the allowance along with the shortage price');
    if (Object.keys(errors).length) throw new ValidationError('Product details are not valid', errors);
    return data;
  },
});

export const loadTypeDefinition = defineMaster({
  key: 'load-types', label: 'Load types', singular: 'Load type', group: GROUPS.cargo,
  description: 'Full load, part load, bulk liquid, container, break-bulk; whether several drops are allowed.',
  model: LoadType, createSchema: S.createLoadTypeSchema, updateSchema: S.updateLoadTypeSchema,
});

export const shortagePolicyDefinition = defineMaster({
  key: 'shortage-policies', label: 'Shortage policies', singular: 'Shortage policy', group: GROUPS.cargo,
  description: 'Allowed loss for a product or product group, and how excess loss is priced and who bears it (driver, company or shared).',
  model: ShortagePolicy, createSchema: S.createShortagePolicySchema, updateSchema: S.updateShortagePolicySchema,
  refs: [
    { path: 'productId', target: 'products' }, { path: 'productGroupId', target: 'product-groups' },
    { path: 'pricePerUnit.currencyId', target: 'currencies' }, { path: 'approvalPolicyId', target: 'approval-policies' },
  ],
  filters: {
    productId: { schema: idQuery, apply: (v: string) => ({ productId: new Types.ObjectId(v) }), description: 'Product' },
    bearer: { schema: z.enum(['driver', 'company', 'shared']), apply: (v: string) => ({ bearer: v }), description: 'Who bears excess loss' },
  },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    if (!data.productId === !data.productGroupId) push(errors, 'productId', 'Apply the policy to exactly one product or one product group');
    if (data.allowanceKind === 'percent' && Number(data.allowanceValue) > 10) push(errors, 'allowanceValue', 'A percentage allowance cannot exceed 10%');
    if (data.bearer === 'shared' && data.driverSharePercent === undefined) push(errors, 'driverSharePercent', 'Say what share the driver bears');
    if (data.bearer !== 'shared' && data.driverSharePercent !== undefined) push(errors, 'driverSharePercent', 'Only shared policies split the cost');
    if (data.bearer !== 'company' && !data.pricePerUnit) push(errors, 'pricePerUnit', 'Recovering from the driver needs a price per unit');
    if (Object.keys(errors).length) throw new ValidationError('Shortage policy is not valid', errors);
    return data;
  },
});

export const podTypeDefinition = defineMaster({
  key: 'pod-types', label: 'Delivery proof types', singular: 'Delivery proof type', group: GROUPS.cargo,
  description: 'What counts as proof of delivery: signed note, stamp, photo, e-signature or OTP.',
  model: PodType, createSchema: S.createPodTypeSchema, updateSchema: S.updatePodTypeSchema,
  async prepare(data: Plain) {
    if (data.evidence === 'photo' && data.requiresPhoto === false) throw new ValidationError('Photo evidence always needs a photo', { requiresPhoto: ['Must be true for photo evidence'] });
    return data.evidence === 'photo' ? { ...data, requiresPhoto: true } : data;
  },
});

export const masters: MasterDefinition[] = [productGroupDefinition, productDefinition, loadTypeDefinition, shortagePolicyDefinition, podTypeDefinition];
