import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { Product } from '../cargo/models/product.model.js';
import { Trailer } from '../fleet/models/trailer.model.js';
import { Party } from '../parties/models/party.model.js';
import { CancellationReason } from '../trips/models/policies.model.js';
import { cumulativeKm } from './calc.js';
import { Consignment } from './models/cargo.model.js';
import { Trip } from './models/trip.model.js';
import { announce } from './notices.js';
import type * as S from './operations.schema.js';
import { operationsSettings } from './settings.js';
import {
  activeDriver, activeRecord, baseCurrency, conflict, driverThread, formatMoney, log, need, post, present, queue, refuse, resolve, save, toBase, type OpsContext,
} from './support.js';
import { assertFree, buildStops, closeEarly, createTrip, placeName, presentTrip, truckFacts } from './trips.service.js';

/**
 * A loaded trip that can't deliver (#64): an accident, or cargo that is refused. What may happen to the load,
 * who carries a write-off and who decides are the company's settings: Company → Trips.
 */

const OWNER_ROLES = ['owner', 'admin'];

async function loadedTrip(id: string) {
  const trip = await Trip.findById(id);
  if (!trip) throw new NotFoundError('Trip not found');
  if (!trip.get('active')) throw conflict('This trip is closed.');
  const consignment = await Consignment.findOne({ tripId: trip._id, inTransit: true });
  if (!consignment) throw conflict('Nothing is on this truck: stop the trip or end it instead.');
  if (consignment.get('writeOff')?.status === 'pending') throw conflict('A write-off of this load is waiting for the owner.');
  return { trip, consignment };
}

const reasonText = (name: unknown, note?: string) => [String(name), note].filter(Boolean).join(': ');

/** What happens to the load: return it, move it to another truck, or write it off. */
export async function handleUndelivered(id: string, input: S.UndeliveredInput, ctx: OpsContext) {
  need(ctx, 'trips', 'update');
  const settings = await operationsSettings();
  if (!ctx.roles.some((r) => [...OWNER_ROLES, ...settings.loadedTripRoles].includes(r))) throw new ForbiddenError("Your role doesn't decide what happens to a loaded trip. The company sets who does in Company → Trips.");
  const outcomes: string[] = settings.loadedTripOutcomes;
  if (!outcomes.includes(input.outcome)) throw refuse({ return: 'This company does not return loads to the consignor.', transfer: 'This company does not move loads to another truck.', write_off: 'This company does not write loads off.' }[input.outcome]);
  const { trip, consignment } = await loadedTrip(id);
  const reason = await activeRecord(CancellationReason, input.reasonId, 'reason');
  if (!(reason.appliesTo as string[] | undefined)?.includes('trip')) throw refuse(`"${reason.name}" isn't a reason for a trip.`);
  const why = reasonText(reason.name, input.note);
  if (input.outcome === 'return') return returnLoad(trip, consignment, input, reason, why, ctx);
  if (input.outcome === 'transfer') return transferLoad(trip, consignment, input, reason, why, ctx);
  return writeOffLoad(trip, consignment, input, reason, why, ctx);
}

type Doc = Awaited<ReturnType<typeof loadedTrip>>['trip'];

/* ---------- Return it ---------- */

