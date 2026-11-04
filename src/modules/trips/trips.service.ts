import { Types } from 'mongoose';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { idQuery } from '../../core/masters/query.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import { CARGO_KINDS } from '../fleet/models/trailerType.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { VehicleModel } from '../fleet/models/vehicleModel.model.js';
import { Route } from '../geography/models/route.model.js';
import { Unit } from '../geography/models/unit.model.js';
import { ExpenseCategory, ExpenseItem, EXPENSE_PER } from './models/expense.model.js';
import { FuelNorm, FuelType } from './models/fuel.model.js';
import { ADVANCE_BASES, AdvancePolicy, CancellationReason, CANCEL_APPLIES } from './models/policies.model.js';
import { StopType } from './models/stopType.model.js';
import { TripBudget } from './models/tripBudget.model.js';
import { TripStage } from './models/tripStage.model.js';
import { TripType } from './models/tripType.model.js';
import * as S from './trips.schema.js';

const byId = (field: string) => ({ schema: idQuery, apply: (v: string) => ({ [field]: new Types.ObjectId(v) }), description: `Only records with this ${field}` });
const push = (errors: Record<string, string[]>, key: string, message: string) => { (errors[key] ??= []).push(message); };
const fail = (errors: Record<string, string[]>, message: string) => { if (Object.keys(errors).length) throw new ValidationError(message, errors); };

export const tripTypeDefinition = defineMaster({
  key: 'trip-types', label: 'Trip types', singular: 'Trip type', group: GROUPS.trips,
  description: 'Fuel, general cargo, container, local delivery, empty run. Each has its own stages, required documents and trip sheet layout. One may be the default.',
  model: TripType, createSchema: S.createTripTypeSchema, updateSchema: S.updateTripTypeSchema,
  refs: [{ path: 'loadTypeId', target: 'load-types' }, { path: 'requiredDocumentTypeIds', target: 'document-types' }, { path: 'printLayoutId', target: 'print-layouts' }],
  filters: { cargoKind: { schema: z.enum(CARGO_KINDS), apply: (v: string) => ({ cargoKind: v }), description: 'Cargo kind' } },
});

export const tripStageDefinition = defineMaster({
  key: 'trip-stages', label: 'Trip stages', singular: 'Trip stage', group: GROUPS.trips, lockedChoices: ['event'],
  description: 'The workflow of a trip type, in order. Each stage names who acts, what documents it needs and which message it sends. One stage is final.',
  model: TripStage, createSchema: S.createTripStageSchema, updateSchema: S.updateTripStageSchema,
  sortFields: ['order', 'code', 'name', 'createdAt'], defaultSort: 'order',
  refs: [
    { path: 'tripTypeId', target: 'trip-types' }, { path: 'actorRoleId', target: 'roles' },
    { path: 'requiredDocumentTypeIds', target: 'document-types' }, { path: 'notifyTemplateId', target: 'message-templates' },
  ],
  immutable: ['tripTypeId'],
  filters: { tripTypeId: byId('tripTypeId') },
  async prepare(data: Plain, ctx) {
    if (data.isFinal && data.reopenable) throw new ValidationError('The final stage cannot be reopenable', { reopenable: ['Not allowed on the final stage'] });
    if (data.isFinal) {
      const later = await TripStage.countDocuments({ tripTypeId: data.tripTypeId, status: 'active', order: { $gt: data.order }, ...(ctx.id ? { _id: { $ne: ctx.id } } : {}) });
      if (later) throw new ValidationError('The final stage must be the last one', { order: [`${later} active stage(s) come after it`] });
    } else {
      const final = await TripStage.findOne({ tripTypeId: data.tripTypeId, status: 'active', isFinal: true, ...(ctx.id ? { _id: { $ne: ctx.id } } : {}) }).select('order').lean();
      if (final && Number(data.order) > Number(final.order)) throw new ValidationError('Stages cannot come after the final stage', { order: [`The final stage is at ${final.order}`] });
    }
    return data;
  },
});

export const stopTypeDefinition = defineMaster({
  key: 'stop-types', label: 'Stop types', singular: 'Stop type', group: GROUPS.trips,
  description: 'Start, loading, offloading, border, fuel, rest, end: how waiting at each is counted and any document it needs.',
  model: StopType, createSchema: S.createStopTypeSchema, updateSchema: S.updateStopTypeSchema,
  refs: [{ path: 'requiresDocumentTypeId', target: 'document-types' }],
});

