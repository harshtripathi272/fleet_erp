import { Types } from 'mongoose';
import { z } from 'zod';
import { ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { idQuery } from '../../core/masters/query.js';
import type { Plain } from '../../core/masters/types.js';
import { ChargeType, ConsignmentDocumentType, ConsignmentType, FuelPrice, RATE_BASES, Tariff } from './models/freight.model.js';
import * as S from './freight.schema.js';

/**
 * The freight masters (#135, consignments design 3.4). They belong to Trips, not Billing: a consignment is priced
 * and a trip's profit worked out whether or not the company invoices from this app (correction 12 in 3.4.7).
 */

const byId = (path: string, description: string) => ({ schema: idQuery, apply: (v: string) => ({ [path]: new Types.ObjectId(v) }), description });

/** How each basis reads on a screen, with the sentence the tariff editor shows under it. */
export const BASIS_LABELS: Record<(typeof RATE_BASES)[number], string> = {
  per_consignment: 'Fixed, per consignment', per_trip: 'Fixed, per trip', per_tonne: 'Per tonne', per_kg: 'Per kg',
  per_litre: 'Per litre (as measured)', per_litre_20: 'Per litre at 20 °C', per_m3: 'Per cubic metre', per_piece: 'Per piece',
  per_km: 'Per km', per_tonne_km: 'Per tonne-km', per_drop_beyond: 'Per drop after the free ones', shortage_beyond_allowance: 'Shortage beyond the allowance',
};
export const BASIS_SENTENCES: Record<(typeof RATE_BASES)[number], string> = {
  per_consignment: 'The price, once for the consignment.',
  per_trip: "The price, once per trip and customer: the customer's first consignment on the trip carries it.",
  per_tonne: 'Price × tonnes charged.', per_kg: 'Price × kg charged.', per_litre: 'Price × litres as measured.',
  per_litre_20: 'Price × litres at 20 °C.', per_m3: 'Price × cubic metres.', per_piece: 'Price × pieces.',
  per_km: 'Price × the distance the tariff charges on.', per_tonne_km: 'Price × tonnes × km.',
  per_drop_beyond: 'Price × drops after the free ones (one free unless the line says).',
  shortage_beyond_allowance: "Less the loss beyond the allowance × the price (or the product's shortage price).",
};

const CHARGE_ON_LABELS = { loaded: 'Loaded quantity', delivered: 'Delivered quantity', planned: 'Planned quantity', greater_of: 'The greater of loaded and delivered', lesser_of: 'The lesser of loaded and delivered' };
const PRICE_ON_LABELS = { pickup_date: 'The day it was loaded', delivery_date: 'The day it was delivered', booking_date: 'The day it was booked', trip_dispatch: 'The day the truck left' };
const DISTANCE_LABELS = { route_lead: "The consignment's own lead distance", trip_loaded_km: "The trip's loaded km", manual: 'A distance typed on the consignment' };
const SHORTAGE_LABELS = { none: 'Nothing deducted', beyond_allowance: 'Loss beyond the allowance deducted', all: 'All loss deducted' };
const CARGO_KIND_LABELS = { volume: 'Liquids measured at 20 °C', weighed: 'Weighed goods', counted: 'Counted goods' };
const STEP_LABELS = { booking: 'When it is booked', pickup: 'At loading', transit: 'On the road', drop: 'At delivery', close: 'When the trip closes' };

export const consignmentTypeDefinition = defineMaster({
  key: 'consignment-types', label: 'Consignment types', singular: 'Consignment type', group: GROUPS.cargo, module: 'trips',
  description: 'Full load, part load, bulk liquid, container, parcels. Each type says how its goods are measured, whether it may load or drop at several places, whether its drops may be decided on the road, and which papers it needs.',
  model: ConsignmentType, createSchema: S.createConsignmentTypeSchema, updateSchema: S.updateConsignmentTypeSchema,
  refs: [{ path: 'requiredDocuments.documentTypeId', target: 'consignment-document-types' }, { path: 'podTypeId', target: 'pod-types' }],
  columns: ['cargoKind', 'multiDrop', 'multiPickup', 'splitDecidedLate'],
  labels: { cargoKind: 'Measured as', multiDrop: 'Several drops', multiPickup: 'Several pickups', splitDecidedLate: 'Drops decided on the road', defaultTariffBasis: 'Usually charged', requiredDocuments: 'Papers it needs', podTypeId: 'Proof of delivery', requireConsigneeParty: 'Consignee must be a customer record' },
  choiceLabels: { cargoKind: CARGO_KIND_LABELS, defaultTariffBasis: BASIS_LABELS, 'requiredDocuments.step': STEP_LABELS },
  hints: {
    splitDecidedLate: 'Its drops may be left "to be confirmed" when it is planned, and split between places once the truck is on the road.',
    defaultTariffBasis: 'A starting point for a new tariff of this type; the tariff decides.',
    requiredDocuments: 'On top of the papers every consignment needs (Consignment document types).',
  },
});

export const consignmentDocumentTypeDefinition = defineMaster({
  key: 'consignment-document-types', label: 'Consignment document types', singular: 'Consignment document type', group: GROUPS.cargo, module: 'trips',
  description: "The papers that travel with a consignment: loading invoice, weighbridge ticket, delivery note, proof of delivery and the company's own. Each says when it is expected and what waits for it. Truck and driver papers are Document types.",
  model: ConsignmentDocumentType, createSchema: S.createConsignmentDocumentTypeSchema, updateSchema: S.updateConsignmentDocumentTypeSchema,
  columns: ['step', 'requiredBy', 'perLeg', 'driverKind'],
  labels: { step: 'Expected', requiredBy: 'Waits for it', perLeg: 'One per pickup or drop', hasNumber: 'Has a number', hasDate: 'Has a date', hasAmount: 'Has an amount', hasValidity: 'Has an expiry', driverKind: 'From the phone it is a', readFields: 'Driver types' },
  choiceLabels: {
    step: STEP_LABELS,
    requiredBy: { none: 'Nothing', to_leave_stop: 'The truck leaving the stop', to_close_trip: 'Closing the trip', to_invoice: 'Invoicing' },
    driverKind: { loading: 'Loading invoice', delivery: 'Delivery note', pod: 'Proof of delivery', weighbridge: 'Weighbridge ticket', permit: 'Permit', eway: 'E-way bill', other: 'Other paper' },
    readFields: { docNo: 'Document number', qty: 'Quantity', ambientL: 'Litres observed', tempC: 'Temperature', density: 'Density', certStd20L: 'Litres at 20 °C on the certificate' },
  },
  hints: {
    requiredBy: '"The truck leaving the stop" holds it at the loading or offloading point until this paper is recorded (Company → Freight decides whether papers hold a truck at all). "Invoicing" keeps the consignment off invoices until it is in.',
    readFields: 'What the phone asks the driver to type with the photo. A person checks the figures before they are recorded.',
  },
});

export const chargeTypeDefinition = defineMaster({
  key: 'charge-types', label: 'Charge types', singular: 'Charge type', group: GROUPS.money, module: 'trips',
  description: 'The kinds of money line on a consignment and its invoice: freight, the minimum charge, extra drops, shortage deductions, and any the company adds. Each says how it is usually worked out.',
  model: ChargeType, createSchema: S.createChargeTypeSchema, updateSchema: S.updateChargeTypeSchema,
  refs: [{ path: 'defaultPrice.currencyId', target: 'currencies' }],
  columns: ['kind', 'direction', 'defaultBasis', 'taxable'],
  labels: { kind: 'What it is', direction: 'Who pays', defaultBasis: 'Usually worked out', defaultPrice: 'Usual price', taxable: 'Taxed', printLabel: 'Words on the invoice' },
  choiceLabels: {
    kind: { freight: 'Freight', minimum: 'Minimum charge top-up', charge: 'Extra charge', deduction: 'Deduction' },
    direction: { revenue: 'Billed to the customer', cost: 'A cost the company pays' },
    defaultBasis: BASIS_LABELS,
  },
  hints: {
    direction: 'A cost (a broker\'s commission, a hired truck) lowers the trip\'s profit and is never put on the customer\'s invoice.',
    printLabel: 'Leave empty to print the name.',
  },
});

export const tariffDefinition = defineMaster({
  key: 'tariffs', label: 'Tariffs', singular: 'Tariff', group: GROUPS.money, module: 'trips',
  description: 'What a customer pays to move a consignment: who it is for, when it applies, and its charge lines (fixed, per tonne, kg, litre, litre at 20 °C, m³, piece, km or tonne-km; extra drops; shortage deductions), with a minimum. The most specific tariff wins: a customer and route beat a customer alone.',
  model: Tariff, createSchema: S.createTariffSchema, updateSchema: S.updateTariffSchema,
  sortFields: ['code', 'name', 'validFrom', 'priority', 'createdAt', 'updatedAt'],
  refs: [
    { path: 'customerId', target: 'parties' }, { path: 'consignorPartyId', target: 'parties' }, { path: 'consignmentTypeId', target: 'consignment-types' },
    { path: 'routeId', target: 'routes' }, { path: 'fromPlaceId', target: 'places' }, { path: 'toPlaceId', target: 'places' },
    { path: 'fromCountryId', target: 'countries' }, { path: 'toCountryId', target: 'countries' }, { path: 'productId', target: 'products' },
    { path: 'productGroupId', target: 'product-groups' }, { path: 'vehicleTypeId', target: 'vehicle-types' }, { path: 'currencyId', target: 'currencies' },
    { path: 'lines.chargeTypeId', target: 'charge-types' }, { path: 'lines.price.currencyId', target: 'currencies' },
    { path: 'minimumCharge.currencyId', target: 'currencies' },
  ],
  columns: ['customerId', 'routeId', 'productId', 'currencyId', 'chargeOn', 'validFrom', 'priority'],
  labels: {
    customerId: 'Customer', consignorPartyId: 'Consignor', consignmentTypeId: 'Consignment type', routeId: 'Route', fromPlaceId: 'From place', toPlaceId: 'To place',
    fromCountryId: 'From country', toCountryId: 'To country', productId: 'Product', productGroupId: 'Product group', vehicleTypeId: 'Vehicle type', currencyId: 'Currency',
    priceOn: 'Priced on', chargeOn: 'Charged on', distanceSource: 'Distance from', shortageDeduction: 'Shortage', shortageAllowancePercent: 'Allowance %', taxRatePercent: 'VAT %',
    lines: 'Charge lines', 'lines.chargeTypeId': 'Charge', 'lines.basis': 'Worked out', 'lines.price': 'Price', 'lines.freeQty': 'Free drops', 'lines.minimum': 'At least', 'lines.maximum': 'At most',
    minimumCharge: 'Minimum charge', priority: 'Priority', validFrom: 'From', validTo: 'Until',
  },
  choiceLabels: { chargeOn: CHARGE_ON_LABELS, priceOn: PRICE_ON_LABELS, distanceSource: DISTANCE_LABELS, shortageDeduction: SHORTAGE_LABELS, 'lines.basis': BASIS_LABELS },
  hints: {
    customerId: 'Leave empty for a rate card that applies to every customer.',
    routeId: "Leave empty for any route. A tariff for the trip's route wins over one without.",
    chargeOn: 'Empty: the company\'s default (Company → Freight).',
    shortageDeduction: 'What the customer deducts for goods lost on the way. Separate from what the driver pays (Shortage policies). Empty: the company\'s default.',
    shortageAllowancePercent: "Empty: the driver-side allowance for the product.",
    minimumCharge: 'The least the freight comes to, in the tariff\'s currency.',
    priority: 'Breaks a tie between two equally specific tariffs: the higher number wins.',
  },
  filters: {
    customerId: byId('customerId', 'Customer'),
    routeId: byId('routeId', 'Route'),
    productId: byId('productId', 'Product'),
    chargeOn: { schema: z.enum(['loaded', 'delivered', 'planned', 'greater_of', 'lesser_of']), apply: (v: string) => ({ chargeOn: v }), description: 'Charged on' },
  },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    const currency = String(data.currencyId ?? '');
    const sameCurrency = (m: unknown) => !m || String((m as Plain).currencyId) === currency;
    if (!sameCurrency(data.minimumCharge)) errors.minimumCharge = ["Use the tariff's currency"];
    const lines = (data.lines ?? []) as Plain[];
    lines.forEach((line, i) => {
      const at = `lines.${i}`;
      for (const key of ['price', 'minimum', 'maximum']) if (!sameCurrency(line[key])) errors[`${at}.${key}`] = ["Use the tariff's currency"];
      if (!line.price && line.basis !== 'shortage_beyond_allowance') errors[`${at}.price`] = ['Enter the price'];
      if (line.freeQty !== undefined && line.basis !== 'per_drop_beyond') errors[`${at}.freeQty`] = ['Only an extra-drop line has free drops'];
      const min = (line.minimum as Plain | undefined)?.amountMinor, max = (line.maximum as Plain | undefined)?.amountMinor;
      if (min !== undefined && max !== undefined && Number(min) > Number(max)) errors[`${at}.maximum`] = ['At most must be more than at least'];
    });
    const chargeTypes = new Map((await ChargeType.find({ _id: { $in: lines.map((l) => l.chargeTypeId) } }).select('kind').lean()).map((c) => [String(c._id), String(c.kind)]));
    lines.forEach((line, i) => {
      const kind = chargeTypes.get(String(line.chargeTypeId));
      if (line.basis === 'shortage_beyond_allowance' && kind && kind !== 'deduction') errors[`lines.${i}.chargeTypeId`] = ['A shortage line uses a deduction charge type'];
    });
    if (data.routeId && (data.fromPlaceId || data.toPlaceId)) errors.routeId = ['Choose a route or the places, not both'];
    if (Object.keys(errors).length) throw new ValidationError('The tariff is not valid', errors);
    return data;
  },
});

