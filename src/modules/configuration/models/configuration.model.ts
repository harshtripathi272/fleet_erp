import { Schema } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { FIELD_TYPES } from '../../../core/masters/dynamicFields.js';
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
};

/** An extra field a company adds to a built-in master, stored under `custom.<key>`. */
const fieldDefinitionSchema = masterSchema({ entity: { type: String, required: true }, ...fieldSpec });
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
