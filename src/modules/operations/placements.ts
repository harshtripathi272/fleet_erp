import type { Plain } from '../../core/masters/types.js';
import { validateDynamicValues, type DynamicField } from '../../core/masters/dynamicFields.js';
import { resolveOptions } from '../configuration/configuration.service.js';
import { FieldDefinition } from '../configuration/models/configuration.model.js';
import { refuse } from './support.js';
import { fileOptions } from '../../core/masters/fileFields.js';
import * as Fmt from '../../core/format/regional.js';
import { storeOf } from '../../core/storage/index.js';
import { StoredFile } from '../files/file.model.js';
import type { PdfBlock } from './pdf.js';

/**
 * Company fields on operational records (#67). A master is edited in one form; a trip is filled in step by
 * step, so each field names the step where it's asked (its placement) and who answers it. Each step's API
 * checks its own fields here, and it can't complete until the required ones are filled.
 */

async function fieldsAt(entity: string, steps: string[]) {
  const defs = await FieldDefinition.find({ entity, placement: { $in: steps }, status: 'active' }).sort({ order: 1, key: 1 }).lean() as Plain[];
  return { defs, fields: await resolveOptions(defs) };
}

/**
 * The record's `custom` values after a step: what the step sent, checked, on top of what is already there.
 * `input` may only hold fields of `steps[0]`; `alsoRequire` are earlier steps whose required fields must be filled by now.
 */
export async function stepCustom(entity: string, step: string, input: Plain | undefined, base: Plain = {}, alsoRequire: string[] = []) {
  const steps = [step, ...alsoRequire];
  const { defs, fields } = await fieldsAt(entity, steps);
  if (!defs.length && !input) return Object.keys(base).length ? base : undefined;
  const given = Object.fromEntries(Object.entries(input ?? {}).filter(([key]) => fields.some((f) => f.key === key)));
  const unknown = Object.keys(input ?? {}).filter((key) => !(key in given));
  if (unknown.length) throw refuse(`${unknown.join(', ')} ${unknown.length === 1 ? "isn't a field" : "aren't fields"} of this step.`);
  const values = await validateDynamicValues(fields.map((f) => ({ ...f, required: false })), given, base, 'company');
  const missing = defs.filter((d) => d.required && [undefined, null, ''].includes(values[String(d.key)] as never));
  const office = missing.filter((d) => d.askedOf !== 'driver').map((d) => String(d.label));
  const driver = missing.filter((d) => d.askedOf === 'driver').map((d) => String(d.label));
  if (office.length) throw refuse(`Fill in ${office.join(', ')}.`);
  if (driver.length) throw refuse(`Waiting for the driver to answer ${driver.join(', ')}.`);
  return Object.keys(values).length ? values : undefined;
}

/** Every company field of the operational records, for the desks to draw. */
export async function companyFields() {
  const defs = await FieldDefinition.find({ placement: { $exists: true }, status: 'active' }).sort({ order: 1, key: 1 }).lean() as Plain[];
  const resolved = await resolveOptions(defs) as Array<DynamicField & Plain>;
  return resolved.map((f) => ({ id: String(f._id), entity: f.entity, placement: f.placement, askedOf: f.askedOf ?? 'office', printOn: f.printOn ?? [], key: f.key, label: f.label, type: f.type, required: Boolean(f.required), options: f.options, referenceMaster: f.referenceMaster, min: f.min, max: f.max, helpText: f.helpText, ...fileOptions(f) }));
}

/** What the driver still has to answer on their trip and load. */
export async function driverQuestions(trip: Plain, consignments: Plain[]) {
  const defs = await FieldDefinition.find({ askedOf: 'driver', status: 'active', entity: { $in: ['trips', 'consignments'] } }).sort({ order: 1, key: 1 }).lean() as Plain[];
  const resolved = await resolveOptions(defs) as Array<DynamicField & Plain>;
  const open = consignments.find((c) => !c.delivered);
  // A field about the load can be answered only once something is on the truck.
  return resolved.filter((f) => {
    const on = f.entity === 'trips' ? trip : open;
    return on && ((on.custom ?? {}) as Plain)[f.key] === undefined;
  }).map((f) => ({ entity: f.entity, key: f.key, label: f.label, type: f.type, required: Boolean(f.required), options: f.options, min: f.min, max: f.max, helpText: f.helpText, ...fileOptions(f) }));
}

