import { z } from 'zod';
import { ValidationError } from '../errors/index.js';
import { getRefTarget } from './registry.js';
import type { Plain } from './types.js';

export const FIELD_TYPES = ['text', 'long_text', 'number', 'boolean', 'date', 'select', 'multi_select', 'email', 'phone', 'reference'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Values of fields that were later archived are kept untouched; only new input is checked. */
export interface DynamicField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  referenceMaster?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  helpText?: string;
  order?: number;
}

function validatorFor(field: DynamicField): z.ZodType {
  switch (field.type) {
    case 'text': {
      let s = z.string().trim().min(1).max(field.maxLength ?? 500);
      if (field.pattern) s = s.regex(new RegExp(field.pattern), `Must match ${field.pattern}`);
      return s;
    }
    case 'long_text': return z.string().trim().min(1).max(field.maxLength ?? 5000);
    case 'number': {
      let n = z.number().finite();
      if (field.min !== undefined) n = n.min(field.min);
      if (field.max !== undefined) n = n.max(field.max);
      return n;
    }
    case 'boolean': return z.boolean();
    case 'date': return z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
    case 'select': return z.enum((field.options ?? []) as [string, ...string[]]);
    case 'multi_select': return z.array(z.enum((field.options ?? []) as [string, ...string[]])).max(50)
      .refine((v) => new Set(v).size === v.length, 'Values must be unique');
    case 'email': return z.string().trim().toLowerCase().pipe(z.email());
    case 'phone': return z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Use international format');
    case 'reference': return z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a record id').transform((v) => v.toLowerCase());
  }
}

/**
 * Validates values against field definitions. Unknown keys are rejected;
 * `null` removes a value when `base` (existing values) is given.
 */
export async function validateDynamicValues(fields: DynamicField[], input: Plain, base: Plain = {}, label = 'custom'): Promise<Plain> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const errors: Record<string, string[]> = {};
  const result: Plain = { ...base };
  for (const [key, value] of Object.entries(input)) {
    const field = byKey.get(key);
    if (!field) { errors[key] = ['Unknown field']; continue; }
    if (value === null) { delete result[key]; continue; }
    const parsed = validatorFor(field).safeParse(value);
    if (!parsed.success) { errors[key] = parsed.error.issues.map((i) => i.message); continue; }
    result[key] = parsed.data;
  }
  for (const field of fields) {
    const value = result[field.key];
    if (field.required && (value === undefined || value === '' || (Array.isArray(value) && !value.length))) {
      (errors[field.key] ??= []).push('Required');
    }
  }
  for (const field of fields.filter((f) => f.type === 'reference' && result[f.key] !== undefined && !errors[f.key])) {
    const target = getRefTarget(field.referenceMaster ?? '');
    if (!target) { errors[field.key] = ['Reference target no longer exists']; continue; }
    const exists = await target.model.exists({ _id: result[field.key], ...(target.statusField ? { status: 'active' } : {}) });
    if (!exists) errors[field.key] = [`No active ${target.label.toLowerCase()} with this id`];
  }
  if (Object.keys(errors).length) throw new ValidationError(`Invalid ${label} fields`, { [label]: errors });
  return result;
}
