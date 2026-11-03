import { Schema, model } from 'mongoose';

/** One attempt to fetch the day's exchange rates: what was stored, skipped, or why it failed. */
const rateFeedRunSchema = new Schema({
  at: { type: Date, default: () => new Date() },
  provider: { type: String, required: true },
  outcome: { type: String, enum: ['stored', 'failed', 'off'], required: true },
  /** The company-time date the rates were stored for. */
  effectiveDate: Date,
  stored: { type: Number, default: 0 },
  /** Pairs left alone because someone entered that day's rate by hand or from the bank. */
  keptManual: { type: Number, default: 0 },
  missing: { type: [String], default: [] },
  error: String,
  trigger: { type: String, enum: ['schedule', 'manual'], default: 'schedule' },
}, { versionKey: false, strict: 'throw' });
rateFeedRunSchema.index({ at: -1 });

export const RateFeedRun = model('RateFeedRun', rateFeedRunSchema);
