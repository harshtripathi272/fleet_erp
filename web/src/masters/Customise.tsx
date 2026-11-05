import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { useApp } from "../store";
import { Button, Drawer, SettingRow, SettingsSection, Switch } from "../ui/kit";
import { label } from "./history";
import { ComingSoonRows } from "../ui/comingSoon";

/**
 * The master of masters (#65, docs/entities.md): how this company shapes one master. Its name, each field (name,
 * hint, shown, required, list column, section, order), each list of choices (names, order, which are offered),
 * and the company's own fields. The code's definition is the starting point; everything here is the company's
 * layer on top, saved in one go, and each part can go back to the code's default.
 */

interface FieldLayout { path: string; label?: string; hint?: string; hidden?: boolean; required?: boolean; section?: string; order?: number; column?: boolean; columnOrder?: number }
interface ChoiceValue { value: string; label?: string; order?: number; retired?: boolean }
interface Layout { master: { label?: string; singular?: string; description?: string; hidden?: boolean }; sections: string[]; fields: FieldLayout[]; choices: { path: string; values: ChoiceValue[] }[] }

/** The fields a company works with: its master's own fields, not bookkeeping, attachments or links to other systems. */
const SKIP = new Set(["custom", "externalRefs", "attachments", "version"]);
const editable = (f: Rec) => f.entered && f.group === "master" && !f.hidden && !SKIP.has(String(f.path).split(".")[0]);
const depth = (path: string) => path.split(".").length - 1;

