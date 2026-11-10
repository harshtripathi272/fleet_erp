// #130: the revenue engine (consignments design 3.5), phase 1. Pure: facts and a tariff in, lines, totals and the
// engine's own sentences out. No database: every rule is a table of facts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  priceConsignment, type ChargeTypeInput, type EngineSettings, type FactLeg, type FactLine, type FactMeasure, type PricingFacts,
  type RevenueLine, type TariffInput, type TariffLineInput,
} from '../src/modules/freight/revenue/index.js';

const USD = { id: 'usd', code: 'USD', minorUnits: 2 };
const ZMW = { id: 'zmw', code: 'ZMW', minorUnits: 2 };
const T = {
  FREIGHT: { id: 'ct-freight', code: 'FREIGHT', name: 'Freight', kind: 'freight' },
  MINIMUM: { id: 'ct-min', code: 'MINIMUM', name: 'Minimum charge top-up', kind: 'minimum' },
  EXTRA_DROP: { id: 'ct-drop', code: 'EXTRA_DROP', name: 'Extra drop', kind: 'charge' },
  SHORTAGE: { id: 'ct-short', code: 'SHORTAGE_DEDUCTION', name: 'Shortage beyond allowance', kind: 'deduction', taxable: false },
  LABOUR: { id: 'ct-labour', code: 'LOADING_LABOUR', name: 'Loading labour', kind: 'charge' },
  BROKER: { id: 'ct-broker', code: 'BROKER_COMMISSION', name: 'Broker commission', kind: 'charge', direction: 'cost' },
} satisfies Record<string, ChargeTypeInput>;

const settings = (over: Partial<EngineSettings> = {}): EngineSettings => ({
  chargeOnDefault: 'delivered', distanceSourceDefault: 'route_lead', shortageDeductionDefault: 'beyond_allowance',
  tax: { mode: 'none', ratePercent: 0, pricesIncludeTax: false }, chargeTypes: Object.values(T), ...over,
});
const usd = (amountMinor: number) => ({ amountMinor, currencyId: 'usd' });
const tariff = (lines: Array<Partial<TariffLineInput> & Pick<TariffLineInput, 'basis'>>, over: Partial<TariffInput> = {}): TariffInput => ({
  id: 'tar-1', code: 'PUMA-DAR-ZM', version: 3, currencyId: 'usd', matchedOn: 'customer and route',
  lines: lines.map((l, i) => ({ id: `tl-${i + 1}`, chargeTypeId: T.FREIGHT.id, ...l })), ...over,
});

const diesel: FactLine = { id: 'L1', productId: 'ago', productName: 'Diesel', plannedQty: 38000, unit: 'L', product: { volumeCorrected: true, densityKgPerL: 0.835, decimals: 0, shortageAllowancePercent: 0.3 } };
const cement: FactLine = { id: 'L2', productId: 'cem', productName: 'Cement', plannedQty: 30, unit: 't', pieces: 600, product: { decimals: 3 } };
const bags: FactLine = { id: 'L3', productId: 'maize', productName: 'Maize', plannedQty: 400, unit: 'bags', grossKg: 20000, product: {} };

const m = (lineId: string, qty: number, unit: string, extra: Partial<FactMeasure> = {}): FactMeasure => ({ lineId, qty, unit, ...extra });
const fuel = (std20L: number, ambientL = std20L + 150) => m('L1', ambientL, 'L', { ambientL, std20L, tempC: 30, density: 835 });
let legNo = 0;
const pickup = (actual?: FactMeasure[], status: FactLeg['status'] = actual ? 'done' : 'planned'): FactLeg => ({ id: `leg-${++legNo}`, kind: 'pickup', status, ...(actual ? { actual } : {}) });
const drop = (actual?: FactMeasure[], outcome: FactLeg['outcome'] = 'delivered', status: FactLeg['status'] = actual ? 'done' : 'planned'): FactLeg =>
  ({ id: `leg-${++legNo}`, kind: 'drop', status, ...(actual ? { actual, outcome } : {}) });

const facts = (over: Partial<PricingFacts> = {}): PricingFacts => ({
  number: 'CN-0412', pricedOn: '2026-11-04T08:00:00Z', currency: USD, lines: [diesel], legs: [pickup([fuel(37650)]), drop([fuel(37390)])],
  distance: { leadKm: 1840, tripLoadedKm: 1900, manualKm: 1850 }, shortageAllowancePercent: 0.3, ...over,
});
const price = (f: Partial<PricingFacts>, t: TariffInput | null, s: Partial<EngineSettings> = {}) => priceConsignment(facts(f), t, settings(s));
const amounts = (lines: RevenueLine[]) => lines.map((l) => [l.kind, l.amountMinor]);
const one = (lines: RevenueLine[]) => { assert.equal(lines.length, 1, JSON.stringify(lines)); return lines[0]!; };