export const expenseCategoryDefinition = defineMaster({
  key: 'expense-categories', label: 'Expense categories', singular: 'Expense category', group: GROUPS.trips,
  description: 'Groups of trip costs with their ledger code, whether a receipt is required, and the amount payable without approval.',
  model: ExpenseCategory, createSchema: S.createExpenseCategorySchema, updateSchema: S.updateExpenseCategorySchema,
  refs: [{ path: 'maxWithoutApproval.currencyId', target: 'currencies' }],
});

export const expenseItemDefinition = defineMaster({
  key: 'expense-items', label: 'Expense items', singular: 'Expense item', group: GROUPS.trips,
  description: 'Each kind of cost: toll, border fee, meals, parking, repair. Usual amount and how it is counted (per trip, day, border, km).',
  model: ExpenseItem, createSchema: S.createExpenseItemSchema, updateSchema: S.updateExpenseItemSchema,
  refs: [{ path: 'categoryId', target: 'expense-categories' }, { path: 'defaultAmount.currencyId', target: 'currencies' }],
  filters: {
    categoryId: byId('categoryId'),
    per: { schema: z.enum(EXPENSE_PER), apply: (v: string) => ({ per: v }), description: 'How the cost is counted' },
  },
});

export const fuelTypeDefinition = defineMaster({
  key: 'fuel-types', label: 'Fuel types', singular: 'Fuel type', group: GROUPS.trips,
  description: 'Diesel 50 ppm, diesel 500 ppm, petrol, AdBlue, measured in a volume unit.',
  model: FuelType, createSchema: S.createFuelTypeSchema, updateSchema: S.updateFuelTypeSchema,
  refs: [{ path: 'unitId', target: 'units' }],
  async prepare(data: Plain) {
    const unit = await Unit.findById(data.unitId).select('dimension').lean();
    if (unit && unit.dimension !== 'volume') throw new ValidationError('Fuel is measured in a volume unit', { unitId: ['Choose a volume unit, e.g. litres'] });
    return data;
  },
});

export const fuelNormDefinition = defineMaster({
  key: 'fuel-norms', label: 'Fuel norms', singular: 'Fuel norm', group: GROUPS.trips,
  description: 'km per litre loaded and empty for a vehicle type or model, with a safety reserve. A vehicle\'s own figures override its model, which overrides its type.',
  model: FuelNorm, createSchema: S.createFuelNormSchema, updateSchema: S.updateFuelNormSchema,
  searchFields: ['notes'], sortFields: ['kmPerLLoaded', 'kmPerLEmpty', 'createdAt', 'updatedAt'], defaultSort: '-createdAt', titleField: 'kmPerLLoaded',
  refs: [{ path: 'vehicleTypeId', target: 'vehicle-types' }, { path: 'vehicleModelId', target: 'vehicle-models' }],
  filters: { vehicleTypeId: byId('vehicleTypeId'), vehicleModelId: byId('vehicleModelId') },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    if (!data.vehicleTypeId === !data.vehicleModelId) push(errors, 'vehicleTypeId', 'Set exactly one of vehicle type or vehicle model');
    if (Number(data.kmPerLLoaded) > Number(data.kmPerLEmpty)) push(errors, 'kmPerLLoaded', 'A loaded truck cannot cover more km per litre than an empty one');
    fail(errors, 'Fuel norm is not valid');
    return data;
  },
});

async function assertSameCurrency(data: Plain, paths: string[], currencyId?: unknown) {
  const ids = new Set<string>();
  if (currencyId) ids.add(String(currencyId));
  for (const path of paths) {
    const value = data[path] as { currencyId?: unknown } | undefined;
    if (value?.currencyId) ids.add(String(value.currencyId));
  }
  if (ids.size > 1) throw new ValidationError('All amounts must use the same currency', { [paths[0]!]: ['Mixed currencies'] });
}

