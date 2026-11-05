import { z } from 'zod';

/** Shared request-validation building blocks for every master. */
export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character id').transform((v) => v.toLowerCase());
export const idParams = z.strictObject({ id: objectId });

export const code = z.string().trim().min(1).max(32)
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9._\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/"'));
export const name = z.string().trim().min(1).max(120);
export const text = (max: number, min = 1) => z.string().trim().min(min).max(max);
export const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Must be a valid e-mail address'));
export const phone = z.string().trim().transform((v) => v.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use international format: + and the country code, then the number, with no spaces'));
export const percent = z.number().min(0).max(100);
export const positive = z.number().positive().max(1e9);
export const nonNegative = z.number().min(0).max(1e9);
export const integer = (min: number, max: number) => z.number().int().min(min).max(max);

const dateOnly = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
/** Accepts YYYY-MM-DD or a full ISO timestamp and returns a Date. */
export const isoDate = z.union([dateOnly, dateTime]).transform((v) => new Date(v));

/** Money in minor units (ngwee, cents) so totals never suffer floating-point drift. */
export const money = z.strictObject({
  amountMinor: z.number().int().min(0).max(1e13),
  currencyId: objectId,
});

export const location = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const address = z.strictObject({
  line1: text(200),
  line2: text(200).optional(),
  cityId: objectId.optional(),
  postalCode: text(20).optional(),
});

/** Ids in an array must be unique. */
export const idList = (max: number) => z.array(objectId).max(max).refine((v) => new Set(v).size === v.length, 'Ids must be unique');

export const regexText = z.string().trim().min(1).max(200).refine((value) => {
  try { new RegExp(value); return true; } catch { return false; }
}, 'Must be a valid regular expression');

const attachment = z.strictObject({
  name: text(200),
  url: z.string().trim().max(2000).refine((v) => /^https?:\/\//.test(v), 'Must be an http(s) URL'),
  mime: text(100).optional(),
  sizeBytes: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
});

export const customKey = /^[a-z][a-zA-Z0-9]{0,39}$/;

/** Fields every master accepts. Defaults live in Mongoose so PATCH never resets them. */
export const baseShape = {
  status: z.enum(['active', 'inactive']).optional(),
  validFrom: isoDate.optional(),
  validTo: isoDate.optional(),
  branchIds: z.array(objectId).max(50).optional(),
  tags: z.array(text(40)).max(20).optional(),
  notes: text(2000, 0).optional(),
  externalRefs: z.array(z.strictObject({ system: text(40), ref: text(120) })).max(10).optional(),
  attachments: z.array(attachment).max(20).optional(),
  custom: z.record(z.string().regex(customKey, 'Custom field keys are camelCase'), z.unknown()).optional(),
};

/**
 * PATCH schema from a create schema: every field optional, optional fields may be null
 * to clear them, and the caller must send the version they edited.
 */
const NEVER_NULL = new Set(['status', 'custom']);

export function toUpdateSchema<T extends z.ZodRawShape>(shape: T, neverNull: string[] = []) {
  const out: Record<string, z.ZodType> = {};
  const keep = new Set([...NEVER_NULL, ...neverNull]);
  for (const [key, schema] of Object.entries(shape)) {
    const field = schema as z.ZodType;
    const optional = field.safeParse(undefined).success;
    out[key] = optional && !keep.has(key) ? field.nullable().optional() : field.optional();
  }
  return z.strictObject({ ...out, version: z.number().int().min(0) })
    .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Send at least one field to change');
}

export const archiveBody = z.strictObject({ reason: text(500).optional() }).default({});
