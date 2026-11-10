import { z } from 'zod';
import { Company } from '../company/company.model.js';

/*
 * The company's fleet policy (#136): the truck statuses, in order, each a rule made of whitelisted
 * predicates, and the thresholds they use. Everything here is configuration with defaults; renaming,
 * reordering, switching off or adding a status changes what trucks show, with no code change.
 */

/** Where a distance or "inside" is measured to. `place:<code>` is one place by its code. */
const target = z.union([z.enum(['base', 'loadPlaces', 'offloadPlaces', 'baseOrLoadPlaces', 'nextStop', 'nextOffload']), z.string().regex(/^place:[A-Za-z0-9_\-/.]{1,40}$/, 'place: and a place code')]);
export type Target = z.infer<typeof target>;

export const THRESHOLD_DEFAULTS = {
  /** A free truck this close to its base or a loading place is "near origin". */
  nearOriginKm: 50,
  /** A loaded truck this close to its next offloading place is "near destination". */
  nearDestinationKm: 100,
  /** A position older than this is stale: rules that need one can't use it. */
  staleAfterMinutes: 15,
  /** A free truck whose last trip ended away from base this recently is still "returning". */
  returnWindowHours: 48,
  /** At a stop means inside its place's geofence too, not only arrived by the driver or the office. */
  atPlaceMeansInsideGeofence: true,
  /** With no fresh position, where the trips last left the truck stands in for it, so a company without trackers still sees free trucks. */
  useLastKnownPlace: true,
  /** Heading within this many degrees of a place counts as heading toward it. */
  headingToleranceDeg: 60,
  /** How long every position is kept, and how long an event id is remembered so a repeat changes nothing. */
  historyDays: 14,
  dedupeDays: 7,
  /** How often a tracker service that is asked (Traccar) is asked for positions. */
  pollSeconds: 60,
};
export type Thresholds = typeof THRESHOLD_DEFAULTS;
const NUMBER_THRESHOLDS = ['nearOriginKm', 'nearDestinationKm', 'staleAfterMinutes', 'returnWindowHours', 'headingToleranceDeg'] as const;
/** A number in a rule, or the name of a threshold, so one change to a threshold reaches every rule that uses it. */
const amount = z.union([z.number().min(0).max(100_000), z.enum(NUMBER_THRESHOLDS)]);

export type Predicate =
  | { p: 'noActiveTrip' } | { p: 'hasActiveTrip' }
  | { p: 'tripEventSeen'; v: string } | { p: 'tripEventNotSeen'; v: string }
  | { p: 'atStopKind'; v: { kind: string; state: 'arrived' | 'left' } }
  | { p: 'insideStopPlace'; v: string }
  | { p: 'insidePlaceType'; v: string[] }
  | { p: 'insideOf'; v: Target }
  | { p: 'withinKmOf'; v: { of: Target; km: number | string } }
  | { p: 'headingToward'; v: Target }
  | { p: 'vehicleStatusIn'; v: string[] }
  | { p: 'vehicleInactive' } | { p: 'workOrderOpen' }
  | { p: 'positionKnown' } | { p: 'positionFresh' } | { p: 'positionSimulated' } | { p: 'locationKnown' }
  | { p: 'speedAbove'; v: number } | { p: 'speedBelow'; v: number }
  | { p: 'ignition'; v: boolean }
  | { p: 'allLoadsDelivered' } | { p: 'someLoadDelivered' }
  | { p: 'lastTripEndedWithin'; v: number | string }
  | { p: 'lastTripEndedAt'; v: 'base' | 'elsewhere' }
  | { p: 'not'; v: Predicate } | { p: 'any'; v: Predicate[] } | { p: 'all'; v: Predicate[] };

const word = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'A key in lower case, e.g. loaded');
/** The closed set of predicates: nothing is evaluated that isn't listed here. */
export const predicateSchema: z.ZodType<Predicate> = z.lazy(() => z.discriminatedUnion('p', [
  z.strictObject({ p: z.literal('noActiveTrip') }), z.strictObject({ p: z.literal('hasActiveTrip') }),
  z.strictObject({ p: z.literal('tripEventSeen'), v: word }), z.strictObject({ p: z.literal('tripEventNotSeen'), v: word }),
  z.strictObject({ p: z.literal('atStopKind'), v: z.strictObject({ kind: word, state: z.enum(['arrived', 'left']) }) }),
  z.strictObject({ p: z.literal('insideStopPlace'), v: word }),
  z.strictObject({ p: z.literal('insidePlaceType'), v: z.array(word).min(1).max(20) }),
  z.strictObject({ p: z.literal('insideOf'), v: target }),
  z.strictObject({ p: z.literal('withinKmOf'), v: z.strictObject({ of: target, km: amount }) }),
  z.strictObject({ p: z.literal('headingToward'), v: target }),
  z.strictObject({ p: z.literal('vehicleStatusIn'), v: z.array(word).min(1).max(10) }),
  z.strictObject({ p: z.literal('vehicleInactive') }), z.strictObject({ p: z.literal('workOrderOpen') }),
  z.strictObject({ p: z.literal('positionKnown') }), z.strictObject({ p: z.literal('positionFresh') }), z.strictObject({ p: z.literal('positionSimulated') }), z.strictObject({ p: z.literal('locationKnown') }),
  z.strictObject({ p: z.literal('speedAbove'), v: z.number().min(0).max(300) }), z.strictObject({ p: z.literal('speedBelow'), v: z.number().min(0).max(300) }),
  z.strictObject({ p: z.literal('ignition'), v: z.boolean() }),
  z.strictObject({ p: z.literal('allLoadsDelivered') }), z.strictObject({ p: z.literal('someLoadDelivered') }),
  z.strictObject({ p: z.literal('lastTripEndedWithin'), v: z.union([z.number().min(0).max(10_000), z.literal('returnWindowHours')]) }),
  z.strictObject({ p: z.literal('lastTripEndedAt'), v: z.enum(['base', 'elsewhere']) }),
  z.strictObject({ p: z.literal('not'), v: predicateSchema }),
  z.strictObject({ p: z.literal('any'), v: z.array(predicateSchema).min(1).max(20) }),
  z.strictObject({ p: z.literal('all'), v: z.array(predicateSchema).min(1).max(20) }),
]));

