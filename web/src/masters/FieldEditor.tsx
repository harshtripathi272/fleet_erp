import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { useApp } from "../store";
import { can } from "../api/session";
import { Button, ChoiceChips, Field, FieldGroup, SwitchField, UnitInput } from "../ui/kit";
import { COMMON_FIELD_TYPES, FILE_KINDS, FIELD_TYPES, fieldType, guessFieldType, isFileType, kindsOf, type FileKind } from "./fieldTypes";
import { FileField } from "./FileField";

/**
 * The field editor (#97): one for a company field on any master and for a custom master's fields. Most fields need
 * a name and nothing else, so that's what it asks: the kind follows from the name where it can, the common kinds show
 * first, and only what a kind can't work without appears. Everything else waits under "More options".
 */

/** A field's definition as the API takes it (`field-definitions`, or one of a custom master's `fields`). */
export type FieldSpec = Rec & { key?: string; label?: string; type?: string };

/** "Medical certificate" → "medicalCertificate". */
export const keyFromLabel = (text: string) => text.trim().replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[^a-z]+/i, "").replace(/^./, (c) => c.toLowerCase()).slice(0, 40);

/** The settings each kind of field takes; the rest are dropped before saving so the API never sees stray ones. */
const SETTINGS: Record<string, string[]> = {
  maxLength: ["text", "long_text"], pattern: ["text"], min: ["number"], max: ["number"],
  options: ["select", "multi_select"], listId: ["select", "multi_select"], referenceMaster: ["reference"],
  maxSizeMb: ["image", "document", "files"], maxFiles: ["files"], accept: ["document", "files"], withExpiry: ["document"],
};
const BASE = ["key", "label", "type", "required", "helpText", "order"];
export function cleanSpec(spec: FieldSpec): FieldSpec {
  const out: FieldSpec = {};
  for (const [k, v] of Object.entries(spec)) {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (BASE.includes(k) || (SETTINGS[k]?.includes(String(spec.type)))) out[k] = v;
  }
  return out;
}

/** A sample of the field, drawn the way the form will draw it. */
function Preview({ spec, defs }: { spec: FieldSpec; defs: Rec[] }) {
  const [value, setValue] = useState<unknown>(undefined);
  const name = `${spec.label || "New field"}${spec.required ? " *" : ""}`;
  const type = String(spec.type ?? "text");
  const choices = ((spec.options as string[] | undefined) ?? []).filter(Boolean);
  if (isFileType(type)) return <FieldGroup label={name} hint={spec.helpText as string | undefined}><FileField preview field={{ ...spec, key: spec.key || "preview", type }} target={{}} value={undefined} onChange={() => undefined} /></FieldGroup>;
  if (type === "boolean") return <SwitchField label={name} hint={spec.helpText as string | undefined} checked={Boolean(value)} onChange={setValue} />;
  if (type === "multi_select") return <FieldGroup label={name} hint={spec.helpText as string | undefined}><ChoiceChips label={name} options={(choices.length ? choices : ["First choice", "Second choice"]).map((c) => ({ value: c, label: c }))} value={(value as string[]) ?? []} onChange={setValue} /></FieldGroup>;
  return (
    <Field label={name} hint={spec.helpText as string | undefined}>
      {type === "select" ? <select value={(value as string) ?? ""} onChange={(e) => setValue(e.target.value)}><option value="">—</option>{(choices.length ? choices : ["First choice", "Second choice"]).map((c) => <option key={c}>{c}</option>)}</select>
        : type === "reference" ? <select disabled><option>{defs.find((d) => d.key === spec.referenceMaster)?.singular ? `Choose a ${String(defs.find((d) => d.key === spec.referenceMaster)!.singular).toLowerCase()}` : "Choose a record"}</option></select>
        : type === "long_text" ? <textarea rows={2} value={(value as string) ?? ""} onChange={(e) => setValue(e.target.value)} />
        : <input type={type === "number" ? "number" : type === "date" ? "date" : type === "email" ? "email" : type === "phone" ? "tel" : "text"} placeholder={type === "phone" ? "+260 97 123 4567" : undefined} value={(value as string) ?? ""} onChange={(e) => setValue(e.target.value)} />}
    </Field>
  );
}

