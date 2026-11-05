import { z } from 'zod';
import { baseShape, code, integer, isoDate, money, name, objectId, text, toUpdateSchema } from '../../core/masters/zod.js';
import { TYRE_ACTIONS, WORK_ORDER_SOURCES, WORK_ORDER_STAGES } from './models/maintenance.model.js';

const reading = z.number().min(0).max(5_000_000);

export const servicePlanShape = {
  code, name, description: text(500).optional(),
  vehicleTypeId: objectId.optional(),
  vehicleId: objectId.optional(),
  everyKm: integer(1, 1_000_000).optional(),
  everyDays: integer(1, 3650).optional(),
  everyEngineHours: integer(1, 100_000).optional(),
  includes: text(2000).optional(),
  ...baseShape,
};
export const createServicePlanSchema = z.strictObject(servicePlanShape);
export const updateServicePlanSchema = toUpdateSchema(servicePlanShape);

const partLine = z.strictObject({
  name: text(120),
  partNumber: text(60).optional(),
  quantity: z.number().positive().max(100_000),
  unitCost: money,
});

export const workOrderShape = {
  vehicleId: objectId,
  source: z.enum(WORK_ORDER_SOURCES).optional(),
  servicePlanId: objectId.optional(),
  description: text(2000).optional(),
  workshopPartyId: objectId.optional(),
  stage: z.enum(WORK_ORDER_STAGES).optional(),
  stopsTruck: z.boolean().optional(),
  odometerKm: reading.optional(),
  engineHours: reading.optional(),
  startedAt: isoDate.optional(),
  endedAt: isoDate.optional(),
  labour: money.optional(),
  parts: z.array(partLine).max(100).optional(),
  ...baseShape,
};
export const createWorkOrderSchema = z.strictObject(workOrderShape);
export const updateWorkOrderSchema = toUpdateSchema(workOrderShape);

export const tyreRecordShape = {
  vehicleId: objectId,
  position: text(40),
  fromPosition: text(40).optional(),
  action: z.enum(TYRE_ACTIONS),
  serialNumber: text(60).optional(),
  odometerKm: reading.optional(),
  at: isoDate,
  cost: money.optional(),
  ...baseShape,
};
export const createTyreRecordSchema = z.strictObject(tyreRecordShape);
export const updateTyreRecordSchema = toUpdateSchema(tyreRecordShape);

export const costsQuery = z.strictObject({ from: isoDate, to: isoDate }).refine((q) => q.from <= q.to, 'The start must be before the end');
export type CostsQuery = z.infer<typeof costsQuery>;

export const defectSchema = z.strictObject({ note: text(1000) });
export type DefectInput = z.infer<typeof defectSchema>;
