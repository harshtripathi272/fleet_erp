import { z } from 'zod';
import { FIELD_TYPES } from '../../core/masters/dynamicFields.js';
import { FIELD_ANSWERERS, FIELD_DOCUMENTS } from './models/configuration.model.js';
import { baseShape, code, customKey, integer, name, objectId, regexText, text, toUpdateSchema } from '../../core/masters/zod.js';

export const listShape = {
  code, name, description: text(500).optional(),
  values: z.array(z.strictObject({
    value: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/, 'Lowercase value, e.g. o_positive'),
    label: text(80),
    order: integer(0, 1000).optional(),
    active: z.boolean().optional(),
  })).min(1).max(500),
  ...baseShape,
};

const fieldSpec = {
  key: z.string().regex(customKey, 'camelCase key, e.g. unionNumber'),
  label: text(80),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(text(80)).min(1).max(200).optional(),
  listId: objectId.optional(),
  referenceMaster: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  maxLength: integer(1, 5000).optional(),
  pattern: regexText.optional(),
  helpText: text(300).optional(),
  order: integer(0, 1000).optional(),
};

export const fieldDefinitionShape = {
  entity: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'A master key such as "drivers"'),
  ...fieldSpec,
  placement: z.string().regex(/^[a-z_]{2,30}$/).optional(),
  askedOf: z.enum(FIELD_ANSWERERS).optional(),
  printOn: z.array(z.enum(FIELD_DOCUMENTS)).max(2).optional(),
  ...baseShape,
};

export const customMasterShape = {
  code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{1,39}$/, 'Lowercase key, e.g. health-cards'),
  name, description: text(500).optional(),
  fields: z.array(z.strictObject(fieldSpec)).min(1).max(60),
  titleField: z.string().regex(customKey),
  ...baseShape,
};

export const customRecordShape = {
  data: z.record(z.string().regex(customKey), z.unknown()),
  ...baseShape,
};

export const createListSchema = z.strictObject(listShape);
export const updateListSchema = toUpdateSchema(listShape);
export const createFieldDefinitionSchema = z.strictObject(fieldDefinitionShape);
export const updateFieldDefinitionSchema = toUpdateSchema(fieldDefinitionShape);
export const createCustomMasterSchema = z.strictObject(customMasterShape);
export const updateCustomMasterSchema = toUpdateSchema(customMasterShape);
export const createCustomRecordSchema = z.strictObject(customRecordShape);
export const updateCustomRecordSchema = toUpdateSchema(customRecordShape);

export const listCodeParams = z.strictObject({ code: z.string().trim().min(1).max(32).transform((v) => v.toUpperCase()) });
export const recordParams = z.strictObject({ masterId: objectId });
export const recordIdParams = z.strictObject({ masterId: objectId, id: objectId });
