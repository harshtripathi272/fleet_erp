import { Schema } from 'mongoose';
import { opsModel } from './model.js';
import { ObjectId, moneySchema, schemaOptions } from '../../../core/masters/schema.js';
import { approvalSchema } from './funding.model.js';

export const DOC_KINDS = ['loading', 'delivery', 'expense', 'fuel', 'other'] as const;
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

/** What was loaded on a trip and what was delivered, with any shortage beyond the allowance. */
const consignmentSchema = new Schema<any>({
  number: { type: String, required: true },
  tripId: { type: ObjectId, ref: 'Trip', required: true },
  productId: { type: ObjectId, ref: 'Product', required: true },
  invoiceNo: { type: String, required: true },
  consignor: String,
  consignee: String,
  loadedAt: { type: Date, required: true },
  loadDocId: { type: ObjectId, ref: 'DriverDocument' },
  load: { type: measureSchema, required: true },
  delivered: { type: measureSchema, default: undefined },
  /** True from loading until delivery; one load in transit per trip. */
  inTransit: { type: Boolean, default: true },
  shortage: { type: shortageSchema, default: undefined },
  /** Going back to the consignor instead of on to the consignee (#64). */
  returned: { type: new Schema({ at: Date, by: { type: ObjectId, ref: 'User' }, reason: String, placeId: { type: ObjectId, ref: 'Place' } }, { _id: false }), default: undefined },
  /** Each move to another truck, oldest first; `tripId` is the trip carrying it now. */
  transfers: { type: [new Schema({ fromTripId: { type: ObjectId, ref: 'Trip' }, toTripId: { type: ObjectId, ref: 'Trip' }, at: Date, by: { type: ObjectId, ref: 'User' }, reason: String }, { _id: false })], default: undefined },
  writeOff: { type: writeOffSchema, default: undefined },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
consignmentSchema.index({ number: 1 }, { unique: true });
consignmentSchema.index({ tripId: 1 });
consignmentSchema.index({ tripId: 1, inTransit: 1 }, { unique: true, partialFilterExpression: { inTransit: true } });
consignmentSchema.index({ updatedAt: 1 });
// Shortages waiting for a decision, and the paged list.
consignmentSchema.index({ 'shortage.status': 1 }, { sparse: true });
consignmentSchema.index({ loadedAt: -1 });

export const Consignment = opsModel('Consignment', consignmentSchema);