/** Design tokens the screens colour a status with: never a hex value. */
export const STATUS_COLOURS = ['status-ok', 'status-info', 'status-warn', 'status-bad', 'status-mute'] as const;
export const STATUS_GROUPS = ['available', 'soon', 'on_trip', 'down', 'unknown'] as const;

export const statusSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'A key in lower case with underscores, e.g. at_border'),
  label: z.string().trim().min(1).max(60),
  colour: z.enum(STATUS_COLOURS),
  group: z.enum(STATUS_GROUPS),
  /** Counts as free for a new trip. */
  isAvailable: z.boolean(),
  /** Not free yet, but soon: listed apart in "nearest trucks". */
  availableSoon: z.boolean().optional(),
  /** What a fleet platform calls this status, when it doesn't use our key. */
  exportCode: z.string().regex(/^[A-Z0-9_]{1,40}$/, 'Capitals, digits and _, e.g. AVAIL_NEAR_ORIGIN'),
  enabled: z.boolean(),
  /** All must be true. An empty list always matches: a last, catch-all status. */
  when: z.array(predicateSchema).max(20),
});
export type StatusRule = z.infer<typeof statusSchema>;

const thresholdsSchema = z.strictObject({
  nearOriginKm: z.number().min(0).max(5000),
  nearDestinationKm: z.number().min(0).max(5000),
  staleAfterMinutes: z.number().int().min(1).max(10_080),
  returnWindowHours: z.number().min(0).max(720),
  atPlaceMeansInsideGeofence: z.boolean(),
  useLastKnownPlace: z.boolean(),
  headingToleranceDeg: z.number().min(5).max(180),
  historyDays: z.number().int().min(1).max(365),
  dedupeDays: z.number().int().min(1).max(60),
  pollSeconds: z.number().int().min(15).max(3600),
}).partial();

export const fleetPolicyInput = z.strictObject({
  statuses: z.array(statusSchema).min(1, 'Keep at least one status').max(40).optional(),
  thresholds: thresholdsSchema.optional(),
  /** Per fleet-exchange connection: our status key → the platform's own name for it. */
  vendorMaps: z.record(z.string().regex(/^[0-9a-f]{24}$/i), z.record(z.string().max(40), z.string().trim().min(1).max(60))).optional(),
}).superRefine((p, ctx) => {
  const keys = (p.statuses ?? []).map((s) => s.key);
  keys.forEach((k, i) => { if (keys.indexOf(k) !== i) ctx.addIssue({ code: 'custom', path: ['statuses', i, 'key'], message: `"${k}" is used twice` }); });
  if (p.statuses && !p.statuses.some((s) => s.enabled)) ctx.addIssue({ code: 'custom', path: ['statuses'], message: 'Keep at least one status switched on' });
});
export type FleetPolicyInput = z.infer<typeof fleetPolicyInput>;
export interface FleetPolicy { statuses: StatusRule[]; thresholds: Thresholds; vendorMaps: Record<string, Record<string, string>> }

const s = (key: string, label: string, colour: StatusRule['colour'], group: StatusRule['group'], isAvailable: boolean, exportCode: string, when: Predicate[], extra: Partial<StatusRule> = {}): StatusRule =>
  ({ key, label, colour, group, isAvailable, exportCode, enabled: true, when, ...extra });
const FREE: Predicate[] = [{ p: 'noActiveTrip' }, { p: 'vehicleStatusIn', v: ['available', 'on_trip'] }];

