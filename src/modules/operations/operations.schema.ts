import { z } from 'zod';
import { customKey, isoDate, money, objectId, text } from '../../core/masters/zod.js';
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
/** Company fields answered at a step (#67). The step checks them against the definitions. */
const custom = z.record(z.string().regex(customKey), z.unknown()).optional();
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
  custom,
  plannedStart: isoDate,
  productId: objectId.optional(),
  plannedQty: quantity.optional(),
  /** The trip's consignments, made with it (#135). Left out, the load is added at loading, as before. */
  consignments: z.array(z.lazy(() => inlineConsignmentSchema)).max(50).optional(),
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

export const dispatchSchema = z.strictObject({ custom }).optional();
export type DispatchInput = z.infer<typeof dispatchSchema>;
export const endTripSchema = z.strictObject({ closingFuelL: litresValue, custom });
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
  z.strictObject({ tripId: objectId, kind: z.literal('fuel'), litres: z.number().positive().max(200000), reason: reasonText.optional(), custom }),
  z.strictObject({ tripId: objectId, kind: z.literal('cash'), amount: money.refine((m) => m.amountMinor > 0, 'Enter an amount'), reason: reasonText.optional(), custom }),
]);
export type CreateRequestInput = { tripId: string; kind: 'fuel' | 'cash'; litres?: number; amount?: { amountMinor: number; currencyId: string }; reason?: string; custom?: Record<string, unknown> };

export const decideSchema = z.strictObject({ approve: z.boolean(), note: reasonText.optional(), via, custom });
export type DecideInput = z.infer<typeof decideSchema>;

export const issueSchema = z.strictObject({
  paymentMethodId: objectId.optional(),
  medium: text(60).optional(),
  reference: text(60).optional(),
  station: text(120).optional(),
  /** Fuel: what a litre cost, for trip profit. */
  unitPrice: money.optional(),
  via,
  custom,
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
  /** The consignment the sender says it is for: its number, or its position in the list they were shown. */
  consignmentNo: text(40).optional(),
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
  consignmentId: objectId.optional(),
  legId: objectId.optional(),
  documentTypeId: objectId.optional(),
});
export type SendDocumentInput = z.infer<typeof sendDocumentSchema>;

/* ---------- Loading, delivery, shortage ---------- */

export const consignmentListQuery = z.strictObject({ ...page, tripId: objectId.optional(), shortage: z.enum(['pending', 'charged', 'waived', 'none']).optional() });
export type ConsignmentListQuery = z.infer<typeof consignmentListQuery>;

const measured = {
  /** Optional only for weighed goods with a ticket: the net is gross less tare. */
  qty: quantity.optional(),
  ambientL: litresValue.optional(),
  tempC: z.number().min(-30).max(80).optional(),
  density: z.number().min(0).max(2000).optional(),
  certStd20L: litresValue.optional(),
  gross: quantity.optional(),
  tare: quantity.optional(),
  ticketNo: text(60).optional(),
  docId: objectId.optional(),
  custom,
};

