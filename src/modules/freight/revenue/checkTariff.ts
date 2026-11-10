import { check } from '../../../core/formula/index.js';
import { RATE_BASES, type TariffInput } from './types.js';
import { formulaNames, sampleVariables } from './variables.js';

/**
 * What is wrong with a tariff before it is saved (the tariff master's `prepare`, design 3.5.6): every condition and
 * formula must parse, read only known names and give the right kind of answer; slabs must go up; a percentage line
 * needs its percentage; a priced line needs a price. An empty list means it can be saved.
 */
export function checkTariff(tariff: Pick<TariffInput, 'lines' | 'currencyId'>): string[] {
  const problems: string[] = [];
  const names = formulaNames();
  const sample = sampleVariables();
  tariff.lines.forEach((line, i) => {
    const which = `Line ${i + 1}${line.description ? ` (${line.description})` : ''}`;
    const add = (why: string) => problems.push(`${which}: ${why}`);
    if (!(RATE_BASES as readonly string[]).includes(line.basis)) add(`"${line.basis}" is not a rate basis.`);
    if (line.when) for (const p of check(line.when, { names, expect: 'boolean', sample })) add(`the condition: ${p}`);
    if (line.basis === 'formula') {
      if (!line.formula) add('a formula line needs its formula.');
      else for (const p of check(line.formula, { names, expect: 'number', sample })) add(`the formula: ${p}`);
    } else if (line.formula) add('a formula is only used with the basis "Formula".');
    if (line.basis.startsWith('percent_') && line.percent === undefined) add('a percentage line needs its percentage.');
    const slabs = line.slabs ?? [];
    if (slabs.length) {
      let from = 0;
      let ordered = true;
      slabs.forEach((slab, j) => {
        const top = slab.upTo ?? Infinity;
        if (ordered && slab.upTo == null && j < slabs.length - 1) { add('only the last slab can be open-ended.'); ordered = false; }
        else if (ordered && top <= from) { add(`slab ${j + 1} must go above ${from}.`); ordered = false; }
        from = top;
        if (slab.price.currencyId !== tariff.currencyId) add(`slab ${j + 1} is priced in another currency than the tariff.`);
      });
    } else if (!['formula', 'percent_of_freight', 'percent_of_value', 'shortage_beyond_allowance'].includes(line.basis) && !line.price) add('it needs a price.');
    if (line.price && line.price.currencyId !== tariff.currencyId) add('it is priced in another currency than the tariff.');
  });
  return problems;
}