export const fuelPriceDefinition = defineMaster({
  key: 'fuel-prices', label: 'Fuel prices', singular: 'Fuel price', group: GROUPS.money, module: 'trips',
  description: "What a litre of fuel costs, for each trip's profit, when the fuel issue itself has no price. The most specific one for the trip's fuel, place and day is used.",
  model: FuelPrice, createSchema: S.createFuelPriceSchema, updateSchema: S.updateFuelPriceSchema,
  sortFields: ['code', 'name', 'validFrom', 'createdAt', 'updatedAt'],
  refs: [{ path: 'fuelTypeId', target: 'fuel-types' }, { path: 'placeId', target: 'places' }, { path: 'countryId', target: 'countries' }, { path: 'pricePerL.currencyId', target: 'currencies' }],
  columns: ['fuelTypeId', 'placeId', 'countryId', 'pricePerL', 'validFrom'],
  labels: { fuelTypeId: 'Fuel', placeId: 'Place', countryId: 'Country', pricePerL: 'Price per litre', validFrom: 'From', validTo: 'Until' },
  hints: { fuelTypeId: 'Leave empty for any fuel.', placeId: 'Leave empty for anywhere; a price for the place the truck filled up wins.' },
});

export const freightMasters = [consignmentTypeDefinition, consignmentDocumentTypeDefinition, chargeTypeDefinition, tariffDefinition, fuelPriceDefinition];
