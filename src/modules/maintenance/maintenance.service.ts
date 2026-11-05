import * as Fmt from '../../core/format/regional.js';
import { Types } from 'mongoose';
import { ConflictError, ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { idQuery } from '../../core/masters/query.js';
import * as MasterService from '../../core/masters/service.js';
import type { MasterContext, Plain } from '../../core/masters/types.js';
import { logger } from '../../core/logger/index.js';
import { isAreaOn } from '../company/areas.js';
import { Company, MAINTENANCE_DEFAULTS } from '../company/company.model.js';
import { Driver } from '../drivers/models/driver.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { notify } from '../messaging/dispatcher.js';
import { Trip } from '../operations/models/trip.model.js';
import { baseCurrency, log, nextNumber, post, queue, toBase, type OpsContext } from '../operations/support.js';
import * as S from './maintenance.schema.js';
import { ServicePlan, ServiceState, TyreRecord, WorkOrder } from './models/maintenance.model.js';

/**
 * The Maintenance area (#63): service plans, work orders and tyres on each truck. Trucks don't count down by
 * themselves: what is due is worked out each time from the odometer, the engine hours and the dates.
 */

const byId = (field: string) => ({ schema: idQuery, apply: (v: string) => ({ [field]: new Types.ObjectId(v) }), description: `Only records with this ${field}` });
const fail = (errors: Record<string, string[]>) => { if (Object.keys(errors).length) throw new ValidationError('Details are not valid', errors); };

export async function maintenanceSettings() {
  const company = await Company.findOne().select('maintenance').lean<{ maintenance?: Partial<typeof MAINTENANCE_DEFAULTS> }>();
  return { ...MAINTENANCE_DEFAULTS, ...(company?.maintenance ?? {}) };
}

type Money = { amountMinor: number; currencyId: unknown };

/** Money in the base currency at the date's rate. Nothing to convert needs no base currency. */
async function inBase(amounts: Array<{ money: Money; times?: number }>, date: Date) {
  let total = 0;
  for (const { money, times = 1 } of amounts) total += (await toBase(Math.round(money.amountMinor * times), money.currencyId, date)).baseMinor;
  return total;
}

export const servicePlanDefinition = defineMaster({
  key: 'service-plans', label: 'Service plans', singular: 'Service plan', group: GROUPS.maintenance, module: 'maintenance',
  description: 'What a truck type or one truck needs, and how often: every so many km, days or engine hours, whichever comes first.',
  model: ServicePlan, createSchema: S.createServicePlanSchema, updateSchema: S.updateServicePlanSchema,
  columns: ['vehicleTypeId', 'vehicleId', 'everyKm', 'everyDays', 'everyEngineHours'],
  fixedFields: ['vehicleTypeId', 'vehicleId', 'everyKm', 'everyDays', 'everyEngineHours'],
  labels: { everyKm: 'Every (km)', everyDays: 'Every (days)', everyEngineHours: 'Every (engine hours)', vehicleId: 'One truck', vehicleTypeId: 'Truck type' },
  hints: {
    vehicleTypeId: 'Every truck of this type follows the plan. Choose a type or one truck, not both.',
    everyKm: 'Fill in at least one of km, days and engine hours. Whichever comes first makes the service due.',
    includes: 'What the workshop does at this service. It shows on the due list.',
  },
  refs: [{ path: 'vehicleTypeId', target: 'vehicle-types' }, { path: 'vehicleId', target: 'vehicles' }],
  filters: { vehicleTypeId: byId('vehicleTypeId'), vehicleId: byId('vehicleId') },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    if (!data.vehicleTypeId && !data.vehicleId) errors.vehicleTypeId = ['Choose a truck type or one truck'];
    if (data.vehicleTypeId && data.vehicleId) errors.vehicleId = ['Choose a truck type or one truck, not both'];
    if (!data.everyKm && !data.everyDays && !data.everyEngineHours) errors.everyKm = ['Fill in at least one of km, days and engine hours'];
    fail(errors);
    return data;
  },
});

