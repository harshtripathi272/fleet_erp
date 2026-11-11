/**
 * Field names as people read them, in sentence case: one function, so the form, the list, the import
 * template and the audit log all say "Registration number" and "Tank capacity (L)".
 */

/** "currency" → "currencies", "branch" → "branches", "class" → "classes", "make" → "makes". */
export const plural = (w: string) => (/[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/.test(w) ? `${w}es` : `${w}s`);

/** "Nominations" → "Nomination", "Batteries" → "Battery", "Expenses" → "Expense": for names kept only in the plural. */
export const singular = (w: string) => (/ies$/.test(w) ? `${w.slice(0, -3)}y` : /(ss|x|ch|sh)es$/.test(w) ? w.slice(0, -2) : /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);

/** Units written at the end of a field name, shown in brackets. Longest first. */
const UNITS: [RegExp, string][] = [
  [/KgPerL$/, 'kg/L'],
  [/Kg$/, 'kg'],
  [/Km$/, 'km'],
  [/Pct$/, '%'],
  [/L$/, 'L'],
  [/M$/, 'm'],
  [/C$/, '°C'],
];
/** Words that are written in capitals. */
/** Short words written out. */
const WORDS: Record<string, string> = { min: 'minimum', max: 'maximum', email: 'e-mail' };
/** Whole keys with a name of their own: an address's lines (#102). */
const NAMED: Record<string, string> = { line1: 'Street address', line2: 'Address line 2' };
const ACRONYMS = new Set(['vin', 'gps', 'url', 'id', 'sms', 'pdf', 'eta', 'tin', 'vat', 'pod', 'po', 'api', 'smtp', 'ip']);

/**
 * One path segment as words: "registrationNumber" → "Registration number", "makeId" (a link) → "Make",
 * "currencyIds" (links) → "Currencies", "nationalId" → "National ID", "tankCapacityL" → "Tank capacity (L)".
 * `link` says the field points at another record, so its trailing "Id" is dropped.
 */
export function fieldLabel(key: string, link = /Ids?$/.test(key) && key !== 'id'): string {
  if (NAMED[key]) return NAMED[key];
  const list = link && key.endsWith('Ids');
  // Money is stored in minor units ("amountMinor") but typed in the currency, so the suffix is not part of its name.
  let base = (link ? key.replace(/Ids?$/, '') : key).replace(/(.)Minor$/, '$1');
  let unit = '';
  for (const [pattern, text] of UNITS) {
    // Only a capitalised suffix after a lower-case letter is a unit ("fuelL", not "total" or "L").
    if (pattern.test(base) && /[a-z]/.test(base.slice(0, base.search(pattern)).slice(-1))) {
      unit = text;
      base = base.replace(pattern, '');
      break;
    }
  }
  // "kmPerLLoaded" → "km per L loaded": split before every capital, keeping a lone "L" (litres) a capital.
  let words = base.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').trim().split(/\s+/)
    .map((w) => (w === 'L' ? w : w.toLowerCase()))
    .map((w) => WORDS[w] ?? w);
  if (list) words = [...words.slice(0, -1), plural(words.at(-1)!)];
  const text = words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(' ');
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return unit ? `${sentence} (${unit})` : sentence;
}

/** A dotted path reads as its last part: "fuel.tankCapacityL" → "Tank capacity (L)". */
export const pathLabel = (path: string, link?: boolean) => fieldLabel(path.split('.').pop() ?? path, link);

/** The whole dotted path as one label, for a flat sheet: "address.cityId" → "Address city". */
export function fullLabel(path: string, link?: boolean): string {
  const parts = path.split('.');
  return parts
    .map((p, i) => fieldLabel(p, i === parts.length - 1 ? link : false))
    .map((w, i) => (i && !/^[A-Z]{2}/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w))
    .join(' ');
}