describe('revenue engine: the design\'s worked examples (3.5.10)', () => {
  test('A. a tanker split after the border: per litre at 20 °C on delivered, extra drops, shortage beyond 0.5 %', () => {
    const r = price({
      legs: [pickup([fuel(37650)]), drop([fuel(9400)]), drop([fuel(9300)]), drop([fuel(9350)]), drop([fuel(9340)])],
    }, tariff([
      { basis: 'per_litre_20', price: usd(8.5) },
      { basis: 'per_drop_beyond', chargeTypeId: T.EXTRA_DROP.id, price: usd(15000), freeQty: 1 },
      { basis: 'shortage_beyond_allowance', chargeTypeId: T.SHORTAGE.id, price: usd(110) },
    ], { shortageAllowancePercent: 0.5 }));
    assert.equal(r.status, 'priced');
    assert.deepEqual(amounts(r.lines), [['freight', 317815], ['charge', 45000], ['deduction', -7920]]);
    assert.equal(r.subtotalMinor, 354895);
    assert.equal(r.totalMinor, 354895);
    const [freight, extra, shortage] = r.lines as [RevenueLine, RevenueLine, RevenueLine];
    assert.deepEqual([freight.qty, freight.unit, freight.unitPriceMinor, freight.description], [37390, 'L at 20 °C', 8.5, 'Freight, delivered']);
    assert.deepEqual([extra.qty, extra.unitPriceMinor, extra.tariffLineId], [3, 15000, 'tl-2']);
    assert.deepEqual([shortage.qty, shortage.unit, shortage.unitPriceMinor], [72, 'L at 20 °C', -110]);
    assert.deepEqual(r.basis, { chargeOn: 'delivered', qty: 37390, unit: 'L at 20 °C', drops: 4, estimated: false });
    assert.deepEqual([r.tariffId, r.tariffVersion, r.currencyId], ['tar-1', 3, 'usd']);
    const words = r.explanation.join(' ');
    assert.match(words, /Tariff PUMA-DAR-ZM v3 \(customer and route matched\)\./);
    assert.match(words, /Charged on delivered: 37,390 L at 20 °C\./);
    assert.match(words, /Extra drop: 4 drops, 1 free: 3 × 150 USD = 450 USD\./);
    assert.match(words, /Loaded 37,650, delivered 37,390: loss 260 L at 20 °C, allowance 0\.5 % = 188, 72 deducted at 1\.1 USD = -79\.2 USD\./);
    assert.match(words, /3,548\.95 USD before tax\./);
  });
  test('C. a fixed price: the same whatever was loaded or delivered', () => {
    for (const delivered of [28.1, 28.4]) {
      const r = price({ lines: [cement], legs: [pickup([m('L2', 28.4, 't')]), drop([m('L2', delivered, 't')])] }, tariff([{ basis: 'per_consignment', price: usd(4000000) }], { shortageDeduction: 'none' }));
      assert.equal(r.status, 'priced');
      assert.deepEqual(amounts(r.lines), [['freight', 4000000]]);
    }
  });
});

