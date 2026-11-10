// #130: the formula language for tariff lines (consignments design 3.5.6). A closed grammar walked as a tree: it
// computes, compares and decides, and the only thing it can ever throw is a FormulaError saying what and where.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { check, compile, evaluate, FormulaError, FUNCTIONS, MAX_DEPTH, MAX_NODES, MAX_SOURCE, roundTo, type Variables } from '../src/core/formula/index.js';
import { ValidationError } from '../src/core/errors/index.js';

const facts: Variables = {
  qty: 37390, km: 1840, kg: 999, tonnes: 28.4, pieces: 400, drops: 4, freight: 3178.15, fuelPrice: 1.42,
  zero: 0, packaging: 'CONT20', product: 'AGO', hazard: true, fragile: false, 'custom.weight': 12.5, 'line.qty': 9500,
  missing: null, nothing: undefined,
};
const value = (src: string, vars: Variables = facts) => evaluate(src, vars).value;
/** Asserts a FormulaError whose message matches, and returns it. */
function fails(src: string, message: RegExp, vars: Variables = facts): FormulaError {
  try {
    evaluate(src, vars);
  } catch (err) {
    assert.ok(err instanceof FormulaError, `${src}: threw ${String(err)}`);
    assert.match(err.message, message, src);
    return err;
  }
  assert.fail(`${src} should have failed with ${message}`);
}

describe('formula: numbers and precedence', () => {
  test('arithmetic binds as in school, and left to right', () => {
    assert.equal(value('1 + 2 * 3'), 7);
    assert.equal(value('(1 + 2) * 3'), 9);
    assert.equal(value('10 - 4 - 3'), 3);
    assert.equal(value('100 / 10 / 5'), 2);
    assert.equal(value('2 * 3 % 4'), 2);
    assert.equal(value('-2 * 3'), -6);
    assert.equal(value('- -2'), 2);
    assert.equal(value('+5'), 5);
    assert.equal(value('-7 % 3'), -1);
    assert.equal(value('0.5 * 4'), 2);
  });
  test('comparison binds looser than arithmetic, not looser than and/or', () => {
    assert.equal(value('1 + 1 = 2'), true);
    assert.equal(value('km > 1000 and drops >= 4'), true);
    assert.equal(value('km < 10 or drops = 4 and hazard'), true);
    assert.equal(value('(km < 10 or drops = 4) and fragile'), false);
    assert.equal(value('not fragile and hazard'), true);
    assert.equal(value('not km > 2000'), true);
    assert.equal(value('km != 1840'), false);
    assert.equal(value('km == 1840'), true);
    assert.equal(value('1 <= 1 and 1 >= 1 and 2 > 1 and 1 < 2'), true);
  });
  test('names, dotted names and literals', () => {
    assert.equal(value('qty * 0.085'), 37390 * 0.085);
    assert.equal(value('custom.weight * 2'), 25);
    assert.equal(value('line.qty / 1000'), 9.5);
    assert.equal(value('true and not false'), true);
    assert.equal(value('packaging = "CONT20"'), true);
    assert.equal(value("product = 'AGO'"), true);
  });
  test('texts are compared without regard to capitals; numbers to a hair', () => {
    assert.equal(value('packaging = "cont20"'), true);
    assert.equal(value('packaging != "CONT40"'), true);
    assert.equal(value('0.1 + 0.2 = 0.3'), true);
    assert.equal(value('0.1 + 0.2 != 0.3'), false);
  });
  test('signs typed from a phone or a spreadsheet', () => {
    assert.equal(value('km × 2'), 3680);
    assert.equal(value('km ÷ 2'), 920);
    assert.equal(value('5 − 2'), 3);
    assert.equal(value('2 ≤ 3 and 3 ≥ 2 and 2 ≠ 3'), true);
  });
  test('whitespace and line breaks do not matter', () => {
    assert.equal(value('  qty\n *\t2  '), 74780);
  });
});