/** The statuses a new company starts with, first match wins (docs/design/fleet-data-exchange.md, section 3.3). */
export const DEFAULT_STATUSES: StatusRule[] = [
  s('in_maintenance', 'In maintenance', 'status-bad', 'down', false, 'MAINTENANCE', [{ p: 'any', v: [{ p: 'vehicleStatusIn', v: ['in_workshop', 'breakdown'] }, { p: 'workOrderOpen' }] }]),
  s('unavailable', 'Out of service', 'status-mute', 'down', false, 'OUT_OF_SERVICE', [{ p: 'any', v: [{ p: 'vehicleStatusIn', v: ['impounded', 'sold'] }, { p: 'vehicleInactive' }] }]),
  s('at_unloading', 'At unloading', 'status-info', 'on_trip', false, 'AT_UNLOADING', [{ p: 'hasActiveTrip' }, { p: 'any', v: [{ p: 'atStopKind', v: { kind: 'offload', state: 'arrived' } }, { p: 'insideStopPlace', v: 'offload' }] }]),
  s('at_border', 'At border', 'status-warn', 'on_trip', false, 'AT_BORDER', [{ p: 'hasActiveTrip' }, { p: 'any', v: [{ p: 'atStopKind', v: { kind: 'border', state: 'arrived' } }, { p: 'all', v: [{ p: 'insidePlaceType', v: ['border'] }, { p: 'tripEventSeen', v: 'loaded' }] }] }]),
  s('at_loading', 'At loading', 'status-info', 'on_trip', false, 'AT_LOADING', [{ p: 'hasActiveTrip' }, { p: 'any', v: [{ p: 'atStopKind', v: { kind: 'load', state: 'arrived' } }, { p: 'insideStopPlace', v: 'load' }] }]),
  s('loaded_near_destination', 'Loaded, near destination', 'status-info', 'soon', false, 'ONWARD_NEAR_DESTINATION', [{ p: 'hasActiveTrip' }, { p: 'tripEventSeen', v: 'loaded' }, { p: 'not', v: { p: 'allLoadsDelivered' } }, { p: 'positionFresh' }, { p: 'withinKmOf', v: { of: 'nextOffload', km: 'nearDestinationKm' } }], { availableSoon: true }),
  s('loaded_in_transit', 'Loaded, in transit', 'status-info', 'on_trip', false, 'ONWARD', [{ p: 'hasActiveTrip' }, { p: 'tripEventSeen', v: 'loaded' }, { p: 'not', v: { p: 'allLoadsDelivered' } }]),
  s('empty_returning', 'Empty, returning', 'status-ok', 'soon', false, 'EMPTY_RETURNING', [{ p: 'hasActiveTrip' }, { p: 'allLoadsDelivered' }, { p: 'tripEventNotSeen', v: 'ended' }], { availableSoon: true }),
  s('en_route_to_load', 'Going to load', 'status-info', 'on_trip', false, 'TO_LOADING', [{ p: 'hasActiveTrip' }, { p: 'tripEventSeen', v: 'dispatched' }, { p: 'tripEventNotSeen', v: 'loaded' }]),
  s('assigned', 'Assigned', 'status-info', 'on_trip', false, 'ASSIGNED', [{ p: 'hasActiveTrip' }, { p: 'tripEventNotSeen', v: 'dispatched' }]),
  s('available_at_base', 'Available at base', 'status-ok', 'available', true, 'AVAIL_AT_BASE', [...FREE, { p: 'insideOf', v: 'base' }]),
  s('available_near_origin', 'Available near origin', 'status-ok', 'available', true, 'AVAIL_NEAR_ORIGIN', [...FREE, { p: 'withinKmOf', v: { of: 'baseOrLoadPlaces', km: 'nearOriginKm' } }]),
  s('available_returning', 'Available, returning', 'status-ok', 'available', true, 'AVAIL_RETURNING', [...FREE, { p: 'any', v: [
    { p: 'all', v: [{ p: 'lastTripEndedWithin', v: 'returnWindowHours' }, { p: 'lastTripEndedAt', v: 'elsewhere' }] },
    { p: 'all', v: [{ p: 'positionFresh' }, { p: 'headingToward', v: 'base' }, { p: 'speedAbove', v: 5 }] },
  ] }]),
  s('unknown', 'Position unknown', 'status-warn', 'unknown', false, 'UNKNOWN', [...FREE, { p: 'not', v: { p: 'locationKnown' } }]),
  s('available_elsewhere', 'Available (other place)', 'status-ok', 'available', true, 'AVAIL_ELSEWHERE', FREE),
];

/** What a truck shows when no status matches: the company's list has a gap, and the screen says so. */
export const NO_MATCH: StatusRule = s('no_status', 'No status matches', 'status-mute', 'unknown', false, 'NO_STATUS', []);

/** The policy with defaults filled in: the company's statuses if it has set them, its thresholds over the defaults. */
export function withDefaults(saved: FleetPolicyInput | undefined | null): FleetPolicy {
  return {
    statuses: saved?.statuses?.length ? saved.statuses : DEFAULT_STATUSES,
    thresholds: { ...THRESHOLD_DEFAULTS, ...(saved?.thresholds ?? {}) },
    vendorMaps: saved?.vendorMaps ?? {},
  };
}

/** The policy in effect now. */
export async function fleetPolicy(): Promise<FleetPolicy> {
  const company = await Company.findOne().select('fleetPolicy').lean<{ fleetPolicy?: FleetPolicyInput }>();
  return withDefaults(company?.fleetPolicy);
}
