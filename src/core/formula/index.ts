import { FormulaError } from './errors.js';
import { run, type Value, type Variables } from './evaluate.js';
import { namesIn, parse, type Node } from './parse.js';

/**
 * The formula language (#130, consignments design 3.5.6): arithmetic and conditions over named facts, for tariff
 * lines that no fixed rate basis expresses. It is parsed into a tree and the tree is walked. Nothing is ever turned
 * into code, no object is reached, and the only error it raises is a `FormulaError` saying what and where.
 */

export { FormulaError } from './errors.js';
export { FUNCTIONS, type FunctionName } from './functions.js';
export { MAX_DEPTH, MAX_NODES } from './parse.js';
export { MAX_NAME, MAX_SOURCE } from './tokens.js';
export { roundTo, type Value, type Variables } from './evaluate.js';

export type Expect = 'number' | 'boolean';

export interface Formula {
  readonly source: string;
  readonly tree: Node;
  /** Every variable it reads, in order of first appearance. */
  readonly names: readonly string[];
}

export interface Result<T extends number | boolean = number | boolean> {
  value: T;
  /** The variables it actually read and their values (an `if` reads only one branch), kept for the explanation. */
  used: Record<string, Value>;
}

/** Parses a formula once, to evaluate it many times. */
export function compile(source: string): Formula {
  const tree = parse(source);
  return Object.freeze({ source, tree, names: Object.freeze(namesIn(tree)) });
}

/** Edit distance, for "did you mean". Names are short, so the plain table is fine. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** The closest known name to a mistyped one, when one is close enough to be what was meant. */
export function closest(name: string, known: Iterable<string>): string | undefined {
  let best: string | undefined;
  let score = Infinity;
  for (const k of known) {
    const d = k.toLowerCase() === name.toLowerCase() ? 0.5 : distance(name, k);
    if (d < score) { best = k; score = d; }
  }
  return score <= Math.max(1, Math.min(2, Math.floor(name.length / 3))) ? best : undefined;
}

const unknown = (name: string, known: Iterable<string>) => {
  const near = closest(name, known);
  return `There is no value called "${name}"${near ? `: did you mean "${near}"?` : ''}`;
};

/** A plain copy of the variables, so the formula never reads through a prototype. */
const table = (variables: Variables) => new Map(Object.keys(variables).map((k) => [k, variables[k]] as const));

/**
 * Works a formula out against the facts. The result must be a finite number or a yes/no; with `expect`, it must be
 * that one. A name with no value, a division by zero or a type mismatch is a `FormulaError`: it never guesses.
 */
export function evaluate(formula: Formula | string, variables: Variables, expect?: 'number'): Result<number>;
export function evaluate(formula: Formula | string, variables: Variables, expect: 'boolean'): Result<boolean>;
export function evaluate(formula: Formula | string, variables: Variables, expect?: Expect): Result;
export function evaluate(formula: Formula | string, variables: Variables, expect?: Expect): Result {
  const f = typeof formula === 'string' ? compile(formula) : formula;
  const values = table(variables);
  const used: Record<string, Value> = Object.create(null);
  const value = run(f.tree, (name, at) => {
    if (!values.has(name)) throw new FormulaError(unknown(name, values.keys()), at);
    const v = values.get(name);
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) throw new FormulaError(`"${name}" has no value here`, at);
    if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') throw new FormulaError(`"${name}" is not a number, a text or a yes/no`, at);
    used[name] = v;
    return v;
  });
  if (typeof value === 'string') throw new FormulaError('The formula gives a text; it must give a number or a yes/no.');
  if (expect === 'number' && typeof value !== 'number') throw new FormulaError('The formula gives a yes/no, but an amount is needed here.');
  if (expect === 'boolean' && typeof value !== 'boolean') throw new FormulaError('The formula gives a number, but a condition is needed here, such as km > 100.');
  return { value, used: { ...used } };
}

export interface CheckOptions {
  /** The names a formula here may read. A name ending in "." admits every name under it ("custom."). */
  names: Iterable<string>;
  expect?: Expect;
  /** Example facts for a dry run, which catches a wrong type or a yes/no where an amount is needed. */
  sample?: Variables;
}

/**
 * What is wrong with a formula before it is saved (a tariff master's `prepare`): it must parse, read only known
 * names, and, given sample facts, give the kind of value expected. An empty list means it is fine.
 */
export function check(source: string, options: CheckOptions): string[] {
  let f: Formula;
  try {
    f = compile(source);
  } catch (err) {
    if (err instanceof FormulaError) return [err.message];
    throw err;
  }
  const known = [...options.names];
  const exact = new Set(known.filter((n) => !n.endsWith('.')));
  const prefixes = known.filter((n) => n.endsWith('.'));
  const problems = f.names
    .filter((n) => !exact.has(n) && !prefixes.some((p) => n.startsWith(p) && n.length > p.length))
    .map((n) => `${unknown(n, exact)}.`.replace('?.', '?'));
  // A dry run needs a value for every name; one admitted by a prefix ("custom.") may not have a sample, so skip it.
  if (problems.length || !options.sample || f.names.some((n) => !Object.hasOwn(options.sample!, n))) return problems;
  try {
    evaluate(f, options.sample, options.expect);
  } catch (err) {
    if (err instanceof FormulaError) return [err.message];
    throw err;
  }
  return [];
}