describe('formula: every function', () => {
  test('min and max take any number of values', () => {
    assert.equal(value('min(3, 1, 2)'), 1);
    assert.equal(value('max(3, 1, 2)'), 3);
    assert.equal(value('min(km)'), 1840);
    assert.equal(value('max(qty * 0.085, 2500)'), 37390 * 0.085);
  });
  test('round is half away from zero, to whole numbers or decimals', () => {
    assert.equal(value('round(2.5)'), 3);
    assert.equal(value('round(-2.5)'), -3);
    assert.equal(value('round(1.005, 2)'), 1.01);
    assert.equal(value('round(1234.5678, 1)'), 1234.6);
    assert.equal(value('round(1250, -2)'), 1300);
    assert.equal(value('round(-0.4)'), 0);
    assert.ok(!Object.is(value('round(-0.4)'), -0));
    assert.equal(roundTo(2.675, 2), 2.68);
  });
  test('floor, ceil and abs', () => {
    assert.equal(value('floor(2.9)'), 2);
    assert.equal(value('floor(-2.1)'), -3);
    assert.equal(value('ceil(2.1)'), 3);
    assert.equal(value('ceil(61 / 24)'), 3);
    assert.equal(value('abs(-4.5)'), 4.5);
  });
  test('if picks a branch and works out only that one', () => {
    assert.equal(value('if(km > 1000, 1, 2)'), 1);
    assert.equal(value('if(km < 1000, 1, 2)'), 2);
    // The branch not taken would divide by zero, or read a name with no value: neither is reached.
    assert.equal(value('if(zero > 0, qty / zero, 0)'), 0);
    assert.equal(value('if(true, 5, missing)'), 5);
    assert.deepEqual(evaluate('if(hazard, km, kg)', facts).used, { hazard: true, km: 1840 });
    assert.equal(value('if(hazard, packaging = "CONT20", false)'), true);
  });
  test('and and or stop as soon as the answer is known', () => {
    assert.equal(value('fragile and qty / zero > 1'), false);
    assert.equal(value('hazard or missing > 1'), true);
    assert.deepEqual(evaluate('fragile and km > 1', facts).used, { fragile: false });
  });
  test('between includes both ends', () => {
    assert.equal(value('between(km, 1840, 2000)'), true);
    assert.equal(value('between(km, 1000, 1840)'), true);
    assert.equal(value('between(km, 1841, 2000)'), false);
  });
  test('slab is a progressive rate (design 3.5.10, example B)', () => {
    // 999 chargeable kg on 12 / 10 / 8 at 500 and 2,000 kg: 500 × 12 + 499 × 10.
    assert.equal(value('slab(kg, 500, 12, 2000, 10, 8)'), 10990);
    assert.equal(value('slab(2500, 500, 12, 2000, 10, 8)'), 500 * 12 + 1500 * 10 + 500 * 8);
    assert.equal(value('slab(500, 500, 12, 2000, 10, 8)'), 6000);
    assert.equal(value('slab(0, 500, 12, 8)'), 0);
    assert.equal(value('slab(100, 500, 12, 8)'), 1200);
    assert.equal(value('max(slab(kg, 500, 12, 2000, 10, 8), 6000)'), 10990);
  });
  test('the help lists exactly the functions there are', () => {
    assert.deepEqual(Object.keys(FUNCTIONS).sort(), ['abs', 'between', 'ceil', 'floor', 'if', 'max', 'min', 'round', 'slab']);
    for (const spec of Object.values(FUNCTIONS)) assert.ok(spec.usage && spec.help);
  });
});

describe('formula: what it read', () => {
  test('a compiled formula lists its names, and evaluates many times', () => {
    const f = compile('if(km > 500, qty * fuelPrice, custom.weight)');
    assert.deepEqual(f.names, ['km', 'qty', 'fuelPrice', 'custom.weight']);
    assert.equal(evaluate(f, facts).value, 37390 * 1.42);
    assert.equal(evaluate(f, { ...facts, km: 10 }).value, 12.5);
    assert.ok(Object.isFrozen(f));
  });
  test('used holds the values read, for the revenue explanation', () => {
    assert.deepEqual(evaluate('qty * fuelPrice', facts).used, { qty: 37390, fuelPrice: 1.42 });
  });
  test('expect insists on an amount or a condition', () => {
    assert.equal(evaluate('km * 2', facts, 'number').value, 3680);
    assert.equal(evaluate('km > 2', facts, 'boolean').value, true);
    assert.throws(() => evaluate('km > 2', facts, 'number'), /an amount is needed/);
    assert.throws(() => evaluate('km * 2', facts, 'boolean'), /a condition is needed/);
  });
});