describe('revenue engine: every freight basis', () => {
  const delivered = (lines: FactLine[], on: FactMeasure[], off: FactMeasure[] = on) => ({ lines, legs: [pickup(on), drop(off)] });
  const freightOf = (f: Partial<PricingFacts>, basis: TariffLineInput['basis'], unitPrice: number, t: Partial<TariffInput> = {}) =>
    one(price(f, tariff([{ basis, price: usd(unitPrice) }], { shortageDeduction: 'none', ...t })).lines);

  test('per consignment and per trip are one each', () => {
    assert.equal(freightOf({}, 'per_consignment', 250000).amountMinor, 250000);
    assert.equal(freightOf({}, 'per_trip', 250000).amountMinor, 250000);
    assert.equal(freightOf({ perTrip: { carries: true } }, 'per_trip', 250000).amountMinor, 250000);
  });
  test('per trip: the customer\'s other consignments on the trip say where the price is', () => {
    const line = freightOf({ perTrip: { carries: false, carrierNumber: 'CN-0411' } }, 'per_trip', 250000);
    assert.deepEqual([line.amountMinor, line.description], [0, 'Freight · included in CN-0411']);
  });
  test('per tonne: tonnes, kg, and litres through the measured or the product\'s density', () => {
    assert.equal(freightOf(delivered([cement], [m('L2', 28.4, 't')]), 'per_tonne', 4500).qty, 28.4);
    assert.equal(freightOf(delivered([{ ...cement, unit: 'kg' }], [m('L2', 28400, 'kg')]), 'per_tonne', 4500).amountMinor, 127800);
    // 37,390 L at 20 °C at 835 kg/m³ measured: 31.221 t.
    assert.equal(freightOf({}, 'per_tonne', 4500).qty, 31.221);
    // Without a measured density, the product's 0.84 kg/L.
    const plain = { ...diesel, product: { ...diesel.product, densityKgPerL: 0.84 } };
    assert.equal(freightOf(delivered([plain], [m('L1', 1000, 'L', { std20L: 1000 })]), 'per_tonne', 4500).qty, 0.84);
    const r = price(delivered([{ ...diesel, product: { volumeCorrected: true } }], [m('L1', 1000, 'L', { std20L: 1000 })]), tariff([{ basis: 'per_tonne', price: usd(4500) }], { shortageDeduction: 'none' }));
    assert.equal(r.status, 'unpriced');
    assert.equal(r.problem, "CN-0412 has no weight or density, so it can't be charged per tonne.");
    assert.deepEqual(r.lines, []);
  });
  test('per kg', () => {
    assert.equal(freightOf(delivered([cement], [m('L2', 1.25, 't')]), 'per_kg', 12).amountMinor, 15000);
  });
  test('per litre (as measured) and per litre at 20 °C', () => {
    assert.equal(freightOf({}, 'per_litre', 8.5).qty, 37540); // ambient litres delivered
    assert.equal(freightOf({}, 'per_litre_20', 8.5).qty, 37390);
    // A certificate's 20 °C figure wins over the computed one.
    assert.equal(freightOf(delivered([diesel], [fuel(37650)], [m('L1', 37500, 'L', { std20L: 37390, certStd20L: 37400 })]), 'per_litre_20', 8.5).qty, 37400);
    const r = price(delivered([cement], [m('L2', 28.4, 't')]), tariff([{ basis: 'per_litre_20', price: usd(8.5) }], { shortageDeduction: 'none' }));
    assert.equal(r.problem, 'CN-0412 is not measured in litres; a rate per litre at 20 °C needs litres.');
  });
  test('per cubic metre, from litres or the booked volume', () => {
    assert.equal(freightOf(delivered([{ ...diesel, product: {} }], [m('L1', 30000, 'L')]), 'per_m3', 300).qty, 30);
    assert.equal(freightOf(delivered([{ ...cement, unit: 'm3' }], [m('L2', 42, 'm3')]), 'per_m3', 300).amountMinor, 12600);
  });
  test('per piece: a counted unit, or a piece count on the measure', () => {
    assert.equal(freightOf(delivered([bags], [m('L3', 400, 'bags')], [m('L3', 398, 'bags')]), 'per_piece', 150).qty, 398);
    assert.equal(freightOf(delivered([cement], [m('L2', 30, 't', { pieces: 600 })], [m('L2', 29.9, 't', { pieces: 598 })]), 'per_piece', 150).qty, 598);
    const r = price(delivered([{ ...cement, pieces: undefined }], [m('L2', 30, 't')]), tariff([{ basis: 'per_piece', price: usd(150) }], { shortageDeduction: 'none' }));
    assert.equal(r.problem, "CN-0412 has no count of pieces, so it can't be charged per piece.");
  });
  test('per km, by each distance source', () => {
    assert.equal(freightOf({}, 'per_km', 200).qty, 1840);
    assert.equal(freightOf({}, 'per_km', 200, { distanceSource: 'trip_loaded_km' }).qty, 1900);
    assert.equal(freightOf({}, 'per_km', 200, { distanceSource: 'manual' }).qty, 1850);
    assert.equal(one(price({}, tariff([{ basis: 'per_km', price: usd(200) }], { shortageDeduction: 'none' }), { distanceSourceDefault: 'trip_loaded_km' }).lines).qty, 1900);
    const r = price({ distance: {} }, tariff([{ basis: 'per_km', price: usd(200) }]));
    assert.equal(r.status, 'unpriced');
    assert.match(r.problem!, /no lead distance yet/);
    assert.match(price({ distance: {} }, tariff([{ basis: 'per_km', price: usd(200) }], { distanceSource: 'manual' })).problem!, /no lead distance typed in/);
    assert.match(price({ distance: { tripLoadedKm: 0 } }, tariff([{ basis: 'per_km', price: usd(200) }], { distanceSource: 'trip_loaded_km' })).problem!, /trip has no loaded km/);
  });
  test('per tonne-km', () => {
    const line = freightOf(delivered([cement], [m('L2', 28.4, 't')]), 'per_tonne_km', 3);
    assert.equal(line.qty, 28.4 * 1840);
    assert.equal(line.amountMinor, Math.round(28.4 * 1840 * 3));
  });
  test('several goods lines are charged together', () => {
    const second: FactLine = { ...cement, id: 'L4', productName: 'Lime' };
    const r = price({ lines: [cement, second], legs: [pickup([m('L2', 10, 't'), m('L4', 5, 't')]), drop([m('L2', 10, 't'), m('L4', 5, 't')])] }, tariff([{ basis: 'per_tonne', price: usd(4500) }]));
    assert.equal(one(r.lines).qty, 15);
  });
});

