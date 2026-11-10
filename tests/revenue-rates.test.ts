// #130, consignments design 3.5 phase 3: the full rate engine's pure parts. Slab rates, chargeable weight,
// conditions on a line, formula lines that keep what they saw, percentages of freight and of value, cost lines,
// and the check a tariff passes before it is saved. Detention, pass-through costs and tariff versions need the
// stop times and the database of #135, and come after it.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkTariff, FORMULA_VARIABLES, formulaNames, priceConsignment, variablesFor, type ChargeTypeInput, type EngineSettings, type FactLeg,
  type FactLine, type FactMeasure, type PricingFacts, type RevenueLine, type TariffInput, type TariffLineInput,
} from '../src/modules/freight/revenue/index.js';

const USD = { id: 'usd', code: 'USD', minorUnits: 2 };
const T = {
  FREIGHT: { id: 'ct-freight', code: 'FREIGHT', name: 'Freight', kind: 'freight' },
  MINIMUM: { id: 'ct-min', code: 'MINIMUM', name: 'Minimum charge top-up', kind: 'minimum' },
  FUEL: { id: 'ct-fuel', code: 'FUEL_SURCHARGE', name: 'Fuel surcharge', kind: 'charge' },
  HANDLING: { id: 'ct-hand', code: 'HANDLING', name: 'Container handling', kind: 'charge' },
  INSURANCE: { id: 'ct-ins', code: 'INSURANCE', name: 'Goods in transit cover', kind: 'charge' },
  BROKER: { id: 'ct-broker', code: 'BROKER_COMMISSION', name: 'Broker commission', kind: 'charge', direction: 'cost' },
} satisfies Record<string, ChargeTypeInput>;
const settings: EngineSettings = {
  chargeOnDefault: 'delivered', distanceSourceDefault: 'route_lead', shortageDeductionDefault: 'none',
  tax: { mode: 'none', ratePercent: 0, pricesIncludeTax: false }, chargeTypes: Object.values(T),
};
const usd = (amountMinor: number) => ({ amountMinor, currencyId: 'usd' });
const tariff = (lines: Array<Partial<TariffLineInput> & Pick<TariffLineInput, 'basis'>>, over: Partial<TariffInput> = {}): TariffInput => ({
  id: 'tar', code: 'RATES', currencyId: 'usd', shortageDeduction: 'none', lines: lines.map((l, i) => ({ id: `tl-${i + 1}`, chargeTypeId: T.FREIGHT.id, ...l })), ...over,
});
const m = (lineId: string, qty: number, unit: string, extra: Partial<FactMeasure> = {}): FactMeasure => ({ lineId, qty, unit, ...extra });
let n = 0;
const leg = (kind: FactLeg['kind'], actual: FactMeasure[]): FactLeg => ({ id: `leg-${++n}`, kind, status: 'done', actual, ...(kind === 'drop' ? { outcome: 'delivered' as const } : {}) });

// Situations 33 and 34: a part load of 400 kg taking 3 m³.
const parcel: FactLine = { id: 'P', productId: 'gen', productName: 'General cargo', plannedQty: 400, unit: 'kg', volumeM3: 3, product: {} };
const diesel: FactLine = { id: 'D', productId: 'ago', productName: 'Diesel', plannedQty: 38000, unit: 'L', product: { volumeCorrected: true, densityKgPerL: 0.835, decimals: 0 } };
const fuel = (std20L: number) => m('D', std20L + 150, 'L', { ambientL: std20L + 150, std20L, density: 835 });

const facts = (over: Partial<PricingFacts> = {}): PricingFacts => ({
  number: 'CN-0412', pricedOn: '2026-11-04', currency: USD, lines: [parcel], legs: [leg('pickup', [m('P', 400, 'kg')]), leg('drop', [m('P', 400, 'kg')])],
  distance: { leadKm: 1840, tripLoadedKm: 1900, tripKm: 3800 }, ...over,
});
const price = (f: Partial<PricingFacts>, t: TariffInput) => priceConsignment(facts(f), t, settings);
const amounts = (lines: RevenueLine[]) => lines.map((l) => [l.chargeTypeId, l.amountMinor]);
const words = (r: { explanation: string[] }) => r.explanation.join(' ');

