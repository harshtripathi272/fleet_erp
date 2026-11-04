import { z } from 'zod';
import { isoDate, money, objectId, text } from '../../core/masters/zod.js';
import { DOC_CHANNELS, DOC_KINDS } from './models/cargo.model.js';
import { STOP_KINDS } from './models/trip.model.js';

/* ---------- Shared ---------- */

const page = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const via = z.enum(['app', 'whatsapp']).optional();
const litresValue = z.number().min(0).max(200000);
const quantity = z.number().min(0).max(1e7);
const reasonText = text(500);
const sinceQuery = isoDate.optional();

export const tripStopParams = z.strictObject({ id: objectId, stopId: objectId });
export const driverParams = z.strictObject({ driverId: objectId });
export const vehicleParams = z.strictObject({ vehicleId: objectId });
export const reasonSchema = z.strictObject({ reason: reasonText });
export type ReasonInput = z.infer<typeof reasonSchema>;

const stopPlan = z.strictObject({ placeId: objectId, kind: z.enum(STOP_KINDS) });

/* ---------- Trips ---------- */

export const tripListQuery = z.strictObject({
  ...page,
  state: z.enum(['open', 'planned', 'on_road', 'ended', 'settled', 'cancelled']).optional(),
  driverId: objectId.optional(),
  vehicleId: objectId.optional(),
  customerId: objectId.optional(),
  nominationId: objectId.optional(),
  search: z.string().trim().min(1).max(40).optional(),
});
export type TripListQuery = z.infer<typeof tripListQuery>;

export const createTripSchema = z.strictObject({
  customerId: objectId,
  /** The trip type whose stages the trip follows; the company's default type when omitted. */
  tripTypeId: objectId.optional(),
  vehicleId: objectId,
  driverId: objectId.optional(),
  trailerId: objectId.optional(),
  routeId: objectId.optional(),
  stops: z.array(stopPlan).min(2).max(30).optional(),
  plannedStart: isoDate,
  productId: objectId.optional(),
  plannedQty: quantity.optional(),
});
export type CreateTripInput = z.infer<typeof createTripSchema>;

export const updateTripSchema = z.strictObject({
  version: z.number().int().min(0),
  customerId: objectId.optional(),
  driverId: objectId.nullable().optional(),
  trailerId: objectId.nullable().optional(),
  routeId: objectId.nullable().optional(),
  stops: z.array(stopPlan).min(2).max(30).optional(),
  plannedStart: isoDate.optional(),
  productId: objectId.nullable().optional(),
  plannedQty: quantity.nullable().optional(),
  fuelBudgetL: litresValue.optional(),
  cashBudgetMinor: z.number().int().min(0).max(1e13).optional(),
}).refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Send at least one field to change');
export type UpdateTripInput = z.infer<typeof updateTripSchema>;

export const positionSchema = z.strictObject({
  km: z.number().min(0).max(100000),
  speed: z.number().min(0).max(200),
  heading: z.number().min(-360).max(360).optional(),
  /** `simulator` for the demo drive; `gps` for a tracker. Required, so a demo position is never taken for a real one. */
  source: z.enum(['simulator', 'gps']),
});
export type PositionInput = z.infer<typeof positionSchema>;

export const endTripSchema = z.strictObject({ closingFuelL: litresValue });
export type EndTripInput = z.infer<typeof endTripSchema>;
/** Where the truck is now and what is left in the tank, when a trip is stopped before loading. */
export const stopTripSchema = z.strictObject({ reason: text(300), closingFuelL: litresValue, placeId: objectId.optional() });
export type StopTripInput = z.infer<typeof stopTripSchema>;

