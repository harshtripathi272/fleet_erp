import { model, type Model, type Schema } from 'mongoose';

/** Registers a trip-side model. Records are loosely typed, like masters; Zod validates every write first. */
export const opsModel = (name: string, schema: Schema<any>): Model<any> => model<any>(name, schema) as Model<any>;