/** The plan changes: the trip now ends with a return leg, delivered and closed the usual way. */
async function returnLoad(trip: Doc, consignment: Doc, input: S.UndeliveredInput & { outcome: 'return' }, reason: Plain, why: string, ctx: OpsContext) {
  const at = new Date();
  const stops = (trip.toObject() as Plain).stops as Array<Plain & { placeId: unknown; kind: string; legKm: number; arrivedAt?: Date }>;
  const last = stops.reduce((found, s, i) => (s.arrivedAt ? i : found), 0);
  // Refused where it was going: the stops it reached stay in the record, but the trip no longer offloads or ends there.
  const kept = stops.slice(0, last + 1).map((s) => (s.kind === 'offload' || s.kind === 'end' ? { ...s, kind: 'via' } : s));
  const place = String(input.returnPlaceId ?? stops.find((s) => s.kind === 'load')!.placeId);
  const built = await buildStops([...kept.map((s) => ({ placeId: String(s.placeId), kind: s.kind as never })), { placeId: place, kind: 'offload' as never }, { placeId: place, kind: 'end' as never }]);
  const legs = built.slice(kept.length);
  // Past the last stop it reached, the truck first drives back over what it covered.
  const past = Math.max(0, Number(trip.get('tracking')?.km ?? 0) - cumulativeKm(stops)[last]!);
  legs[0]!.legKm += Math.round(past * 2);
  trip.set({ stops: [...kept, ...legs], undelivered: { outcome: 'return', reasonId: reason._id, reason: why, at, by: ctx.actorId }, updatedBy: ctx.actorId });
  trip.markModified('stops');
  await save(trip);
  consignment.set({ returned: { at, by: ctx.actorId, reason: why, placeId: place }, updatedBy: ctx.actorId });
  await save(consignment);
  const name = await placeName(place);
  const plain = trip.toObject() as Plain;
  if (plain.driverId) await post(driverThread(plain.driverId), at, { title: `Take the load back · ${plain.number}`, text: `${why}. Return the load to ${name}.` }, ctx);
  await log(ctx, at, `Load ${consignment.get('number')} going back to ${name}: ${why}`, { tripId: trip._id });
  await announce('trip.load_returned', plain, ctx, { variables: { reason: why, 'place.name': name } });
  return presentTrip(plain);
}

/* ---------- Move it to another truck ---------- */

async function transferLoad(trip: Doc, consignment: Doc, input: S.UndeliveredInput & { outcome: 'transfer' }, reason: Plain, why: string, ctx: OpsContext) {
  need(ctx, 'trips', 'create');
  const at = new Date();
  const old = trip.toObject() as Plain;
  const stops = old.stops as Array<{ placeId: unknown; kind: string; arrivedAt?: Date }>;
  if (String(input.vehicleId) === String(old.vehicleId)) throw refuse('Choose another truck. To change the driver only, ask the driver to hand over and carry on.');
  const remaining = stops.filter((s) => !s.arrivedAt && s.kind !== 'start');
  if (!remaining.some((s) => s.kind === 'offload')) throw refuse('This load has already reached its offloading point. Return it or write it off.');
  const here = String(input.placeId ?? [...stops].reverse().find((s) => s.arrivedAt)?.placeId ?? stops[0]!.placeId);

  // Everything that could refuse comes first, so the old trip isn't closed for nothing.
  const truck = await truckFacts(input.vehicleId);
  await assertFree('vehicleId', input.vehicleId, truck.plate, trip._id);
  const driverId = input.driverId ?? (old.driverId ? String(old.driverId) : undefined);
  if (!driverId) throw refuse('Choose the driver.');
  const driver = await activeDriver(driverId);
  await assertFree('driverId', driverId, String(driver.name), trip._id);
  if (input.trailerId) {
    const trailer = await activeRecord(Trailer, input.trailerId, 'trailer');
    await assertFree('trailerId', input.trailerId, String(trailer.registrationNumber), trip._id);
  }
  const plan = [{ placeId: truck.placeId ?? here, kind: 'start' }, { placeId: here, kind: 'load' }, ...remaining.map((s) => ({ placeId: String(s.placeId), kind: s.kind }))] as NonNullable<S.CreateTripInput['stops']>;
  await buildStops(plan);

  trip.set({ undelivered: { outcome: 'transfer', reasonId: reason._id, reason: why, at, by: ctx.actorId } });
  await closeEarly(trip, { reason: why, placeId: here, closingFuelL: input.closingFuelL, requestNote: 'The load moved to another truck' }, at, ctx);
  let created: Plain;
  try {
    created = await createTrip({
      customerId: String(old.customerId), vehicleId: input.vehicleId, driverId, trailerId: input.trailerId, productId: old.productId ? String(old.productId) : undefined,
      plannedQty: old.plannedQty as number | undefined, plannedStart: at, stops: plan,
    } as S.CreateTripInput, ctx, { nominationId: old.nominationId, transferredFromTripId: trip._id });
  } catch (err) {
    // The checks above passed, so something changed in between: the load stays on the old trip.
    trip.set({ active: true, endedAt: undefined, stopReason: undefined, closingFuelL: undefined, undelivered: undefined });
    await save(trip);
    throw err;
  }
  consignment.set({ tripId: created.id, transfers: [...((consignment.toObject() as Plain).transfers as Plain[] ?? []), { fromTripId: trip._id, toTripId: created.id, at, by: ctx.actorId, reason: why }], updatedBy: ctx.actorId });
  await save(consignment);
  trip.set('transferredToTripId', created.id);
  await save(trip);

  const name = await placeName(here);
  if (old.driverId) await post(driverThread(old.driverId), at, { title: `${old.number} closed`, text: `${why}. The load moves to ${truck.plate} at ${name}.` }, ctx);
  await post(queue('trips'), at, { title: `Load moved to ${truck.plate}`, text: `${old.number} closed: ${why}. ${created.number} carries ${consignment.get('number')} from ${name}.`, buttons: [{ label: 'Open trip', nav: { tripId: String(created.id) } }] }, ctx);
  await log(ctx, at, `Load ${consignment.get('number')} moved to ${created.number} (${truck.plate}) at ${name}: ${why}`, { tripId: trip._id });
  await log(ctx, at, `Carries ${consignment.get('number')} from ${old.number}`, { tripId: created.id });
  await announce('trip.load_transferred', created, ctx, { variables: { reason: why, 'place.name': name } });
  return created;
}

