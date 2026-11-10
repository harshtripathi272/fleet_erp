import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, addressSchema, locationSchema, masterSchema, subdoc, masterModel } from '../../../core/masters/schema.js';

export const PLACE_TYPES = ['depot', 'terminal', 'refinery', 'mine', 'port', 'customer_site', 'yard', 'fuel_station', 'border', 'weighbridge', 'workshop', 'parking', 'office', 'other'] as const;

const placeSchema = masterSchema({
  ...codeNameFields,
  type: { type: String, enum: PLACE_TYPES, required: true, index: true },
  cityId: { type: ObjectId, ref: 'City', index: true },
  address: { type: addressSchema, default: undefined },
  location: locationSchema,
  /** GeoJSON copy of `location` for distance queries. */
  geo: subdoc({ type: { type: String, enum: ['Point'], required: true }, coordinates: { type: [Number], required: true } }),
  geofenceRadiusM: { type: Number, default: 300, min: 25, max: 50000 },
  /** A geofence drawn as a shape, corner by corner (#136); without one, the circle of geofenceRadiusM around the location. */
  geofencePolygon: { type: [locationSchema], default: undefined },
  openingHours: String,
  contactName: String,
  contactPhone: String,
  ownerPartyId: { type: ObjectId, ref: 'Party' },
});
uniqueIndex(placeSchema, { code: 1 });
placeSchema.index({ geo: '2dsphere' }, { sparse: true });

export const Place = masterModel('Place', placeSchema);