const slabs = [{ upTo: 500, price: usd(1200) }, { upTo: 2000, price: usd(1000) }, { upTo: null, price: usd(800) }];

describe('rates: slabs and chargeable weight (situations 33, 34; design example B)', () => {
  test('example B: 400 kg in 3 m³ at 333 kg/m³ is 999 kg chargeable, on progressive slabs', () => {
    const r = price({}, tariff([{ basis: 'per_kg', slabs, slabMode: 'progressive' }], { volumetricDivisorKgPerM3: 333, minimumCharge: usd(600000) }));
    assert.equal(r.status, 'priced');
    assert.deepEqual(amounts(r.lines), [[T.FREIGHT.id, 1099000]]);
    const line = r.lines[0]!;
    assert.equal(line.qty, 999);
    assert.equal(Math.round(line.qty! * line.unitPriceMinor!), 1099000); // an invoice line re-multiplies them
    assert.match(words(r), /Chargeable weight 999 kg: actual 400 kg, volumetric 3 m³ × 333 = 999 kg\./);
    assert.match(words(r), /Freight: 500 × 12 USD \+ 499 × 10 USD = 10,990 USD\./);
  });
  test('whole slabs price every unit at the band the quantity reaches', () => {
    const r = price({}, tariff([{ basis: 'per_kg', slabs, slabMode: 'whole' }], { volumetricDivisorKgPerM3: 333 }));
    assert.deepEqual(amounts(r.lines), [[T.FREIGHT.id, 999000]]);
    assert.match(words(r), /999 × 10 USD \(the band up to 2,000\)/);
    const big = price({ lines: [{ ...parcel, volumeM3: undefined }], legs: [leg('pickup', [m('P', 2500, 'kg')]), leg('drop', [m('P', 2500, 'kg')])] }, tariff([{ basis: 'per_kg', slabs, slabMode: 'whole' }]));
    assert.deepEqual(amounts(big.lines), [[T.FREIGHT.id, 2500 * 800]]);
    assert.match(words(big), /the band up to any amount/);
  });
  test('progressive slabs above the second band, and on the band edges', () => {
    const at = (kg: number) => price({ lines: [{ ...parcel, volumeM3: undefined }], legs: [leg('pickup', [m('P', kg, 'kg')]), leg('drop', [m('P', kg, 'kg')])] }, tariff([{ basis: 'per_kg', slabs }])).lines[0]!.amountMinor;
    assert.equal(at(2500), 500 * 1200 + 1500 * 1000 + 500 * 800);
    assert.equal(at(500), 500 * 1200);
    assert.equal(at(2000), 500 * 1200 + 1500 * 1000);
    assert.equal(at(1), 1200);
  });
  test('a quantity above a closed last slab is unpriced, with the reason', () => {
    const closed = [{ upTo: 500, price: usd(1200) }, { upTo: 2000, price: usd(1000) }];
    const r = price({ lines: [{ ...parcel, volumeM3: undefined }], legs: [leg('pickup', [m('P', 2500, 'kg')]), leg('drop', [m('P', 2500, 'kg')])] }, tariff([{ basis: 'per_kg', slabs: closed }]));
    assert.equal(r.status, 'unpriced');
    assert.equal(r.problem, "CN-0412's 2,500 is above the last slab of \"Freight\" (2,000): add a slab with no upper limit.");
  });
  test('slabs that do not go up are refused at pricing, and before saving', () => {
    const bad = [{ upTo: 2000, price: usd(1000) }, { upTo: 500, price: usd(1200) }];
    assert.match(price({}, tariff([{ basis: 'per_kg', slabs: bad }])).problem!, /slabs that don't go up/);
    assert.deepEqual(checkTariff(tariff([{ basis: 'per_kg', slabs: bad }])), ['Line 1: slab 2 must go above 2000.']);
  });
  test('slabs on other bases: per tonne and per km', () => {
    const km = price({}, tariff([{ basis: 'per_km', slabs: [{ upTo: 1000, price: usd(200) }, { upTo: null, price: usd(150) }] }]));
    assert.equal(km.lines[0]!.amountMinor, 1000 * 200 + 840 * 150);
  });
  test('the least chargeable weight, and rounding up to a step', () => {
    const at = (over: Partial<TariffInput>) => price({}, tariff([{ basis: 'per_kg', price: usd(10) }], over)).lines[0]!.qty;
    assert.equal(at({}), 400); // no rules: the actual weight
    assert.equal(at({ minimumChargeableKg: 1500 }), 1500);
    assert.equal(at({ volumetricDivisorKgPerM3: 333, roundQtyUpTo: 100 }), 1000);
    assert.equal(at({ roundQtyUpTo: 100 }), 400);
    assert.equal(at({ roundQtyUpTo: 1 }), 400);
  });
  test('per tonne uses chargeable weight only when the tariff sets a divisor', () => {
    assert.equal(price({}, tariff([{ basis: 'per_tonne', price: usd(100) }])).lines[0]!.qty, 0.4);
    assert.equal(price({}, tariff([{ basis: 'per_tonne', price: usd(100) }], { volumetricDivisorKgPerM3: 333 })).lines[0]!.qty, 0.999);
  });
  test('no weight at all: the per-kg reason, not a guess', () => {
    const r = price({ lines: [{ ...diesel, product: { volumeCorrected: true } }], legs: [leg('pickup', [m('D', 100, 'L', { std20L: 100 })]), leg('drop', [m('D', 100, 'L', { std20L: 100 })])] }, tariff([{ basis: 'per_kg', price: usd(10) }]));
    assert.equal(r.problem, "CN-0412 has no weight or density, so it can't be charged per kg.");
  });
});

describe('rates: conditions on a line', () => {
  const handling = { basis: 'per_consignment' as const, chargeTypeId: T.HANDLING.id, price: usd(5000), when: 'packaging = "cont20"' };
  test('a line applies only when its condition holds; codes compare without regard to capitals', () => {
    const t = tariff([{ basis: 'per_consignment', price: usd(100000) }, handling]);
    assert.deepEqual(amounts(price({ codes: { packaging: 'CONT20' } }, t).lines), [[T.FREIGHT.id, 100000], [T.HANDLING.id, 5000]]);
    const r = price({ codes: { packaging: 'CONT40' } }, t);
    assert.deepEqual(amounts(r.lines), [[T.FREIGHT.id, 100000]]);
    assert.match(words(r), /Container handling: left out, as packaging = "cont20" does not hold here \(packaging = CONT40\)\./);
  });
  test('a condition reading a fact with no value leaves the consignment unpriced, saying which', () => {
    const r = price({}, tariff([{ basis: 'per_consignment', price: usd(100000) }, handling]));
    assert.equal(r.status, 'unpriced');
    assert.equal(r.problem, 'Container handling: "packaging" has no value here at column 1.');
  });
  test('conditions on numbers, counts and company fields', () => {
    const t = (when: string) => tariff([{ basis: 'per_consignment', price: usd(100000) }, { basis: 'per_consignment', chargeTypeId: T.HANDLING.id, price: usd(5000), when }]);
    assert.equal(price({}, t('km > 1500 and drops = 1')).lines.length, 2);
    assert.equal(price({}, t('between(km, 0, 1000)')).lines.length, 1);
    assert.equal(price({ custom: { hazardous: true } }, t('custom.hazardous')).lines.length, 2);
    assert.equal(price({ custom: { hazardous: false } }, t('custom.hazardous')).lines.length, 1);
    assert.match(price({}, t('km * 2')).problem!, /a condition is needed here/);
  });
});

describe('rates: formula lines (situation 36)', () => {
  const formula = 'max(0, 1.80 - 0.03 * floor((1500 - min(km, 1500)) / 100)) * litres20';
  const fuelTariff = tariff([
    { basis: 'formula', formula, description: 'Freight by distance' },
    { basis: 'percent_of_freight', chargeTypeId: T.FUEL.id, percent: 5, when: 'fuelPrice > 30' },
  ]);
  const tanker = (leadKm: number, fuelPrice?: number) => facts({
    lines: [diesel], legs: [leg('pickup', [fuel(37650)]), leg('drop', [fuel(37390)])], distance: { leadKm }, ...(fuelPrice !== undefined ? { fuelPrice } : {}),
  });
  test('the formula prices freight, and keeps what it computed and what it saw', () => {
    const r = priceConsignment(tanker(1200, 28), fuelTariff, settings);
    assert.equal(r.status, 'priced');
    // 1,200 km is 300 under 1,500: 3 × 3 cents off 1.80 = 1.71 a litre × 37,390.
    const [freight] = r.lines as [RevenueLine];
    assert.equal(freight.amountMinor, 6393690);
    assert.deepEqual([freight.qty, freight.unitPriceMinor, freight.formula, freight.variables], [1, 6393690, formula, { km: 1200, litres20: 37390 }]);
    assert.equal(r.lines.length, 1);
    assert.match(words(r), /Fuel surcharge: left out, as fuelPrice > 30 does not hold here \(fuelPrice = 28\)\./);
    assert.match(words(r), /Freight by distance: max\(0, .+\) \* litres20, with km = 1,200, litres20 = 37,390 = 63,936\.9 USD\./);
  });
  test('beyond 1,500 km the full rate; with diesel above 30, 5 % of freight is added', () => {
    const r = priceConsignment(tanker(1840, 31.5), fuelTariff, settings);
    assert.deepEqual(amounts(r.lines), [[T.FREIGHT.id, 6730200], [T.FUEL.id, 336510]]);
    const surcharge = r.lines[1]!;
    assert.deepEqual([surcharge.qty, surcharge.unit, surcharge.unitPriceMinor], [5, '%', 67302]);
    assert.match(words(r), /Fuel surcharge: 5 % of freight 67,302 USD = 3,365\.1 USD\./);
  });
  test('a fact with no value is a reason, not a zero: the design\'s fuel-price case', () => {
    const r = priceConsignment(tanker(1840), fuelTariff, settings);
    assert.equal(r.status, 'unpriced');
    assert.equal(r.problem, 'Fuel surcharge: "fuelPrice" has no value here at column 1.');
    assert.deepEqual(r.lines, []);
  });
  test('a formula that divides by zero or reads an unknown name leaves the consignment unpriced', () => {
    assert.equal(price({}, tariff([{ basis: 'formula', formula: 'kg / (drops - 1)' }])).problem, 'Freight: Divides by zero at column 4.');
    assert.equal(price({}, tariff([{ basis: 'formula', formula: 'kgs * 2' }])).problem, 'Freight: There is no value called "kgs" at column 1: did you mean "kg"?');
    assert.match(price({}, tariff([{ basis: 'formula', formula: 'kg > 2' }])).problem!, /an amount is needed here/);
    assert.equal(price({}, tariff([{ basis: 'formula' }])).problem, 'The tariff\'s line "Freight" has no formula.');
  });
  test('a formula may give a discount, and a line limit still applies', () => {
    const r = price({}, tariff([{ basis: 'per_consignment', price: usd(100000) }, { basis: 'formula', chargeTypeId: T.HANDLING.id, formula: '-0.1 * freight' }]));
    assert.deepEqual(amounts(r.lines), [[T.FREIGHT.id, 100000], [T.HANDLING.id, -10000]]);
    const capped = price({}, tariff([{ basis: 'formula', formula: 'kg * 100', maximum: usd(1000000) }]));
    assert.equal(capped.lines[0]!.amountMinor, 1000000);
  });
  test('every variable has a value, or is empty, never missing', () => {
    const vars = variablesFor(tanker(1840, 31.5), { chargeOn: 'delivered', distanceSource: 'route_lead', freightMinor: 6730200, rules: {} });
    for (const v of FORMULA_VARIABLES) assert.ok(Object.hasOwn(vars, v.name), v.name);
    assert.equal(vars.freight, 67302);
    assert.equal(vars.qty, 37540); // in the goods' own unit: litres as measured
    assert.equal(vars.litres20, 37390);
    assert.equal(vars.loadedQty, 37800);
    assert.equal(vars.shortQty, 260);
    assert.equal(vars.drops, 1);
    assert.equal(vars.packaging, null);
    assert.deepEqual(formulaNames().slice(-1), ['custom.']);
  });
});

describe('rates: percentages and cost lines', () => {
  test('percent of the declared value', () => {
    const r = price({ lines: [{ ...parcel, declaredValueMinor: 10_000_000 }] }, tariff([{ basis: 'per_consignment', price: usd(100000) }, { basis: 'percent_of_value', chargeTypeId: T.INSURANCE.id, percent: 0.5 }]));
    assert.deepEqual(amounts(r.lines), [[T.FREIGHT.id, 100000], [T.INSURANCE.id, 50000]]);
    assert.match(price({}, tariff([{ basis: 'percent_of_value', percent: 0.5 }])).problem!, /has no declared value/);
    assert.match(price({}, tariff([{ basis: 'percent_of_freight' }])).problem!, /has no percentage/);
  });
  test('percent of freight counts the freight priced before it, in line order', () => {
    const r = price({}, tariff([
      { basis: 'percent_of_freight', chargeTypeId: T.FUEL.id, percent: 10, order: 200 },
      { basis: 'per_consignment', price: usd(100000), order: 10 },
    ]));
    assert.deepEqual(amounts(r.lines), [[T.FREIGHT.id, 100000], [T.FUEL.id, 10000]]);
  });
  test('situation 40: a broker\'s 3 % commission is worked out but not billed to the customer', () => {
    const r = price({}, tariff([{ basis: 'per_consignment', price: usd(100000) }, { basis: 'percent_of_freight', chargeTypeId: T.BROKER.id, percent: 3 }]));
    assert.deepEqual(amounts(r.lines), [[T.FREIGHT.id, 100000], [T.BROKER.id, 3000]]);
    assert.equal(r.subtotalMinor, 100000);
  });
});

describe('rates: the check before a tariff is saved', () => {
  test('a good tariff has no problems', () => {
    assert.deepEqual(checkTariff(tariff([
      { basis: 'per_kg', slabs, slabMode: 'progressive' },
      { basis: 'formula', formula: 'max(0, 1.8 - 0.03 * floor((1500 - min(km, 1500)) / 100)) * litres20 + custom.toll' },
      { basis: 'percent_of_freight', percent: 5, when: 'fuelPrice > 30 and packaging != "BULK"' },
      { basis: 'shortage_beyond_allowance', price: usd(110) },
    ])), []);
  });
  test('it names each line\'s problems', () => {
    assert.deepEqual(checkTariff(tariff([
      { basis: 'per_consignment' },
      { basis: 'formula' },
      { basis: 'formula', formula: 'kgs * 2' },
      { basis: 'formula', formula: 'km > 2' },
      { basis: 'per_consignment', price: usd(1), when: 'km +', description: 'Handling' },
      { basis: 'percent_of_freight' },
      { basis: 'per_kg', slabs: [{ upTo: null, price: usd(1) }, { upTo: 5, price: usd(1) }] },
      { basis: 'per_consignment', price: { amountMinor: 1, currencyId: 'zmw' }, formula: 'km' },
      { basis: 'per_parsec' as never, price: usd(1) },
    ])), [
      'Line 1: it needs a price.',
      'Line 2: a formula line needs its formula.',
      'Line 3: the formula: There is no value called "kgs": did you mean "kg"?',
      'Line 4: the formula: The formula gives a yes/no, but an amount is needed here.',
      'Line 5 (Handling): the condition: The formula stops too early at column 5: something is missing at the end',
      'Line 6: a percentage line needs its percentage.',
      'Line 7: only the last slab can be open-ended.',
      'Line 8: a formula is only used with the basis "Formula".',
      'Line 8: it is priced in another currency than the tariff.',
      'Line 9: "per_parsec" is not a rate basis.',
    ]);
  });
});