/* ---------- Write it off ---------- */

async function writeOffLoad(trip: Doc, consignment: Doc, input: S.UndeliveredInput & { outcome: 'write_off' }, reason: Plain, why: string, ctx: OpsContext) {
  const at = new Date();
  const settings = await operationsSettings();
  const carrier = input.carrier ?? settings.writeOffDefaultCarrier;
  const carriers: string[] = settings.writeOffCarriers;
  if (!carriers.includes(carrier)) throw refuse({ driver: 'This company does not charge write-offs to the driver.', company: 'This company does not carry write-offs itself.', insurance: 'This company does not claim write-offs from an insurer.' }[carrier as 'driver']);
  if (carrier === 'driver' && !trip.get('driverId')) throw refuse('This trip has no driver to charge.');
  if (carrier === 'insurance') {
    if (!input.insurerPartyId) throw refuse('Choose the insurer.');
    const insurer = await activeRecord(Party, input.insurerPartyId, 'insurer');
    if (!(insurer.roles as string[]).includes('insurer')) throw refuse(`${insurer.name} is not an insurer.`);
  }
  // The value given; otherwise what the product's shortage price makes of the load.
  const load = consignment.get('load');
  const product = await Product.findById(consignment.get('productId')).select('shortagePricePerUnit').lean<{ shortagePricePerUnit?: { amountMinor: number; currencyId: unknown } }>();
  const price = product?.shortagePricePerUnit;
  const amount = input.amount ?? (price ? { amountMinor: Math.round(Number(load.std20L ?? load.qty) * price.amountMinor), currencyId: price.currencyId } : undefined);
  if (!amount) throw refuse('Enter what the load is worth.');
  const { baseMinor } = await toBase(amount.amountMinor, amount.currencyId, at);
  const stops = trip.get('stops') as Array<{ placeId: unknown; arrivedAt?: Date }>;
  const placeId = input.placeId ?? [...stops].reverse().find((s) => s.arrivedAt)?.placeId ?? stops[0]!.placeId;
  consignment.set({
    writeOff: {
      status: 'pending', carrier, insurerPartyId: input.insurerPartyId, claimReference: input.claimReference, amount, baseAmountMinor: baseMinor,
      reasonId: reason._id, reason: why, placeId, closingFuelL: input.closingFuelL, requestedAt: at, requestedBy: ctx.actorId, requestedByName: ctx.name,
    },
    updatedBy: ctx.actorId,
  });
  await save(consignment);
  // The owner's own write-off needs nobody's approval.
  if (!settings.writeOffNeedsOwner || ctx.roles.some((r) => OWNER_ROLES.includes(r))) return approveWriteOff(trip, consignment, at, ctx);
  const money = formatMoney(baseMinor, await baseCurrency());
  const id = String(consignment._id);
  await post('role:owner', at, {
    title: `Write off ${consignment.get('number')}?`, text: `${ctx.name}: ${why}.`,
    rows: [['Trip', String(trip.get('number'))], ['Value', money], ['Who carries it', CARRIER_NAME[carrier]!]],
    buttons: [
      { label: 'Approve', tone: 'primary', action: { type: 'writeoff.decide', consignmentId: id, approve: true, via: 'whatsapp' } },
      { label: 'Reject', tone: 'danger', action: { type: 'writeoff.decide', consignmentId: id, approve: false, note: 'Rejected on WhatsApp', via: 'whatsapp' } },
    ],
    refId: `${id}-writeoff`,
  }, ctx);
  await log(ctx, at, `Asked the owner to write off ${consignment.get('number')} (${money}): ${why}`, { tripId: trip._id });
  return present(consignment.toObject());
}

