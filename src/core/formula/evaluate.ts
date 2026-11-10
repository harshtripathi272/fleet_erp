import { FormulaError } from './errors.js';
import type { Node } from './parse.js';

export type Value = number | string | boolean;
/** What a formula may read: numbers, texts (codes) and yes/no values. Empty means "has no value". */
export type Variables = Readonly<Record<string, number | string | boolean | null | undefined>>;

/** Two numbers this close are equal, so 0.1 + 0.2 = 0.3 holds. */
const EPSILON = 1e-9;

const kind = (v: Value) => (typeof v === 'number' ? 'a number' : typeof v === 'string' ? 'text' : 'a yes/no');
const what = (n: Node) => (n.k === 'var' ? `"${n.name}"` : n.k === 'call' ? `${n.fn}(…)` : 'this part');

/** Rounds half away from zero, without the 1.005 × 100 = 100.4999… surprise. */
export function roundTo(x: number, digits = 0): number {
  const f = 10 ** digits;
  const r = Math.sign(x) * Math.round(Number((Math.abs(x) * f).toPrecision(15))) / f;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Walks a parsed formula. Pure: it reads only `lookup`, never an object's properties, so a name such as
 * `constructor` or `__proto__` is just a name that has no value. `if`, `and` and `or` work out only what they need.
 */
export function run(tree: Node, lookup: (name: string, at: number) => Value): Value {
  const finite = (x: number, at: number) => {
    if (!Number.isFinite(x)) throw new FormulaError('The result is too large to work with', at);
    return Object.is(x, -0) ? 0 : x;
  };
  const num = (n: Node): number => {
    const v = val(n);
    if (typeof v !== 'number') throw new FormulaError(`${what(n)} is ${kind(v)}, but a number is needed here`, n.at);
    return v;
  };
  const bool = (n: Node, where: string): boolean => {
    const v = val(n);
    if (typeof v !== 'boolean') throw new FormulaError(`${where} needs a yes/no: ${what(n)} is ${kind(v)}. Write a condition, such as km > 100`, n.at);
    return v;
  };

  const val = (n: Node): Value => {
    switch (n.k) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'var': return lookup(n.name, n.at);
      case 'neg': return finite(-num(n.x), n.at);
      case 'not': return !bool(n.x, '"not"');
      case 'and': return bool(n.a, '"and"') && bool(n.b, '"and"');
      case 'or': return bool(n.a, '"or"') || bool(n.b, '"or"');
      case 'math': {
        const a = num(n.a);
        const b = num(n.b);
        switch (n.op) {
          case '+': return finite(a + b, n.at);
          case '-': return finite(a - b, n.at);
          case '*': return finite(a * b, n.at);
          case '/': if (b === 0) throw new FormulaError('Divides by zero', n.at); return finite(a / b, n.at);
          // The remainder keeps the sign of a, as in a spreadsheet's MOD only for positives: -7 % 3 is -1.
          case '%': if (b === 0) throw new FormulaError('Divides by zero', n.at); return finite(a % b, n.at);
        }
        break;
      }
      case 'cmp': {
        const a = val(n.a);
        const b = val(n.b);
        if (n.op === '=' || n.op === '!=') {
          if (typeof a !== typeof b) throw new FormulaError(`Can't compare ${kind(a)} with ${kind(b)}`, n.at);
          // Codes are compared without regard to capitals, so packaging = "cont20" matches CONT20.
          const same = typeof a === 'number' ? Math.abs(a - (b as number)) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b as number))
            : typeof a === 'string' ? a.localeCompare(b as string, undefined, { sensitivity: 'accent' }) === 0
            : a === b;
          return n.op === '=' ? same : !same;
        }
        if (typeof a !== 'number' || typeof b !== 'number') throw new FormulaError(`${n.op} compares numbers, not ${typeof a !== 'number' ? kind(a) : kind(b)}`, n.at);
        switch (n.op) {
          case '<': return a < b;
          case '<=': return a <= b;
          case '>': return a > b;
          case '>=': return a >= b;
        }
        break;
      }
      case 'call': {
        const [first, ...rest] = n.args as [Node, ...Node[]];
        switch (n.fn) {
          case 'if': return bool(first, 'if(…)') ? val(rest[0]!) : val(rest[1]!);
          case 'min': return n.args.map(num).reduce((m, x) => Math.min(m, x));
          case 'max': return n.args.map(num).reduce((m, x) => Math.max(m, x));
          case 'abs': return Math.abs(num(first));
          case 'floor': return finite(Math.floor(num(first)), n.at);
          case 'ceil': return finite(Math.ceil(num(first)), n.at);
          case 'round': {
            const x = num(first);
            const d = rest[0] ? num(rest[0]) : 0;
            if (!Number.isInteger(d) || d < -6 || d > 6) throw new FormulaError('round(x, digits) takes a whole number of digits from -6 to 6', n.at);
            return finite(roundTo(x, d), n.at);
          }
          case 'between': {
            const [x, low, high] = n.args.map(num) as [number, number, number];
            if (low > high) throw new FormulaError(`between(x, low, high) needs low to be no more than high, not ${low} and ${high}`, n.at);
            return x >= low && x <= high;
          }
          case 'slab': {
            const [x, ...rates] = n.args.map(num) as [number, ...number[]];
            const above = rates.pop()!;
            let total = 0;
            let from = 0;
            for (let i = 0; i < rates.length; i += 2) {
              const upTo = rates[i]!;
              const price = rates[i + 1]!;
              if (upTo <= from) throw new FormulaError(`slab limits must go up, but ${upTo} comes after ${from}`, n.at);
              total += Math.max(0, Math.min(x, upTo) - from) * price;
              from = upTo;
            }
            total += Math.max(0, x - from) * above;
            return finite(total, n.at);
          }
        }
        break;
      }
    }
    throw new FormulaError('This part of the formula is not understood', n.at);
  };

  return val(tree);
}
