import { Schema } from 'mongoose';
import { opsModel } from './model.js';
import { ObjectId, moneySchema, schemaOptions } from '../../../core/masters/schema.js';
import { approvalSchema } from './funding.model.js';

/** What a driver's photo is. `loading` and `delivery` are the common two; the rest name a consignment's other papers (#135). */
export const DOC_KINDS = ['loading', 'delivery', 'pod', 'weighbridge', 'permit', 'eway', 'expense', 'fuel', 'other'] as const;
export const DOC_CHANNELS = ['whatsapp', 'app', 'operations'] as const;

/** Figures read from a photo (or typed by the sender); a person checks them before they are recorded. */
const readingSchema = new Schema({
  docNo: String,
  productId: { type: ObjectId, ref: 'Product' },
  qty: Number,
  ambientL: Number,
  tempC: Number,
  density: Number,
  certStd20L: Number,
  consignor: String,
  consignee: String,
  amount: Number,
  currencyCode: String,
  categoryId: { type: ObjectId, ref: 'ExpenseCategory' },
  fuelL: Number,
  /** The consignment the sender says it is for: its number, or its position in the list they were shown. */
  consignmentNo: String,
}, { _id: false, strict: 'throw' });

const fileSchema = new Schema({
  name: { type: String, required: true },
  mime: { type: String, required: true },
  /** An uploaded file (`/files/:id`). */
  fileId: { type: ObjectId, ref: 'StoredFile' },
  size: Number,
  /** A built-in sample picture from the simulated phone: not a real document. */
  sampleId: String,
  /** Inline images from before file storage existed; new documents use `fileId`. */
  dataUrl: String,
  /** A file held by the messaging provider (Marichi Talks). */
  url: String,
}, { _id: false, strict: 'throw' });

