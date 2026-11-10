import { FormulaError } from './errors.js';
import { FUNCTIONS, isFunction, type FunctionName } from './functions.js';
import { tokenize, type Operator, type Token } from './tokens.js';

/** The most parts (numbers, names, signs, calls) one formula may have, and the deepest nesting of brackets. */
export const MAX_NODES = 200;
export const MAX_DEPTH = 40;

export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>=';
export type ArithOp = '+' | '-' | '*' | '/' | '%';

export type Node =
  | { k: 'num'; v: number; at: number }
  | { k: 'str'; v: string; at: number }
  | { k: 'bool'; v: boolean; at: number }
  | { k: 'var'; name: string; at: number }
  | { k: 'call'; fn: FunctionName; args: Node[]; at: number }
  | { k: 'neg'; x: Node; at: number }
  | { k: 'not'; x: Node; at: number }
  | { k: 'and' | 'or'; a: Node; b: Node; at: number }
  | { k: 'cmp'; op: CompareOp; a: Node; b: Node; at: number }
  | { k: 'math'; op: ArithOp; a: Node; b: Node; at: number };

const COMPARE: readonly Operator[] = ['=', '==', '!=', '<', '<=', '>', '>='];

const describe = (t: Token) =>
  t.t === 'end' ? 'the end of the formula' : t.t === 'str' ? `the text "${t.v}"` : t.t === 'num' ? `the number ${t.v}` : `"${t.v}"`;

/**
 * Reads a formula into a tree, by the grammar in consignments design 3.5.6: `or` binds loosest, then `and`, `not`, one
 * comparison, `+ -`, `* / %`, then a leading minus. A comparison can't be chained (`a < b < c`): use `between`.
 */
export function parse(source: string): Node {
  const tokens = tokenize(source);
  let pos = 0;
  let nodes = 0;
  let depth = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const isOp = (v: Operator) => { const t = peek(); return t.t === 'op' && t.v === v; };
  const isKw = (v: string) => { const t = peek(); return t.t === 'kw' && t.v === v; };
  const node = <N extends Node>(n: N): N => {
    if (++nodes > MAX_NODES) throw new FormulaError(`A formula can have at most ${MAX_NODES} parts. Split it into more than one tariff line`);
    return n;
  };
  const expect = (v: Operator, what: string) => {
    const t = peek();
    if (t.t === 'op' && t.v === v) return next();
    throw new FormulaError(`Expected ${what} but found ${describe(t)}`, t.at);
  };
  const nested = <T>(at: number, read: () => T): T => {
    if (++depth > MAX_DEPTH) throw new FormulaError(`Brackets and calls can be nested at most ${MAX_DEPTH} deep`, at);
    try { return read(); } finally { depth--; }
  };

  const or = (): Node => {
    let a = and();
    while (isKw('or')) { const at = next().at; a = node({ k: 'or', a, b: and(), at }); }
    return a;
  };
  const and = (): Node => {
    let a = not();
    while (isKw('and')) { const at = next().at; a = node({ k: 'and', a, b: not(), at }); }
    return a;
  };
  const not = (): Node => {
    if (isKw('not')) { const at = next().at; return nested(at, () => node({ k: 'not', x: not(), at })); }
    return compare();
  };
  const compare = (): Node => {
    const a = sum();
    const t = peek();
    if (t.t !== 'op' || !COMPARE.includes(t.v)) return a;
    next();
    const op = (t.v === '==' ? '=' : t.v) as CompareOp;
    const b = sum();
    const after = peek();
    if (after.t === 'op' && COMPARE.includes(after.v)) throw new FormulaError('Compare one pair at a time: write between(x, low, high), or join two comparisons with "and"', after.at);
    return node({ k: 'cmp', op, a, b, at: t.at });
  };
  const sum = (): Node => {
    let a = product();
    for (let t = peek(); t.t === 'op' && (t.v === '+' || t.v === '-'); t = peek()) { next(); a = node({ k: 'math', op: t.v, a, b: product(), at: t.at }); }
    return a;
  };
  const product = (): Node => {
    let a = unary();
    for (let t = peek(); t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%'); t = peek()) { next(); a = node({ k: 'math', op: t.v, a, b: unary(), at: t.at }); }
    return a;
  };
  const unary = (): Node => {
    if (isOp('-')) { const at = next().at; return nested(at, () => node({ k: 'neg', x: unary(), at })); }
    if (isOp('+')) { next(); return unary(); }
    return primary();
  };
  const primary = (): Node => {
    const t = next();
    switch (t.t) {
      case 'num': return node({ k: 'num', v: t.v, at: t.at });
      case 'str': return node({ k: 'str', v: t.v, at: t.at });
      case 'kw':
        if (t.v === 'true' || t.v === 'false') return node({ k: 'bool', v: t.v === 'true', at: t.at });
        throw new FormulaError(`Expected a number, a name or a bracket but found "${t.v}"`, t.at);
      case 'name': {
        if (!isOp('(')) return node({ k: 'var', name: t.v, at: t.at });
        if (!isFunction(t.v)) throw new FormulaError(`There is no function called ${t.v}: the functions are ${Object.keys(FUNCTIONS).join(', ')}`, t.at);
        const fn = t.v;
        next();
        return nested(t.at, () => {
          const args: Node[] = [];
          if (!isOp(')')) {
            args.push(or());
            while (isOp(',')) { next(); args.push(or()); }
          }
          expect(')', `a comma or ")" to close ${fn}(`);
          const spec = FUNCTIONS[fn];
          if (args.length < spec.min || args.length > spec.max) {
            const want = spec.min === spec.max ? `${spec.min} ${spec.min === 1 ? 'value' : 'values'}` : spec.max >= 41 ? `at least ${spec.min} ${spec.min === 1 ? 'value' : 'values'}` : `${spec.min} to ${spec.max} values`;
            throw new FormulaError(`${fn} takes ${want}, not ${args.length}: ${spec.usage}`, t.at);
          }
          if (fn === 'slab' && args.length % 2 !== 0) throw new FormulaError(`slab needs the quantity, then pairs of limit and price, then the price above the last limit: ${spec.usage}`, t.at);
          return node({ k: 'call', fn, args, at: t.at });
        });
      }
      case 'op':
        if (t.v === '(') {
          return nested(t.at, () => {
            const inner = or();
            expect(')', 'a closing ")"');
            return inner;
          });
        }
        throw new FormulaError(`Expected a number, a name or a bracket but found "${t.v}"`, t.at);
      case 'end':
        if (pos === 1) throw new FormulaError('The formula is empty.');
        throw new FormulaError('The formula stops too early: something is missing at the end', t.at);
    }
  };

  const tree = or();
  const rest = peek();
  if (rest.t !== 'end') {
    const hint = rest.t === 'name' || rest.t === 'num' || (rest.t === 'op' && rest.v === '(') ? ': is an operator such as * missing?' : '';
    throw new FormulaError(`Unexpected ${describe(rest)}${hint}`, rest.at);
  }
  return tree;
}

/** Every variable a tree reads, in the order they first appear. */
export function namesIn(tree: Node): string[] {
  const seen = new Set<string>();
  const walk = (n: Node): void => {
    switch (n.k) {
      case 'var': seen.add(n.name); return;
      case 'call': n.args.forEach(walk); return;
      case 'neg': case 'not': walk(n.x); return;
      case 'and': case 'or': case 'cmp': case 'math': walk(n.a); walk(n.b); return;
      default: return;
    }
  };
  walk(tree);
  return [...seen];
}
