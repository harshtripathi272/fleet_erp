import mongoose, { Schema, model, type Model, type SchemaDefinition, type SchemaOptions } from 'mongoose';

export const { ObjectId } = Schema.Types;
export const STATUSES = ['active', 'inactive', 'archived'] as const;

export const moneySchema = new Schema({
  amountMinor: { type: Number, required: true, min: 0 },
  currencyId: { type: ObjectId, ref: 'Currency', required: true },
}, { _id: false });

/** Optional nested object stored only when provided. */
export const subdoc = (fields: SchemaDefinition) => ({ type: new Schema(fields, { _id: false, strict: 'throw' }), default: undefined });

export const addressSchema = new Schema({
  line1: { type: String, required: true },
  line2: String,
  cityId: { type: ObjectId, ref: 'City' },
  postalCode: String,
}, { _id: false });

export const locationSchema = new Schema({
  lat: { type: Number, required: true, min: -90, max: 90 },
  lng: { type: Number, required: true, min: -180, max: 180 },
}, { _id: false });

const baseFields: SchemaDefinition = {
  status: { type: String, enum: STATUSES, default: 'active', index: true },
  validFrom: Date,
  validTo: Date,
  branchIds: { type: [{ type: ObjectId, ref: 'Branch' }], default: undefined },
  tags: { type: [String], default: undefined },
  notes: String,
  externalRefs: { type: [{ _id: false, system: String, ref: String }], default: undefined },
  attachments: { type: [{ _id: false, name: String, url: String, mime: String, sizeBytes: Number }], default: undefined },
  custom: { type: Schema.Types.Mixed, default: () => ({}) },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
  archivedAt: Date,
  archivedBy: { type: ObjectId, ref: 'User' },
  archiveReason: String,
};

export const schemaOptions: SchemaOptions<any> = {
  timestamps: true,
  versionKey: 'version',
  optimisticConcurrency: true,
  minimize: false,
  strict: 'throw',
};

/** A Mongoose schema with the standard master fields (status, validity, audit, custom fields). */
/** Masters are typed loosely; services validate shapes with Zod before writing. */
export function masterSchema(fields: SchemaDefinition, options: SchemaOptions = {}): Schema<any> {
  return new Schema<any>({ ...fields, ...baseFields }, { ...schemaOptions, ...options } as SchemaOptions<any>);
}

/** True when the value looks like a Mongo ObjectId. */
export const isObjectId = (value: unknown) => typeof value === 'string' && mongoose.isValidObjectId(value) && /^[0-9a-f]{24}$/i.test(value);

/** Registers a master model. Records are loosely typed; Zod validates every write first. */
export function masterModel(name: string, schema: Schema<any>): Model<any> {
  return model<any>(name, schema) as Model<any>;
}