export function Customise({ def, onClose, onEditField }: { def: Rec; onClose: () => void; onEditField: (id?: string) => void }) {
  const client = useQueryClient();
  const { toast } = useApp();
  const saved = useQuery({ queryKey: ["layout", def.key], queryFn: () => api<Layout>(`/meta/layouts/${def.key}`) });
  const [draft, setDraft] = useState<Layout | null>(null);
  const [busy, setBusy] = useState(false);
  const [newSection, setNewSection] = useState("");
  useEffect(() => { if (saved.data && !draft) setDraft({ master: saved.data.master ?? {}, sections: saved.data.sections ?? [], fields: saved.data.fields ?? [], choices: saved.data.choices ?? [] }); }, [saved.data, draft]);

  const fields = useMemo(() => ((def.fields as Rec[]) ?? []).filter(editable), [def.fields]);
  if (!draft) return <Drawer open title={`Customise ${String(def.label).toLowerCase()}`} onClose={onClose} width={960}><p className="muted">Loading…</p></Drawer>;

  /* ---------- Reading and changing the draft ---------- */
  const fieldOf = (path: string) => draft.fields.find((f) => f.path === path) ?? { path };
  const setField = (path: string, change: Partial<FieldLayout>) => {
    const next = { ...fieldOf(path), ...change };
    // An entry that changes nothing is left out, so the field follows the code again.
    const empty = Object.entries(next).every(([k, v]) => k === "path" || v === undefined || v === "" || v === false);
    setDraft({ ...draft, fields: [...draft.fields.filter((f) => f.path !== path), ...(empty ? [] : [next])] });
  };
  const ordered = [...fields].sort((a, b) => (fieldOf(a.path).order ?? Number(a.order ?? 0)) - (fieldOf(b.path).order ?? Number(b.order ?? 0)));
  const move = (path: string, by: -1 | 1) => {
    const list = ordered.filter((f) => depth(f.path) === depth(path) && String(f.path).split(".").slice(0, -1).join(".") === path.split(".").slice(0, -1).join("."));
    const i = list.findIndex((f) => f.path === path);
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    const swapped = [...list];
    [swapped[i], swapped[j]] = [swapped[j]!, swapped[i]!];
    const fieldsNext = [...draft.fields];
    swapped.forEach((f, k) => {
      const at = fieldsNext.findIndex((x) => x.path === f.path);
      const entry = { ...(at >= 0 ? fieldsNext[at]! : { path: String(f.path) }), order: k * 10 };
      if (at >= 0) fieldsNext[at] = entry; else fieldsNext.push(entry);
    });
    setDraft({ ...draft, fields: fieldsNext });
  };
  const choicesOf = (path: string) => draft.choices.find((c) => c.path === path)?.values ?? [];
  const setChoice = (path: string, value: string, change: Partial<ChoiceValue>, order: string[]) => {
    const values = order.map((v, i) => {
      const was = choicesOf(path).find((c) => c.value === v) ?? { value: v };
      return v === value ? { ...was, ...change, order: was.order ?? i } : { ...was, order: was.order ?? i };
    });
    setDraft({ ...draft, choices: [...draft.choices.filter((c) => c.path !== path), { path, values }] });
  };
  const moveChoice = (path: string, value: string, by: -1 | 1, order: string[]) => {
    const i = order.indexOf(value);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    const values = next.map((v, k) => ({ ...(choicesOf(path).find((c) => c.value === v) ?? { value: v }), order: k }));
    setDraft({ ...draft, choices: [...draft.choices.filter((c) => c.path !== path), { path, values }] });
  };

  const original = JSON.stringify({ master: saved.data?.master ?? {}, sections: saved.data?.sections ?? [], fields: saved.data?.fields ?? [], choices: saved.data?.choices ?? [] });
  const dirty = JSON.stringify(draft) !== original;
  const save = async (body: Layout) => {
    setBusy(true);
    try {
      await api(`/meta/layouts/${def.key}`, { method: "PUT", body: { ...body, master: Object.fromEntries(Object.entries(body.master).filter(([, v]) => v !== undefined && v !== "")) } });
      toast(`${def.label} saved. Forms, lists and the import template follow the new shape.`);
      await client.invalidateQueries({ queryKey: ["meta-masters"] });
      await client.invalidateQueries({ queryKey: ["layout", def.key] });
      setDraft(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't save.", "error");
    } finally {
      setBusy(false);
    }
  };

  const enums = ordered.filter((f) => Array.isArray(f.enum) && f.enum.length > 0);
  const locked = new Set((def.lockedChoices as string[] | undefined) ?? []);
  const customFields = (def.customFields as Rec[] | undefined) ?? [];

  return (
    <Drawer open title={`Customise ${String(def.label).toLowerCase()}`} onClose={onClose} width={960}
      footer={
        <>
          <Button tone="quiet" disabled={busy} onClick={() => void save({ master: {}, sections: [], fields: [], choices: [] })}>Reset everything to the default</Button>
          <span className="spacer" />
          <Button tone="quiet" disabled={!dirty || busy} onClick={() => setDraft(null)}>Discard changes</Button>
          <Button tone="primary" busy={busy} disabled={!dirty} onClick={() => void save(draft)}>Save changes</Button>
        </>
      }>
      <div className="customise">
        <SettingsSection title="The master" description="How it is named across the app: the masters list, headings, buttons and the import template.">
          <SettingRow title="Name" description={`The code calls it "${def.codeLabel ?? def.label}".`} htmlFor="cm-label">
            <input id="cm-label" className="input" placeholder={String(def.label)} value={draft.master.label ?? ""} onChange={(e) => setDraft({ ...draft, master: { ...draft.master, label: e.target.value || undefined } })} />
          </SettingRow>
          <SettingRow title="One record is called" description='Used in "New …" and messages about a single record.' htmlFor="cm-singular">
            <input id="cm-singular" className="input" placeholder={String(def.singular)} value={draft.master.singular ?? ""} onChange={(e) => setDraft({ ...draft, master: { ...draft.master, singular: e.target.value || undefined } })} />
          </SettingRow>
          <SettingRow title="Description" description="Shown under the master's heading." htmlFor="cm-desc">
            <textarea id="cm-desc" className="input" rows={2} placeholder={String(def.description ?? "")} value={draft.master.description ?? ""} onChange={(e) => setDraft({ ...draft, master: { ...draft.master, description: e.target.value || undefined } })} />
          </SettingRow>
          <SettingRow title="Show in the masters list" description="Hidden masters keep their records and still work; only the list leaves them out.">
            <Switch label="Show in the masters list" checked={!draft.master.hidden} onChange={(on) => setDraft({ ...draft, master: { ...draft.master, hidden: on ? undefined : true } })} />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Fields" description="Every field this master has. Hidden fields keep their stored values and are still accepted from imports and other systems. Fields the app needs can be renamed and moved, but not hidden or made optional.">
          <div className="cust-table-wrap">
            <table className="cust-table">
              <thead><tr><th>Field</th><th>Hint</th><th>Shown</th><th>Required</th><th>In list</th><th>Section</th><th>Order</th></tr></thead>
              <tbody>
                {ordered.map((f) => {
                  const l = fieldOf(f.path);
                  const inList = String(f.path).split(".").length > 1 && ordered.some((p) => p.array && String(f.path).startsWith(`${p.path}.`));
                  return (
                    <tr key={f.path} className={depth(f.path) ? "cust-child" : undefined}>
                      <td>
                        <input className="input" aria-label={`Name of ${f.codeLabel ?? f.label}`} placeholder={String(f.codeLabel ?? f.label)} value={l.label ?? ""} onChange={(e) => setField(f.path, { label: e.target.value || undefined })} />
                        <span className="cust-path">{f.path}</span>
                      </td>
                      <td><input className="input" aria-label={`Hint for ${f.codeLabel ?? f.label}`} placeholder={String(f.hint ?? "")} value={l.hint ?? ""} onChange={(e) => setField(f.path, { hint: e.target.value || undefined })} /></td>
                      <td><Switch label={`Show ${f.codeLabel ?? f.label}`} checked={!l.hidden} disabled={Boolean(f.systemRequired)} onChange={(on) => setField(f.path, { hidden: on ? undefined : true })} /></td>
                      <td><Switch label={`Require ${f.codeLabel ?? f.label}`} checked={Boolean(f.systemRequired || l.required)} disabled={Boolean(f.systemRequired) || inList} onChange={(on) => setField(f.path, { required: on || undefined })} /></td>
                      <td>{depth(f.path) === 0 && <Switch label={`Show ${f.codeLabel ?? f.label} as a list column`} checked={Boolean(l.column)} onChange={(on) => setField(f.path, { column: on || undefined })} />}</td>
                      <td>
                        {depth(f.path) === 0 && (
                          <select className="input" aria-label={`Section of ${f.codeLabel ?? f.label}`} value={l.section ?? ""} onChange={(e) => setField(f.path, { section: e.target.value || undefined })}>
                            <option value="">Main</option>
                            {draft.sections.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        )}
                      </td>
                      <td className="cust-move">
                        <button type="button" className="icon-btn" aria-label={`Move ${f.codeLabel ?? f.label} up`} onClick={() => move(f.path, -1)}><ArrowUp size={15} /></button>
                        <button type="button" className="icon-btn" aria-label={`Move ${f.codeLabel ?? f.label} down`} onClick={() => move(f.path, 1)}><ArrowDown size={15} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <SettingRow title="Sections" description="Groups of fields in the form, in this order. Fields in no section come first.">
            <div className="cust-sections">
              {draft.sections.map((s) => (
                <span key={s} className="chip">{s}<button type="button" aria-label={`Remove section ${s}`} onClick={() => setDraft({ ...draft, sections: draft.sections.filter((x) => x !== s), fields: draft.fields.map((f) => (f.section === s ? { ...f, section: undefined } : f)) })}>×</button></span>
              ))}
              <span className="cust-add">
                <input className="input" placeholder="New section, e.g. Next of kin" value={newSection} onChange={(e) => setNewSection(e.target.value)} />
                <Button size="sm" disabled={!newSection.trim() || draft.sections.includes(newSection.trim())} onClick={() => { setDraft({ ...draft, sections: [...draft.sections, newSection.trim()] }); setNewSection(""); }}>Add</Button>
              </span>
            </div>
          </SettingRow>
        </SettingsSection>

        {enums.length > 0 && (
          <SettingsSection title="Lists of choices" description="Rename choices, put them in the order people pick from, and stop offering ones the company doesn't use. Records that already hold a choice keep it.">
            {enums.map((f) => {
              const order = f.enum as string[];
              const isLocked = locked.has(f.path);
              return (
                <div key={f.path} className="cust-choices">
                  <h4>{f.label}{isLocked && <span className="muted"> · the app acts on these, so they can be renamed but not removed</span>}</h4>
                  {order.map((v) => {
                    const c = choicesOf(f.path).find((x) => x.value === v);
                    const codeName = (f.codeChoiceLabels as Rec | undefined)?.[v] ?? label(v);
                    return (
                      <div key={v} className="cust-choice">
                        <input className="input" aria-label={`Name of ${codeName}`} placeholder={String(codeName)} value={c?.label ?? ""} onChange={(e) => setChoice(f.path, v, { label: e.target.value || undefined }, order)} />
                        <Switch label={`Offer ${codeName}`} checked={!c?.retired} disabled={isLocked} onChange={(on) => setChoice(f.path, v, { retired: on ? undefined : true }, order)} />
                        <span className="cust-move">
                          <button type="button" className="icon-btn" aria-label={`Move ${codeName} up`} onClick={() => moveChoice(f.path, v, -1, order)}><ArrowUp size={15} /></button>
                          <button type="button" className="icon-btn" aria-label={`Move ${codeName} down`} onClick={() => moveChoice(f.path, v, 1, order)}><ArrowDown size={15} /></button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </SettingsSection>
        )}

        {def.customFieldsAllowed !== false && (
          <SettingsSection title="The company's own fields" description="Fields this company added. They work like built-in ones: in forms, lists, search and the import template.">
            {customFields.map((f) => (
              <SettingRow key={f.key} title={String(f.label)} description={`${label(String(f.type))}${f.required ? " · required" : ""}`}>
                <Button size="sm" onClick={() => onEditField(String(f.id))}>Edit</Button>
              </SettingRow>
            ))}
            <SettingRow title="Add a field" description="Text, a number, a date, yes or no, a choice from a list, or a link to another master.">
              <Button size="sm" onClick={() => onEditField()}><Plus size={14} /> Add a field</Button>
            </SettingRow>
          </SettingsSection>
        )}
        <SettingsSection title="Coming soon">
          <ComingSoonRows place="masters" />
        </SettingsSection>
      </div>
    </Drawer>
  );
}
