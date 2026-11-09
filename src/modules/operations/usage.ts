import { addUsageSource, type Usage } from '../../core/masters/references.js';
import { getMaster } from '../../core/masters/registry.js';
import { Types } from 'mongoose';
import { driverBalance } from './ledger.js';
import { Trip } from './models/trip.model.js';

/** What an open trip points at, by the master it's in. */
const ON_A_TRIP: Record<string, string[]> = {
  Vehicle: ['vehicleId'], Trailer: ['trailerId'], Driver: ['driverId'], Party: ['customerId'], Route: ['routeId'], Product: ['productId'], Place: ['stops.placeId'],
};

/**
 * What keeps a master record from being archived: work still under way on it. Finished trips don't: a truck that was
 * sold or a driver who has left stays on their old records, and comes off the lists used for new ones.
 */
addUsageSource(async (targetKey, id, activeOnly) => {
  if (!activeOnly) return [];
  const model = getMaster(targetKey)?.model.modelName ?? '';
  const usage: Usage[] = [];
  for (const path of ON_A_TRIP[model] ?? []) {
    const count = await Trip.countDocuments({ [path]: new Types.ObjectId(id), active: true });
    if (count) usage.push({ master: 'Trip', label: 'Trips under way', path, count });
  }
  if (model === 'Driver') {
    // Their account leaves the desks with them, so what's on it has to be settled first.
    const unsettled = await Trip.countDocuments({ driverId: new Types.ObjectId(id), active: false, settlementId: null, $or: [{ endedAt: { $ne: null } }, { settleAfterCancel: true }] });
    if (unsettled) usage.push({ master: 'Trip', label: 'Trips still to settle', path: 'driverId', count: unsettled });
    else if (await driverBalance(id)) usage.push({ master: 'Settlement', label: 'A balance still to settle', path: 'driverId', count: 1 });
  }
  return usage;
});