export const tripBudgetDefinition = defineMaster({
  key: 'trip-budgets', label: 'Trip budgets', singular: 'Trip budget', group: GROUPS.trips,
  description: 'Expected fuel and cash for a route, optionally per vehicle type. The cash total is calculated from the items. Use Estimate to combine it with fuel norms.',
  model: TripBudget, createSchema: S.createTripBudgetSchema, updateSchema: S.updateTripBudgetSchema,
  sortFields: ['code', 'name', 'totalCashMinor', 'createdAt', 'updatedAt'],
  refs: [
    { path: 'routeId', target: 'routes' }, { path: 'vehicleTypeId', target: 'vehicle-types' },
    { path: 'currencyId', target: 'currencies' }, { path: 'cashItems.expenseItemId', target: 'expense-items' },
  ],
  filters: { routeId: byId('routeId'), vehicleTypeId: byId('vehicleTypeId') },
  async prepare(data: Plain) {
    const items = (data.cashItems ?? []) as Array<{ expenseItemId: unknown; amountMinor: number }>;
    const ids = items.map((i) => String(i.expenseItemId));
    if (new Set(ids).size !== ids.length) throw new ValidationError('Each expense item may appear once', { cashItems: ['Duplicate expense item'] });
    return { ...data, totalCashMinor: items.reduce((sum, i) => sum + i.amountMinor, 0) };
  },
});

export const advancePolicyDefinition = defineMaster({
  key: 'advance-policies', label: 'Advance policies', singular: 'Advance policy', group: GROUPS.trips,
  description: 'How much cash a driver may receive (from the route budget, per day, or a fixed sum), the ceiling, the cap on cash already held, and approvals.',
  model: AdvancePolicy, createSchema: S.createAdvancePolicySchema, updateSchema: S.updateAdvancePolicySchema,
  refs: [
    { path: 'perDayAmount.currencyId', target: 'currencies' }, { path: 'fixedAmount.currencyId', target: 'currencies' },
    { path: 'maxAmount.currencyId', target: 'currencies' }, { path: 'capOnCashHeld.currencyId', target: 'currencies' },
    { path: 'approvalPolicyId', target: 'approval-policies' }, { path: 'paymentMethodIds', target: 'payment-methods' },
  ],
  filters: { basis: { schema: z.enum(ADVANCE_BASES), apply: (v: string) => ({ basis: v }), description: 'How the advance is calculated' } },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    if (data.basis === 'per_day' && !data.perDayAmount) push(errors, 'perDayAmount', 'Required for per-day advances');
    if (data.basis !== 'per_day' && data.perDayAmount) push(errors, 'perDayAmount', 'Only per-day advances take a daily amount');
    if (data.basis === 'fixed' && !data.fixedAmount) push(errors, 'fixedAmount', 'Required for fixed advances');
    if (data.basis !== 'fixed' && data.fixedAmount) push(errors, 'fixedAmount', 'Only fixed advances take a fixed amount');
    const fixed = data.fixedAmount as { amountMinor: number } | undefined;
    const max = data.maxAmount as { amountMinor: number };
    if (fixed && fixed.amountMinor > max.amountMinor) push(errors, 'fixedAmount', 'Cannot exceed the maximum amount');
    fail(errors, 'Advance policy is not valid');
    await assertSameCurrency(data, ['maxAmount', 'perDayAmount', 'fixedAmount', 'capOnCashHeld']);
    return data;
  },
});

export const cancellationReasonDefinition = defineMaster({
  key: 'cancellation-reasons', label: 'Cancellation reasons', singular: 'Cancellation reason', group: GROUPS.trips,
  description: 'Why a trip, order or request was cancelled, and whether the customer is charged.',
  model: CancellationReason, createSchema: S.createCancellationReasonSchema, updateSchema: S.updateCancellationReasonSchema,
  filters: { appliesTo: { schema: z.enum(CANCEL_APPLIES), apply: (v: string) => ({ appliesTo: v }), description: 'Usable for' } },
});

/* ---------- Estimate ---------- */

interface Norm { kmPerLLoaded: number; kmPerLEmpty: number; reservePercent: number; source: string; }

