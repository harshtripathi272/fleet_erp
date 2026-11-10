/**
 * The functions a formula may call, and nothing else (consignments design 3.5.6). `min` and `max` arguments are
 * counted, the rest have a fixed number. The words are shown in the tariff editor's help.
 */
export interface FunctionSpec {
  /** Fewest and most arguments; `slab` also needs an even count, checked by the parser. */
  min: number;
  max: number;
  usage: string;
  help: string;
}

export const FUNCTIONS = Object.freeze({
  min: { min: 1, max: 50, usage: 'min(a, b, …)', help: 'The smallest of the numbers.' },
  max: { min: 1, max: 50, usage: 'max(a, b, …)', help: 'The largest of the numbers.' },
  round: { min: 1, max: 2, usage: 'round(x, digits)', help: 'x rounded half away from zero, to a whole number or to that many decimals (−6 to 6).' },
  floor: { min: 1, max: 1, usage: 'floor(x)', help: 'x rounded down to a whole number.' },
  ceil: { min: 1, max: 1, usage: 'ceil(x)', help: 'x rounded up to a whole number.' },
  abs: { min: 1, max: 1, usage: 'abs(x)', help: 'x without its minus sign.' },
  if: { min: 3, max: 3, usage: 'if(condition, a, b)', help: 'a when the condition holds, else b. Only the chosen one is worked out.' },
  between: { min: 3, max: 3, usage: 'between(x, low, high)', help: 'Yes when x is from low to high, both included.' },
  slab: {
    min: 4, max: 41, usage: 'slab(x, upTo1, price1, upTo2, price2, …, priceAbove)',
    help: 'A progressive rate: the first upTo1 units at price1, the units after that up to upTo2 at price2, and so on; units above the last limit at priceAbove.',
  },
} satisfies Record<string, FunctionSpec>);

export type FunctionName = keyof typeof FUNCTIONS;

export const isFunction = (name: string): name is FunctionName => Object.hasOwn(FUNCTIONS, name);
