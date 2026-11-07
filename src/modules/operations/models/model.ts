import { fileLinks } from '../../../core/masters/fileFields.js';
import { model, type Model, type Schema } from 'mongoose';

/** Operational records a company can add fields to (#67), by model: a file one of them holds opens for whoever reads it (#97). */
const WITH_FIELDS: Record<string, string> = { Trip: 'trips', Consignment: 'consignments', FundRequest: 'fund-requests', Expense: 'expenses', Settlement: 'settlements', Nomination: 'nominations' };
/** Registers a trip-side model. Records are loosely typed, like masters; Zod validates every write first. */
export const opsModel = (name: string, schema: Schema<any>): Model<any> => {
  if (WITH_FIELDS[name] && schema.path('custom')) schema.plugin(fileLinks(WITH_FIELDS[name]) as never);
  return model<any>(name, schema) as Model<any>;
};
