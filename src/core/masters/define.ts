import type { Schema } from 'mongoose';
import type { MasterDefinition } from './types.js';

type Draft = Omit<MasterDefinition, 'searchFields' | 'sortFields' | 'updateSchema'> & Partial<Pick<MasterDefinition, 'searchFields' | 'sortFields' | 'updateSchema'>>;

/** Fills the defaults most code + name masters share. */
export function defineMaster(draft: Draft & { updateSchema: MasterDefinition['updateSchema'] }): MasterDefinition {
  return {
    searchFields: ['code', 'name'],
    sortFields: ['code', 'name', 'createdAt', 'updatedAt'],
    defaultSort: 'code',
    titleField: 'name',
    ...draft,
  };
}

/** Code + name fields with a unique code. */
export const codeNameFields = {
  code: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: String,
};

/** Case-insensitive unique index, e.g. on (cityId, name). */
export function uniqueIndex(schema: Schema, fields: Record<string, 1 | -1>, partial?: Record<string, unknown>) {
  schema.index(fields, { unique: true, collation: { locale: 'en', strength: 2 }, ...(partial ? { partialFilterExpression: partial } : {}) });
}
