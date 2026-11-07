import { Schema } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { FIELD_TYPES } from '../../../core/masters/dynamicFields.js';
import { FILE_KINDS } from '../../../core/masters/fileFields.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

/** A short list with no master of its own: blood groups, colours, religions… */
const listSchema = masterSchema({
  ...codeNameFields,
  values: { type: [{ _id: false, value: String, label: String, order: Number, active: { type: Boolean, default: true } }], default: [] },
});
uniqueIndex(listSchema, { code: 1 });
export const List = masterModel('List', listSchema);

const fieldSpec = {
  key: { type: String, required: true },
  label: { type: String, required: true },
  type: { type: String, enum: FIELD_TYPES, required: true },
  required: { type: Boolean, default: false },
  options: { type: [String], default: undefined },
  listId: { type: ObjectId, ref: 'List' },
  referenceMaster: String,
  min: Number,
  max: Number,
  maxLength: Number,
  pattern: String,
  helpText: String,
  order: { type: Number, default: 100 },
  /** File fields (#97). */
  maxSizeMb: Number,
  maxFiles: Number,
  accept: { type: [{ type: String, enum: FILE_KINDS }], default: undefined },
  withExpiry: Boolean,
};

/**
 * The operational records a company can add fields to (#67), and the steps of each where a field is asked.
 * A trip is filled in step by step on the desks, so its fields say which step they belong to.
 */
export const PLACEMENTS: Record<string, string[]> = {
  trips: ['create', 'dispatch', 'close'],
  consignments: ['loading', 'delivery'],
  'fund-requests': ['ask', 'approve', 'pay'],
  expenses: ['submit', 'approve'],
  settlements: ['post'],
  nominations: ['create'],
};
export const FIELD_ANSWERERS = ['office', 'driver'] as const;
/** The documents a company field can print on. */
export const FIELD_DOCUMENTS = ['trip_sheet', 'driver_statement'] as const;

/** An extra field a company adds to a built-in master or an operational record, stored under `custom.<key>`. */
const fieldDefinitionSchema = masterSchema({
  entity: { type: String, required: true },
  ...fieldSpec,
  /** Operational records only: the step where it is asked, who answers it, and the documents it prints on. */
  placement: String,
  askedOf: { type: String, enum: FIELD_ANSWERERS },
  printOn: { type: [{ type: String, enum: FIELD_DOCUMENTS }], default: undefined },
});
fieldDefinitionSchema.index({ entity: 1, key: 1 }, { unique: true });
export const FieldDefinition = masterModel('FieldDefinition', fieldDefinitionSchema);

/** A master defined entirely by the company, e.g. "Health cards". */
const customMasterSchema = masterSchema({
  ...codeNameFields,
  fields: { type: [new Schema(fieldSpec, { _id: false })], required: true },
  titleField: { type: String, required: true },
});
uniqueIndex(customMasterSchema, { code: 1 });
export const CustomMaster = masterModel('CustomMaster', customMasterSchema);

const customRecordSchema = masterSchema({
  masterId: { type: ObjectId, ref: 'CustomMaster', required: true },
  title: { type: String, required: true },
  data: { type: Schema.Types.Mixed, default: () => ({}) },
});
customRecordSchema.index({ masterId: 1, title: 1 });
export const CustomRecord = masterModel('CustomRecord', customRecordSchema);