/** The driver answers on their own trip or load; only what is asked of the driver. */
export async function driverAnswers(trip: { get: (k: string) => unknown; set: (k: string, v: unknown) => void; _id: unknown }, consignment: { get: (k: string) => unknown; set: (k: string, v: unknown) => void } | null, values: Plain) {
  const defs = await FieldDefinition.find({ askedOf: 'driver', status: 'active', entity: { $in: ['trips', 'consignments'] } }).lean() as Plain[];
  const fields = await resolveOptions(defs);
  const keyed = new Map(defs.map((d) => [String(d.key), { def: d, field: fields.find((f) => f.key === d.key)! }]));
  const unknown = Object.keys(values).filter((k) => !keyed.has(k));
  if (unknown.length) throw refuse(`${unknown.join(', ')} isn't asked of you.`);
  for (const entity of ['trips', 'consignments'] as const) {
    const doc = entity === 'trips' ? trip : consignment;
    const given = Object.fromEntries(Object.entries(values).filter(([k]) => keyed.get(k)!.def.entity === entity));
    if (!Object.keys(given).length) continue;
    if (!doc) throw refuse('Nothing is on the truck to answer this about.');
    const own = [...keyed.values()].filter((k) => k.def.entity === entity).map((k) => ({ ...k.field, required: false }));
    doc.set('custom', await validateDynamicValues(own, given, (doc.get('custom') ?? {}) as Plain, 'company'));
  }
}

/** Placeholders a message can use: {{trip.custom.bookingRef}}. */
export const customValues = (prefix: string, custom: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((custom ?? {}) as Plain).map(([k, v]) => [`${prefix}.custom.${k}`, asText(v)]));

/** A company value as words: a file by its name (#97), a list joined, yes or no. */
const asText = (v: unknown): string => {
  const named = (x: unknown) => (x && typeof x === 'object' && 'fileId' in x ? String((x as Plain).name) : String(x));
  return Array.isArray(v) ? v.map(named).join(', ') : v === true ? 'Yes' : v === false ? 'No' : named(v);
};

/**
 * The rows a document prints for the company fields marked to go on it. A file prints as its name, and a document
 * with its expiry date; a picture prints as the picture itself (printedPictures), not as a row.
 */
export async function printedFields(document: string, records: Array<[string, Plain]>) {
  const defs = await FieldDefinition.find({ printOn: document, status: 'active' }).sort({ order: 1, key: 1 }).lean() as Plain[];
  const rows: [string, string][] = [];
  for (const d of defs) {
    for (const [entity, record] of records) {
      const value = entity === d.entity ? ((record.custom ?? {}) as Plain)[String(d.key)] : undefined;
      if (value === undefined || (d.type === 'image' && pictureOf(value))) continue;
      const expires = d.type === 'document' && (value as Plain).expiresOn ? `, expires ${Fmt.calendarDate(String((value as Plain).expiresOn))}` : '';
      rows.push([String(d.label), `${asText(value)}${expires}`]);
    }
  }
  return rows;
}

/** A picture field's photo, when it is one a document can carry (a JPEG). */
const pictureOf = (value: unknown) => (value && typeof value === 'object' && (value as Plain).mime === 'image/jpeg' ? String((value as Plain).fileId) : undefined);

/** The pictures a document prints for the company picture fields marked to go on it (#97), each under its name. */
export async function printedPictures(document: string, records: Array<[string, Plain]>): Promise<PdfBlock[]> {
  const defs = await FieldDefinition.find({ printOn: document, type: 'image', status: 'active' }).sort({ order: 1, key: 1 }).lean() as Plain[];
  const blocks: PdfBlock[] = [];
  for (const d of defs) {
    for (const [entity, record] of records) {
      const fileId = entity === d.entity ? pictureOf(((record.custom ?? {}) as Plain)[String(d.key)]) : undefined;
      const file = fileId ? await StoredFile.findById(fileId).lean() : null;
      if (!file) continue;
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of await (await storeOf(file)).open(file.key)) chunks.push(Buffer.from(chunk as Buffer));
        blocks.push({ kind: 'picture', label: String(d.label), jpeg: Buffer.concat(chunks) });
      } catch {
        // A picture storage can't give back prints as its name, so the document still goes out.
        blocks.push({ kind: 'facts', rows: [[String(d.label), file.name]] });
      }
    }
  }
  return blocks;
}
