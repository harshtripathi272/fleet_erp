/** The areas of the business a company can switch on and off (#56): plain data, read by the company model and areas.ts. */
export type AreaState = 'live' | 'early' | 'not-built';
export interface Area {
  key: string; name: string; description: string; state: AreaState; defaultOn: boolean; always?: boolean;
  /** An area inside another: on only while that one is on too. */
  within?: string;
}

export const AREAS = [
  { key: 'masters', name: 'Masters', description: 'Trucks, drivers, customers, places and every other list the work draws on.', state: 'live', defaultOn: true, always: true },
  { key: 'trips', name: 'Trips and nominations', description: "Planning, dispatching and closing trips, and customers' nominations.", state: 'live', defaultOn: true },
  { key: 'finance', name: 'Money', description: 'Fuel and cash requests, expenses, and settling drivers.', state: 'live', defaultOn: true },
  { key: 'tracking', name: 'Tracking', description: "Where each truck is and how fast it moves, from the driver's phone or a tracker.", state: 'live', defaultOn: true },
  { key: 'driver-app', name: 'Driver app', description: 'Drivers sign in on their phone to see their trip, send receipts and report arrivals.', state: 'live', defaultOn: true },
  { key: 'maintenance', name: 'Maintenance', description: 'Service plans, what is due on each truck, work orders, and what each truck costs to keep on the road.', state: 'early', defaultOn: false },
  { key: 'parts', name: 'Parts', description: 'Inside Maintenance: the parts used on each work order, with their costs.', state: 'early', defaultOn: false, within: 'maintenance' },
  { key: 'tyres', name: 'Tyres', description: 'Inside Maintenance: tyres fitted, rotated and replaced on each truck, by position and odometer.', state: 'early', defaultOn: false, within: 'maintenance' },
  { key: 'billing', name: 'Billing', description: 'Customer rates, invoices, payments received and exchange gain or loss.', state: 'not-built', defaultOn: false },
  { key: 'customer-portal', name: 'Customer portal', description: 'Customers sign in to follow their own loads, delivery proof and invoices.', state: 'not-built', defaultOn: false },
] as const satisfies readonly Area[];

export type AreaKey = (typeof AREAS)[number]['key'];
export const AREA_KEYS = AREAS.map((a) => a.key) as [AreaKey, ...AreaKey[]];
export const areaOf = (key: string) => AREAS.find((a) => a.key === key) as Area | undefined;
/** The areas switched on when a company has never chosen. */
export const DEFAULT_AREAS: AreaKey[] = AREAS.filter((a) => a.defaultOn).map((a) => a.key);