export const workOrderDefinition = defineMaster({
  key: 'work-orders', label: 'Work orders', singular: 'Work order', group: GROUPS.maintenance, module: 'maintenance',
  description: 'A job on a truck: a due service, a defect the driver reported, or anything else. While an order that stops the truck is not done, the truck cannot be given a trip.',
  model: WorkOrder, createSchema: S.createWorkOrderSchema, updateSchema: S.updateWorkOrderSchema,
  searchFields: ['number', 'description'],
  sortFields: ['number', 'stage', 'startedAt', 'endedAt', 'createdAt', 'updatedAt'],
  defaultSort: '-createdAt',
  titleField: 'number',
  columns: ['vehicleId', 'stage', 'stopsTruck', 'workshopPartyId', 'startedAt', 'endedAt'],
  fixedFields: ['stage', 'stopsTruck', 'source', 'servicePlanId', 'odometerKm', 'engineHours', 'startedAt', 'endedAt', 'labour'],
  lockedChoices: ['stage', 'source'],
  hidden: ['costBaseMinor'],
  immutable: ['vehicleId'],
  labels: { vehicleId: 'Truck', servicePlanId: 'Service', workshopPartyId: 'Workshop', stopsTruck: 'Stops the truck', source: 'Opened from', 'parts.unitCost': 'Unit cost' },
  choiceLabels: { stage: { open: 'Open', in_workshop: 'In the workshop', done: 'Done' }, source: { service: 'A due service', defect: 'A defect the driver reported', manual: 'By hand' } },
  hints: {
    stopsTruck: 'While this order is not done, the truck cannot be given a trip or leave on one.',
    odometerKm: 'The reading when the work was done. The next service counts from it.',
    labour: 'What the labour cost. Together with the parts it makes the cost per truck.',
  },
  fieldModules: { parts: 'parts' },
  refs: [
    { path: 'vehicleId', target: 'vehicles' }, { path: 'servicePlanId', target: 'service-plans' },
    { path: 'workshopPartyId', target: 'parties', partyRoles: ['workshop'] },
    { path: 'labour.currencyId', target: 'currencies' }, { path: 'parts.unitCost.currencyId', target: 'currencies' },
    { path: 'reportedByDriverId', target: 'drivers', usageOnly: true },
  ],
  filters: {
    vehicleId: byId('vehicleId'), servicePlanId: byId('servicePlanId'),
    stage: { schema: S.workOrderShape.stage.unwrap(), apply: (v: string) => ({ stage: v }), description: 'Stage' },
  },
  async prepare(data: Plain, ctx: MasterContext) {
    const errors: Record<string, string[]> = {};
    const stage = String(data.stage ?? 'open');
    if (ctx.existing?.stage === 'done' && stage !== 'done') errors.stage = ['A finished work order stays finished. Open a new one.'];
    if (data.source === 'service' && !data.servicePlanId) errors.servicePlanId = ['Choose the service this order is for'];
    if (data.parts && (data.parts as unknown[]).length && !(await isAreaOn('parts'))) errors.parts = ['Parts are switched off for this company'];
    const now = new Date();
    const out: Plain = { ...data, stage };
    if (stage !== 'open') out.startedAt ??= now;
    if (stage === 'done') out.endedAt ??= now;
    if (out.startedAt && out.endedAt && (out.endedAt as Date) < (out.startedAt as Date)) errors.endedAt = ['The end cannot be before the start'];
    fail(errors);
    if (ctx.mode === 'create') {
      out.number = await nextNumber('work-orders', 'WO', now);
      if (out.stopsTruck === undefined) out.stopsTruck = (await maintenanceSettings())[out.source === 'defect' ? 'defectStopsTruck' : 'workOrderStopsTruck'];
    }
    const truck = await Vehicle.findById(data.vehicleId).select('odometerKm engineHours').lean<{ odometerKm?: number; engineHours?: number }>();
    if (stage === 'done') {
      out.odometerKm ??= await odometerOf(data.vehicleId, truck?.odometerKm);
      out.engineHours ??= truck?.engineHours;
      // A reading taken at the workshop moves the truck's own reading on, never back.
      const set: Plain = {};
      if (typeof out.odometerKm === 'number' && out.odometerKm > (truck?.odometerKm ?? -1)) set.odometerKm = out.odometerKm;
      if (typeof out.engineHours === 'number' && out.engineHours > (truck?.engineHours ?? -1)) set.engineHours = out.engineHours;
      if (Object.keys(set).length) await Vehicle.updateOne({ _id: data.vehicleId }, { $set: set });
    }
    out.costBaseMinor = await inBase([
      ...(out.labour ? [{ money: out.labour as Money }] : []),
      ...((out.parts ?? []) as Array<{ quantity: number; unitCost: Money }>).map((p) => ({ money: p.unitCost, times: p.quantity })),
    ], (out.endedAt ?? out.startedAt ?? now) as Date);
    return out;
  },
});