export const loadingSchema = z.strictObject({
  tripId: objectId,
  productId: objectId,
  invoiceNo: text(60),
  consignor: text(200, 0).optional(),
  consignee: text(200, 0).optional(),
  ...measured,
  qty: quantity.refine((v) => v > 0, 'Enter the loaded quantity').optional(),
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
  custom,
  driverId: objectId,
  tripId: objectId.optional(),
  categoryId: objectId,
  amount: money.refine((m) => m.amountMinor > 0, 'Enter the amount'),
  receiptNo: text(60).optional(),
  docId: objectId.optional(),
  note: text(500).optional(),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const expenseDecisionSchema = z.strictObject({ approve: z.boolean(), reason: reasonText.optional(), via, custom });
export type ExpenseDecisionInput = z.infer<typeof expenseDecisionSchema>;

/* ---------- Settlement ---------- */

export const settlementListQuery = z.strictObject({ ...page, driverId: objectId.optional() });
export type SettlementListQuery = z.infer<typeof settlementListQuery>;

export const settlementSchema = z.strictObject({
  driverId: objectId,
  /** None: settling what the driver carries with no trip, such as an opening balance or a driver who is leaving (#102). */
  tripIds: z.array(objectId).max(100).refine((v) => new Set(v).size === v.length, 'Trips must be unique'),
  /** Positive: the driver hands cash back. Negative: the company pays the driver. Base-currency minor units. */
  cashMinor: z.number().int().min(-1e13).max(1e13),
  /** Lines typed by hand, each in the driver's favour or against them. */
  lines: z.array(z.strictObject({
    kind: z.enum(['allowance', 'bonus', 'fine', 'loan', 'repayment', 'correction', 'other']),
    label: text(120),
    amountMinor: z.number().int().positive('Enter the amount').max(1e13),
    toDriver: z.boolean(),
    reason: text(300).optional(),
  })).max(30).optional(),
  paidVia: z.strictObject({ paymentMethodId: objectId.optional(), reference: text(60).optional() }).optional(),
  note: text(500).optional(),
  custom,
});
export const reverseSettlementSchema = z.strictObject({ reason: text(300).refine((v) => v.trim().length > 0, 'Say why it is reversed') });
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
  custom,
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
export const syncQuery = z.strictObject({ since: sinceQuery, from: sinceQuery });

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
/** What a driver answers about their trip and load (#67). */
export const driverFieldsSchema = z.strictObject({ values: z.record(z.string().regex(customKey), z.unknown()) });
export type DriverFieldsInput = z.infer<typeof driverFieldsSchema>;
export const driverSendSchema = z.strictObject({
  kind: z.enum(DOC_KINDS),
  /** Which consignment, pickup or drop, and paper it is, when the driver chose (#135). */
  consignmentId: objectId.optional(),
  legId: objectId.optional(),
  documentTypeId: objectId.optional(),
  /** One signed sheet for every consignment dropped at the stop (Company → Freight). */
  allAtStop: z.boolean().optional(),
  fileId: objectId.optional(),
  note: text(1000).optional(),
  reading: readingSchema.optional(),
}).refine((v) => v.fileId || v.note, 'Attach a photo or write a message');
export type DriverSendInput = z.infer<typeof driverSendSchema>;
export const driverMessagesQuery = z.strictObject({ since: z.iso.datetime().optional() });
export const driverStopParams = z.strictObject({ stopId: objectId });

/* ---------- Consignments (#135, consignments design 3.12) ---------- */

const contact = z.strictObject({
  name: text(200), phone: text(40).optional(), whatsapp: text(40).optional(), email: text(200).optional(), address: text(300).optional(), taxId: text(60).optional(),
});
const consignmentLine = z.strictObject({
  /** Kept on an edit, so the legs' quantities still point at it. */
  id: objectId.optional(),
  productId: objectId,
  description: text(200).optional(),
  plannedQty: quantity.optional(),
  pieces: z.number().int().min(0).max(1e7).optional(),
  grossKg: quantity.optional(),
  volumeM3: z.number().min(0).max(1e5).optional(),
  declaredValue: money.optional(),
  hazard: z.boolean().optional(),
});
/** A planned quantity for one goods line at a pickup or drop: the line by its id, or by its position in `lines`. */
const plannedAt = z.strictObject({ lineId: objectId.optional(), line: z.number().int().min(0).max(99).optional(), qty: quantity.optional(), pieces: z.number().int().min(0).max(1e7).optional() })
  .refine((v) => v.lineId !== undefined || v.line !== undefined, 'Say which goods line');
export const plannedLeg = z.strictObject({
  /** An existing leg, kept on an edit. */
  id: objectId.optional(),
  kind: z.enum(['pickup', 'drop']),
  /** Empty: to be confirmed (a drop decided on the road). */
  placeId: objectId.optional(),
  /** A stop of the trip it happens at, when the person chose one. */
  stopId: objectId.optional(),
  plannedAt: isoDate.optional(),
  planned: z.array(plannedAt).max(50).optional(),
  contact: contact.optional(),
  note: text(300).optional(),
});
const references = z.strictObject({
  customerRef: text(60).optional(), orderNo: text(60).optional(), lrNo: text(60).optional(), ewayBillNo: text(60).optional(), ewayBillValidUntil: isoDate.optional(),
  sealNos: z.array(text(40)).max(30).optional(), permitNo: text(60).optional(), leadKm: z.number().min(0).max(20000).optional(),
});
/** A rate agreed on the consignment (#135 Part 1). null on an edit takes it off, so a tariff prices it again. */
const agreedRate = z.strictObject({
  basis: z.enum(['per_consignment', 'per_kg', 'per_tonne', 'per_litre', 'per_litre_20', 'per_piece', 'per_km']),
  /** A unit price keeps fractions of a minor unit: 0.085 USD a litre is 8.5. */
  price: z.strictObject({ amountMinor: z.number().min(0).max(1e13), currencyId: objectId }),
  chargeOn: z.enum(['loaded', 'delivered']).optional(),
});
const consignmentShape = {
  consignmentTypeId: objectId.optional(),
  /** Who is billed; the trip's customer when left out. */
  customerId: objectId.optional(),
  consignorPartyId: objectId.optional(),
  consignor: contact.optional(),
  consigneePartyId: objectId.optional(),
  consignee: contact.optional(),
  brokerPartyId: objectId.optional(),
  paymentTerms: z.enum(['to_be_billed', 'paid', 'to_pay']).optional(),
  requiredBy: isoDate.optional(),
  lines: z.array(consignmentLine).min(1, 'Add the goods').max(50),
  references: references.optional(),
  rate: agreedRate.nullable().optional(),
  notes: text(1000).optional(),
  custom,
};
/** One consignment as the New trip form sends it: the trip is the one being made. */
export const inlineConsignmentSchema = z.strictObject({ ...consignmentShape, legs: z.array(plannedLeg).max(60).optional() });
export type InlineConsignmentInput = z.infer<typeof inlineConsignmentSchema>;
export const createConsignmentSchema = z.strictObject({ ...consignmentShape, tripId: objectId, legs: z.array(plannedLeg).max(60).optional() });
export type CreateConsignmentInput = z.infer<typeof createConsignmentSchema>;
export const updateConsignmentSchema = z.strictObject({
  version: z.number().int().min(0),
  ...Object.fromEntries(Object.entries(consignmentShape).map(([k, v]) => [k, (v as z.ZodType).optional()])),
}).refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Send at least one field to change');
export type UpdateConsignmentInput = Partial<z.infer<typeof inlineConsignmentSchema>> & { version: number };
/** Replace the planned legs: the split-delivery save. Done legs are sent back as they are or left out. */
export const putLegsSchema = z.strictObject({
  version: z.number().int().min(0),
  legs: z.array(plannedLeg).min(2).max(60),
  /** Leave quantity unplaced, to be confirmed later, instead of putting all of it on the drops. */
  leaveRest: z.boolean().optional(),
});
export type PutLegsInput = z.infer<typeof putLegsSchema>;

const legMeasure = z.strictObject({
  lineId: objectId,
  qty: quantity.optional(),
  ambientL: litresValue.optional(),
  tempC: z.number().min(-30).max(80).optional(),
  density: z.number().min(0).max(2000).optional(),
  certStd20L: litresValue.optional(),
  gross: quantity.optional(),
  tare: quantity.optional(),
  ticketNo: text(60).optional(),
  pieces: z.number().int().min(0).max(1e7).optional(),
  /** Drops: when the consignee did not take everything. */
  accepted: quantity.optional(),
  damaged: quantity.optional(),
  shortDelivered: quantity.optional(),
});
const legDocument = z.strictObject({
  documentTypeId: objectId.optional(),
  number: text(60).optional(),
  date: isoDate.optional(),
  amount: money.optional(),
  validUntil: isoDate.optional(),
  driverDocId: objectId.optional(),
  fileId: objectId.optional(),
});
export const legRecordSchema = z.strictObject({
  measures: z.array(legMeasure).min(1, 'Enter what was loaded or delivered').max(50),
  documents: z.array(legDocument).max(20).optional(),
  /** The driver's photo the figures came from; it is marked recorded. */
  docId: objectId.optional(),
  pod: z.strictObject({ podTypeId: objectId.optional(), number: text(60).optional(), receivedBy: text(120).optional(), receivedAt: isoDate.optional(), remarks: text(500).optional() }).optional(),
  outcome: z.enum(['delivered', 'partial', 'refused']).optional(),
  sealNos: z.array(text(40)).max(30).optional(),
  note: text(500).optional(),
  /** Someone allowed to record over the truck's capacity says why. */
  override: z.strictObject({ reason: text(300) }).optional(),
  custom,
});
export type LegRecordInput = z.infer<typeof legRecordSchema>;
export const legParams = z.strictObject({ id: objectId, legId: objectId });
export const refusalParams = z.strictObject({ id: objectId, refusalId: objectId });
export const refusalDecisionSchema = z.strictObject({ outcome: z.enum(['return', 'write_off', 'charge_driver', 'claim_supplier']), note: text(300).optional() });
export const stopRecordSchema = z.strictObject({
  records: z.array(legRecordSchema.extend({ consignmentId: objectId, legId: objectId })).min(1).max(200),
});
export type StopRecordInput = z.infer<typeof stopRecordSchema>;
export const attachDocumentSchema = legDocument.extend({ legId: objectId.optional() });
export type AttachDocumentInput = z.infer<typeof attachDocumentSchema>;
export const documentParams = z.strictObject({ id: objectId, docId: objectId });
/** Say what a driver's photo is and which consignment and leg it belongs to. */
export const fileDocumentSchema = z.strictObject({
  documentTypeId: objectId.optional(),
  consignmentId: objectId.optional(),
  legId: objectId.optional(),
});
export type FileDocumentInput = z.infer<typeof fileDocumentSchema>;
export const cancelConsignmentSchema = z.strictObject({ version: z.number().int().min(0), reason: reasonText });
export const passStopSchema = z.strictObject({ reason: reasonText });
/** Re-order the stops not yet reached, or add one (a border, a rest, a weighbridge). */
export const putStopsSchema = z.strictObject({
  version: z.number().int().min(0),
  stops: z.array(z.strictObject({ id: objectId.optional(), placeId: objectId, kind: z.enum(STOP_KINDS) })).min(2).max(60),
});
export type PutStopsInput = z.infer<typeof putStopsSchema>;

export const consignmentsQuery = z.strictObject({
  ...page,
  tripId: objectId.optional(),
  status: z.string().trim().regex(/^[a-z_]+(,[a-z_]+)*$/).max(200).optional(),
  customerId: objectId.optional(),
  consignorPartyId: objectId.optional(),
  consigneePartyId: objectId.optional(),
  productId: objectId.optional(),
  revenueStatus: z.enum(['unpriced', 'estimated', 'priced', 'frozen', 'invoiced']).optional(),
  podMissing: z.coerce.boolean().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  dateField: z.enum(['booked', 'loaded', 'delivered']).optional(),
  q: z.string().trim().min(1).max(60).optional(),
  shortage: z.enum(['pending', 'charged', 'waived', 'none']).optional(),
  tab: z.enum(['all', 'to_load', 'on_road', 'to_deliver', 'waiting_pod', 'unpriced']).optional(),
});
export type ConsignmentsQuery = z.infer<typeof consignmentsQuery>;
/** The consignment report (#135 Part 4): the list's filters, the columns to show (comma list of keys), and up to 500 a page. */
export const reportQuery = consignmentsQuery.extend({
  columns: z.string().trim().regex(/^[a-zA-Z0-9.]+(,[a-zA-Z0-9.]+)*$/).max(600).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
