import { evaluate, FormulaError, type Result } from '../../../core/formula/index.js';
import * as Fmt from '../../../core/format/regional.js';
import { chargeableKg, chargedBy, chargedQuantity, losses, measureFor, progress, QUANTITY_BASES, round3, roundTo, UNIT_LABEL } from './quantities.js';
import { variablesFor } from './variables.js';
import type {
  ChargeTypeInput, EngineSettings, PricingFacts, RevenueBasis, RevenueLine, RevenueResult, TariffInput, TariffLineInput,
} from './types.js';

/**
 * What a consignment is worth, and why (#130, consignments design 3.5.1–3.5.5 and 3.5.8). Pure: the same facts,
 * tariff and settings always give the same lines, totals and sentences.
 *
 * In order: a frozen or invoiced revenue is left as it is; a manual price replaces freight (or everything, when it is
 * the whole price); each tariff line is priced on its basis; freight is topped up to the minimum charge; the
 * customer-side shortage is deducted once the last drop is in; lines a person added or switched off survive; tax and
 * totals follow, then the figure in the base currency. Anything that can't be worked out leaves the consignment
 * unpriced with the reason. It never guesses.
 */
export function priceConsignment(facts: PricingFacts, tariff: TariffInput | null | undefined, settings: EngineSettings): RevenueResult {
  const previous = facts.previous;
  if (previous && (previous.status === 'frozen' || previous.status === 'invoiced')) {
    return { ...(previous as unknown as RevenueResult), lines: previous.lines, explanation: (previous.explanation as string[] | undefined) ?? [], unchanged: true };
  }

  const currency = facts.currency;
  const say: string[] = [];
  const pricedOn = new Date(facts.pricedOn);
  const types = new Map(settings.chargeTypes.map((t) => [t.id, t] as const));
  const byCode = (code: string) => settings.chargeTypes.find((t) => t.code === code);
  const state = progress(facts);
  const chargeOn = tariff?.chargeOn ?? settings.chargeOnDefault;
  const distanceSource = tariff?.distanceSource ?? settings.distanceSourceDefault;
  const manual = previous?.manual;
  const kept = (previous?.lines ?? []).filter((l) => l.source === 'manual');
  const keptFreight = kept.filter((l) => l.kind === 'freight' || l.kind === 'minimum');
  const keptOther = kept.filter((l) => l.kind !== 'freight' && l.kind !== 'minimum');
  const money = (minor: number) => Fmt.money(minor, currency);
  const each = (minor: number) => `${Fmt.number(minor / 10 ** currency.minorUnits, { min: 0, max: currency.minorUnits + 4 })} ${currency.code}`;
  const qtyText = (q: number) => Fmt.number(q, { min: 0, max: 3 });

  const lines: RevenueLine[] = [];
  const tariffLineOf = new Map<string, TariffLineInput>();
  let problem: string | undefined;
  let estimated = !state.complete;
  let basis: Partial<RevenueBasis> = {};
  const fail = (why: string) => { problem ??= why; };

  const labelOf = (tl: TariffLineInput | undefined, type: ChargeTypeInput) => tl?.description || type.printLabel || type.name;
  const km = (): number | undefined => {
    const d = facts.distance;
    const value = distanceSource === 'trip_loaded_km' ? d.tripLoadedKm : distanceSource === 'manual' ? d.manualKm : d.leadKm;
    return value !== undefined && value > 0 ? round3(value) : undefined;
  };
  const noKm = () => (distanceSource === 'manual' ? `${facts.number} has no lead distance typed in, so it can't be charged per km.`
    : distanceSource === 'trip_loaded_km' ? `${facts.number}'s trip has no loaded km to charge.`
    : `${facts.number} has no lead distance yet: it needs a pickup and a drop on the trip's stops.`);

  const weightRules = { volumetricDivisorKgPerM3: tariff?.volumetricDivisorKgPerM3, minimumChargeableKg: tariff?.minimumChargeableKg, roundQtyUpTo: tariff?.roundQtyUpTo };
  /** Freight priced so far (and a manual freight), in minor units: what percentages and `freight` in a formula read. */
  const freightSoFar = () => [...(manual ? keptFreight : []), ...lines].filter((l) => l.kind === 'freight' || l.kind === 'minimum').reduce((s, l) => s + l.amountMinor, 0);
  function runFormula(label: string, source: string, expect: 'boolean'): Result<boolean> | undefined;
  function runFormula(label: string, source: string, expect: 'number'): Result<number> | undefined;
  function runFormula(label: string, source: string, expect: 'number' | 'boolean') {
    try {
      return evaluate(source, variablesFor(facts, { chargeOn, distanceSource, freightMinor: freightSoFar(), rules: weightRules }), expect);
    } catch (err) {
      if (err instanceof FormulaError) { fail(`${label}: ${err.message}`); return undefined; }
      throw err;
    }
  }
  const seen = (used: Record<string, unknown>) => Object.entries(used).map(([k, v]) => `${k} = ${typeof v === 'number' ? qtyText(v) : String(v)}`).join(', ');

  /** Slab bands priced (design 3.4.5): each band's units at its price, or every unit at the band the quantity reaches. */
  const slabbed = (label: string, qty: number, slabs: NonNullable<TariffLineInput['slabs']>, mode: TariffLineInput['slabMode']): { amountMinor: number; text: string } | undefined => {
    let from = 0;
    for (const [i, slab] of slabs.entries()) {
      const top = slab.upTo ?? Infinity;
      if (top <= from || (slab.upTo == null && i < slabs.length - 1)) { fail(`The tariff's line "${label}" has slabs that don't go up one after another.`); return undefined; }
      from = top;
    }
    if (qty > from) { fail(`${facts.number}'s ${qtyText(qty)} is above the last slab of "${label}" (${qtyText(from)}): add a slab with no upper limit.`); return undefined; }
    if (mode === 'whole') {
      const band = slabs.find((sl) => (sl.upTo ?? Infinity) >= qty)!;
      return { amountMinor: roundMinor(qty * band.price.amountMinor), text: `${qtyText(qty)} × ${each(band.price.amountMinor)} (the band up to ${band.upTo == null ? 'any amount' : qtyText(band.upTo)})` };
    }
    let amount = 0;
    const parts: string[] = [];
    from = 0;
    for (const slab of slabs) {
      const top = slab.upTo ?? Infinity;
      const units = round3(Math.max(0, Math.min(qty, top) - from));
      if (units > 0) { amount += units * slab.price.amountMinor; parts.push(`${qtyText(units)} × ${each(slab.price.amountMinor)}`); }
      from = top;
      if (qty <= top) break;
    }
    return { amountMinor: roundMinor(amount), text: parts.join(' + ') || '0' };
  };

  /** One tariff line as a revenue line, or nothing when it comes to nothing (no extra drops, a condition that doesn't hold). */
  const priceLine = (tl: TariffLineInput, type: ChargeTypeInput): RevenueLine | undefined => {
    const label = labelOf(tl, type);
    if (tl.when) {
      const holds = runFormula(label, tl.when, 'boolean');
      if (!holds) return undefined;
      if (!holds.value) { say.push(`${label}: left out, as ${tl.when} does not hold here (${seen(holds.used)}).`); return undefined; }
    }
    const slabs = tl.slabs?.length ? tl.slabs : undefined;
    const priced = !slabs && !['formula', 'percent_of_freight', 'percent_of_value', 'shortage_beyond_allowance'].includes(tl.basis);
    if (priced && !tl.price) { fail(`The tariff's line "${label}" has no price.`); return undefined; }
    if ((tl.price && tl.price.currencyId !== currency.id) || slabs?.some((sl) => sl.price.currencyId !== currency.id)) {
      fail(`The tariff's line "${label}" is priced in another currency than the tariff.`);
      return undefined;
    }
    let price = Number(tl.price?.amountMinor ?? 0);
    let qty: number;
    let description = label;
    let unit = UNIT_LABEL[tl.basis];
    let sentence: string | undefined;
    let extra: Partial<RevenueLine> = {};
    switch (tl.basis) {
      case 'per_consignment':
        qty = 1;
        break;
      case 'per_trip':
        if (facts.perTrip && !facts.perTrip.carries) {
          say.push(`${label}: charged once per trip${facts.perTrip.carrierNumber ? `, on ${facts.perTrip.carrierNumber}` : ''}.`);
          return { chargeTypeId: type.id, kind: type.kind, description: facts.perTrip.carrierNumber ? `${label} · included in ${facts.perTrip.carrierNumber}` : `${label} · included in the trip's price`, qty: 1, unit, unitPriceMinor: 0, amountMinor: 0, source: 'tariff', tariffLineId: tl.id, accepted: true };
        }
        qty = 1;
        break;
      case 'per_km': {
        const d = km();
        if (d === undefined) { fail(noKm()); return undefined; }
        qty = d;
        basis.km = d;
        break;
      }
      case 'per_drop_beyond': {
        const free = tl.freeQty ?? 1;
        const drops = state.drops.length;
        qty = Math.max(0, drops - free);
        if (!qty) { say.push(`${label}: ${drops} ${drops === 1 ? 'drop' : 'drops'}, ${free} free, so nothing extra.`); return undefined; }
        sentence = `${label}: ${drops} drops, ${free} free: ${qty} × ${each(price)}`;
        break;
      }
      case 'shortage_beyond_allowance':
        return undefined; // the shortage step prices it
      case 'percent_of_freight':
      case 'percent_of_value': {
        if (tl.percent === undefined) { fail(`The tariff's line "${label}" has no percentage.`); return undefined; }
        const of = tl.basis === 'percent_of_freight' ? freightSoFar()
          : facts.lines.length && facts.lines.every((l) => l.declaredValueMinor !== undefined) ? facts.lines.reduce((s, l) => s + l.declaredValueMinor!, 0) : undefined;
        if (of === undefined) { fail(`${facts.number} has no declared value, so "${label}" can't be worked out.`); return undefined; }
        qty = tl.percent;
        price = of / 100;
        sentence = `${label}: ${qtyText(tl.percent)} % of ${tl.basis === 'percent_of_freight' ? 'freight' : 'the declared value'} ${money(of)}`;
        break;
      }
      case 'formula': {
        if (!tl.formula) { fail(`The tariff's line "${label}" has no formula.`); return undefined; }
        const r = runFormula(label, tl.formula, 'number');
        if (!r) return undefined;
        qty = 1;
        price = roundMinor(r.value * 10 ** currency.minorUnits);
        unit = '';
        extra = { formula: tl.formula, variables: r.used };
        sentence = `${label}: ${tl.formula}${Object.keys(r.used).length ? `, with ${seen(r.used)}` : ''}`;
        break;
      }
      default: {
        if (!QUANTITY_BASES.includes(tl.basis)) { fail(`The tariff's line "${label}" uses a rate basis this version can't price yet.`); return undefined; }
        // Charged on chargeable weight per kg, and per tonne when the tariff sets a volumetric divisor (3.5.4).
        const byWeight = tl.basis === 'per_kg' || (tl.basis === 'per_tonne' && !!tariff?.volumetricDivisorKgPerM3);
        const charged = byWeight
          ? chargedBy(chargeOn, facts, (a) => {
            if (a.kg === undefined) return measureFor(tl.basis, a, facts.number) as { problem: string };
            const w = chargeableKg(a, weightRules, facts);
            return 'problem' in w ? w : { ...w, qty: tl.basis === 'per_kg' ? w.kg : round3(w.kg / 1000) };
          })
          : chargedQuantity(tl.basis, chargeOn, facts);
        if ('problem' in charged) { fail(charged.problem); return undefined; }
        qty = charged.qty;
        if (tl.basis === 'per_tonne_km') {
          const d = km();
          if (d === undefined) { fail(noKm()); return undefined; }
          qty = round3(charged.qty * d);
          basis.km = d;
        }
        if (charged.estimated) estimated = true;
        if (type.kind === 'freight' && basis.qty === undefined) Object.assign(basis, { qty, unit });
        description = `${label}, ${charged.from}`;
        say.push(`Charged on ${charged.from}${charged.estimated && charged.note ? `, as an estimate: ${charged.note}` : ''}: ${qtyText(qty)} ${unit}.`);
        if ('kg' in charged && typeof charged.kg === 'number') {
          const w = charged as unknown as { kg: number; actualKg: number; volumetricKg?: number; m3?: number };
          if (w.kg !== w.actualKg) {
            say.push(`Chargeable weight ${qtyText(w.kg)} kg: actual ${qtyText(w.actualKg)} kg${w.volumetricKg !== undefined ? `, volumetric ${qtyText(w.m3!)} m³ × ${qtyText(tariff!.volumetricDivisorKgPerM3!)} = ${qtyText(w.volumetricKg)} kg` : ''}${tariff?.minimumChargeableKg ? `, least charged ${qtyText(tariff.minimumChargeableKg)} kg` : ''}${tariff?.roundQtyUpTo ? `, rounded up to the next ${qtyText(tariff.roundQtyUpTo)} kg` : ''}.`);
          }
        }
        break;
      }
    }
    let amountMinor: number;
    if (slabs && tl.basis !== 'formula' && !tl.basis.startsWith('percent_')) {
      const s2 = slabbed(label, qty, slabs, tl.slabMode);
      if (!s2) return undefined;
      amountMinor = s2.amountMinor;
      price = qty ? amountMinor / qty : amountMinor;
      sentence = `${label}: ${s2.text}`;
    } else {
      amountMinor = roundMinor(qty * price);
    }
    let unitPriceMinor = price;
    let note: string | undefined;
    const min = tl.minimum?.currencyId === currency.id ? tl.minimum.amountMinor : undefined;
    const max = tl.maximum?.currencyId === currency.id ? tl.maximum.amountMinor : undefined;
    if (min !== undefined && amountMinor < min) { note = `Raised to the line's minimum of ${money(min)}.`; amountMinor = min; }
    if (max !== undefined && amountMinor > max) { note = `Capped at the line's maximum of ${money(max)}.`; amountMinor = max; }
    if (note) unitPriceMinor = qty ? amountMinor / qty : amountMinor;
    say.push(`${sentence ?? `${label}: ${qtyText(qty)} ${unit} × ${each(price)}`} = ${money(amountMinor)}.${note ? ` ${note}` : ''}`);
    return {
      chargeTypeId: type.id, kind: type.kind, description, qty, ...(unit ? { unit } : {}), unitPriceMinor, amountMinor, source: 'tariff', tariffLineId: tl.id, accepted: true,
      ...extra, ...(note ? { note } : {}),
    };
  };

  if (manual?.whole) {
    say.push(`Priced by hand as the whole price${manual.reason ? `: ${manual.reason}` : ''}.`);
    if (!kept.length) fail(`${facts.number} is marked as priced by hand, but has no price lines.`);
  } else {
    if (manual) say.push(`Freight priced by hand${manual.reason ? `: ${manual.reason}` : ''}.`);
    if (!tariff) {
      if (!manual) fail('No tariff covers this consignment; add one under Tariffs or price it by hand.');
    } else if (tariff.currencyId !== currency.id) {
      fail(`The tariff ${tariff.code} is in another currency than the one it is being priced in.`);
    } else {
      say.push(`Tariff ${tariff.code}${tariff.version ? ` v${tariff.version}` : ''}${tariff.matchedOn ? ` (${tariff.matchedOn} matched)` : ''}.`);
      const ordered = tariff.lines.map((tl, i) => ({ tl, i })).sort((a, b) => (a.tl.order ?? 100) - (b.tl.order ?? 100) || a.i - b.i).map((x) => x.tl);
      for (const tl of ordered) {
        tariffLineOf.set(tl.id, tl);
        const type = types.get(tl.chargeTypeId);
        if (!type) { fail(`The tariff's line "${tl.description ?? tl.basis}" names a charge type that is missing or switched off.`); break; }
        if (manual && (type.kind === 'freight' || type.kind === 'minimum')) continue;
        const line = priceLine(tl, type);
        if (problem) break;
        if (line) lines.push(line);
      }

      // Minimum charge (3.5.3 step 5): freight topped up, as priceTrip did.
      const minimum = tariff.minimumCharge;
      if (!problem && !manual && minimum && minimum.currencyId === currency.id) {
        const freight = lines.filter((l) => l.kind === 'freight').reduce((s, l) => s + l.amountMinor, 0);
        if (freight < minimum.amountMinor) {
          const type = byCode('MINIMUM') ?? settings.chargeTypes.find((t) => t.kind === 'minimum');
          if (!type) fail('The tariff has a minimum charge, but there is no Minimum charge type to put it on. Add one under Charge types.');
          else {
            const top = minimum.amountMinor - freight;
            lines.push({ chargeTypeId: type.id, kind: 'minimum', description: type.printLabel || type.name, qty: 1, unitPriceMinor: top, amountMinor: top, source: 'tariff', accepted: true });
            say.push(`Freight came to ${money(freight)}, under the minimum charge of ${money(minimum.amountMinor)}: ${money(top)} added.`);
          }
        }
      }
    }

    // Customer-side shortage (3.5.5), once the last drop is recorded.
    const shortageLine = tariff?.lines.find((tl) => tl.basis === 'shortage_beyond_allowance');
    const mode = tariff?.shortageDeduction ?? (shortageLine ? 'beyond_allowance' : settings.shortageDeductionDefault);
    if (!problem && (tariff || manual) && state.complete) {
      for (const loss of losses(facts)) {
        if (!(loss.loss > 0)) continue;
        const what = facts.lines.length > 1 ? `${loss.line.productName ?? 'Goods'}: l` : 'L';
        if (mode === 'none') { say.push(`${what}oss ${qtyText(loss.loss)} ${loss.unit}: not deducted, as the tariff deducts no shortage.`); continue; }
        const percent = mode === 'all' ? 0 : tariff?.shortageAllowancePercent ?? loss.line.product.shortageAllowancePercent ?? facts.shortageAllowancePercent ?? 0;
        const allowance = roundTo((loss.loaded * percent) / 100, loss.decimals);
        const net = Math.max(0, roundTo(loss.loss - allowance, loss.decimals));
        const head = `Loaded ${qtyText(loss.loaded)}, delivered ${qtyText(loss.delivered)}: ${what === 'L' ? 'loss' : `${what}oss`} ${qtyText(loss.loss)} ${loss.unit}`;
        if (!net) { say.push(`${head}, within the allowance of ${percent} % (${qtyText(allowance)}).`); continue; }
        const linePrice = shortageLine?.price && shortageLine.price.currencyId === currency.id ? shortageLine.price.amountMinor : undefined;
        const price = linePrice ?? loss.line.product.shortagePricePerUnitMinor;
        const type = (shortageLine && types.get(shortageLine.chargeTypeId)) || byCode('SHORTAGE_DEDUCTION');
        if (price === undefined || !(price > 0)) { say.push(`${head}, ${qtyText(net)} beyond the allowance, not deducted: neither the tariff nor the product has a shortage price.`); continue; }
        if (!type) { say.push(`${head}, ${qtyText(net)} beyond the allowance, not deducted: there is no Shortage deduction charge type.`); continue; }
        const amountMinor = roundMinor(-net * price);
        const label = labelOf(shortageLine, type);
        lines.push({
          chargeTypeId: type.id, kind: 'deduction', description: facts.lines.length > 1 && loss.line.productName ? `${label} · ${loss.line.productName}` : label,
          qty: net, unit: loss.unit, unitPriceMinor: -price, amountMinor, source: 'tariff', ...(shortageLine ? { tariffLineId: shortageLine.id } : {}), accepted: true,
        });
        say.push(`${head}, allowance ${mode === 'all' ? 'none' : `${percent} % = ${qtyText(allowance)}`}, ${qtyText(net)} deducted at ${each(price)} = ${money(amountMinor)}.`);
      }
    }
  }

  // What a person did survives a reprice: lines they added, and lines they switched off (3.5.8).
  const key = (l: RevenueLine) => `${l.tariffLineId ?? l.chargeTypeId}|${l.legId ?? ''}|${l.kind}`;
  const off = new Map((previous?.lines ?? []).filter((l) => l.source !== 'manual' && l.accepted === false).map((l) => [key(l), l] as const));
  const engine = problem ? [] : lines.map((l) => {
    const was = off.get(key(l));
    return was ? { ...l, accepted: false, ...(was.note ? { note: was.note } : {}), ...(was.by ? { by: was.by } : {}) } : l;
  });
  if (manual && !manual.whole && !keptFreight.length) fail(`${facts.number} is marked as priced by hand, but has no freight line.`);
  // On a problem nothing the engine worked out is kept, only what a person typed.
  const priced = (problem ? kept : manual?.whole ? kept : [...(manual ? keptFreight : []), ...engine, ...keptOther]).map((l) => withTax(l));

  function withTax(l: RevenueLine): RevenueLine {
    const type = types.get(l.chargeTypeId);
    const tl = l.tariffLineId ? tariffLineOf.get(l.tariffLineId) : undefined;
    const percent = settings.tax.mode === 'none' || type?.taxable === false ? 0
      : l.source === 'manual' && l.taxPercent !== undefined ? l.taxPercent
      : settings.tax.mode === 'single' ? settings.tax.ratePercent
      : tl?.taxRatePercent ?? tariff?.taxRatePercent ?? settings.tax.ratePercent;
    const taxMinor = !percent ? 0 : settings.tax.pricesIncludeTax ? roundMinor((l.amountMinor * percent) / (100 + percent)) : roundMinor((l.amountMinor * percent) / 100);
    return { ...l, taxPercent: percent, taxMinor };
  }

  // Totals: what is billed to the customer. Cost lines (a broker's commission) and lines switched off are not.
  const billed = priced.filter((l) => l.accepted !== false && types.get(l.chargeTypeId)?.direction !== 'cost');
  const include = settings.tax.pricesIncludeTax;
  const taxMinor = billed.reduce((s, l) => s + (l.taxMinor ?? 0), 0);
  const subtotalMinor = billed.reduce((s, l) => s + (include ? l.amountMinor - (l.taxMinor ?? 0) : l.amountMinor), 0);
  const totalMinor = include ? billed.reduce((s, l) => s + l.amountMinor, 0) : subtotalMinor + taxMinor;

  if (problem) say.push(problem);
  else say.push(`${money(subtotalMinor)} before tax${taxMinor ? `, ${money(taxMinor)} tax, ${money(totalMinor)} in all` : ''}${estimated && !manual?.whole ? ', as an estimate until every pickup and drop is recorded' : ''}.`);

  // The base currency, for trip profit (3.5.3 step 9). A missing rate never fails the pricing.
  let base: Pick<RevenueResult, 'baseSubtotalMinor' | 'baseTotalMinor' | 'rateToBase'> = {};
  if (facts.base && !problem) {
    const b = facts.base;
    const rate = b.id === currency.id ? 1 : b.rate ?? undefined;
    if (rate !== undefined && rate > 0) {
      const convert = (minor: number) => Math.round((minor / 10 ** currency.minorUnits) * rate * 10 ** b.minorUnits);
      base = { baseSubtotalMinor: convert(subtotalMinor), baseTotalMinor: convert(totalMinor), rateToBase: rate };
    } else {
      say.push(`Add the ${currency.code} rate for ${Fmt.date(pricedOn)} under Exchange rates to see this in ${b.code}.`);
    }
  }

  const status = problem ? 'unpriced' : manual?.whole ? 'priced' : estimated ? 'estimated' : 'priced';
  return {
    status,
    ...(tariff ? { tariffId: tariff.id, ...(tariff.version !== undefined ? { tariffVersion: tariff.version } : {}) } : {}),
    currencyId: currency.id,
    pricedOn,
    basis: { chargeOn, ...basis, drops: state.drops.length, estimated: status === 'estimated' },
    lines: priced,
    subtotalMinor, taxMinor, totalMinor,
    ...base,
    explanation: say,
    ...(problem ? { problem } : {}),
  };
}

/** A whole minor unit, half away from zero, so a deduction rounds like the charge it mirrors. */
export function roundMinor(x: number): number {
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return Object.is(r, -0) ? 0 : r;
}