export const tyreRecordDefinition = defineMaster({
  key: 'tyre-records', label: 'Tyres', singular: 'Tyre record', group: GROUPS.maintenance, module: 'tyres',
  description: 'Tyres fitted, rotated and replaced on each truck, by position and odometer.',
  model: TyreRecord, createSchema: S.createTyreRecordSchema, updateSchema: S.updateTyreRecordSchema,
  searchFields: ['position', 'serialNumber'],
  sortFields: ['at', 'position', 'createdAt', 'updatedAt'],
  defaultSort: '-at',
  titleField: 'position',
  columns: ['vehicleId', 'action', 'serialNumber', 'odometerKm', 'at'],
  hidden: ['costBaseMinor'],
  labels: { vehicleId: 'Truck', fromPosition: 'Moved from', at: 'Date' },
  hints: { position: 'Where it sits on the truck, in the words your workshop uses: "Front left" or "Drive axle 2, outer right".', fromPosition: 'For a rotation: where it came from.' },
  refs: [{ path: 'vehicleId', target: 'vehicles' }, { path: 'cost.currencyId', target: 'currencies' }],
  filters: { vehicleId: byId('vehicleId') },
  async prepare(data: Plain) {
    return { ...data, costBaseMinor: await inBase(data.cost ? [{ money: data.cost as Money }] : [], data.at as Date) };
  },
});

/* ---------- The odometer ---------- */

/** The truck's reading, plus what it has driven on the trip it is on: the reading only moves when a trip ends. */
async function odometerOf(vehicleId: unknown, reading?: number) {
  if (reading === undefined) return undefined;
  const trip = await Trip.findOne({ vehicleId, active: true, dispatchedAt: { $exists: true } }).select('tracking.km').lean<{ tracking?: { km?: number } }>();
  return Math.round(reading + (trip?.tracking?.km ?? 0));
}

/* ---------- What is due ---------- */

export type ServiceHealth = 'ok' | 'due' | 'overdue';
export interface ServiceRow {
  vehicleId: string; plate: string; planId: string; plan: string; includes?: string; health: ServiceHealth;
  odometerKm?: number; nextKm?: number; kmLeft?: number; nextDate?: string; daysLeft?: number; nextHours?: number; hoursLeft?: number;
  lastServiceAt?: string; openWorkOrder?: { id: string; number: string };
  /** What makes it due, in words: "1,200 km over". */
  reason?: string;
  cycle: string; stateId: string;
}

const DAY = 86_400_000;
const n = (value: number) => Fmt.number(value, { max: 2 });

/** Why it is due, in words: the limit already passed, else the one close enough to count, else the first there is. */
function reasonFor(limits: Array<{ left?: number; soon: number; unit: string }>) {
  const known = limits.filter((l): l is { left: number; soon: number; unit: string } => l.left !== undefined);
  const limit = known.find((l) => l.left < 0) ?? known.find((l) => l.left <= l.soon) ?? known[0];
  if (!limit) return undefined;
  return limit.left < 0 ? `${n(-limit.left)} ${limit.unit} over` : `${n(limit.left)} ${limit.unit} left`;
}