/** A photo or message a driver sends (or the office files for them): recorded against a trip or returned. */
const driverDocumentSchema = new Schema<any>({
  driverId: { type: ObjectId, ref: 'Driver', required: true },
  tripId: { type: ObjectId, ref: 'Trip' },
  kind: { type: String, enum: DOC_KINDS, required: true },
  channel: { type: String, enum: DOC_CHANNELS, required: true },
  note: String,
  file: { type: fileSchema, default: undefined },
  reading: { type: readingSchema, default: undefined },
  /** The consignment and the pickup or drop it belongs to, once known (#135). */
  consignmentId: { type: ObjectId, ref: 'Consignment' },
  legId: { type: ObjectId },
  documentTypeId: { type: ObjectId, ref: 'ConsignmentDocumentType' },
  /**
   * A question the bot asked the driver about this photo on WhatsApp and is waiting on: what it is, then which
   * consignment. Kept on the document, so nothing is lost if the driver never answers.
   */
  question: {
    type: new Schema({
      ask: { type: String, enum: ['kind', 'consignment'], required: true },
      options: { type: [new Schema({ label: { type: String, required: true }, value: { type: String, required: true } }, { _id: false })], default: [] },
      at: { type: Date, required: true },
    }, { _id: false, strict: 'throw' }),
    default: undefined,
  },
  /** Sent from a simulator: a sample picture with generated figures, not a real document. */
  simulated: { type: Boolean, default: false },
  status: { type: String, enum: ['new', 'recorded', 'returned'], default: 'new' },
  recordRef: String,
  returnReason: String,
  at: { type: Date, required: true },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
driverDocumentSchema.index({ tripId: 1, status: 1 });
driverDocumentSchema.index({ driverId: 1, at: -1 });
driverDocumentSchema.index({ updatedAt: 1 });
driverDocumentSchema.index({ 'file.fileId': 1 }, { sparse: true });
// The desks' queues: documents still to check, oldest first; and the paged list, newest first.
driverDocumentSchema.index({ status: 1, kind: 1, at: 1 });
driverDocumentSchema.index({ at: -1 });
driverDocumentSchema.index({ consignmentId: 1 }, { sparse: true });
driverDocumentSchema.index({ driverId: 1, 'question.at': -1 }, { sparse: true });

export const DriverDocument = opsModel('DriverDocument', driverDocumentSchema);

/** A quantity as measured; fuel adds ambient litres, temperature, density and the 20 °C volume. */
const measureSchema = new Schema({
  qty: { type: Number, min: 0, required: true },
  unit: { type: String, required: true },
  ambientL: Number,
  tempC: Number,
  density: Number,
  vcf: Number,
  std20L: Number,
  certStd20L: Number,
  /** Weighed goods: the weighbridge ticket's figures, in the product's unit; `qty` is the net. */
  gross: Number,
  tare: Number,
  ticketNo: String,
  at: Date,
  podNo: String,
  docId: { type: ObjectId, ref: 'DriverDocument' },
}, { _id: false, strict: 'throw' });

/** In the product's unit (`unit`): for fuel, litres at 20 °C, as the field names say; for other cargo, its own quantity. */
const shortageSchema = new Schema({
  unit: String,
  loaded20L: Number,
  delivered20L: Number,
  lossL: Number,
  allowancePercent: Number,
  allowanceL: Number,
  netShortL: Number,
  pricePerL: { type: moneySchema, default: undefined },
  amount: { type: moneySchema, default: undefined },
  baseAmountMinor: Number,
  status: { type: String, enum: ['pending', 'charged', 'waived', 'none'], required: true },
  decidedAt: Date,
  decidedBy: { type: ObjectId, ref: 'User' },
  note: String,
  /** Who may waive it, routed by the company's shortage-waiver policy when the delivery was recorded. */
  approval: { type: approvalSchema, default: undefined },
}, { _id: false, strict: 'throw' });

/** A load given up for lost: what it was worth, who carries that, and the owner's decision where one is needed. */
const writeOffSchema = new Schema({
  status: { type: String, enum: ['pending', 'approved', 'rejected'], required: true },
  carrier: { type: String, enum: ['driver', 'company', 'insurance'], required: true },
  insurerPartyId: { type: ObjectId, ref: 'Party' },
  claimReference: String,
  amount: { type: moneySchema, required: true },
  baseAmountMinor: { type: Number, required: true },
  reasonId: { type: ObjectId, ref: 'CancellationReason' },
  reason: String,
  /** Where the truck is and what is in the tank: the trip closes with these once it is approved. */
  placeId: { type: ObjectId, ref: 'Place' },
  closingFuelL: Number,
  requestedAt: Date,
  requestedBy: { type: ObjectId, ref: 'User' },
  requestedByName: String,
  decidedAt: Date,
  decidedBy: { type: ObjectId, ref: 'User' },
  note: String,
}, { _id: false, strict: 'throw' });


/* ---------- Consignments (#135, consignments design 3.2) ---------- */

/** A person or company without a party record: a consignee who is only a name and a phone number. */
const contactSchema = new Schema({
  name: { type: String, required: true },
  phone: String,
  whatsapp: String,
  email: String,
  address: String,
  taxId: String,
}, { _id: false, strict: 'throw' });

/** Every trip a consignment has been on, oldest first. */
const movementSchema = new Schema({
  tripId: { type: ObjectId, ref: 'Trip', required: true },
  from: { type: Date, required: true },
  to: Date,
  reason: String,
  by: { type: ObjectId, ref: 'User' },
}, { _id: false, strict: 'throw' });

/** One product and its planned quantity. What was actually loaded and delivered is on the legs. */
const lineSchema = new Schema({
  productId: { type: ObjectId, ref: 'Product', required: true },
  /** As on the customer's papers ("Portland cement 50 kg"). */
  description: String,
  plannedQty: Number,
  /** The product's unit symbol, as a measure's unit. */
  unit: { type: String, required: true },
  pieces: Number,
  grossKg: Number,
  volumeM3: Number,
  declaredValue: { type: moneySchema, default: undefined },
  hazard: Boolean,
}, { _id: true, strict: 'throw' });

export const LEG_KINDS = ['pickup', 'drop'] as const;
export const LEG_STATUSES = ['planned', 'done', 'skipped'] as const;
export const DROP_OUTCOMES = ['delivered', 'partial', 'refused'] as const;

const plannedQtySchema = new Schema({ lineId: { type: ObjectId, required: true }, qty: Number, pieces: Number }, { _id: false, strict: 'throw' });

/** A measure as recorded (today's measure: litres at 20 °C for fuel, a weighbridge ticket for weighed goods), for one line. */
export const legMeasureSchema = new Schema({
  lineId: { type: ObjectId, required: true },
  qty: { type: Number, min: 0, required: true },
  unit: { type: String, required: true },
  ambientL: Number,
  tempC: Number,
  density: Number,
  vcf: Number,
  std20L: Number,
  certStd20L: Number,
  gross: Number,
  tare: Number,
  ticketNo: String,
  pieces: Number,
  /** Drops only, in the line's unit, when the consignee did not take everything. */
  accepted: Number,
  damaged: Number,
  shortDelivered: Number,
  docIds: { type: [{ type: ObjectId, ref: 'DriverDocument' }], default: undefined },
}, { _id: false, strict: 'throw' });

const podSchema = new Schema({
  podTypeId: { type: ObjectId, ref: 'PodType' },
  /** The delivery note or POD number. */
  number: String,
  receivedBy: String,
  receivedAt: Date,
  docIds: { type: [{ type: ObjectId, ref: 'DriverDocument' }], default: undefined },
  /** As written on the POD ("2 bags torn"). */
  remarks: String,
}, { _id: false, strict: 'throw' });

/** One pickup or one drop of a consignment at a place: planned, then done. It attaches to a stop of the trip. */
const legSchema = new Schema({
  kind: { type: String, enum: LEG_KINDS, required: true },
  sequence: { type: Number, required: true },
  /** Empty while the place is still to be confirmed (a split decided late). */
  placeId: { type: ObjectId, ref: 'Place' },
  /** The trip's stop it happens at, once attached, and that trip (a moved consignment keeps the legs another truck did). */
  stopId: { type: ObjectId },
  tripId: { type: ObjectId, ref: 'Trip' },
  status: { type: String, enum: LEG_STATUSES, default: 'planned' },
  plannedAt: Date,
  /** What is planned here, per line: a split delivery puts 9,500 L of line 1 here. */
  planned: { type: [plannedQtySchema], default: undefined },
  /** What was loaded or offloaded here, per line. */
  actual: { type: [legMeasureSchema], default: undefined },
  recordedAt: Date,
  recordedBy: { type: ObjectId, ref: 'User' },
  pod: { type: podSchema, default: undefined },
  outcome: { type: String, enum: DROP_OUTCOMES },
  /** Someone to call at this drop, when it isn't the consignment's consignee (a depot's storeman). */
  contact: { type: contactSchema, default: undefined },
  note: String,
}, { _id: true, strict: 'throw' });

/** A paper that goes with the consignment: a loading invoice, a weighbridge ticket, a delivery note, the POD. */
const consignmentDocumentSchema = new Schema({
  documentTypeId: { type: ObjectId, ref: 'ConsignmentDocumentType' },
  /** The type's name when it was filed, so the paper still reads right if the type is renamed or switched off. */
  label: String,
  number: String,
  date: Date,
  /** The pickup or drop it belongs to, when it does. */
  legId: { type: ObjectId },
  /** The photo or PDF the driver sent. */
  driverDocId: { type: ObjectId, ref: 'DriverDocument' },
  /** Or a file the office uploaded. */
  fileId: { type: ObjectId, ref: 'StoredFile' },
  amount: { type: moneySchema, default: undefined },
  validUntil: Date,
  at: Date,
  by: { type: ObjectId, ref: 'User' },
}, { _id: true, strict: 'throw' });

/** The bases a rate agreed on the consignment may use (#135 Part 1): the common ones; a tariff offers the rest. */
export const AGREED_RATE_BASES = ['per_consignment', 'per_kg', 'per_tonne', 'per_litre', 'per_litre_20', 'per_piece', 'per_km'] as const;

/** A rate agreed for this consignment, typed while making the trip: it prices the consignment without a tariff. */
const agreedRateSchema = new Schema({
  basis: { type: String, enum: AGREED_RATE_BASES, required: true },
  price: { type: moneySchema, required: true },
  /** Empty: the company's default (Company → Freight). */
  chargeOn: { type: String, enum: ['loaded', 'delivered'] },
}, { _id: false, strict: 'throw' });

const referencesSchema = new Schema({
  customerRef: String,
  orderNo: String,
  /** The company's own consignment note or LR number, when it keeps a book apart from our numbers. */
  lrNo: String,
  ewayBillNo: String,
  ewayBillValidUntil: Date,
  sealNos: { type: [String], default: undefined },
  permitNo: String,
  /** Lead distance typed by the office, for tariffs that charge on a typed distance. */
  leadKm: Number,
}, { _id: false, strict: 'throw' });

export const REVENUE_STATUSES = ['unpriced', 'estimated', 'priced', 'frozen', 'invoiced'] as const;
export const REVENUE_LINE_KINDS = ['freight', 'minimum', 'charge', 'deduction'] as const;

/** One money line of a consignment's revenue: freight, a charge or a deduction, each with how it was reached. */
const revenueLineSchema = new Schema({
  chargeTypeId: { type: ObjectId, ref: 'ChargeType', required: true },
  kind: { type: String, enum: REVENUE_LINE_KINDS, required: true },
  description: { type: String, required: true },
  qty: Number,
  unit: String,
  /** In the revenue's currency; fractions of a minor unit are kept. Negative for a deduction. */
  unitPriceMinor: Number,
  amountMinor: { type: Number, required: true },
  taxPercent: Number,
  taxMinor: Number,
  source: { type: String, enum: ['tariff', 'auto', 'manual'], required: true },
  tariffLineId: { type: ObjectId },
  legId: { type: ObjectId },
  /** The goods line it prices, for a tariff line worked out per goods line. */
  lineId: { type: ObjectId },
  /** A formula line keeps what it computed and what it saw (design 3.5.6). */
  formula: String,
  variables: { type: Schema.Types.Mixed, default: undefined },
  accepted: { type: Boolean, default: true },
  note: String,
  by: { type: ObjectId, ref: 'User' },
}, { _id: true, strict: 'throw' });

/** What the consignment is worth, and why (design 3.2.2). Worked out by the revenue engine, never typed, except a manual price. */
const revenueSchema = new Schema({
  status: { type: String, enum: REVENUE_STATUSES, required: true, default: 'unpriced' },
  tariffId: { type: ObjectId, ref: 'Tariff' },
  /** The tariff's version used, so a later edit to the tariff doesn't move history. */
  tariffVersion: Number,
  currencyId: { type: ObjectId, ref: 'Currency' },
  /** The day whose tariff and exchange rate applied. */
  pricedOn: Date,
  pricedAt: Date,
  /** The quantities the engine charged on. */
  basis: {
    type: new Schema({ chargeOn: String, qty: Number, unit: String, km: Number, pieces: Number, drops: Number, estimated: Boolean }, { _id: false, strict: 'throw' }),
    default: undefined,
  },
  lines: { type: [revenueLineSchema], default: [] },
  subtotalMinor: Number,
  taxMinor: Number,
  totalMinor: Number,
  /** Before tax, in the base currency, for trip profit. Empty when the day's exchange rate is missing. */
  baseSubtotalMinor: Number,
  baseTotalMinor: Number,
  rateToBase: Number,
  /** A price typed by hand instead of a tariff: who, why, and whether it is the whole price. */
  manual: {
    type: new Schema({ by: { type: ObjectId, ref: 'User' }, at: Date, reason: String, whole: Boolean }, { _id: false, strict: 'throw' }),
    default: undefined,
  },
  frozenAt: Date,
  /** What froze it: an invoice, the trip's settlement, its delivery, or a person. */
  frozenFor: { type: String, enum: ['invoice', 'settlement', 'delivery', 'manual'] },
  invoiceIds: { type: [{ type: ObjectId, ref: 'Invoice' }], default: undefined },
  /** The engine's own words for how it got here, one per step. */
  explanation: { type: [String], default: [] },
  /** Why it could not be priced, when it could not. */
  problem: String,
}, { _id: false, strict: 'throw' });

/** What happened to a consignment that was not simply delivered: going back, moved to another truck, written off (#64). */
const outcomeSchema = new Schema({
  returned: { type: new Schema({ at: Date, by: { type: ObjectId, ref: 'User' }, reason: String, placeId: { type: ObjectId, ref: 'Place' } }, { _id: false }), default: undefined },
  transfers: { type: [new Schema({ fromTripId: { type: ObjectId, ref: 'Trip' }, toTripId: { type: ObjectId, ref: 'Trip' }, at: Date, by: { type: ObjectId, ref: 'User' }, reason: String }, { _id: false })], default: undefined },
  writeOff: { type: writeOffSchema, default: undefined },
}, { _id: false, strict: 'throw' });

export const CONSIGNMENT_STATUSES = [
  'draft', 'booked', 'assigned', 'loading', 'loaded', 'in_transit', 'delivering', 'delivered', 'closed',
  'cancelled', 'returning', 'returned', 'written_off',
] as const;
export const PAYMENT_TERMS = ['to_be_billed', 'paid', 'to_pay'] as const;

/**
 * One consignor's goods moving under one contract to one consignee, at one rate: the unit of revenue. A trip
 * carries one or many; each has its own goods, parties, papers, pickups and drops (anywhere on the route) and
 * POD. Its status is worked out from its legs on every save.
 */
const consignmentSchema = new Schema<any>({
  number: { type: String, required: true },
  consignmentTypeId: { type: ObjectId, ref: 'ConsignmentType' },
  status: { type: String, enum: CONSIGNMENT_STATUSES, required: true, default: 'booked' },
  /** Who is billed; the trip's customer unless said otherwise. */
  customerId: { type: ObjectId, ref: 'Party', required: true },
  consignorPartyId: { type: ObjectId, ref: 'Party' },
  consignor: { type: contactSchema, default: undefined },
  consigneePartyId: { type: ObjectId, ref: 'Party' },
  consignee: { type: contactSchema, default: undefined },
  brokerPartyId: { type: ObjectId, ref: 'Party' },
  paymentTerms: { type: String, enum: PAYMENT_TERMS, default: 'to_be_billed' },
  /** The trip carrying it now. */
  tripId: { type: ObjectId, ref: 'Trip' },
  movements: { type: [movementSchema], default: [] },
  bookedAt: { type: Date, required: true },
  requiredBy: Date,
  lines: { type: [lineSchema], required: true },
  legs: { type: [legSchema], required: true },
  documents: { type: [consignmentDocumentSchema], default: [] },
  references: { type: referencesSchema, default: undefined },
  rate: { type: agreedRateSchema, default: undefined },
  revenue: { type: revenueSchema, default: undefined },
  /** The driver-side shortage (what the driver may pay for), worked out when the last drop is recorded. */
  shortage: { type: shortageSchema, default: undefined },
  outcome: { type: outcomeSchema, default: undefined },
  /** When the first pickup and the last drop were recorded: lists and the pricing date read these. */
  loadedAt: Date,
  deliveredAt: Date,
  /** From its first pickup to its last drop along the trip's stops (or the route master's figure), km. */
  leadKm: Number,
  cancelledAt: Date,
  cancelReason: String,
  notes: String,
  custom: { type: Schema.Types.Mixed, default: undefined },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
consignmentSchema.index({ number: 1 }, { unique: true });
consignmentSchema.index({ tripId: 1, status: 1 });
consignmentSchema.index({ customerId: 1, bookedAt: -1 });
consignmentSchema.index({ status: 1, bookedAt: -1 });
consignmentSchema.index({ 'legs.stopId': 1 }, { sparse: true });
consignmentSchema.index({ 'references.lrNo': 1 }, { sparse: true });
consignmentSchema.index({ customerId: 1, 'references.customerRef': 1 }, { unique: true, partialFilterExpression: { 'references.customerRef': { $type: 'string' } } });
consignmentSchema.index({ 'revenue.status': 1 }, { sparse: true });
consignmentSchema.index({ 'movements.tripId': 1 });
consignmentSchema.index({ updatedAt: 1 });
consignmentSchema.index({ 'shortage.status': 1 }, { sparse: true });
consignmentSchema.index({ loadedAt: -1 });

export const Consignment = opsModel('Consignment', consignmentSchema);

/** Statuses of a consignment that is finished with: nothing more happens to it on its trip. */
export const FINISHED = ['delivered', 'closed', 'cancelled', 'returned', 'written_off'] as const;