/* What happens to a load a trip can't deliver (#64). */
const undelivered = { reasonId: objectId, note: text(300).optional() };
export const undeliveredSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...undelivered, outcome: z.literal('return'), returnPlaceId: objectId.optional() }),
  z.strictObject({ ...undelivered, outcome: z.literal('transfer'), vehicleId: objectId, driverId: objectId.optional(), trailerId: objectId.optional(), placeId: objectId.optional(), closingFuelL: litresValue }),
  z.strictObject({
    ...undelivered, outcome: z.literal('write_off'), carrier: z.enum(['driver', 'company', 'insurance']).optional(), insurerPartyId: objectId.optional(), claimReference: text(60).optional(),
    amount: money.optional(), placeId: objectId.optional(), closingFuelL: litresValue,
  }),
]);
export type UndeliveredInput = z.infer<typeof undeliveredSchema>;
export const writeOffDecisionSchema = z.strictObject({ approve: z.boolean(), note: text(300).optional(), via });
export type WriteOffDecisionInput = z.infer<typeof writeOffDecisionSchema>;

export const vehicleStateSchema = z.strictObject({ placeId: objectId.optional(), fuelL: litresValue.optional() })
  .refine((v) => v.placeId !== undefined || v.fuelL !== undefined, 'Send the place, the fuel or both');
export type VehicleStateInput = z.infer<typeof vehicleStateSchema>;

/* ---------- Money requests ---------- */

export const requestListQuery = z.strictObject({
  ...page,
  tripId: objectId.optional(),
  status: z.enum(['pending', 'owner', 'approved', 'issued', 'rejected', 'cancelled']).optional(),
  kind: z.enum(['fuel', 'cash']).optional(),
});
export type RequestListQuery = z.infer<typeof requestListQuery>;

export const createRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ tripId: objectId, kind: z.literal('fuel'), litres: z.number().positive().max(200000), reason: reasonText.optional() }),
  z.strictObject({ tripId: objectId, kind: z.literal('cash'), amount: money.refine((m) => m.amountMinor > 0, 'Enter an amount'), reason: reasonText.optional() }),
]);
export type CreateRequestInput = { tripId: string; kind: 'fuel' | 'cash'; litres?: number; amount?: { amountMinor: number; currencyId: string }; reason?: string };

export const decideSchema = z.strictObject({ approve: z.boolean(), note: reasonText.optional(), via });
export type DecideInput = z.infer<typeof decideSchema>;

export const issueSchema = z.strictObject({
  paymentMethodId: objectId.optional(),
  medium: text(60).optional(),
  reference: text(60).optional(),
  station: text(120).optional(),
  via,
}).refine((v) => v.paymentMethodId || v.medium, 'Choose the payment method');
export type IssueInput = z.infer<typeof issueSchema>;

/* ---------- Driver documents ---------- */

export const documentListQuery = z.strictObject({
  ...page,
  tripId: objectId.optional(),
  driverId: objectId.optional(),
  status: z.enum(['new', 'recorded', 'returned']).optional(),
  kind: z.enum(DOC_KINDS).optional(),
});
export type DocumentListQuery = z.infer<typeof documentListQuery>;

/** A real document: a file uploaded first (`POST /files`), referred to by its id. */
const uploadedFile = z.strictObject({ fileId: objectId });
/** A sample picture from the simulated phone. */
const sampleFile = z.strictObject({ name: text(200), mime: z.string().trim().regex(/^[\w.+-]+\/[\w.+-]+$/).max(100), sampleId: text(80) });

export const readingSchema = z.strictObject({
  docNo: text(60).optional(),
  productId: objectId.optional(),
  qty: quantity.optional(),
  ambientL: litresValue.optional(),
  tempC: z.number().min(-30).max(80).optional(),
  density: z.number().min(0).max(2000).optional(),
  certStd20L: litresValue.optional(),
  consignor: text(200).optional(),
  consignee: text(200).optional(),
  amount: z.number().min(0).max(1e9).optional(),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  categoryId: objectId.optional(),
  fuelL: litresValue.optional(),
});