/** Every plan on every truck it applies to, overdue first. */
export async function serviceStatus(now = new Date()): Promise<ServiceRow[]> {
  const settings = await maintenanceSettings();
  const [plans, vehicles] = await Promise.all([
    ServicePlan.find({ status: 'active' }).lean() as Promise<Plain[]>,
    Vehicle.find({ status: 'active', operationalStatus: { $ne: 'sold' } }).select('registrationNumber vehicleTypeId odometerKm engineHours').lean() as Promise<Plain[]>,
  ]);
  const pairs = plans.flatMap((plan) => vehicles
    .filter((v) => (plan.vehicleId ? String(plan.vehicleId) === String(v._id) : String(plan.vehicleTypeId) === String(v.vehicleTypeId)))
    .map((vehicle) => ({ plan, vehicle })));
  if (!pairs.length) return [];

  const planIds = plans.map((p) => p._id);
  const [orders, trips, states] = await Promise.all([
    WorkOrder.find({ servicePlanId: { $in: planIds }, status: 'active' }).sort({ endedAt: -1 }).select('number vehicleId servicePlanId stage endedAt odometerKm engineHours').lean() as Promise<Plain[]>,
    Trip.find({ active: true, dispatchedAt: { $exists: true } }).select('vehicleId tracking.km').lean() as Promise<Plain[]>,
    ServiceState.find({ planId: { $in: planIds } }).lean() as Promise<Plain[]>,
  ]);
  const key = (vehicleId: unknown, planId: unknown) => `${vehicleId}:${planId}`;
  const stateOf = new Map(states.map((s) => [key(s.vehicleId, s.planId), s]));
  const lastDone = new Map<string, Plain>();
  const open = new Map<string, Plain>();
  for (const o of orders) {
    const k = key(o.vehicleId, o.servicePlanId);
    if (o.stage !== 'done') open.set(k, o);
    else if (!lastDone.has(k)) lastDone.set(k, o);
  }
  const onRoad = new Map(trips.map((t) => [String(t.vehicleId), Number((t.tracking as Plain | undefined)?.km ?? 0)]));

  const rows: ServiceRow[] = [];
  for (const { plan, vehicle } of pairs) {
    const k = key(vehicle._id, plan._id);
    const reading = vehicle.odometerKm === undefined ? undefined : Math.round(Number(vehicle.odometerKm) + (onRoad.get(String(vehicle._id)) ?? 0));
    const hours = vehicle.engineHours as number | undefined;
    // Before a truck's first service, a plan counts from when it first applied to the truck.
    let state = stateOf.get(k);
    if (!state) {
      state = await ServiceState.findOneAndUpdate(
        { vehicleId: vehicle._id, planId: plan._id },
        { $setOnInsert: { baseKm: reading, baseHours: hours, baseAt: now } },
        { upsert: true, returnDocument: 'after' },
      ).lean() as unknown as Plain;
    } else if ((state.baseKm === undefined && reading !== undefined) || (state.baseHours === undefined && hours !== undefined)) {
      // The truck got its first reading after the plan started.
      const set = { ...(state.baseKm === undefined && reading !== undefined ? { baseKm: reading } : {}), ...(state.baseHours === undefined && hours !== undefined ? { baseHours: hours } : {}) };
      await ServiceState.updateOne({ _id: state._id }, { $set: set });
      state = { ...state, ...set };
    }
    const last = lastDone.get(k);
    const fromKm = (last?.odometerKm ?? state.baseKm) as number | undefined;
    const fromHours = (last?.engineHours ?? state.baseHours) as number | undefined;
    const fromDate = (last?.endedAt ?? state.baseAt) as Date;

    const nextKm = plan.everyKm && fromKm !== undefined ? fromKm + Number(plan.everyKm) : undefined;
    const nextHours = plan.everyEngineHours && fromHours !== undefined ? fromHours + Number(plan.everyEngineHours) : undefined;
    const next = plan.everyDays ? new Date(new Date(fromDate).getTime() + Number(plan.everyDays) * DAY) : undefined;
    const kmLeft = nextKm !== undefined && reading !== undefined ? nextKm - reading : undefined;
    const hoursLeft = nextHours !== undefined && hours !== undefined ? nextHours - hours : undefined;
    const daysLeft = next ? Math.ceil((next.getTime() - now.getTime()) / DAY) : undefined;
    const over = [kmLeft, hoursLeft, daysLeft].some((left) => left !== undefined && left < 0);
    const soon = (kmLeft !== undefined && kmLeft <= settings.dueSoonKm) || (daysLeft !== undefined && daysLeft <= settings.dueSoonDays) || (hoursLeft !== undefined && hoursLeft <= settings.dueSoonHours);
    const health: ServiceHealth = over ? 'overdue' : soon ? 'due' : 'ok';
    const order = open.get(k);
    rows.push({
      vehicleId: String(vehicle._id), plate: String(vehicle.registrationNumber), planId: String(plan._id), plan: String(plan.name), includes: plan.includes as string | undefined,
      health, odometerKm: reading, nextKm, kmLeft, nextDate: next?.toISOString(), daysLeft, nextHours, hoursLeft,
      lastServiceAt: last ? new Date(last.endedAt as Date).toISOString() : undefined,
      openWorkOrder: order ? { id: String(order._id), number: String(order.number) } : undefined,
      reason: reasonFor([{ left: kmLeft, soon: settings.dueSoonKm, unit: 'km' }, { left: daysLeft, soon: settings.dueSoonDays, unit: 'days' }, { left: hoursLeft, soon: settings.dueSoonHours, unit: 'engine hours' }]),
      cycle: last ? String(last._id) : 'first', stateId: String(state._id),
    });
  }
  const rank: Record<ServiceHealth, number> = { overdue: 0, due: 1, ok: 2 };
  return rows.sort((a, b) => rank[a.health] - rank[b.health] || a.plate.localeCompare(b.plate));
}

