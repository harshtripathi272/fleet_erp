import { customValues } from './placements.js';
import { env } from '../../config/env.js';
import * as Fmt from '../../core/format/regional.js';
import { logger } from '../../core/logger/index.js';
import type { Plain } from '../../core/masters/types.js';
import { type DispatchInput, notify } from '../messaging/dispatcher.js';
import { currencyInfo, type OpsContext } from './support.js';
import { plateOf, routeLabel, trailerPlate } from './trips.service.js';

/**
 * The messages a step sends on the company's chosen channels (e-mail, SMS, WhatsApp), through the
 * dispatcher: which templates go to whom is the company's notification rules. Called once a step has
 * succeeded; a message that can't go never undoes the step, and the outbox keeps it with its error.
 */

type Event = DispatchInput['event'];
type Values = NonNullable<DispatchInput['variables']>;

export interface Notice {
  variables?: Values;
  /** Defaults to the trip's driver and customer. */
  driverId?: unknown;
  partyId?: unknown;
  ref?: { kind: string; id: unknown };
  attachments?: DispatchInput['attachments'];
}

/** {{amount}} and {{currency}} for a money amount, written as the templates expect: "TZS" and "1,250.50" (in the company's number format). */
export async function moneyValues(amount: { amountMinor: number; currencyId: unknown } | undefined): Promise<Record<string, string>> {
  if (!amount?.currencyId) return {};
  const currency = await currencyInfo(amount.currencyId).catch(() => null);
  if (!currency) return {};
  return { amount: Fmt.amount(amount.amountMinor, currency.minorUnits), currency: currency.code };
}

/** The values every trip message may use. */
export async function tripValues(trip: Plain | null | undefined): Promise<Values> {
  if (!trip) return {};
  const stops = (trip.stops ?? []) as Array<{ kind: string; placeId: unknown }>;
  return {
    ...customValues('trip', trip.custom),
    'trip.number': String(trip.number ?? ''),
    'vehicle.registration': await plateOf(trip.vehicleId),
    'trailer.registration': await trailerPlate(trip.trailerId),
    'route.name': stops.length ? await routeLabel({ stops }) : '',
  };
}

/** Sends the event's messages for a step on a trip (or with no trip, e.g. a nomination). Never throws. */
export async function announce(event: Event, trip: Plain | null | undefined, ctx: OpsContext, notice: Notice = {}): Promise<void> {
  try {
    const driverId = notice.driverId ?? trip?.driverId;
    const partyId = notice.partyId ?? trip?.customerId;
    const ref = notice.ref ?? (trip ? { kind: 'trips', id: trip._id ?? trip.id } : undefined);
    await notify({
      event,
      variables: { link: env.APP_URL, ...(await tripValues(trip)), ...notice.variables },
      driverId: driverId ? String(driverId) : undefined,
      partyId: partyId ? String(partyId) : undefined,
      ref: ref ? { kind: ref.kind, id: String(ref.id) } : undefined,
      attachments: notice.attachments,
      actorId: ctx.actorId,
    });
  } catch (err) {
    logger.error({ err, event }, 'The messages for a step could not be prepared');
  }
}