export function FieldEditor({ initial, defs, editing, takenKeys = [], onSave, onCancel, busy, saveLabel, extra }: {
  initial: FieldSpec;
  defs: Rec[];
  /** An existing field: its kind and key are fixed once it may hold values. */
  editing?: boolean;
  /** Keys already used on this master, so a new field's key never clashes. */
  takenKeys?: string[];
  onSave: (spec: FieldSpec) => void;
  onCancel: () => void;
  busy?: boolean;
  saveLabel?: string;
  /** Settings of the place the field is added to, shown before the preview (a master's list column). */
  extra?: ReactNode;
}) {
  const [spec, setSpec] = useState<FieldSpec>(initial.type ? initial : { ...initial, type: "text" });
  const [keyTouched, setKeyTouched] = useState(Boolean(editing));
  // A kind someone picked themselves is never overridden by a guess from the name.
  const [kindPicked, setKindPicked] = useState(Boolean(initial.type));
  const startsOpen = Boolean(editing) && ["helpText", "pattern", "min", "max", "maxLength", "maxSizeMb", "maxFiles", "listId", "accept"].some((k) => spec[k] !== undefined);
  const [more, setMore] = useState(startsOpen);
  const [allKinds, setAllKinds] = useState(() => !COMMON_FIELD_TYPES.includes(String(initial.type ?? "text")));
  const lists = useQuery({ queryKey: ["lists-for-fields"], queryFn: () => api<Rec[]>("/lists", { query: { status: "active", limit: 100 } }), enabled: more && (spec.type === "select" || spec.type === "multi_select"), staleTime: 60_000 });
  const set = (change: FieldSpec) => setSpec((s) => ({ ...s, ...change }));
  const type = fieldType(spec.type);
  const has = (o: string) => Boolean(type?.options.includes(o as never));
  const setLabel = (label: string) => {
    const guessed = kindPicked || editing ? undefined : guessFieldType(label);
    if (guessed && !COMMON_FIELD_TYPES.includes(guessed.type)) setAllKinds(true);
    set({ label, ...(keyTouched ? {} : { key: keyFromLabel(label) || undefined }), ...(guessed ? { type: guessed.type, withExpiry: guessed.withExpiry || undefined } : {}) });
  };
  const keyClash = !editing && spec.key && takenKeys.includes(String(spec.key));
  const [choicesText, setChoicesText] = useState(((spec.options as string[] | undefined) ?? []).join("\n"));
  const missing = !String(spec.label ?? "").trim() ? "Give the field a name" : !spec.key ? "Give the field a key under More options" : keyClash ? "Another field already has this name" : (spec.type === "select" || spec.type === "multi_select") && !(spec.options as string[] | undefined)?.length && !spec.listId ? "Add the choices" : spec.type === "reference" && !spec.referenceMaster ? "Choose what it links to" : null;
  const kinds = allKinds ? FIELD_TYPES : FIELD_TYPES.filter((t) => COMMON_FIELD_TYPES.includes(t.value));

  return (
    <div className="field-editor">
      <Field label="Name *"><input autoFocus={!editing} value={String(spec.label ?? "")} maxLength={80} placeholder="e.g. Medical certificate" onChange={(e) => setLabel(e.target.value)} /></Field>

      <FieldGroup label="What it holds" wide hint={editing ? "This can't change once it may have values. Add a new field instead, and archive this one." : type?.holds}>
        {editing ? <strong className="kind-fixed">{type?.label ?? String(spec.type)}</strong> : (
          <div className="kind-chips" role="radiogroup" aria-label="What it holds">
            {kinds.map((t) => {
              const Icon = t.icon;
              const on = spec.type === t.value;
              return <button key={t.value} type="button" role="radio" aria-checked={on} className={on ? "on" : ""} onClick={() => { setKindPicked(true); set({ type: t.value }); }}><Icon size={15} aria-hidden /> {t.label}</button>;
            })}
            {!allKinds && <button type="button" className="kind-more" onClick={() => setAllKinds(true)}>More kinds</button>}
          </div>
        )}
      </FieldGroup>

      {/* Only what this kind can't work without. Everything else waits under More options. */}
      {has("choices") && !spec.listId && (
        <Field label="Choices *" hint="One per line, in the order people pick from."><textarea rows={4} value={choicesText} onChange={(e) => { setChoicesText(e.target.value); set({ options: e.target.value.split("\n").map((c) => c.trim()).filter(Boolean), listId: undefined }); }} /></Field>
      )}
      {has("referenceMaster") && (
        <Field label="Links to *" hint="The kind of record people pick.">
          <select disabled={editing} value={String(spec.referenceMaster ?? "")} onChange={(e) => set({ referenceMaster: e.target.value || undefined })}>
            <option value="">Choose a master</option>
            {defs.filter((d) => d.key !== "custom-records" && d.kind !== "custom").map((d) => <option key={String(d.key)} value={String(d.key)}>{String(d.label)}</option>)}
          </select>
        </Field>
      )}
      <div className="field-editor-switches">
        <SwitchField label="Required" hint={isFileType(spec.type) ? "A record can't be saved without the file." : "A record can't be saved without it."} checked={Boolean(spec.required)} onChange={(on) => set({ required: on || undefined })} />
        {has("withExpiry") && <SwitchField label="It has an expiry date" hint="Asked with the file, and shown beside it." checked={Boolean(spec.withExpiry)} onChange={(on) => set({ withExpiry: on || undefined })} />}
      </div>
      {extra}

      <button type="button" className="link-btn field-editor-more" aria-expanded={more} onClick={() => setMore(!more)}><ChevronDown size={14} aria-hidden /> More options</button>
      {more && (
        <div className="field-editor-body">
          <Field label="Help text" hint="A line under the field: what to put in it."><input value={String(spec.helpText ?? "")} maxLength={300} onChange={(e) => set({ helpText: e.target.value || undefined })} /></Field>
          {has("choices") && (
            <Field label="Or use a shared list" hint="A simple list kept in Masters, shared by several fields.">
              <select value={String(spec.listId ?? "")} onChange={(e) => set({ listId: e.target.value || undefined, options: e.target.value ? undefined : choicesText.split("\n").map((c) => c.trim()).filter(Boolean) })}>
                <option value="">None: use the choices typed above</option>
                {(lists.data ?? []).map((l) => <option key={String(l.id)} value={String(l.id)}>{String(l.name)}</option>)}
              </select>
            </Field>
          )}
          {(has("min") || has("maxLength")) && (
            <div className="grid-2">
              {has("min") && <Field label="Smallest"><input type="number" value={spec.min === undefined ? "" : String(spec.min)} onChange={(e) => set({ min: e.target.value === "" ? undefined : Number(e.target.value) })} /></Field>}
              {has("max") && <Field label="Largest"><input type="number" value={spec.max === undefined ? "" : String(spec.max)} onChange={(e) => set({ max: e.target.value === "" ? undefined : Number(e.target.value) })} /></Field>}
              {has("maxLength") && <Field label="Longest" hint="Characters."><input type="number" min={1} max={5000} value={spec.maxLength === undefined ? "" : String(spec.maxLength)} onChange={(e) => set({ maxLength: e.target.value === "" ? undefined : Number(e.target.value) })} /></Field>}
            </div>
          )}
          {has("accept") && (
            <FieldGroup label="Kinds of file it takes" hint="Pictures and PDFs open in the browser. Word and Excel files are always downloaded, never opened in the app.">
              <ChoiceChips label="Kinds of file it takes" options={FILE_KINDS.map((k) => ({ value: k.value as FileKind, label: k.label }))} value={kindsOf(spec)}
                onChange={(next) => set({ accept: next.length ? next : undefined })} />
            </FieldGroup>
          )}
          {(has("maxSizeMb") || has("maxFiles")) && (
            <div className="grid-2">
              {has("maxSizeMb") && <Field label="Largest file"><UnitInput label="Largest file" unit="MB" step={1} value={spec.maxSizeMb === undefined ? "" : String(spec.maxSizeMb)} onChange={(v) => set({ maxSizeMb: v === "" ? undefined : Math.max(1, Math.round(Number(v))) })} /></Field>}
              {has("maxFiles") && <Field label="How many files"><input type="number" min={1} max={20} placeholder="10" value={spec.maxFiles === undefined ? "" : String(spec.maxFiles)} onChange={(e) => set({ maxFiles: e.target.value === "" ? undefined : Math.min(20, Math.max(1, Number(e.target.value))) })} /></Field>}
            </div>
          )}
          <div className="grid-2">
            <Field label="Key" hint={editing ? "Fixed once the field exists: imports and other systems use it." : "Where the value is stored, made from the name. Imports and other systems use it."}>
              <input className="mono" disabled={editing} value={String(spec.key ?? "")} maxLength={40} onChange={(e) => { setKeyTouched(true); set({ key: e.target.value || undefined }); }} />
            </Field>
            {has("pattern") && <Field label="Must match" hint="A pattern the text must follow, for example ^[A-Z]{3}[0-9]{4}$."><input className="mono" value={String(spec.pattern ?? "")} onChange={(e) => set({ pattern: e.target.value || undefined })} /></Field>}
          </div>
          <section className="field-editor-preview" aria-label="How it will look">
            <h4>How it will look</h4>
            <div className="grid-2"><Preview spec={spec} defs={defs} /></div>
          </section>
        </div>
      )}
      <div className="field-editor-foot">
        {missing && String(spec.label ?? "") !== "" && <span className="muted small">{missing}</span>}
        <span className="spacer" />
        <Button tone="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button tone="primary" busy={busy} disabled={Boolean(missing)} onClick={() => onSave(cleanSpec(spec))}>{saveLabel ?? (editing ? "Save field" : "Add field")}</Button>
      </div>
    </div>
  );
}

