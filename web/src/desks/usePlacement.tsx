import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Rec } from "../api/adapter";
import { api } from "../api/client";
import { Field } from "../ui/kit";

/**
 * Company fields on an operational record (#67). Each step draws the fields a company placed there, using one
 * set of inputs, and sends what was typed with the step. The API checks them with the field's definition.
 */

export interface CompanyField {
  entity: string; placement: string; askedOf: "office" | "driver"; printOn: string[]; key: string; label: string;
  type: string; required: boolean; options?: string[]; referenceMaster?: string; min?: number; max?: number; helpText?: string;
}

export const useCompanyFields = () =>
  useQuery({ queryKey: ["company-fields"], queryFn: () => api<CompanyField[]>("/operations/company-fields").catch(() => [] as CompanyField[]), staleTime: 60_000 });

const blank = (value: unknown) => value === undefined || value === "" || (Array.isArray(value) && !value.length);

export function FieldInput({ field, value, onChange }: { field: Pick<CompanyField, "key" | "label" | "type" | "required" | "options" | "referenceMaster" | "min" | "max" | "helpText">; value: unknown; onChange: (next: unknown) => void }) {
  const options = useQuery({
    queryKey: ["company-field-options", field.referenceMaster],
    enabled: field.type === "reference" && Boolean(field.referenceMaster),
    queryFn: () => api<Rec[]>(`/${field.referenceMaster}`, { query: { status: "active", limit: 100 } }),
  });
  const label = `${field.label}${field.required ? " *" : ""}`;
  const text = (value as string | undefined) ?? "";
  if (field.type === "boolean") {
    return (
      <Field label={label} hint={field.helpText}>
        <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}>
          <option value="">Choose…</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </Field>
    );
  }
  if (field.type === "select" || field.type === "reference") {
    const choices = field.type === "select"
      ? (field.options ?? []).map((o) => ({ value: o, label: o }))
      : (options.data ?? []).map((r) => ({ value: String(r.id), label: String(r.name ?? r.title ?? r.registrationNumber ?? r.code ?? r.id) }));
    return (
      <Field label={label} hint={field.helpText}>
        <select value={text} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">Choose…</option>
          {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </Field>
    );
  }
  if (field.type === "multi_select") {
    const picked = (value as string[] | undefined) ?? [];
    return (
      <Field label={label} hint={field.helpText}>
        <select multiple value={picked} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>
    );
  }
  if (field.type === "long_text") return <Field label={label} hint={field.helpText}><textarea rows={2} value={text} onChange={(e) => onChange(e.target.value || undefined)} /></Field>;
  if (field.type === "number") {
    return (
      <Field label={label} hint={field.helpText}>
        <input type="number" min={field.min} max={field.max} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
      </Field>
    );
  }
  const type = field.type === "date" ? "date" : field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text";
  return <Field label={label} hint={field.helpText}><input type={type} value={text} onChange={(e) => onChange(e.target.value || undefined)} /></Field>;
}

/**
 * The fields of a step, as a block to draw, what to send, and whether it may go. `alsoRequire` are earlier steps
 * whose required fields aren't filled yet. A required field the driver answers holds the step; the API says so.
 */
export function usePlacement(entity: string, step: string, existing?: Record<string, unknown>, alsoRequire: string[] = []) {
  const { data } = useCompanyFields();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const fields = (data ?? []).filter((f) => f.entity === entity && f.askedOf === "office"
    && (f.placement === step || (alsoRequire.includes(f.placement) && f.required && blank(existing?.[f.key]))));
  const merged = { ...existing, ...values };
  const missing = fields.filter((f) => f.required && blank(merged[f.key]));
  const custom = Object.fromEntries(Object.entries(values).filter(([, v]) => !blank(v)));
  return {
    ready: !missing.length,
    custom: Object.keys(custom).length ? custom : undefined,
    block: fields.length > 0 && (
      <div className="grid-3 placement-fields">
        {fields.map((f) => <FieldInput key={f.key} field={f} value={merged[f.key]} onChange={(v) => setValues((old) => ({ ...old, [f.key]: v }))} />)}
      </div>
    ),
  };
}