async function normFor(vehicleId?: string, vehicleTypeId?: string): Promise<Norm | null> {
  let typeId = vehicleTypeId;
  if (vehicleId) {
    const vehicle = await Vehicle.findById(vehicleId).select('kmPerLLoaded kmPerLEmpty modelId vehicleTypeId registrationNumber').lean();
    if (!vehicle) throw new NotFoundError('Vehicle not found');
    typeId = String(vehicle.vehicleTypeId);
    if (vehicle.kmPerLLoaded && vehicle.kmPerLEmpty) {
      const reserve = (await FuelNorm.findOne({ vehicleTypeId: typeId, status: 'active' }).select('reservePercent').lean())?.reservePercent ?? 5;
      return { kmPerLLoaded: Number(vehicle.kmPerLLoaded), kmPerLEmpty: Number(vehicle.kmPerLEmpty), reservePercent: Number(reserve), source: `vehicle ${vehicle.registrationNumber}` };
    }
    if (vehicle.modelId) {
      const norm = await FuelNorm.findOne({ vehicleModelId: vehicle.modelId, status: 'active' }).lean();
      if (norm) return { kmPerLLoaded: Number(norm.kmPerLLoaded), kmPerLEmpty: Number(norm.kmPerLEmpty), reservePercent: Number(norm.reservePercent ?? 5), source: 'vehicle model norm' };
      const model = await VehicleModel.findById(vehicle.modelId).select('kmPerLLoaded kmPerLEmpty name').lean();
      if (model?.kmPerLLoaded && model.kmPerLEmpty) return { kmPerLLoaded: Number(model.kmPerLLoaded), kmPerLEmpty: Number(model.kmPerLEmpty), reservePercent: 5, source: `model ${model.name}` };
    }
  }
  if (typeId) {
    const norm = await FuelNorm.findOne({ vehicleTypeId: typeId, status: 'active' }).lean();
    if (norm) return { kmPerLLoaded: Number(norm.kmPerLLoaded), kmPerLEmpty: Number(norm.kmPerLEmpty), reservePercent: Number(norm.reservePercent ?? 5), source: 'vehicle type norm' };
  }
  return null;
}

/** Fuel from route distances and the best fuel norm; cash from the matching trip budget. */
export async function estimate(query: S.EstimateQuery) {
  const route = await Route.findById(query.routeId).lean();
  if (!route) throw new NotFoundError('Route not found');
  let vehicleTypeId = query.vehicleTypeId;
  if (query.vehicleId) vehicleTypeId = String((await Vehicle.findById(query.vehicleId).select('vehicleTypeId').lean())?.vehicleTypeId ?? '') || undefined;
  const budget = (vehicleTypeId ? await TripBudget.findOne({ routeId: route._id, vehicleTypeId, status: 'active' }).lean() : null)
    ?? await TripBudget.findOne({ routeId: route._id, vehicleTypeId: { $exists: false }, status: 'active' }).lean();
  const norm = await normFor(query.vehicleId, vehicleTypeId);
  const loadedKm = Number(route.loadedKm ?? 0);
  const emptyKm = Number(route.emptyKm ?? 0);
  let fuel: Plain;
  if (budget?.fuelL) fuel = { litres: Number(budget.fuelL), source: `trip budget ${budget.code}` };
  else if (route.fuelBudgetL) fuel = { litres: Number(route.fuelBudgetL), source: `route ${route.code}` };
  else if (norm) {
    const raw = loadedKm / norm.kmPerLLoaded + emptyKm / norm.kmPerLEmpty;
    const litres = Math.ceil((raw * (1 + norm.reservePercent / 100)) / 5) * 5;
    fuel = { litres, source: norm.source, calculation: { loadedKm, emptyKm, kmPerLLoaded: norm.kmPerLLoaded, kmPerLEmpty: norm.kmPerLEmpty, reservePercent: norm.reservePercent, beforeReserveL: Math.round(raw * 10) / 10 } };
  } else {
    fuel = { litres: null, source: 'none', hint: 'Add a fuel norm for this vehicle type, consumption on the vehicle, or a fuel budget on the route' };
  }
  const cash = budget
    ? { amountMinor: Number(budget.totalCashMinor), currencyId: String(budget.currencyId), source: `trip budget ${budget.code}`, items: budget.cashItems }
    : route.cashBudget ? { ...(route.cashBudget as Plain), source: `route ${route.code}` } : { amountMinor: null, source: 'none' };
  return { route: { id: String(route._id), code: route.code, name: route.name, totalKm: route.totalKm, loadedKm, emptyKm }, fuel, cash };
}

export const masters: MasterDefinition[] = [
  tripTypeDefinition, tripStageDefinition, stopTypeDefinition, expenseCategoryDefinition, expenseItemDefinition,
  fuelTypeDefinition, fuelNormDefinition, tripBudgetDefinition, advancePolicyDefinition, cancellationReasonDefinition,
];