export const sendDocumentSchema = z.strictObject({
  driverId: objectId,
  tripId: objectId.optional(),
  kind: z.enum(DOC_KINDS),
  note: text(1000).optional(),
  file: uploadedFile.optional(),
  /** Figures typed by whoever files it. A person checks them before they are recorded. */
  reading: readingSchema.optional(),
  channel: z.enum(DOC_CHANNELS).default('operations'),
});
export type SendDocumentInput = z.infer<typeof sendDocumentSchema>;

/* ---------- Loading, delivery, shortage ---------- */

export const consignmentListQuery = z.strictObject({ ...page, tripId: objectId.optional(), shortage: z.enum(['pending', 'charged', 'waived', 'none']).optional() });
export type ConsignmentListQuery = z.infer<typeof consignmentListQuery>;

const measured = {
  qty: quantity,
  ambientL: litresValue.optional(),
  tempC: z.number().min(-30).max(80).optional(),
  density: z.number().min(0).max(2000).optional(),
  certStd20L: litresValue.optional(),
  docId: objectId.optional(),
};

export const loadingSchema = z.strictObject({
  tripId: objectId,
  productId: objectId,
  invoiceNo: text(60),
  consignor: text(200, 0).optional(),
  consignee: text(200, 0).optional(),
  ...measured,
  qty: quantity.refine((v) => v > 0, 'Enter the loaded quantity'),
});
export type LoadingInput = z.infer<typeof loadingSchema>;

export const deliverySchema = z.strictObject({ podNo: text(60), ...measured });
export type DeliveryInput = z.infer<typeof deliverySchema>;

export const shortageDecisionSchema = z.strictObject({ charge: z.boolean(), note: reasonText.optional(), via });
export type ShortageDecisionInput = z.infer<typeof shortageDecisionSchema>;

/* ---------- Expenses ---------- */

export const expenseListQuery = z.strictObject({ ...page, tripId: objectId.optional(), driverId: objectId.optional(), status: z.enum(['pending', 'approved', 'rejected']).optional() });
export type ExpenseListQuery = z.infer<typeof expenseListQuery>;

