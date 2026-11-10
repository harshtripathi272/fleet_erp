import { FormulaError } from './errors.js';

/** The longest formula and the longest name accepted (consignments design 3.5.6). */
export const MAX_SOURCE = 500;
export const MAX_NAME = 64;

export const OPERATORS = ['<=', '>=', '!=', '==', '<', '>', '=', '+', '-', '*', '/', '%', '(', ')', ','] as const;
export type Operator = (typeof OPERATORS)[number];
export const KEYWORDS = ['and', 'or', 'not', 'true', 'false'] as const;
export type Keyword = (typeof KEYWORDS)[number];

export type Token =
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'name'; v: string; at: number }
  | { t: 'kw'; v: Keyword; at: number }
  | { t: 'op'; v: Operator; at: number }
  | { t: 'end'; at: number };

const isDigit = (c: string) => c >= '0' && c <= '9';
const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
/** Signs people type from a phone or a spreadsheet, read as the operator they mean. */
const ALIASES: Record<string, Operator> = { '×': '*', '÷': '/', '−': '-', '≤': '<=', '≥': '>=', '≠': '!=' };
/** What someone used to another language probably meant. */
const HINTS: Record<string, string> = { '&&': 'Write "and" instead of &&', '||': 'Write "or" instead of ||', '!': 'Write "not" instead of !', '^': 'Powers are not supported; multiply instead', '<>': 'Write != for "is not"' };

const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Splits a formula into its words, numbers, texts and signs. Columns are 1-based. */
export function tokenize(source: string): Token[] {
  if (typeof source !== 'string') throw new FormulaError('A formula must be text.');
  if (source.length > MAX_SOURCE) throw new FormulaError(`A formula can be at most ${MAX_SOURCE} characters; this one has ${source.length}.`);
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const at = i + 1;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (isDigit(c)) {
      let j = i;
      while (j < source.length && isDigit(source[j]!)) j++;
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) { j++; while (j < source.length && isDigit(source[j]!)) j++; }
      const v = Number(source.slice(i, j));
      if (!Number.isFinite(v)) throw new FormulaError('This number is too large', at);
      out.push({ t: 'num', v, at });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const close = source.indexOf(c, i + 1);
      const nl = source.slice(i + 1, close < 0 ? undefined : close).search(/[\r\n]/);
      if (close < 0 || nl >= 0) throw new FormulaError(`The text that starts here has no closing ${c}`, at);
      out.push({ t: 'str', v: source.slice(i + 1, close), at });
      i = close + 1;
      continue;
    }
    if (isLetter(c)) {
      let j = i;
      while (j < source.length && (isLetter(source[j]!) || isDigit(source[j]!) || source[j] === '_' || source[j] === '.')) j++;
      const word = source.slice(i, j);
      if (word.length > MAX_NAME) throw new FormulaError(`A name can be at most ${MAX_NAME} characters`, at);
      if (word.endsWith('.') || word.includes('..')) throw new FormulaError(`"${word}" is not a name: a dot must join two parts, as in custom.weight`, at);
      if ((KEYWORDS as readonly string[]).includes(word)) out.push({ t: 'kw', v: word as Keyword, at });
      else out.push({ t: 'name', v: word, at });
      i = j;
      continue;
    }
    const two = source.slice(i, i + 2);
    const hint = two.length === 2 ? own(HINTS, two) : undefined;
    if (hint) throw new FormulaError(hint, at);
    if ((OPERATORS as readonly string[]).includes(two)) { out.push({ t: 'op', v: two as Operator, at }); i += 2; continue; }
    const op = (OPERATORS as readonly string[]).includes(c) ? (c as Operator) : own(ALIASES, c);
    if (op) { out.push({ t: 'op', v: op, at }); i++; continue; }
    const single = own(HINTS, c);
    if (single) throw new FormulaError(single, at);
    if (c === '.') throw new FormulaError('Write a number with a digit before the point, as in 0.5', at);
    throw new FormulaError(`"${c}" can't be used in a formula`, at);
  }
  out.push({ t: 'end', at: source.length + 1 });
  return out;
}
