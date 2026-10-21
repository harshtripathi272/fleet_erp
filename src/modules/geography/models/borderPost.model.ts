import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, moneySchema, masterModel } from '../../../core/masters/schema.js';

const borderPostSchema = masterSchema({
  ...codeNameFields,
  countryAId: { type: ObjectId, ref: 'Country', required: true },
  countryBId: { type: ObjectId, ref: 'Country', required: true },
  placeId: { type: ObjectId, ref: 'Place' },
  oneStopBorder: { type: Boolean, default: false },
  workingHours: String,
  typicalWaitHours: { type: Number, min: 0, max: 240 },
  fees: { type: [{ _id: false, description: String, amount: moneySchema }], default: undefined },
  clearingAgentPartyIds: { type: [{ type: ObjectId, ref: 'Party' }], default: undefined },
});
uniqueIndex(borderPostSchema, { code: 1 });

export const BorderPost = masterModel('BorderPost', borderPostSchema);