export const expenseSchema = z.strictObject({
  driverId: objectId,
  tripId: objectId.optional(),
  categoryId: objectId,
  amount: money.refine((m) => m.amountMinor > 0, 'Enter the amount'),
  receiptNo: text(60).optional(),
  docId: objectId.optional(),
  note: text(500).optional(),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const expenseDecisionSchema = z.strictObject({ approve: z.boolean(), reason: reasonText.optional(), via });
export type ExpenseDecisionInput = z.infer<typeof expenseDecisionSchema>;

/* ---------- Settlement ---------- */

export const settlementListQuery = z.strictObject({ ...page, driverId: objectId.optional() });
export type SettlementListQuery = z.infer<typeof settlementListQuery>;

export const settlementSchema = z.strictObject({
  driverId: objectId,
  tripIds: z.array(objectId).min(1, 'Pick the trips to settle').max(100).refine((v) => new Set(v).size === v.length, 'Trips must be unique'),
  /** Positive: the driver hands cash back. Negative: the company pays the driver. Base-currency minor units. */
  cashMinor: z.number().int().min(-1e13).max(1e13),
  note: text(500).optional(),
});
export type SettlementInput = z.infer<typeof settlementSchema>;

/* ---------- Nominations ---------- */

export const nominationListQuery = z.strictObject({ ...page, status: z.enum(['draft', 'sent', 'accepted', 'converted', 'cancelled']).optional(), customerId: objectId.optional() });
export type NominationListQuery = z.infer<typeof nominationListQuery>;

const nominationShape = {
  customerId: objectId,
  orderSourceId: objectId.optional(),
  reference: text(60).optional(),
  loadingPlaceId: objectId,
  productId: objectId.optional(),
  qtyPerTruck: quantity.optional(),
  requiredDate: isoDate,
  trucks: z.array(z.strictObject({ vehicleId: objectId, driverId: objectId.optional() })).min(1, 'Pick at least one truck').max(100),
  note: text(1000).optional(),
};
export const nominationSchema = z.strictObject(nominationShape);
export type NominationInput = z.infer<typeof nominationSchema>;
export const nominationUpdateSchema = z.strictObject({
  version: z.number().int().min(0),
  ...Object.fromEntries(Object.entries(nominationShape).map(([k, v]) => [k, (v as z.ZodType).optional()])),
}).refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Send at least one field to change');
export type NominationUpdateInput = Partial<NominationInput> & { version: number };

export const acceptSchema = z.strictObject({ customerReply: z.boolean().default(false) }).default({ customerReply: false });
export type AcceptInput = z.infer<typeof acceptSchema>;
export const convertSchema = z.strictObject({ routeId: objectId.optional(), offloadPlaceId: objectId.optional() });
export type ConvertInput = z.infer<typeof convertSchema>;

/* ---------- Messages, activity, WhatsApp ---------- */

const thread = z.string().trim().regex(/^(queue:[a-z][a-z-]{1,39}|role:[a-z][a-z0-9_-]{0,39}|(user|driver|customer):[0-9a-f]{24})$/, 'queue:<permission>, role:<key>, user:<id>, driver:<id> or customer:<id>');
export const messageListQuery = z.strictObject({ thread: thread.optional(), since: sinceQuery, limit: z.coerce.number().int().min(1).max(500).default(100) });
export type MessageListQuery = z.infer<typeof messageListQuery>;
export const chatSchema = z.strictObject({ thread, text: text(2000) });
export type ChatInput = z.infer<typeof chatSchema>;
export const readSchema = z.strictObject({ thread });
export type ReadInput = z.infer<typeof readSchema>;
export const activityListQuery = z.strictObject({ tripId: objectId.optional(), since: sinceQuery, limit: z.coerce.number().int().min(1).max(500).default(100) });
export type ActivityListQuery = z.infer<typeof activityListQuery>;
export const syncQuery = z.strictObject({ since: sinceQuery });

/** The simulated driver phone: a sample picture with generated figures, or a real upload, sent as if on WhatsApp. */
export const simulateSchema = z.strictObject({
  driverId: objectId,
  tripId: objectId.optional(),
  kind: z.enum(DOC_KINDS).optional(),
  text: text(1000).optional(),
  file: z.union([uploadedFile, sampleFile]).optional(),
  reading: readingSchema.optional(),
}).refine((v) => v.text || v.file, 'Attach a photo or write a message');
export type SimulateInput = z.infer<typeof simulateSchema>;

/** Provisional Marichi Talks webhook body until its real format is known. */
export const inboundSchema = z.strictObject({
  from: z.string().trim().regex(/^\+?[1-9]\d{6,14}$/, 'International number'),
  text: text(1000).optional(),
  kind: z.enum(DOC_KINDS).optional(),
  /** A photo held by Marichi Talks, linked by URL until its media format is known. */
  media: z.strictObject({
    name: text(200),
    mime: z.string().trim().regex(/^[\w.+-]+\/[\w.+-]+$/).max(100),
    url: z.string().trim().max(2000).refine((v) => /^https:\/\//.test(v), 'Must be an https URL'),
  }).optional(),
  /** The one-time token of the button the person tapped, as sent with the message. */
  buttonToken: z.string().trim().regex(/^[A-Za-z0-9_-]{20,64}$/, 'A button token').optional(),
});
export type InboundInput = z.infer<typeof inboundSchema>;

/* ---------- Driver app ---------- */

/** What a driver sends from the driver app: an uploaded file, a message, or both. */
export const driverSendSchema = z.strictObject({
  kind: z.enum(DOC_KINDS),
  fileId: objectId.optional(),
  note: text(1000).optional(),
  reading: readingSchema.optional(),
}).refine((v) => v.fileId || v.note, 'Attach a photo or write a message');
export type DriverSendInput = z.infer<typeof driverSendSchema>;
export const driverMessagesQuery = z.strictObject({ since: z.iso.datetime().optional() });
export const driverStopParams = z.strictObject({ stopId: objectId });