/**
 * Fires "Service due" through the notification rules: once when a service comes due and once more if it goes
 * overdue, per service cycle, and not while a work order is already open for it. Several runs can't send it twice.
 */
export async function remindDueServices(now = new Date()): Promise<number> {
  if (!(await isAreaOn('maintenance'))) return 0;
  let sent = 0;
  for (const row of await serviceStatus(now)) {
    if (row.health === 'ok' || row.openWorkOrder) continue;
    const field = row.health === 'overdue' ? 'remindedOverdueFor' : 'remindedDueFor';
    const taken = await ServiceState.findOneAndUpdate({ _id: row.stateId, [field]: { $ne: row.cycle } }, { $set: { [field]: row.cycle } }).lean();
    if (!taken) continue;
    const title = `${row.plan} ${row.health === 'overdue' ? 'overdue' : 'due'} · ${row.plate}`;
    await post(queue('work-orders'), now, { title, text: row.reason ?? '', refId: `service-${row.stateId}-${row.cycle}` });
    await notify({ event: 'service.due', variables: { 'vehicle.registration': row.plate, 'document.name': row.plan, reason: row.reason }, ref: { kind: 'vehicles', id: row.vehicleId } });
    sent += 1;
  }
  return sent;
}

let worker: NodeJS.Timeout | undefined;
/** Checks for due services every `intervalMs` in this process. Safe on several instances: each reminder is taken once. */
export function startMaintenanceWorker(intervalMs = 15 * 60_000) {
  if (worker) return;
  worker = setInterval(() => { remindDueServices().catch((err) => logger.error({ err }, 'Maintenance worker failed')); }, intervalMs);
  worker.unref();
}
export function stopMaintenanceWorker() { if (worker) clearInterval(worker); worker = undefined; }

/* ---------- Trucks that can't be given a trip ---------- */

