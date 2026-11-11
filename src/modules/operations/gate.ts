import type { Plain } from '../../core/masters/types.js';
import { Place } from '../geography/models/place.model.js';
import { ConsignmentDocumentType } from '../freight/models/freight.model.js';
import { freightSettings } from '../freight/settings.js';
import { stopGate, type ConsignmentP, type Gate, type GateDocType, type StopP } from './legs.js';
import { Consignment } from './models/cargo.model.js';

/**
 * The stop that holds a trip's truck, read from the database (#135, design 3.7.2). Kept apart from the services so
 * trips, consignments and the driver app all ask the same question and get the same answer.
 */

/** Papers that must be in before the truck leaves the stop they belong to. */
export async function leaveStopDocTypes(): Promise<GateDocType[]> {
  return (await ConsignmentDocumentType.find({ status: 'active', requiredBy: 'to_leave_stop' }).select('name step driverKind').lean()) as unknown as GateDocType[];
}

export async function placeNames(ids: unknown[]) {
  const places = await Place.find({ _id: { $in: [...new Set(ids.filter(Boolean).map(String))] } }).select('name').lean();
  const names = new Map(places.map((p) => [String(p._id), String(p.name)]));
  return (id: unknown) => names.get(String(id)) ?? '—';
}

/** The gate for a trip, with its consignments when the caller has them already. */
export async function tripGate(trip: Plain, consignments?: Plain[]): Promise<Gate | null> {
  const stops = (trip.stops ?? []) as StopP[];
  const [settings, docTypes, names, list] = await Promise.all([
    freightSettings(), leaveStopDocTypes(), placeNames(stops.map((s) => s.placeId)),
    consignments ? Promise.resolve(consignments) : Consignment.find({ tripId: trip._id }).lean(),
  ]);
  return stopGate({ _id: trip._id, stops }, list as unknown as ConsignmentP[], settings, names, docTypes);
}