describe('revenue engine: which quantity is charged', () => {
  const t = (chargeOn: TariffInput['chargeOn']) => tariff([{ basis: 'per_litre_20', price: usd(10) }], { chargeOn, shortageDeduction: 'none' });
  const done = { legs: [pickup([fuel(37650)]), drop([fuel(37390)])] };
  test('loaded, delivered, planned, the greater and the lesser', () => {
    assert.equal(one(price(done, t('loaded')).lines).qty, 37650);
    assert.equal(one(price(done, t('delivered')).lines).qty, 37390);
    assert.equal(one(price(done, t('planned')).lines).qty, 38000);
    assert.equal(one(price(done, t('greater_of')).lines).qty, 37650);
    assert.equal(one(price(done, t('lesser_of')).lines).qty, 37390);
  });
  test('an empty chargeOn on the tariff takes the company default', () => {
    assert.equal(one(price(done, t(undefined), { chargeOnDefault: 'loaded' }).lines).qty, 37650);
    assert.equal(price(done, t(undefined), { chargeOnDefault: 'loaded' }).basis?.chargeOn, 'loaded');
  });
  test('before loading, the planned quantity is an estimate', () => {
    const r = price({ legs: [pickup(), drop()] }, t('delivered'));
    assert.equal(r.status, 'estimated');
    assert.equal(one(r.lines).qty, 38000);
    assert.equal(r.basis?.estimated, true);
    assert.match(r.explanation.join(' '), /Charged on planned, as an estimate: nothing is loaded yet: 38,000 L at 20 °C\./);
    assert.match(r.explanation.join(' '), /as an estimate until every pickup and drop is recorded/);
  });
  test('while drops are open, the loaded quantity stands in for the delivered one', () => {
    const r = price({ legs: [pickup([fuel(37650)]), drop([fuel(18000)]), drop()] }, t('delivered'));
    assert.equal(r.status, 'estimated');
    assert.equal(one(r.lines).qty, 37650);
    assert.match(r.explanation.join(' '), /loaded quantity stands in for the delivered one/);
  });
  test('loaded is final once every pickup is in, though the consignment is only estimated until delivered', () => {
    const r = price({ legs: [pickup([fuel(37650)]), drop()] }, t('loaded'));
    assert.equal(one(r.lines).qty, 37650);
    assert.equal(r.status, 'estimated');
  });
  test('two pickups add up; a skipped leg does not count', () => {
    const r = price({ legs: [pickup([fuel(20000)]), pickup([fuel(17650)]), pickup(undefined, 'skipped'), drop([fuel(37390)])] }, t('loaded'));
    assert.equal(one(r.lines).qty, 37650);
    assert.equal(r.status, 'priced');
  });
  test('with one of two pickups done and no plan, what is loaded so far stands in', () => {
    const r = price({ lines: [{ ...diesel, plannedQty: undefined }], legs: [pickup([fuel(20000)]), pickup(), drop()] }, t('loaded'));
    assert.equal(one(r.lines).qty, 20000);
    assert.equal(r.status, 'estimated');
  });
  test('nothing planned and nothing loaded cannot be priced on quantity', () => {
    const r = price({ lines: [{ ...diesel, plannedQty: undefined }], legs: [pickup(), drop()] }, t('delivered'));
    assert.equal(r.status, 'unpriced');
    assert.equal(r.problem, "CN-0412 has no planned or loaded quantity yet, so it can't be priced.");
  });
  test('delivered counts what the consignee accepted, and nothing from a refused drop', () => {
    const r = price({
      lines: [bags],
      legs: [pickup([m('L3', 400, 'bags')]), drop([m('L3', 200, 'bags', { accepted: 190, damaged: 10 })], 'partial'), drop([m('L3', 200, 'bags')], 'refused')],
    }, tariff([{ basis: 'per_piece', price: usd(100) }], { chargeOn: 'delivered', shortageDeduction: 'none' }));
    assert.equal(one(r.lines).qty, 190);
  });
  test('a drop accepted in part scales its 20 °C figure too', () => {
    const r = price({ legs: [pickup([fuel(10000)]), drop([m('L1', 10100, 'L', { std20L: 10000, accepted: 5050 })], 'partial')] }, t('delivered'));
    assert.equal(one(r.lines).qty, 5000);
  });
});