/** Trucks stopped by a work order that is not done, for the screens. */
export async function heldTrucks() {
  const orders = await WorkOrder.find({ status: 'active', stopsTruck: true, stage: { $ne: 'done' } }).select('number vehicleId stage').lean() as Plain[];
  return orders.map((o) => ({ vehicleId: String(o.vehicleId), workOrderId: String(o._id), number: String(o.number), stage: String(o.stage) }));
}

/* ---------- Cost per truck ---------- */

/** What each truck cost to keep on the road in a period, and per km driven. Amounts are in the base currency's minor units. */
export async function costs(query: S.CostsQuery) {
  const to = new Date(query.to);
  // A date with no time means the whole day.
  if (to.getUTCHours() === 0 && to.getUTCMinutes() === 0) to.setUTCHours(23, 59, 59, 999);
  const range = { $gte: query.from, $lte: to };
  const [orders, tyres, trips, vehicles, base] = await Promise.all([
    WorkOrder.find({ status: 'active', stage: 'done', endedAt: range }).select('vehicleId costBaseMinor').lean() as Promise<Plain[]>,
    TyreRecord.find({ status: 'active', at: range }).select('vehicleId costBaseMinor').lean() as Promise<Plain[]>,
    Trip.find({ endedAt: range }).select('vehicleId tracking.km').lean() as Promise<Plain[]>,
    Vehicle.find({ status: 'active' }).select('registrationNumber').lean() as Promise<Plain[]>,
    baseCurrency(),
  ]);
  const rows = new Map(vehicles.map((v) => [String(v._id), { vehicleId: String(v._id), plate: String(v.registrationNumber), workOrders: 0, workOrderMinor: 0, tyreMinor: 0, km: 0 }]));
  for (const o of orders) { const r = rows.get(String(o.vehicleId)); if (r) { r.workOrders += 1; r.workOrderMinor += Number(o.costBaseMinor ?? 0); } }
  for (const t of tyres) { const r = rows.get(String(t.vehicleId)); if (r) r.tyreMinor += Number(t.costBaseMinor ?? 0); }
  for (const t of trips) { const r = rows.get(String(t.vehicleId)); if (r) r.km += Number((t.tracking as Plain | undefined)?.km ?? 0); }
  const data = [...rows.values()]
    .map((r) => { const costMinor = r.workOrderMinor + r.tyreMinor; return { ...r, km: Math.round(r.km), costMinor, perKmMinor: r.km > 0 ? Math.round(costMinor / r.km) : null }; })
    .filter((r) => r.costMinor > 0 || r.km > 0)
    .sort((a, b) => b.costMinor - a.costMinor || a.plate.localeCompare(b.plate));
  return { currency: base.code, minorUnits: base.minorUnits, rows: data };
}

/* ---------- A defect the driver reports ---------- */

/** Opens a work order on the driver's truck, and tells the office. Whether it stops the truck is the company's default. */
export async function reportDefect(driverId: string, input: S.DefectInput, ctx: OpsContext) {
  const trip = await Trip.findOne({ driverId, active: true }).sort({ createdAt: -1 }).select('vehicleId number').lean<{ _id: unknown; vehicleId: unknown; number: string }>();
  if (!trip) throw new ConflictError('You have no truck on a trip. Call the office about this one.');
  const driver = await Driver.findById(driverId).select('name').lean<{ name: string }>();
  const order = await MasterService.create(workOrderDefinition, { vehicleId: String(trip.vehicleId), source: 'defect', description: input.note, reportedByDriverId: new Types.ObjectId(driverId) }, { actorId: ctx.actorId, canSeeSensitive: false });
  const truck = await Vehicle.findById(trip.vehicleId).select('registrationNumber').lean<{ registrationNumber: string }>();
  const at = new Date();
  await post(queue('work-orders'), at, {
    title: `Defect on ${truck?.registrationNumber} · ${order.number}`, text: `${driver?.name}: ${input.note}`,
    buttons: [{ label: 'Open the work order', nav: { view: 'maintenance' } }],
  }, ctx);
  await log(ctx, at, `${driver?.name} reported a defect on ${truck?.registrationNumber} (${order.number})`, { tripId: trip._id });
  return order;
}
