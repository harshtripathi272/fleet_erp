import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, moneySchema, subdoc, masterModel } from '../../../core/masters/schema.js';

export const PACKAGING = ['bulk', 'bags', 'drums', 'pallets', 'cartons', 'containers', 'loose'] as const;

/** What is carried. Fuel products carry density and the 20 °C reference used for shortage. */
const productSchema = masterSchema({
  ...codeNameFields,
  groupId: { type: ObjectId, ref: 'ProductGroup', required: true, index: true },
  unitId: { type: ObjectId, ref: 'Unit', required: true },
  hazard: subdoc({ unClass: { type: String, required: true }, unNumber: String, packingGroup: String }),
  densityKgPerL: Number,
  volumeCorrected: { type: Boolean, default: false },
  referenceTemperatureC: Number,
  shortageAllowancePercent: { type: Number, min: 0, max: 10 },
  shortagePricePerUnit: moneySchema,
  packaging: { type: String, enum: PACKAGING },
  allowedTrailerTypeIds: { type: [{ type: ObjectId, ref: 'TrailerType' }], default: undefined },
});
uniqueIndex(productSchema, { code: 1 });

export const Product = masterModel('Product', productSchema);
