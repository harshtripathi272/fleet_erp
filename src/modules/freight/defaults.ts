import { logger } from '../../core/logger/index.js';
import { getMaster } from '../../core/masters/registry.js';
import * as MasterService from '../../core/masters/service.js';
import type { Plain } from '../../core/masters/types.js';
import { ChargeType, ConsignmentDocumentType, ConsignmentType } from './models/freight.model.js';

/**
 * The freight lists every company starts with (consignments design 3.4): kinds of consignment, the papers that
 * travel with them and the kinds of money line on a bill. Ordinary records the company renames, adds to or
 * switches off. A list is filled only while it is empty, so a company that removed one of these keeps it removed.
 */

export const CONSIGNMENT_TYPE_DEFAULTS: Plain[] = [
  { code: 'FTL', name: 'Full load', description: "One customer's goods filling the truck.", cargoKind: 'weighed', defaultTariffBasis: 'per_consignment' },
  { code: 'PTL', name: 'Part load', description: 'Several customers on one truck, each loaded and dropped where it goes.', cargoKind: 'weighed', multiDrop: true, defaultTariffBasis: 'per_kg' },
  { code: 'BULK_LIQUID', name: 'Bulk liquid (fuel)', description: 'Fuel and other liquids, measured at 20 °C; may load at two terminals and be split between depots on the way.', cargoKind: 'volume', multiDrop: true, multiPickup: true, splitDecidedLate: true, defaultTariffBasis: 'per_litre_20' },
  { code: 'CONTAINER', name: 'Container', description: 'Containers counted per unit.', cargoKind: 'counted', defaultTariffBasis: 'per_piece' },
  { code: 'COURIER', name: 'Parcels', description: 'Small consignments counted by piece or weight.', cargoKind: 'counted', defaultTariffBasis: 'per_kg' },
];

export const DOCUMENT_TYPE_DEFAULTS: Plain[] = [
  { code: 'LOADING_INVOICE', name: 'Loading invoice', step: 'pickup', requiredBy: 'to_leave_stop', perLeg: true, hasAmount: true, driverKind: 'loading', readFields: ['docNo', 'qty', 'ambientL', 'tempC', 'density', 'certStd20L'], description: 'The supplier\'s invoice for what was loaded. The truck may not leave the loading point without it.' },
  { code: 'LOADING_CERT', name: 'Loading certificate / bill of lading', step: 'pickup', perLeg: true, driverKind: 'loading', readFields: ['docNo', 'ambientL', 'tempC', 'density', 'certStd20L'] },
  { code: 'WEIGHBRIDGE', name: 'Weighbridge ticket', step: 'pickup', perLeg: true, driverKind: 'weighbridge', readFields: ['docNo', 'qty'] },
  { code: 'LR', name: 'Consignment note', step: 'booking', description: 'Our own consignment note or lorry receipt.' },
  { code: 'EWAY', name: 'E-way bill', step: 'booking', hasValidity: true, driverKind: 'eway' },
  { code: 'PERMIT', name: 'Transit permit', step: 'transit', hasValidity: true, driverKind: 'permit' },
  { code: 'DELIVERY_NOTE', name: 'Delivery note', step: 'drop', perLeg: true, driverKind: 'delivery', readFields: ['docNo', 'qty', 'ambientL', 'tempC', 'density', 'certStd20L'] },
  { code: 'POD', name: 'Proof of delivery', step: 'drop', requiredBy: 'to_invoice', perLeg: true, hasDate: true, driverKind: 'pod', readFields: ['docNo'], description: 'Signed by the consignee. Billing waits for it.' },
  { code: 'SEAL_REPORT', name: 'Seal report', step: 'pickup', perLeg: true },
  { code: 'OTHER', name: 'Other paper', step: 'transit', hasNumber: false },
];

/** Phase 1 ships these five; a company adds its own (detention, tolls, labour) as it needs them. */
export const CHARGE_TYPE_DEFAULTS: Plain[] = [
  { code: 'FREIGHT', name: 'Freight', kind: 'freight', defaultBasis: 'per_consignment' },
  { code: 'MINIMUM', name: 'Minimum charge top-up', kind: 'minimum' },
  { code: 'EXTRA_DROP', name: 'Extra drop', kind: 'charge', defaultBasis: 'per_drop_beyond' },
  { code: 'SHORTAGE_DEDUCTION', name: 'Shortage deduction', kind: 'deduction', defaultBasis: 'shortage_beyond_allowance', taxable: false },
  { code: 'OTHER', name: 'Other charge', kind: 'charge' },
];

const LISTS = [
  { key: 'consignment-types', model: ConsignmentType, rows: CONSIGNMENT_TYPE_DEFAULTS },
  { key: 'consignment-document-types', model: ConsignmentDocumentType, rows: DOCUMENT_TYPE_DEFAULTS },
  { key: 'charge-types', model: ChargeType, rows: CHARGE_TYPE_DEFAULTS },
] as const;

/** Fills each freight list that is empty with its defaults. Returns how many records it made. */
export async function ensureFreightLists(actorId?: string) {
  let created = 0;
  for (const list of LISTS) {
    if (await list.model.exists({})) continue;
    const def = getMaster(list.key);
    for (const row of list.rows) {
      try {
        if (def) await MasterService.create(def, def.createSchema.parse(row) as Plain, { actorId, canSeeSensitive: true });
        else await list.model.create(row);
        created += 1;
      } catch (err) {
        // Two requests seeding at once: the other one made it.
        if ((err as { code?: number }).code !== 11000 && !/already exists|duplicate/i.test(String((err as Error).message))) logger.warn({ err, code: row.code }, 'A freight default could not be added');
      }
    }
  }
  return created;
}

/** A freight record by its code, filling the lists first on a company that has never had them. */
async function byCode<T>(model: { findOne: (q: Plain) => { lean: <R>() => Promise<R | null> } }, code: string): Promise<T | null> {
  const found = await model.findOne({ code, status: 'active' }).lean<T>();
  if (found) return found;
  if (await ensureFreightLists()) return model.findOne({ code, status: 'active' }).lean<T>();
  return null;
}

export const documentTypeByCode = (code: string) => byCode<Plain>(ConsignmentDocumentType as never, code);
export const chargeTypeByCode = (code: string) => byCode<Plain>(ChargeType as never, code);
export const consignmentTypeByCode = (code: string) => byCode<Plain>(ConsignmentType as never, code);