/**
 * Adds or edits a company field on a master (a `field-definitions` record) with the editor above. `onSaved` gets
 * the saved field, so a form that was open can show it straight away.
 */
export function CompanyFieldEditor({ entity, entityLabel, field, defs, onSaved, onCancel }: { entity: string; entityLabel: string; field?: Rec; defs: Rec[]; onSaved: (saved: Rec) => void; onCancel: () => void }) {
  const client = useQueryClient();
  const { toast, me } = useApp();
  const [busy, setBusy] = useState(false);
  // Whether the master's list shows it: a column of the company's layout, set here so a new field is seen straight away.
  const mayShape = can(me, "company", "update");
  const master = defs.find((d) => d.key === entity);
  const wasInList = Boolean(((master?.customFields ?? []) as Rec[]).find((f) => f.id === field?.id)?.column);
  const [inList, setInList] = useState<boolean | null>(null);
  const existing = useQuery({ queryKey: ["record", "field-definitions", field?.id], queryFn: () => api<Rec>(`/field-definitions/${field!.id}`), enabled: Boolean(field?.id) });
  const taken = ((defs.find((d) => d.key === entity)?.customFields ?? []) as Rec[]).map((f) => String(f.key));
  if (field?.id && !existing.data) return <p className="muted">Loading…</p>;
  const save = async (spec: FieldSpec) => {
    setBusy(true);
    try {
      const saved = existing.data
        ? await api<Rec>(`/field-definitions/${existing.data.id}`, { method: "PATCH", body: { ...withoutFixed(spec, existing.data), version: existing.data.version } })
        : await api<Rec>("/field-definitions", { method: "POST", body: { ...spec, entity } });
      if (mayShape && inList !== null && inList !== wasInList) await setColumn(entity, `custom.${String(saved.key)}`, inList);
      toast(existing.data ? `${String(saved.label)} saved` : `${String(saved.label)} added to ${entityLabel.toLowerCase()}`);
      await client.invalidateQueries({ queryKey: ["meta-masters"] });
      await client.invalidateQueries({ queryKey: ["records", "field-definitions"] });
      await client.invalidateQueries({ queryKey: ["company-fields"] });
      await client.invalidateQueries({ queryKey: ["layout", entity] });
      onSaved(saved);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save the field.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <FieldEditor key={String(existing.data?.id ?? "new")} initial={existing.data ? pickSpec(existing.data) : {}} defs={defs} editing={Boolean(existing.data)} takenKeys={taken} busy={busy} onSave={(s) => void save(s)} onCancel={onCancel}
      extra={mayShape && <SwitchField label={`Show it in the list of ${entityLabel.toLowerCase()}`} hint="As a column. A picture shows as a small picture." checked={inList ?? wasInList} onChange={setInList} />} />
  );
}

/** Adds or removes a company field as a list column, in the master's layout, keeping everything else in it. */
async function setColumn(entity: string, path: string, on: boolean) {
  const layout = await api<{ fields?: Rec[] }>(`/meta/layouts/${entity}`);
  const fields = ((layout.fields ?? []) as Rec[]).filter((f) => f.path !== path);
  const was = ((layout.fields ?? []) as Rec[]).find((f) => f.path === path) ?? { path };
  const next = { ...was, column: on || undefined };
  const keep = Object.entries(next).some(([k, v]) => k !== "path" && v !== undefined);
  await api(`/meta/layouts/${entity}`, { method: "PUT", body: { fields: [...fields.map(strip), ...(keep ? [strip(next)] : [])] } });
}
/** A layout entry as the API takes it back: without empty settings. */
const strip = (f: Rec) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null));