describe('formula: every error says what and where', () => {
  test('dividing by zero', () => {
    const err = fails('qty / zero', /^Divides by zero at column 5\.$/);
    assert.equal(err.column, 5);
    fails('qty % zero', /Divides by zero/);
  });
  test('names', () => {
    fails('kmm * 2', /There is no value called "kmm" at column 1: did you mean "km"\?/);
    fails('Km * 2', /did you mean "km"/); // names are case-sensitive
    fails('wholly_unknown', /^There is no value called "wholly_unknown" at column 1\.$/);
    fails('missing + 1', /"missing" has no value here at column 1/);
    fails('nothing + 1', /"nothing" has no value here/);
    fails('x', /"x" has no value here/, { x: Number.NaN });
    fails('x', /not a number, a text or a yes\/no/, { x: {} as unknown as number });
  });
  test('types', () => {
    fails('packaging + 1', /"packaging" is text, but a number is needed here at column 1/);
    fails('hazard * 2', /"hazard" is a yes\/no, but a number is needed/);
    fails('if(km, 1, 2)', /if\(…\) needs a yes\/no at column 4: "km" is a number/);
    fails('km and true', /"and" needs a yes\/no/);
    fails('not km', /"not" needs a yes\/no/);
    fails('packaging = 1', /Can't compare text with a number/);
    fails('packaging > "A"', /> compares numbers, not text/);
    fails('"abc"', /gives a text/);
  });
  test('syntax', () => {
    fails('', /^The formula is empty\.$/);
    fails('   ', /The formula is empty/);
    fails('1 +', /stops too early at column 4/);
    fails('(1 + 2', /Expected a closing "\)" but found the end of the formula at column 7/);
    fails('1 + 2)', /Unexpected "\)" at column 6/);
    fails('2km', /Unexpected "km" at column 2: is an operator such as \* missing\?/);
    fails('km (2)', /There is no function called km/);
    fails('2 (3)', /is an operator such as \* missing/);
    fails('a < b < c', /Compare one pair at a time at column 7: write between/, { a: 1, b: 2, c: 3 });
    fails('foo(1)', /There is no function called foo at column 1: the functions are min, max/);
    fails('min()', /min takes at least 1 value, not 0/);
    fails('abs(1, 2)', /abs takes 1 value, not 2/);
    fails('round(1, 2, 3)', /round takes 1 to 2 values, not 3/);
    fails('if(true, 1)', /if takes 3 values, not 2/);
    fails('slab(1, 2, 3)', /slab takes at least 4 values, not 3/);
    fails('slab(1, 2, 3, 4, 5)', /pairs of limit and price/);
    fails('min(1 2)', /Expected a comma or "\)" to close min\(/);
    fails('1 * * 2', /Expected a number, a name or a bracket but found "\*" at column 5/);
    fails('and', /found "and"/);
    fails('"open', /The text that starts here has no closing " at column 1/);
    fails('"line\nbreak"', /no closing/);
    fails('.5', /digit before the point/);
    fails('custom.', /a dot must join two parts/);
    fails('custom..x', /a dot must join two parts/);
    fails('km # 2', /"#" can't be used in a formula at column 4/);
    fails('qty && km', /Write "and" instead of && at column 5/);
    fails('qty || km', /Write "or" instead of \|\|/);
    fails('!hazard', /Write "not" instead of !/);
    fails('2 ^ 3', /Powers are not supported/);
    fails('km <> 1', /Write != for "is not"/);
    fails('_x', /"_" can't be used/);
  });
  test('function arguments', () => {
    fails('round(1, 9)', /takes a whole number of digits from -6 to 6/);
    fails('round(1, 0.5)', /takes a whole number of digits/);
    fails('between(1, 5, 2)', /low to be no more than high, not 5 and 2/);
    fails('slab(100, 500, 12, 400, 10, 8)', /slab limits must go up, but 400 comes after 500/);
    fails('slab(100, 0, 12, 8)', /slab limits must go up, but 0 comes after 0/);
  });
  test('results too large to be money', () => {
    fails('99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999 * 99999999999999999999', /too large/);
    fails('9'.repeat(400), /This number is too large at column 1/);
    fails('x * x', /too large/, { x: 1e300 });
  });
  test('the limits', () => {
    fails('1+'.repeat(MAX_SOURCE) + '1', new RegExp(`at most ${MAX_SOURCE} characters; this one has ${MAX_SOURCE * 2 + 1}`));
    const many = Array.from({ length: 101 }, () => '1').join('+'); // 101 numbers and 100 signs: 201 parts
    assert.ok(many.length <= MAX_SOURCE);
    fails(many, new RegExp(`at most ${MAX_NODES} parts`));
    assert.equal(value(Array.from({ length: 100 }, () => '1').join('+')), 100); // 199 parts: fine
    fails('('.repeat(MAX_DEPTH + 1) + '1' + ')'.repeat(MAX_DEPTH + 1), new RegExp(`nested at most ${MAX_DEPTH} deep`));
    assert.equal(value('('.repeat(MAX_DEPTH) + '1' + ')'.repeat(MAX_DEPTH)), 1);
    fails('-'.repeat(MAX_DEPTH + 1) + '1', /nested at most/);
    fails(`${'a'.repeat(65)} + 1`, /A name can be at most 64 characters/);
  });
  test('a FormulaError is a validation error, so saving a bad tariff is a 422', () => {
    const err = fails('1 / zero', /Divides by zero/);
    assert.ok(err instanceof ValidationError);
    assert.equal(err.statusCode, 422);
    assert.deepEqual(err.details, { reason: 'Divides by zero', column: 3 });
  });
  test('a formula that is not text', () => {
    assert.throws(() => compile(42 as unknown as string), FormulaError);
  });
});

describe('formula: check before saving', () => {
  const names = ['qty', 'km', 'kg', 'packaging', 'hazard', 'custom.'];
  test('a good formula has no problems', () => {
    assert.deepEqual(check('qty * 0.085 + custom.toll', { names }), []);
    assert.deepEqual(check('packaging = "CONT20"', { names, expect: 'boolean', sample: { packaging: 'X' } }), []);
  });
  test('it must parse', () => {
    assert.deepEqual(check('qty *', { names }), ['The formula stops too early at column 6: something is missing at the end']);
  });
  test('it may read only the names offered there; a prefix admits names under it', () => {
    assert.deepEqual(check('kms * 2 + rate', { names }), ['There is no value called "kms": did you mean "km"?', 'There is no value called "rate".']);
    assert.deepEqual(check('custom * 2', { names }), ['There is no value called "custom".']);
  });
  test('a dry run on sample facts catches the wrong kind of answer', () => {
    assert.deepEqual(check('km > 100', { names, expect: 'number', sample: { km: 200 } }), ['The formula gives a yes/no, but an amount is needed here.']);
    assert.deepEqual(check('packaging * 2', { names, sample: { packaging: 'CONT20' } }), ['"packaging" is text, but a number is needed here at column 1.']);
  });
});

describe('formula: nothing reaches outside it', () => {
  const pristine = () => Object.getOwnPropertyNames(Object.prototype).sort().join();
  const before = pristine();

  test('object property names are only names with no value', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'prototype', 'constructor.constructor', 'toString.call']) {
      fails(name, /There is no value called/, {});
      fails(`${name} + 1`, /There is no value called/, {});
      fails(`${name}(1)`, /There is no function called|There is no value called|is not a name/, {});
    }
    fails('__proto__', /"_" can't be used/, {});
  });
  test('a variable called __proto__ is just a variable', () => {
    const vars = JSON.parse('{"__proto__": 7, "km": 2}') as Variables;
    assert.equal(Object.hasOwn(vars, '__proto__'), true);
    // It can't be named in a formula (a name starts with a letter), and it doesn't leak into other names.
    fails('proto', /no value called "proto"/, vars);
    assert.equal(value('km', vars), 2);
  });
  test('a function name is not a value, and a value is not a function', () => {
    fails('min', /There is no value called "min"/, {});
    fails('km(1)', /There is no function called km/, { km: 1 });
  });

  /** A small seeded generator, so a failing fuzz case can be replayed. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const fuzzVars: Variables = { km: 1840, qty: 0, x: -3.5, big: 1e308, tiny: 5e-324, code: 'CONT20', yes: true, no: false, empty: null, 'custom.a': 2 };
  const attempt = (src: string) => {
    try {
      const { value: v } = evaluate(src, fuzzVars);
      assert.ok((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean', `${JSON.stringify(src)} gave ${String(v)}`);
      return 'ok';
    } catch (err) {
      if (!(err instanceof FormulaError)) assert.fail(`${JSON.stringify(src)} threw ${String(err)}`);
      assert.ok(err.message.length > 0 && err.message.length < 400);
      return 'error';
    }
  };

  test('fuzz: random characters never throw anything but a FormulaError', () => {
    const next = rng(130);
    const alphabet = 'abcdefghijklmnopqrstuvwxyzKM0123456789 .,()+-*/%=<>!"\'&|^_#$@[]{}\\;:?~`×÷\n\t\u0000 ';
    for (let i = 0; i < 20000; i++) {
      const len = Math.floor(next() * 40);
      let src = '';
      for (let j = 0; j < len; j++) src += alphabet[Math.floor(next() * alphabet.length)];
      attempt(src);
    }
  });
  test('fuzz: random well-formed-looking token soups never throw anything but a FormulaError', () => {
    const next = rng(2026);
    const words = ['km', 'qty', 'x', 'big', 'tiny', 'code', 'yes', 'no', 'empty', 'custom.a', 'constructor', '__proto__', 'toString',
      '0', '1', '2.5', '1e3', '999999999999', '"CONT20"', "'x'", '(', ')', ',', '+', '-', '*', '/', '%', '=', '!=', '<', '<=', '>', '>=',
      'and', 'or', 'not', 'true', 'false', 'min(', 'max(', 'round(', 'floor(', 'ceil(', 'abs(', 'if(', 'between(', 'slab(', 'eval(', 'Function('];
    let ok = 0;
    for (let i = 0; i < 20000; i++) {
      const len = 1 + Math.floor(next() * 25);
      const parts = Array.from({ length: len }, () => words[Math.floor(next() * words.length)]!);
      // Close what was opened half the time, so many soups parse and reach the evaluator.
      if (next() < 0.5) { const open = parts.join('').split('(').length - parts.join('').split(')').length; parts.push(')'.repeat(Math.max(0, open))); }
      if (attempt(parts.join(' ')) === 'ok') ok++;
    }
    assert.ok(ok > 100, `only ${ok} soups evaluated; the fuzz should reach the evaluator`);
  });
  test('fuzz: random formulas from the grammar evaluate, or fail only with a FormulaError', () => {
    const next = rng(503);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
    const numeric = ['km', 'qty', 'x', 'big', 'tiny', 'custom.a', '0', '1', '2.5', '1000', '999999999999'];
    const gen = (depth: number): string => {
      if (depth <= 0 || next() < 0.25) return pick([...numeric, '"CONT20"', 'code', 'yes', 'no', 'true', 'empty']);
      switch (Math.floor(next() * 7)) {
        case 0: return `${gen(depth - 1)} ${pick(['+', '-', '*', '/', '%'])} ${gen(depth - 1)}`;
        case 1: return `${gen(depth - 1)} ${pick(['=', '!=', '<', '<=', '>', '>='])} ${gen(depth - 1)}`;
        case 2: return `${gen(depth - 1)} ${pick(['and', 'or'])} ${gen(depth - 1)}`;
        case 3: return `${pick(['-', 'not '])}${gen(depth - 1)}`;
        case 4: return `(${gen(depth - 1)})`;
        case 5: return `if(${gen(depth - 1)}, ${gen(depth - 1)}, ${gen(depth - 1)})`;
        default: {
          const fn = pick(['min', 'max', 'round', 'floor', 'ceil', 'abs', 'between', 'slab'] as const);
          const n = fn === 'between' ? 3 : fn === 'slab' ? 2 * (1 + Math.floor(next() * 3)) + 2 : fn === 'round' ? 1 + Math.floor(next() * 2) : fn === 'min' || fn === 'max' ? 1 + Math.floor(next() * 4) : 1;
          return `${fn}(${Array.from({ length: n }, () => gen(depth - 1)).join(', ')})`;
        }
      }
    };
    let ok = 0;
    for (let i = 0; i < 20000; i++) if (attempt(gen(4)) === 'ok') ok++;
    assert.ok(ok > 3000, `only ${ok} formulas evaluated`);
  });
  test('fuzz: deep and long inputs stay within the limits', () => {
    for (const src of ['('.repeat(500), ')'.repeat(500), '-'.repeat(499) + '1', 'not '.repeat(120) + 'yes', 'min('.repeat(100) + '1' + ')'.repeat(100), '1'.repeat(500), '"'.repeat(500), 'a.'.repeat(250)]) attempt(src);
  });
  test('Object.prototype is untouched by everything above', () => {
    assert.equal(pristine(), before);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});
