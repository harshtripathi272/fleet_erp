import { type Model, model, Schema } from 'mongoose';
import { FLEET_OUT_TYPES, POSITION_SOURCES } from '../../core/connections/index.js';

/*
 * The fleet data exchange's own records (#136). Vehicle, place and connection ids are kept without `ref`,
 * on purpose: these are working state, not history, so they never stop a truck or a place being deleted.
 */
const options = { timestamps: true, versionKey: false } as const;
const point = new Schema({ type: { type: String, enum: ['Point'], required: true }, coordinates: { type: [Number], required: true } }, { _id: false });

/**
 * Where each truck was last seen, one document per truck: the newest position any source gave. A reading older
 * than the one held goes to the history only, so a late or replayed call never moves a truck backwards.
 */
const vehiclePositionSchema = new Schema<any>({
  vehicleId: { type: Schema.Types.ObjectId, required: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  geo: { type: point, required: true },
  /** When the reading was taken (the tracker's time), and when it reached us. */
  at: { type: Date, required: true },
  receivedAt: { type: Date, required: true },
  speedKmh: Number,
  heading: Number,
  /** The tracker's own odometer. The workshop's reading on the truck stays the one the rest of the system uses. */
  odometerKm: Number,
  ignition: Boolean,
  accuracyM: Number,
  source: { type: String, enum: POSITION_SOURCES, required: true },
  /** A demonstration position (the simulator), never the truck's real place. */
  simulated: { type: Boolean, default: false },
  connectionId: Schema.Types.ObjectId,
  deviceId: String,
  eventId: String,
}, { ...options, collection: 'vehicle_positions' });
vehiclePositionSchema.index({ vehicleId: 1 }, { unique: true });
vehiclePositionSchema.index({ geo: '2dsphere' });
vehiclePositionSchema.index({ updatedAt: 1 });
export const VehiclePosition = model<any>('VehiclePosition', vehiclePositionSchema) as Model<any>;

/** Every position kept, newest and late ones alike, for a while (the company's `historyDays`). */
const positionHistorySchema = new Schema<any>({
  vehicleId: { type: Schema.Types.ObjectId, required: true },
  lat: Number, lng: Number, at: Date, speedKmh: Number, heading: Number,
  source: { type: String, enum: POSITION_SOURCES },
  connectionId: Schema.Types.ObjectId,
  /** Older than the position held when it arrived. */
  late: Boolean,
  expireAt: { type: Date, required: true },
}, { versionKey: false, collection: 'position_history' });
positionHistorySchema.index({ vehicleId: 1, at: -1 });
positionHistorySchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export const PositionHistory = model<any>('PositionHistory', positionHistorySchema) as Model<any>;

/**
 * The other system's id for one of ours, per connection: a truck's id on a tracker platform, a place's
 * geofence id, a trip's job id. Kept apart from the masters so any number of platforms, and a change of
 * platform, need no new columns.
 */
export const REF_ENTITIES = ['vehicle', 'place', 'trip'] as const;
const externalRefSchema = new Schema<any>({
  connectionId: { type: Schema.Types.ObjectId, required: true },
  entity: { type: String, enum: REF_ENTITIES, required: true },
  localId: { type: Schema.Types.ObjectId, required: true },
  externalId: { type: String, required: true },
  lastSentHash: String,
  lastSentAt: Date,
  /** `manual`: someone matched it on the Connections screen; `auto`: the platform told us. */
  source: { type: String, enum: ['auto', 'manual'], default: 'auto' },
}, { ...options, collection: 'exchange_external_refs' });
externalRefSchema.index({ connectionId: 1, entity: 1, externalId: 1 }, { unique: true });
externalRefSchema.index({ connectionId: 1, entity: 1, localId: 1 }, { unique: true });
export const ExternalRef = model<any>('ExternalRef', externalRefSchema) as Model<any>;

/**
 * Every event a connection sent, by its key, for a few days (the company's `dedupeDays`): a platform that
 * sends the same event twice (they do) changes nothing the second time.
 */
const inboxLogSchema = new Schema<any>({
  connectionId: { type: Schema.Types.ObjectId, required: true },
  eventKey: { type: String, required: true },
  type: String,
  at: Date,
  /** stored: newest position; late: older, history only; unmatched: no truck yet; recorded: kept, not acted on. */
  outcome: { type: String, enum: ['stored', 'late', 'unmatched', 'recorded'] },
  vehicleId: Schema.Types.ObjectId,
  expireAt: { type: Date, required: true },
}, { ...options, collection: 'exchange_inbox_log' });
inboxLogSchema.index({ connectionId: 1, eventKey: 1 }, { unique: true });
inboxLogSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export const ExchangeInboxLog = model<any>('ExchangeInboxLog', inboxLogSchema) as Model<any>;

/**
 * A tracker no truck is matched to yet, parked rather than lost: its last position and how many came in. The
 * Connections screen lists them with "Match to a truck"; matching keeps its last position on that truck.
 */
const unmatchedSchema = new Schema<any>({
  connectionId: { type: Schema.Types.ObjectId, required: true },
  /** The id it is known by: the platform's own id, else the device id, else the plate. */
  key: { type: String, required: true },
  deviceId: String,
  registration: String,
  externalId: String,
  last: {
    type: new Schema({ lat: Number, lng: Number, at: Date, speedKmh: Number, heading: Number, source: String, odometerKm: Number, ignition: Boolean, eventId: String }, { _id: false }),
    required: true,
  },
  count: { type: Number, default: 0 },
  firstSeenAt: Date,
  lastSeenAt: Date,
  expireAt: { type: Date, required: true },
}, { ...options, collection: 'exchange_unmatched' });
unmatchedSchema.index({ connectionId: 1, key: 1 }, { unique: true });
unmatchedSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export const UnmatchedTracker = model<any>('UnmatchedTracker', unmatchedSchema) as Model<any>;

/* Outbound: the exchange's own outbox, beside the messaging one (whose rows are messages, not data). */

export const EXCHANGE_STATUSES = ['queued', 'sending', 'sent', 'failed', 'simulated', 'skipped'] as const;
export const EXCHANGE_ENTITIES = ['trip', 'place', 'vehicle', 'sync'] as const;
const outboxSchema = new Schema<any>({
  /** The connection it goes to; none means the Simulated partner, while nothing is connected. */
  connectionId: Schema.Types.ObjectId,
  /** "none" when there is no connection: the unique key below then still works. */
  connectionKey: { type: String, required: true },
  type: { type: String, enum: FLEET_OUT_TYPES, required: true },
  entity: { type: String, enum: EXCHANGE_ENTITIES, required: true },
  entityId: { type: String, required: true },
  /** The record's version when it was queued; the message carries the version it reads when it is sent. */
  version: Number,
  idempotencyKey: { type: String, required: true },
  /** What caused it: a trip event, an edit, "resync". */
  cause: String,
  occurredAt: { type: Date, required: true },
  status: { type: String, enum: EXCHANGE_STATUSES, default: 'queued', required: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: Date,
  leaseUntil: Date,
  sentAt: Date,
  /** The message as it was sent (built when sent, so it is never stale), and the platform's answer. */
  payload: Schema.Types.Mixed,
  vendorRef: String,
  httpStatus: Number,
  note: String,
  /** Finished rows are kept for a while for the screen, then removed. */
  expireAt: Date,
}, { ...options, collection: 'exchange_outbox' });
outboxSchema.index({ connectionKey: 1, idempotencyKey: 1 }, { unique: true });
outboxSchema.index({ status: 1, nextAttemptAt: 1 });
outboxSchema.index({ connectionKey: 1, entity: 1, entityId: 1, status: 1, createdAt: 1 });
outboxSchema.index({ createdAt: -1 });
outboxSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export const ExchangeOutbox = model<any>('ExchangeOutbox', outboxSchema) as Model<any>;

/**
 * What the Simulated partner was sent: the exact JSON and headers, signature included. Doubles as the example
 * a real platform's engineers build against. Kept a week.
 */
const simulatedLogSchema = new Schema<any>({
  connectionId: Schema.Types.ObjectId,
  outboxId: Schema.Types.ObjectId,
  type: String,
  idempotencyKey: String,
  headers: Schema.Types.Mixed,
  body: String,
  expireAt: { type: Date, required: true },
}, { ...options, collection: 'simulated_partner_log' });
simulatedLogSchema.index({ createdAt: -1 });
simulatedLogSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export const SimulatedPartnerLog = model<any>('SimulatedPartnerLog', simulatedLogSchema) as Model<any>;
