import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

/** A truck and trailer running together from `from` until `to`. Open pairings have open = true. */
const pairingSchema = masterSchema({
  vehicleId: { type: ObjectId, ref: 'Vehicle', required: true },
  trailerId: { type: ObjectId, ref: 'Trailer', required: true },
  from: { type: Date, required: true },
  to: Date,
  open: { type: Boolean, default: true },
  reason: String,
  endReason: String,
});
// A truck and a trailer can each be in only one open pairing; the database enforces it under concurrency.
pairingSchema.index({ vehicleId: 1 }, { unique: true, partialFilterExpression: { open: true } });
pairingSchema.index({ trailerId: 1 }, { unique: true, partialFilterExpression: { open: true } });
pairingSchema.index({ vehicleId: 1, from: -1 });
pairingSchema.index({ trailerId: 1, from: -1 });

export const Pairing = masterModel('Pairing', pairingSchema);