describe('revenue engine: minimums, extra drops and line limits', () => {
  test('freight under the minimum charge is topped up', () => {
    const r = price({ lines: [cement], legs: [pickup([m('L2', 2, 't')]), drop([m('L2', 2, 't')])] },
      tariff([{ basis: 'per_tonne', price: usd(4500) }], { minimumCharge: usd(60000), shortageDeduction: 'none' }));
    assert.deepEqual(amounts(r.lines), [['freight', 9000], ['minimum', 51000]]);
    assert.equal(r.lines[1]!.chargeTypeId, T.MINIMUM.id);
    assert.equal(r.subtotalMinor, 60000);
    assert.match(r.explanation.join(' '), /Freight came to 90 USD, under the minimum charge of 600 USD: 510 USD added\./);
  });
  test('freight at or over the minimum is left alone', () => {
    const r = price({ lines: [cement], legs: [pickup([m('L2', 20, 't')]), drop([m('L2', 20, 't')])] },
      tariff([{ basis: 'per_tonne', price: usd(4500) }], { minimumCharge: usd(60000), shortageDeduction: 'none' }));
    assert.deepEqual(amounts(r.lines), [['freight', 90000]]);
  });
  test('a minimum charge with no minimum charge type to put it on is a problem, not a guess', () => {
    const r = price({}, tariff([{ basis: 'per_consignment', price: usd(100) }], { minimumCharge: usd(60000) }), { chargeTypes: [T.FREIGHT] });
    assert.equal(r.status, 'unpriced');
    assert.match(r.problem!, /no Minimum charge type/);
  });
  test('one drop is free by default; free drops can be set', () => {
    const drops = (n: number) => ({ legs: [pickup([fuel(37650)]), ...Array.from({ length: n }, () => drop([fuel(37390 / n)]))] });
    const t = (freeQty?: number) => tariff([{ basis: 'per_consignment', price: usd(100) }, { basis: 'per_drop_beyond', chargeTypeId: T.EXTRA_DROP.id, price: usd(15000), ...(freeQty !== undefined ? { freeQty } : {}) }], { shortageDeduction: 'none' });
    assert.deepEqual(amounts(price(drops(1), t()).lines), [['freight', 100]]);
    assert.match(price(drops(1), t()).explanation.join(' '), /Extra drop: 1 drop, 1 free, so nothing extra\./);
    assert.deepEqual(amounts(price(drops(3), t()).lines), [['freight', 100], ['charge', 30000]]);
    assert.deepEqual(amounts(price(drops(3), t(2)).lines), [['freight', 100], ['charge', 15000]]);
    assert.deepEqual(amounts(price(drops(3), t(0)).lines), [['freight', 100], ['charge', 45000]]);
    // A drop planned but not yet done counts: the plan says four stops.
    assert.equal(price({ legs: [pickup([fuel(37650)]), drop(), drop(), drop(undefined, undefined, 'skipped')] }, t()).lines[1]!.qty, 1);
  });
  test('a line\'s own minimum and maximum', () => {
    const raised = one(price({ lines: [cement], legs: [pickup([m('L2', 1, 't')]), drop([m('L2', 1, 't')])] }, tariff([{ basis: 'per_tonne', price: usd(4500), minimum: usd(20000) }], { shortageDeduction: 'none' })).lines);
    assert.equal(raised.amountMinor, 20000);
    assert.equal(Math.round(raised.qty! * raised.unitPriceMinor!), 20000); // an invoice line re-multiplies them
    assert.match(raised.note!, /Raised to the line's minimum of 200 USD/);
    const capped = one(price({}, tariff([{ basis: 'per_km', price: usd(200), maximum: usd(300000) }], { shortageDeduction: 'none' })).lines);
    assert.equal(capped.amountMinor, 300000);
    assert.match(capped.note!, /Capped at the line's maximum of 3,000 USD/);
  });
  test('tariff lines are priced in their order', () => {
    const r = price({}, tariff([
      { basis: 'per_consignment', chargeTypeId: T.LABOUR.id, price: usd(5000), order: 200 },
      { basis: 'per_consignment', price: usd(100000), order: 10 },
    ], { shortageDeduction: 'none' }));
    assert.deepEqual(r.lines.map((l) => l.chargeTypeId), [T.FREIGHT.id, T.LABOUR.id]);
  });
});

describe('revenue engine: the customer-side shortage', () => {
  const t = (over: Partial<TariffInput> = {}, withLine = true) => tariff([
    { basis: 'per_litre_20', price: usd(8.5) },
    ...(withLine ? [{ basis: 'shortage_beyond_allowance' as const, chargeTypeId: T.SHORTAGE.id, price: usd(110) }] : []),
  ], over);
  const deduction = (lines: RevenueLine[]) => lines.find((l) => l.kind === 'deduction');

  test('within the allowance, nothing is deducted', () => {
    const r = price({ legs: [pickup([fuel(37650)]), drop([fuel(37500)])] }, t({ shortageAllowancePercent: 0.5 }));
    assert.equal(deduction(r.lines), undefined);
    assert.match(r.explanation.join(' '), /loss 150 L at 20 °C, within the allowance of 0\.5 % \(188\)/);
  });
  test('an empty allowance on the tariff takes the product\'s, then the company\'s', () => {
    // Product 0.3 %: 113 L of 37,650; loss 260; 147 deducted.
    assert.equal(deduction(price({}, t()).lines)!.qty, 147);
    const noProductAllowance = { ...diesel, product: { ...diesel.product, shortageAllowancePercent: undefined } };
    assert.equal(deduction(price({ lines: [noProductAllowance], shortageAllowancePercent: 0.2 }, t()).lines)!.qty, 185);
  });
  test('"all" deducts every litre lost; "none" deducts nothing and says so', () => {
    assert.equal(deduction(price({}, t({ shortageDeduction: 'all' })).lines)!.qty, 260);
    const r = price({}, t({ shortageDeduction: 'none' }));
    assert.equal(deduction(r.lines), undefined);
    assert.match(r.explanation.join(' '), /Loss 260 L at 20 °C: not deducted, as the tariff deducts no shortage\./);
  });
  test('without a shortage line, the company default and the product\'s shortage price apply', () => {
    const priced = { ...diesel, product: { ...diesel.product, shortagePricePerUnitMinor: 120 } };
    const r = price({ lines: [priced] }, t({}, false));
    const d = deduction(r.lines)!;
    assert.deepEqual([d.qty, d.unitPriceMinor, d.amountMinor, d.chargeTypeId, d.tariffLineId], [147, -120, -17640, T.SHORTAGE.id, undefined]);
    assert.equal(deduction(price({ lines: [priced] }, t({}, false), { shortageDeductionDefault: 'none' }).lines), undefined);
  });
  test('no price anywhere: the loss is reported, not deducted', () => {
    const r = price({}, t({}, false));
    assert.equal(deduction(r.lines), undefined);
    assert.equal(r.status, 'priced');
    assert.match(r.explanation.join(' '), /147 beyond the allowance, not deducted: neither the tariff nor the product has a shortage price/);
  });
  test('nothing is deducted until the last drop is in, and refused goods are not a loss', () => {
    assert.equal(deduction(price({ legs: [pickup([fuel(37650)]), drop([fuel(18000)]), drop()] }, t()).lines), undefined);
    const back = price({ legs: [pickup([fuel(37650)]), drop([fuel(18800)]), drop([fuel(18850)], 'refused')] }, t({ shortageAllowancePercent: 0 }));
    assert.equal(deduction(back.lines), undefined);
  });
  test('goods counted in their own unit, each product on its own line', () => {
    const r = price({
      lines: [cement, bags],
      legs: [pickup([m('L2', 30, 't'), m('L3', 400, 'bags')]), drop([m('L2', 29.8, 't'), m('L3', 396, 'bags')])],
    }, tariff([{ basis: 'per_consignment', price: usd(100000) }, { basis: 'shortage_beyond_allowance', chargeTypeId: T.SHORTAGE.id, price: usd(5000) }], { shortageDeduction: 'all' }));
    const d = r.lines.filter((l) => l.kind === 'deduction');
    assert.deepEqual(d.map((l) => [l.description, l.qty, l.unit, l.amountMinor]), [
      ['Shortage beyond allowance · Cement', 0.2, 't', -1000],
      ['Shortage beyond allowance · Maize', 4, 'bags', -20000],
    ]);
  });
});

describe('revenue engine: unpriced, manual and frozen', () => {
  test('no tariff: unpriced, with the reason', () => {
    const r = price({}, null);
    assert.equal(r.status, 'unpriced');
    assert.equal(r.problem, 'No tariff covers this consignment; add one under Tariffs or price it by hand.');
    assert.deepEqual([r.lines, r.subtotalMinor, r.totalMinor], [[], 0, 0]);
    assert.ok(r.explanation.includes(r.problem!));
  });
  test('a tariff line without a price, in another currency, or naming a missing charge type', () => {
    assert.match(price({}, tariff([{ basis: 'per_consignment' }])).problem!, /"Freight" has no price/);
    assert.match(price({}, tariff([{ basis: 'per_consignment', price: { amountMinor: 1, currencyId: 'zmw' } }])).problem!, /priced in another currency/);
    assert.match(price({}, tariff([{ basis: 'per_consignment', price: usd(1), chargeTypeId: 'gone' }])).problem!, /missing or switched off/);
    assert.match(price({}, tariff([{ basis: 'per_consignment', price: usd(1) }], { currencyId: 'zmw' })).problem!, /in another currency than the one it is being priced in/);
  });
  test('one line that cannot be priced leaves the whole consignment unpriced, never part-priced', () => {
    const r = price({ distance: {} }, tariff([{ basis: 'per_consignment', price: usd(100000) }, { basis: 'per_km', chargeTypeId: T.LABOUR.id, price: usd(10) }]));
    assert.equal(r.status, 'unpriced');
    assert.deepEqual(r.lines, []);
  });
  const manualFreight: RevenueLine = { chargeTypeId: T.FREIGHT.id, kind: 'freight', description: 'Agreed on the phone', qty: 1, unitPriceMinor: 300000, amountMinor: 300000, source: 'manual', accepted: true, by: 'user-1' };
  test('a manual price replaces freight and survives a reprice; charges and deductions still follow the tariff', () => {
    const r = price({
      legs: [pickup([fuel(37650)]), drop([fuel(18000)]), drop([fuel(19390)])],
      previous: { status: 'priced', lines: [manualFreight], manual: { reason: 'Spot rate agreed by phone' } },
    }, tariff([
      { basis: 'per_litre_20', price: usd(8.5) },
      { basis: 'per_drop_beyond', chargeTypeId: T.EXTRA_DROP.id, price: usd(15000) },
      { basis: 'shortage_beyond_allowance', chargeTypeId: T.SHORTAGE.id, price: usd(110) },
    ], { shortageAllowancePercent: 0.5 }));
    assert.equal(r.status, 'priced');
    assert.deepEqual(r.lines.map((l) => [l.source, l.kind, l.amountMinor]), [['manual', 'freight', 300000], ['tariff', 'charge', 15000], ['tariff', 'deduction', -7920]]);
    assert.equal(r.lines[0]!.by, 'user-1');
    assert.match(r.explanation[0]!, /Freight priced by hand: Spot rate agreed by phone\./);
  });
  test('a manual price works with no tariff at all', () => {
    const r = price({ previous: { status: 'priced', lines: [manualFreight], manual: { reason: 'No contract yet' } } }, null);
    assert.equal(r.status, 'priced');
    assert.deepEqual(amounts(r.lines), [['freight', 300000]]);
  });
  test('a manual whole price is everything: no tariff lines, no deductions', () => {
    const r = price({ previous: { status: 'estimated', lines: [manualFreight], manual: { whole: true } } }, tariff([{ basis: 'per_litre_20', price: usd(8.5) }, { basis: 'shortage_beyond_allowance', chargeTypeId: T.SHORTAGE.id, price: usd(110) }]));
    assert.equal(r.status, 'priced');
    assert.deepEqual(amounts(r.lines), [['freight', 300000]]);
  });
  test('marked manual with no freight line is a problem', () => {
    assert.match(price({ previous: { status: 'priced', lines: [], manual: { reason: 'x' } } }, null).problem!, /priced by hand, but has no freight line/);
  });
  test('a charge a person added is kept; a line they switched off stays off and out of the totals', () => {
    const labour: RevenueLine = { chargeTypeId: T.LABOUR.id, kind: 'charge', description: 'Loading labour', qty: 1, unitPriceMinor: 5000, amountMinor: 5000, source: 'manual', accepted: true };
    const t = tariff([{ basis: 'per_litre_20', price: usd(8.5) }, { basis: 'per_drop_beyond', chargeTypeId: T.EXTRA_DROP.id, price: usd(15000) }], { shortageDeduction: 'none' });
    const legs = [pickup([fuel(37650)]), drop([fuel(18000)]), drop([fuel(19390)])];
    const first = price({ legs }, t);
    const switchedOff = first.lines.map((l) => (l.kind === 'charge' ? { ...l, accepted: false, note: 'Waived for this customer' } : l));
    const again = price({ legs, previous: { status: 'priced', lines: [...switchedOff, labour] } }, t);
    assert.deepEqual(again.lines.map((l) => [l.source, l.kind, l.amountMinor, l.accepted]), [['tariff', 'freight', 317815, true], ['tariff', 'charge', 15000, false], ['manual', 'charge', 5000, true]]);
    assert.equal(again.lines[1]!.note, 'Waived for this customer');
    assert.equal(again.subtotalMinor, 317815 + 5000);
  });
  test('a frozen or invoiced revenue is not repriced', () => {
    const frozen = { status: 'frozen' as const, lines: [manualFreight], subtotalMinor: 300000, taxMinor: 0, totalMinor: 300000, explanation: ['As it was.'], frozenAt: '2026-11-05T00:00:00Z' };
    const r = price({ previous: frozen }, tariff([{ basis: 'per_litre_20', price: usd(8.5) }]));
    assert.equal(r.unchanged, true);
    assert.equal(r.status, 'frozen');
    assert.deepEqual(r.lines, [manualFreight]);
    assert.deepEqual(r.explanation, ['As it was.']);
    assert.equal(price({ previous: { ...frozen, status: 'invoiced' } }, null).status, 'invoiced');
  });
});

describe('revenue engine: tax, totals and the base currency', () => {
  const t = (over: Partial<TariffInput> = {}, line: Partial<TariffLineInput> = {}) => tariff([
    { basis: 'per_consignment', price: usd(100000), ...line },
    { basis: 'shortage_beyond_allowance', chargeTypeId: T.SHORTAGE.id, price: usd(110) },
  ], { shortageDeduction: 'all', ...over });
  test('no tax by default', () => {
    const r = price({}, t());
    assert.deepEqual([r.subtotalMinor, r.taxMinor, r.totalMinor], [100000 - 28600, 0, 100000 - 28600]);
  });
  test('one company rate; deductions of a type that is not taxable carry none', () => {
    const r = price({}, t(), { tax: { mode: 'single', ratePercent: 16, pricesIncludeTax: false } });
    assert.deepEqual(r.lines.map((l) => [l.taxPercent, l.taxMinor]), [[16, 16000], [0, 0]]);
    assert.deepEqual([r.subtotalMinor, r.taxMinor, r.totalMinor], [71400, 16000, 87400]);
  });
  test('per customer and product: the line\'s rate, else the tariff\'s, else the company\'s', () => {
    const tax = { mode: 'per_customer_product', ratePercent: 16, pricesIncludeTax: false };
    assert.equal(price({}, t({}, { taxRatePercent: 5 }), { tax }).lines[0]!.taxPercent, 5);
    assert.equal(price({}, t({ taxRatePercent: 8 }), { tax }).lines[0]!.taxPercent, 8);
    assert.equal(price({}, t(), { tax }).lines[0]!.taxPercent, 16);
    // With one company rate, the tariff's own rate does not apply.
    assert.equal(price({}, t({ taxRatePercent: 8 }), { tax: { ...tax, mode: 'single' } }).lines[0]!.taxPercent, 16);
  });
  test('prices that include tax', () => {
    const r = price({}, t({ shortageDeduction: 'none' }), { tax: { mode: 'single', ratePercent: 16, pricesIncludeTax: true } });
    assert.deepEqual([r.lines[0]!.taxMinor, r.subtotalMinor, r.taxMinor, r.totalMinor], [13793, 86207, 13793, 100000]);
  });
  test('a cost line is worked out but not billed', () => {
    const r = price({}, tariff([{ basis: 'per_consignment', price: usd(100000) }, { basis: 'per_consignment', chargeTypeId: T.BROKER.id, price: usd(5000) }], { shortageDeduction: 'none' }));
    assert.equal(r.lines.length, 2);
    assert.equal(r.subtotalMinor, 100000);
  });
  test('the base currency: the same, at the day\'s rate, or a sentence when the rate is missing', () => {
    const same = price({ currency: ZMW }, tariff([{ basis: 'per_consignment', price: { amountMinor: 100000, currencyId: 'zmw' } }], { currencyId: 'zmw', shortageDeduction: 'none' }));
    assert.equal(same.problem, undefined);
    const priced = (base: PricingFacts['base']) => price({ base }, t({ shortageDeduction: 'none' }));
    const zmw = priced({ ...ZMW, rate: null });
    assert.deepEqual([zmw.baseSubtotalMinor, zmw.baseTotalMinor, zmw.rateToBase], [undefined, undefined, undefined]);
    assert.match(zmw.explanation.at(-1)!, /^Add the USD rate for .+ under Exchange rates to see this in ZMW\.$/);
    assert.equal(zmw.status, 'priced');
    const converted = priced({ ...ZMW, rate: 26.5 });
    assert.deepEqual([converted.baseSubtotalMinor, converted.baseTotalMinor, converted.rateToBase], [2650000, 2650000, 26.5]);
    const usdBase = priced({ ...USD });
    assert.deepEqual([usdBase.baseSubtotalMinor, usdBase.rateToBase], [100000, 1]);
  });
  test('the same facts always give the same answer', () => {
    const f = facts();
    const tt = t();
    assert.deepEqual(priceConsignment(f, tt, settings()), priceConsignment(f, tt, settings()));
    assert.equal(priceConsignment(f, tt, settings()).pricedOn?.toISOString(), '2026-11-04T08:00:00.000Z');
  });
});
