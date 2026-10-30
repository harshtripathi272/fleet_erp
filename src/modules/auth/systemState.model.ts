import { Schema, model } from 'mongoose';

/** Small key/value flags, e.g. whether the first owner account has been claimed. */
const systemStateSchema = new Schema({
  key: { type: String, required: true },
  value: Schema.Types.Mixed,
}, { timestamps: true, versionKey: false });
systemStateSchema.index({ key: 1 }, { unique: true });

export const SystemState = model('SystemState', systemStateSchema);
