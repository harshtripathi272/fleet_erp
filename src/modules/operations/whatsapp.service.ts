import { decideWriteOff } from './undelivered.service.js';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { ForbiddenError, ServiceUnavailableError, ValidationError } from '../../core/errors/index.js';
import { logger } from '../../core/logger/index.js';
import type { Plain } from '../../core/masters/types.js';
import { permissionChecker } from '../../middleware/authorize.js';
import { Driver } from '../drivers/models/driver.model.js';
import { Currency } from '../finance/models/currency.model.js';
import { Role } from '../roles/role.model.js';
import { User } from '../users/user.model.js';
import { redeem } from './actionTokens.js';
import { decideShortage, markDone, recordDelivery, recordLoading, returnDocument, sendDocument } from './cargo.service.js';
import { decideExpense, recordExpense } from './expenses.service.js';
import { decideRequest, issueRequest } from './funding.service.js';
import { Trip } from './models/trip.model.js';
import * as Schemas from './operations.schema.js';
import { deskOf, refuse, type OpsContext } from './support.js';
import { dispatchTrip, driverTripNow } from './trips.service.js';
import type * as S from './operations.schema.js';

/** The driver's open trip, which a WhatsApp message without a trip is filed against. */
async function openTripOf(driverId: unknown) {
  const trip = await driverTripNow(driverId);
  return trip ? String(trip._id) : undefined;
}

/** Staff act as a driver's WhatsApp from the app: the simulated phone. */
export async function simulate(input: S.SimulateInput, ctx: OpsContext) {
  if (!env.DRIVER_PHONE_SIMULATOR) throw new ForbiddenError('The simulated driver phone is switched off');
  const tripId = input.tripId ?? (await openTripOf(input.driverId));
  return sendDocument({ driverId: input.driverId, tripId, kind: input.kind ?? 'other', note: input.text, file: input.file, reading: input.reading, channel: 'whatsapp' }, { ...ctx, asDriver: true, simulated: true });
}

/** A system context for a driver's own WhatsApp message: it may only file the driver's documents. */
const driverContext = (name: string): OpsContext => ({ name, desk: 'driver', asDriver: true, roles: [], can: (resource, action) => resource === 'driver-documents' && action === 'create' });

async function staffContext(userId: unknown): Promise<OpsContext | null> {
  const user = await User.findById(userId).select('name status roleIds').lean();
  if (!user || user.status !== 'active') return null;
  const roles = await Role.find({ _id: { $in: user.roleIds ?? [] }, status: 'active' }).select('key permissions').lean();
  const permissions = roles.flatMap((r) => (r.permissions ?? []).map((p) => ({ resource: p.resource, actions: [...p.actions] })));
  return { actorId: String(user._id), name: user.name, desk: deskOf(roles.map((r) => r.key)), can: permissionChecker(permissions), roles: roles.map((r) => String(r.key)) };
}

const phoneVariants = (phone: string) => [phone, phone.replace(/^\+/, ''), `+${phone.replace(/^\+/, '')}`];

/** Compares secrets in constant time (hashing first so different lengths compare safely). */
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/**
 * A message from Marichi Talks. From a driver: filed as a document on the open trip. A tapped button:
 * its one-time token runs the command it was sent with, as the person it was sent to.
 * The body format is provisional until the Marichi Talks webhook format is known.
 */
export async function inbound(secret: string | undefined, body: S.InboundInput) {
  if (!env.MARICHI_TALKS_WEBHOOK_SECRET) throw new ServiceUnavailableError('The WhatsApp webhook is not configured');
  if (!sameSecret(secret ?? '', env.MARICHI_TALKS_WEBHOOK_SECRET)) throw new ForbiddenError('Wrong webhook secret');
  const phones = phoneVariants(body.from);
  const driver = await Driver.findOne({ status: 'active', $or: [{ whatsapp: { $in: phones } }, { phone: { $in: phones } }] }).select('_id name').lean();
  if (driver) {
    if (body.buttonToken) throw refuse('Drivers answer with a photo or a message.');
    const tripId = await openTripOf(driver._id);
    const doc = await sendDocument({ driverId: String(driver._id), tripId, kind: body.kind ?? 'other', note: body.text, file: body.media, channel: 'whatsapp' }, driverContext(String(driver.name)));
    return { handled: 'driver-document', id: doc.id };
  }
  if (body.buttonToken) {
    // Only a button the server sent to this number, unused and unexpired, runs, as the person it was sent to.
    const offered = await redeem(body.buttonToken, phones);
    const ctx = offered ? await staffContext(offered.userId) : null;
    if (!offered || !ctx) throw new ForbiddenError('This button is not valid for this number, or was already used');
    return { handled: 'command', result: await executeCommand(offered.command, ctx) };
  }
  logger.warn({ from: body.from }, 'WhatsApp message from an unknown number ignored');
  return { handled: 'ignored' };
}

const minorOf = async (amount: number, code: string) => {
  const currency = await Currency.findOne({ code: code.toUpperCase(), status: 'active' }).lean();
  if (!currency) throw refuse(`Unknown currency ${code}.`);
  return { amountMinor: Math.round(amount * 10 ** Number(currency.minorUnits ?? 2)), currencyId: String(currency._id) };
};

/** Runs a message button's command, e.g. an owner approving a request on WhatsApp. */
export async function executeCommand(command: Plain, ctx: OpsContext): Promise<unknown> {
  const via = { via: 'whatsapp' as const };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new ValidationError('This button no longer matches the record', z.flattenError(result.error));
    return result.data;
  };
  switch (command.type) {
    case 'request.decide': return decideRequest(String(command.id), parse(Schemas.decideSchema, { approve: command.approve, note: command.note || undefined, ...via }), ctx);
    case 'request.issue': return issueRequest(String(command.id), parse(Schemas.issueSchema, { paymentMethodId: command.paymentMethodId, reference: command.reference, station: command.station, ...via }), ctx);
    case 'expense.decide': return decideExpense(String(command.id), parse(Schemas.expenseDecisionSchema, { approve: command.approve, reason: command.reason || undefined, ...via }), ctx);
    case 'expense.record': {
      const amount = await minorOf(Number(command.amount), String(command.currency ?? ''));
      return recordExpense(parse(Schemas.expenseSchema, { driverId: command.driverId, tripId: command.tripId, categoryId: command.categoryId, amount, receiptNo: command.receiptNo, docId: command.docId }), ctx);
    }
    case 'shortage.decide': return decideShortage(String(command.consignmentId), parse(Schemas.shortageDecisionSchema, { charge: command.charge, note: command.note || undefined, ...via }), ctx);
    case 'writeoff.decide': return decideWriteOff(String(command.consignmentId), parse(Schemas.writeOffDecisionSchema, { approve: command.approve, note: command.note || undefined, ...via }), ctx);
    case 'doc.done': return markDone(String(command.docId), ctx);
    case 'doc.return': return returnDocument(String(command.docId), parse(Schemas.reasonSchema, { reason: command.reason }), ctx);
    case 'load.record': {
      const { type: _type, ...rest } = command;
      return recordLoading(parse(Schemas.loadingSchema, rest), ctx);
    }
    case 'delivery.record': {
      const { type: _type, consignmentId, ...rest } = command;
      return recordDelivery(String(consignmentId), parse(Schemas.deliverySchema, rest), ctx);
    }
    case 'trip.dispatch': return dispatchTrip(String(command.tripId), ctx);
    default: throw refuse('This button cannot be answered on WhatsApp.');
  }
}