/** The parts of a saved field the editor works on. */
const pickSpec = (r: Rec): FieldSpec => Object.fromEntries(Object.entries(r).filter(([k]) => BASE.includes(k) || k in SETTINGS));
/** An edit sends what changed; the master, key and kind are fixed, and a setting cleared is sent as null. */
function withoutFixed(spec: FieldSpec, before: Rec): Rec {
  const out: Rec = {};
  for (const k of new Set([...Object.keys(pickSpec(before)), ...Object.keys(spec)])) {
    if (["key", "type", "entity"].includes(k)) continue;
    if (JSON.stringify(spec[k]) !== JSON.stringify(before[k])) out[k] = spec[k] === undefined ? null : spec[k];
  }
  return out;
}

/** "PDFs and pictures, up to 5 MB, with an expiry date": a field's settings in a line, for lists of fields. */
export function specLine(f: Rec) {
  const t = fieldType(f.type);
  const parts = [t?.label ?? String(f.type)];
  if (isFileType(f.type)) {
    if (f.type !== "image") parts.push(kindsOf(f).map((k) => FILE_KINDS.find((x) => x.value === k)!.label).join(", "));
    if (f.maxSizeMb) parts.push(`up to ${String(f.maxSizeMb)} MB`);
    if (f.withExpiry) parts.push("with an expiry date");
  }
  if (f.required) parts.push("required");
  return parts.join(" · ");
}