const CARRIER_NAME: Record<string, string> = { driver: 'The driver', company: 'The company', insurance: 'An insurance claim' };

/** The loss is recorded, the charge falls where it was decided, and the trip closes where the truck is. */
async function approveWriteOff(trip: Doc, consignment: Doc, at: Date, ctx: OpsContext) {
  const w = (consignment.toObject() as Plain).writeOff as Plain;
  consignment.set({ inTransit: false, 'writeOff.status': 'approved', 'writeOff.decidedAt': at, 'writeOff.decidedBy': ctx.actorId, updatedBy: ctx.actorId });
  await save(consignment);
  trip.set({ undelivered: { outcome: 'write_off', reasonId: w.reasonId, reason: w.reason, at, by: ctx.actorId } });
  await closeEarly(trip, { reason: String(w.reason), placeId: w.placeId, closingFuelL: Number(w.closingFuelL), requestNote: 'The load was written off' }, at, ctx);
  const money = formatMoney(Number(w.baseAmountMinor), await baseCurrency());
  const plain = trip.toObject() as Plain;
  if (plain.driverId) {
    await post(driverThread(plain.driverId), at, {
      title: `${plain.number} closed`,
      text: w.carrier === 'driver' ? `The load was written off: ${w.reason}. ${money} goes on your account.` : `The load was written off: ${w.reason}.`,
    }, ctx);
  }
  await log(ctx, at, `Wrote off ${consignment.get('number')} (${money}), carried by ${String(CARRIER_NAME[String(w.carrier)]).toLowerCase()}: ${w.reason}`, { tripId: trip._id });
  await announce('trip.load_written_off', plain, ctx, { variables: { reason: String(w.reason) } });
  return present(consignment.toObject());
}

/** The owner approves or rejects a write-off someone else asked for. Rejected, the trip stays open and the office chooses again. */
export async function decideWriteOff(id: string, input: S.WriteOffDecisionInput, ctx: OpsContext) {
  if (!ctx.roles.some((r) => OWNER_ROLES.includes(r))) throw new ForbiddenError('Only the owner decides a write-off.');
  const consignment = await Consignment.findById(id);
  if (!consignment) throw new NotFoundError('Consignment not found');
  if (consignment.get('writeOff')?.status !== 'pending') throw conflict('Nothing to decide here.');
  const trip = await Trip.findById(consignment.get('tripId'));
  if (!trip) throw new NotFoundError('Trip not found');
  const at = new Date();
  await resolve(`${id}-writeoff`, input.approve ? 'Written off' : 'Not written off');
  if (input.approve) return approveWriteOff(trip, consignment, at, ctx);
  if (!input.note) throw refuse('Give a reason.');
  consignment.set({ 'writeOff.status': 'rejected', 'writeOff.decidedAt': at, 'writeOff.decidedBy': ctx.actorId, 'writeOff.note': input.note, updatedBy: ctx.actorId });
  await save(consignment);
  await post(queue('trips'), at, { title: `${consignment.get('number')} not written off`, text: `${ctx.name}: ${input.note}`, buttons: [{ label: 'Open trip', nav: { tripId: String(trip._id) } }] }, ctx);
  await log(ctx, at, `Did not write off ${consignment.get('number')}: ${input.note}`, { tripId: trip._id });
  return present(consignment.toObject());
}
