import { Company, FREIGHT_DEFAULTS } from '../company/company.model.js';
import { billingSettings } from '../finance/settings.service.js';

export type FreightSettings = Omit<typeof FREIGHT_DEFAULTS, 'chargeOnDefault' | 'shortageDeductionDefault'> & {
  chargeOnDefault: NonNullable<(typeof FREIGHT_DEFAULTS)['chargeOnDefault']>;
  shortageDeductionDefault: NonNullable<(typeof FREIGHT_DEFAULTS)['shortageDeductionDefault']>;
};

const defined = (o: object | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null));

/**
 * Company → Freight, with the defaults filling any gap (#135). The quantity charged and the customer-side shortage
 * fall back to the two Money settings that decided them before consignments, so a company that changed those keeps
 * its invoices exactly as they were.
 */
export async function freightSettings(): Promise<FreightSettings> {
  const company = await Company.findOne().select('freight').lean<{ freight?: Partial<typeof FREIGHT_DEFAULTS> }>();
  const own = defined(company?.freight) as Partial<typeof FREIGHT_DEFAULTS>;
  const merged = { ...FREIGHT_DEFAULTS, ...own } as typeof FREIGHT_DEFAULTS;
  let { chargeOnDefault, shortageDeductionDefault } = merged;
  if (!chargeOnDefault || !shortageDeductionDefault) {
    const billing = await billingSettings();
    chargeOnDefault ??= billing.billOn;
    shortageDeductionDefault ??= billing.shortageOnInvoice === 'none' ? 'none' : 'beyond_allowance';
  }
  return {
    ...merged,
    defaultConsignmentTypeId: merged.defaultConsignmentTypeId ? String(merged.defaultConsignmentTypeId) : undefined,
    chargeOnDefault, shortageDeductionDefault,
  };
}

/**
 * Settings stored now that a later phase of the consignments design acts on. The settings screen says
 * "Not built yet" beside each, so nobody takes a switch that does nothing for one that works.
 */
export const NOT_BUILT: Array<keyof typeof FREIGHT_DEFAULTS> = [
  'createPlacesFromAddresses', 'duplicateCheck', 'bookWithoutTrip', 'podPerStopAllowed', 'notifyConsignee', 'ewayBillWarnHours',
  'detentionShare', 'costShareBy', 'invoiceWithoutPod', 'overheadPerKmMinor', 'overheadPerDayMinor',
];
/** Values of a built setting that a later phase acts on. */
export const NOT_BUILT_VALUES: Record<string, string[]> = { shortageScopeDefault: ['drop'], transferRevenueSplit: ['by_km'], profitCosts: ['overhead'] };
