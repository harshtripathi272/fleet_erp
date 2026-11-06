import { Fragment, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, GripVertical, Plus, Search, Undo2 } from "lucide-react";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { FIELD_TYPE_INFO, fieldTypeInfo, keyFromLabel } from "../masters/fieldTypes";
import { label as wordsFor } from "../masters/history";
import { OPERATIONAL_RECORDS } from "../masters/MastersScreen";
import { Button, Drawer, Field, FieldGroup, SettingRow, SettingsSection, Status, Switch } from "../ui/kit";
import { useSetUp } from "./context";

/**
 * The heart of setting up a company: its masters. Each company keeps different records with different fields, so
 * every master can be renamed, hidden and reshaped here, fields added to it, and whole new masters made. All of it
 * goes in the company file, so the system built here is the system the package deploys. Leaving a master alone
 * keeps the usual one, and only what differs is stored.
 */

type Layout = { entity: string; master: Rec; sections: string[]; fields: Rec[]; choices: Rec[] };
const blank = (entity: string): Layout => ({ entity, master: {}, sections: [], fields: [], choices: [] });
const SKIP = new Set(["custom", "externalRefs", "attachments", "version"]);
const designable = (f: Rec) => f.entered && f.group === "master" && !f.hidden && !SKIP.has(String(f.path).split(".")[0]);
const depth = (path: string) => path.split(".").length - 1;
const changed = (l?: Layout) => Boolean(l && (Object.keys(l.master ?? {}).length || l.sections?.length || l.fields?.length || l.choices?.length));

export function MastersStep() {
  const { file, set, err } = useSetUp();
  const defsQuery = useQuery({ queryKey: ["setup-masters"], queryFn: () => api<Rec[]>("/setup-kit/masters"), staleTime: 60_000 });
  const m = (file.masters ?? {}) as { layouts?: Layout[]; fields?: Rec[]; customMasters?: Rec[]; lists?: Rec[] };
  const layouts = m.layouts ?? [];
  const fields = m.fields ?? [];
  const customMasters = m.customMasters ?? [];
  const [selected, setSelected] = useState("drivers");
  const [search, setSearch] = useState("");
  const [makingMaster, setMakingMaster] = useState<number | "new" | null>(null);
  const areas = file.areas as string[] | undefined;

  const defs = useMemo(() => (defsQuery.data ?? []).filter((d) => d.key !== "custom-records" && d.key !== "custom-masters" && d.key !== "field-definitions" && (!d.module || !areas || areas.includes(String(d.module)))), [defsQuery.data, areas]);
  const groups = useMemo(() => {
    const out = new Map<string, Rec[]>();
    for (const d of defs) {
      const name = layouts.find((l) => l.entity === d.key)?.master?.label ?? d.label;
      if (search && !`${name} ${d.description}`.toLowerCase().includes(search.toLowerCase())) continue;
      out.set(String(d.group), [...(out.get(String(d.group)) ?? []), d]);
    }
    return [...out];
  }, [defs, layouts, search]);
  if (defsQuery.isLoading) return <p className="muted">Loading the masters…</p>;

  const def = defs.find((d) => d.key === selected);
  const record = OPERATIONAL_RECORDS.find((r) => r.key === selected);
  const customAt = selected.startsWith("own:") ? Number(selected.slice(4)) : -1;
  const layoutOf = (entity: string) => layouts.find((l) => l.entity === entity) ?? blank(entity);
  const setLayout = (next: Layout) => {
    const rest = layouts.filter((l) => l.entity !== next.entity);
    set("masters", { ...m, layouts: changed(next) ? [...rest, next] : rest });
  };
  const setFields = (next: Rec[]) => set("masters", { ...m, fields: next });
  const count = (entity: string) => fields.filter((f) => f.entity === entity).length;
  const changedCount = new Set([...layouts.filter(changed).map((l) => l.entity), ...fields.map((f) => String(f.entity))]).size + customMasters.length;

  return (
    <div className="su-stack">
      <p className="su-lead">
        {changedCount ? `${changedCount} changed so far. ` : "Everything starts as the usual masters, ready to use. "}
        Choose a master to see its fields. Rename what this company calls differently, hide what it doesn't use, and add what's missing. Whatever you leave alone keeps working as it is.
      </p>
      {err("masters") && <p className="su-note bad">{err("masters")}</p>}
      <div className="su-designer">
        <nav className="su-master-list" aria-label="Masters">
          <label className="search">
            <Search size={15} aria-hidden />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a master" aria-label="Find a master" />
          </label>
          <section>
            <h3>The company's own</h3>
            {customMasters.map((c, i) => (
              <button key={String(c.code)} className={selected === `own:${i}` ? "on" : ""} onClick={() => setSelected(`own:${i}`)}>
                <span>{String(c.name)}</span><small>New</small>
              </button>
            ))}
            <button className="su-add-master" onClick={() => setMakingMaster("new")}><Plus size={14} /> Add a master</button>
          </section>
          {groups.map(([group, list]) => (
            <section key={group}>
              <h3>{group}</h3>
              {list.map((d) => {
                const l = layoutOf(String(d.key));
                const own = count(String(d.key));
                return (
                  <button key={String(d.key)} className={selected === d.key ? "on" : ""} onClick={() => setSelected(String(d.key))}>
                    <span className={l.master?.hidden ? "off" : ""}>{String(l.master?.label ?? d.label)}</span>
                    {(changed(l) || own > 0) && <small>{l.master?.hidden ? "Hidden" : own ? `+${own}` : "Changed"}</small>}
                  </button>
                );
              })}
            </section>
          ))}
          {!search && (
            <section>
              <h3>Trips and money</h3>
              {OPERATIONAL_RECORDS.map((r) => (
                <button key={r.key} className={selected === r.key ? "on" : ""} onClick={() => setSelected(r.key)}>
                  <span>{r.label}</span>{count(r.key) > 0 && <small>+{count(r.key)}</small>}
                </button>
              ))}
            </section>
          )}
        </nav>
        <div className="su-master-main" key={selected}>
          {def && <MasterDesigner def={def} layout={layoutOf(String(def.key))} onLayout={setLayout} fields={fields} onFields={setFields} defs={defs} customMasters={customMasters} />}
          {record && <RecordFields record={record} fields={fields} onFields={setFields} defs={defs} />}
          {customAt >= 0 && customMasters[customAt] && (
            <OwnMaster master={customMasters[customAt]!} onEdit={() => setMakingMaster(customAt)} onRemove={() => { setSelected("drivers"); set("masters", { ...m, customMasters: customMasters.filter((_, i) => i !== customAt) }); }} />
          )}
        </div>
      </div>
      {makingMaster !== null && (
        <MasterDrawer master={makingMaster === "new" ? undefined : customMasters[makingMaster]} defs={defs} taken={customMasters.map((c) => String(c.code))} onClose={() => setMakingMaster(null)}
          onSave={(next) => {
            const list = makingMaster === "new" ? [...customMasters, next] : customMasters.map((c, i) => (i === makingMaster ? next : c));
            set("masters", { ...m, customMasters: list });
            setSelected(`own:${makingMaster === "new" ? customMasters.length : makingMaster}`);
            setMakingMaster(null);
          }} />
      )}
    </div>
  );
}

/* ---------- One built-in master ---------- */

function MasterDesigner({ def, layout, onLayout, fields, onFields, defs, customMasters }: { def: Rec; layout: Layout; onLayout: (l: Layout) => void; fields: Rec[]; onFields: (f: Rec[]) => void; defs: Rec[]; customMasters: Rec[] }) {
  const [newSection, setNewSection] = useState("");
  const dragged = useRef<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (path: string) => setOpen((was) => { const next = new Set(was); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const list = useMemo(() => ((def.fields as Rec[]) ?? []).filter(designable), [def.fields]);
  const entry = (path: string): Rec => layout.fields.find((f) => f.path === path) ?? { path };
  const setField = (path: string, change: Rec) => {
    const next = { ...entry(path), ...change };
    const empty = Object.entries(next).every(([k, v]) => k === "path" || v === undefined || v === "" || v === false);
    onLayout({ ...layout, fields: [...layout.fields.filter((f) => f.path !== path), ...(empty ? [] : [next])] });
  };
  const ordered = [...list].sort((a, b) => Number(entry(a.path).order ?? a.order ?? 0) - Number(entry(b.path).order ?? b.order ?? 0));
  const siblings = (path: string) => ordered.filter((f) => depth(f.path) === depth(path) && String(f.path).split(".").slice(0, -1).join(".") === path.split(".").slice(0, -1).join("."));
  /** Writes the new order for a group of neighbours; each keeps its other settings. */
  const reorder = (rows: Rec[]) => {
    const out = [...layout.fields];
    rows.forEach((f, k) => {
      const at = out.findIndex((x) => x.path === f.path);
      const value = { ...(at >= 0 ? out[at]! : { path: String(f.path) }), order: k * 10 };
      if (at >= 0) out[at] = value; else out.push(value);
    });
    onLayout({ ...layout, fields: out });
  };
  const move = (path: string, by: number) => {
    const rows = siblings(path);
    const i = rows.findIndex((f) => f.path === path);
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
    reorder(rows);
  };
  const dropOn = (path: string) => {
    const from = dragged.current;
    dragged.current = null;
    if (!from || from === path) return;
    const rows = siblings(path);
    const i = rows.findIndex((f) => f.path === from);
    const j = rows.findIndex((f) => f.path === path);
    if (i < 0 || j < 0) return;
    const [row] = rows.splice(i, 1);
    rows.splice(j, 0, row!);
    reorder(rows);
  };
  const own = fields.filter((f) => f.entity === def.key);
  const hidden = Boolean(layout.master?.hidden);
  const enums = ordered.filter((f) => Array.isArray(f.enum) && f.enum.length > 0);
  const locked = new Set((def.lockedChoices as string[] | undefined) ?? []);
  const setMaster = (change: Rec) => {
    const master = { ...layout.master, ...change };
    for (const k of Object.keys(master)) if (master[k] === undefined || master[k] === "") delete master[k];
    onLayout({ ...layout, master });
  };
  const singular = String(layout.master?.singular ?? def.singular ?? "record");

  return (
    <div className="su-stack">
      <header className="su-master-head">
        <div>
          <h2>{String(layout.master?.label ?? def.label)}</h2>
          <p>{String(layout.master?.description ?? def.description ?? "")}</p>
        </div>
        <span className="su-master-use"><span>Use it</span><Switch label={`Use ${String(def.label)}`} checked={!hidden} onChange={(on) => setMaster({ hidden: on ? undefined : true })} /></span>
      </header>
      {hidden && <p className="su-note">Hidden from the masters list. Anything that depends on it keeps working.</p>}

      <SettingsSection title="What it's called">
        <div className="su-pad grid-2">
          <Field label="Name" hint={`Usually "${String(def.codeLabel ?? def.label)}".`}><input className="input" placeholder={String(def.codeLabel ?? def.label)} value={String(layout.master?.label ?? "")} onChange={(e) => setMaster({ label: e.target.value })} /></Field>
          <Field label="One record is called" hint={`Used in "New ${singular.toLowerCase()}".`}><input className="input" placeholder={String(def.codeSingular ?? def.singular)} value={String(layout.master?.singular ?? "")} onChange={(e) => setMaster({ singular: e.target.value })} /></Field>
        </div>
      </SettingsSection>

      {def.customFieldsAllowed !== false && (
        <OwnFields entity={String(def.key)} title="The company's own fields" text={`Whatever else this company keeps on ${String(def.label).toLowerCase()}. They work like built-in ones: in the form, lists, search and the import template.`} fields={own} all={fields} onFields={onFields} defs={defs} customMasters={customMasters} />
      )}

      <SettingsSection title="Built-in fields" description="Drag to reorder. Fields the app itself needs can be renamed and moved, but not hidden or made optional.">
        <div className="cust-table-wrap su-table">
          <table className="cust-table su-field-table">
            <thead><tr><th aria-label="Move" /><th>Field</th><th>Shown</th><th>Required</th><th>In list</th><th aria-label="More" /></tr></thead>
            <tbody>
              {ordered.filter((f) => depth(f.path) === 0 || open.has(String(f.path).split(".").slice(0, -1).join("."))).map((f) => {
                const l = entry(f.path);
                const fixed = Boolean(f.systemRequired);
                const insideList = String(f.path).split(".").length > 1 && ordered.some((p) => p.array && String(f.path).startsWith(`${p.path}.`));
                const name = String(f.codeLabel ?? f.label);
                const inner = ordered.filter((c) => String(c.path).startsWith(`${f.path}.`) && depth(c.path) === depth(f.path) + 1).length;
                const expanded = open.has(f.path);
                return (
                  <Fragment key={f.path}>
                    <tr className={`${depth(f.path) ? "cust-child" : ""} ${l.hidden ? "su-row-off" : ""}`} draggable onDragStart={() => { dragged.current = f.path; }} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(f.path)}>
                      <td className="su-grip">
                        <GripVertical size={15} aria-hidden />
                        <span className="su-grip-buttons">
                          <button type="button" className="icon-btn" aria-label={`Move ${name} up`} onClick={() => move(f.path, -1)}><ArrowUp size={13} /></button>
                          <button type="button" className="icon-btn" aria-label={`Move ${name} down`} onClick={() => move(f.path, 1)}><ArrowDown size={13} /></button>
                        </span>
                      </td>
                      <td className="su-field-name"><input className="input" aria-label={`Name of ${name}`} placeholder={name} value={String(l.label ?? "")} onChange={(e) => setField(f.path, { label: e.target.value || undefined })} /></td>
                      <td><Switch label={`Show ${name}`} checked={!l.hidden} disabled={fixed} onChange={(on) => setField(f.path, { hidden: on ? undefined : true })} /></td>
                      <td><Switch label={`Require ${name}`} checked={fixed || Boolean(l.required)} disabled={fixed || insideList} onChange={(on) => setField(f.path, { required: on || undefined })} /></td>
                      <td>{depth(f.path) === 0 && <Switch label={`Show ${name} as a list column`} checked={Boolean(l.column)} onChange={(on) => setField(f.path, { column: on || undefined })} />}</td>
                      <td><button type="button" className="su-more" aria-expanded={expanded} onClick={() => toggle(f.path)}>{inner ? `${inner} inside` : "More"} {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}</button></td>
                    </tr>
                    {expanded && (
                      <tr className="su-field-more">
                        <td />
                        <td colSpan={5}>
                          <div className="grid-2">
                            <Field label="Hint" hint="Shown under the field."><input className="input" placeholder={String(f.hint ?? "")} value={String(l.hint ?? "")} onChange={(e) => setField(f.path, { hint: e.target.value || undefined })} /></Field>
                            {depth(f.path) === 0 && layout.sections.length > 0 && (
                              <Field label="Section">
                                <select className="input" value={String(l.section ?? "")} onChange={(e) => setField(f.path, { section: e.target.value || undefined })}>
                                  <option value="">Main</option>
                                  {layout.sections.map((x) => <option key={x} value={x}>{x}</option>)}
                                </select>
                              </Field>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <SettingRow title="Sections" description="Groups of fields in the form, in this order. Add one, then choose it under More on a field.">
          <div className="cust-sections">
            {layout.sections.map((s) => (
              <span key={s} className="chip">{s}<button type="button" aria-label={`Remove section ${s}`} onClick={() => onLayout({ ...layout, sections: layout.sections.filter((x) => x !== s), fields: layout.fields.map((f) => (f.section === s ? { ...f, section: undefined } : f)) })}>×</button></span>
            ))}
            <span className="cust-add">
              <input className="input" placeholder="e.g. Next of kin" value={newSection} onChange={(e) => setNewSection(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newSection.trim() && !layout.sections.includes(newSection.trim())) { onLayout({ ...layout, sections: [...layout.sections, newSection.trim()] }); setNewSection(""); } }} />
              <Button size="sm" disabled={!newSection.trim() || layout.sections.includes(newSection.trim())} onClick={() => { onLayout({ ...layout, sections: [...layout.sections, newSection.trim()] }); setNewSection(""); }}>Add</Button>
            </span>
          </div>
        </SettingRow>
      </SettingsSection>

      {enums.length > 0 && (
        <SettingsSection title="Lists of choices" description="Rename choices, and stop offering ones this company doesn't use. Records that already hold one keep it.">
          {enums.map((f) => {
            const values = (layout.choices.find((c) => c.path === f.path)?.values ?? []) as Rec[];
            const isLocked = locked.has(f.path);
            const setChoice = (value: string, change: Rec) => {
              const was = values.find((v) => v.value === value) ?? { value };
              const next = [...values.filter((v) => v.value !== value), { ...was, ...change }].filter((v) => v.label || v.retired);
              const choices = layout.choices.filter((c) => c.path !== f.path);
              onLayout({ ...layout, choices: next.length ? [...choices, { path: f.path, values: next }] : choices });
            };
            return (
              <div key={f.path} className="cust-choices su-choices">
                <h4>{String(f.label)}{isLocked && <span className="muted"> · the app acts on these, so they can be renamed but not removed</span>}</h4>
                {(f.enum as string[]).map((v) => {
                  const c = values.find((x) => x.value === v);
                  const name = String((f.codeChoiceLabels as Rec | undefined)?.[v] ?? wordsFor(v));
                  return (
                    <div key={v} className="cust-choice">
                      <input className="input" aria-label={`Name of ${name}`} placeholder={name} value={String(c?.label ?? "")} onChange={(e) => setChoice(v, { label: e.target.value || undefined })} />
                      <Switch label={`Offer ${name}`} checked={!c?.retired} disabled={isLocked} onChange={(on) => setChoice(v, { retired: on ? undefined : true })} />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </SettingsSection>
      )}
      {(changedLayout(layout) || own.length > 0) && (
        <div><Button tone="quiet" onClick={() => { onLayout(blank(layout.entity)); onFields(fields.filter((f) => f.entity !== def.key)); }}><Undo2 size={14} /> Back to the usual {String(def.codeLabel ?? def.label).toLowerCase()}</Button></div>
      )}
    </div>
  );
}
const changedLayout = changed;

/* ---------- A trip or money record: only the company's fields, each asked at a step ---------- */

function RecordFields({ record, fields, onFields, defs }: { record: (typeof OPERATIONAL_RECORDS)[number]; fields: Rec[]; onFields: (f: Rec[]) => void; defs: Rec[] }) {
  return (
    <div className="su-stack">
      <header className="su-master-head"><div><h2>{record.label}</h2><p>Add what this company records along the way. Each field is asked at the step you choose, by the office or the driver, and can print on the trip sheet or the driver's statement.</p></div></header>
      <OwnFields entity={record.key} title="The company's own fields" fields={fields.filter((f) => f.entity === record.key)} all={fields} onFields={onFields} defs={defs} steps={record.steps} customMasters={[]} />
    </div>
  );
}

/* ---------- The company's own fields on any record ---------- */

function OwnFields({ entity, title, text, fields, all, onFields, defs, steps, customMasters }: { entity: string; title: string; text?: string; fields: Rec[]; all: Rec[]; onFields: (f: Rec[]) => void; defs: Rec[]; steps?: { value: string; label: string }[]; customMasters: Rec[] }) {
  const [editing, setEditing] = useState<Rec | "new" | null>(null);
  void customMasters;
  return (
    <SettingsSection title={title} description={text}>
      {fields.map((f) => {
        const info = fieldTypeInfo(f.type);
        return (
          <SettingRow key={String(f.key)} title={<>{String(f.label)}{f.required ? <span className="status status-info area-early">Required</span> : null}</>} description={[info.label, f.helpText, steps?.find((s) => s.value === f.placement)?.label && `Asked when ${String(steps.find((s) => s.value === f.placement)!.label).toLowerCase()}`].filter(Boolean).join(" · ")}>
            <span className="su-actions">
              <Button size="sm" onClick={() => setEditing(f)}>Change</Button>
              <Button size="sm" tone="quiet" onClick={() => onFields(all.filter((x) => x !== f))}>Remove</Button>
            </span>
          </SettingRow>
        );
      })}
      <div className="su-pad"><Button onClick={() => setEditing("new")}><Plus size={15} /> Add a field</Button></div>
      {editing !== null && (
        <FieldDrawer field={editing === "new" ? undefined : editing} defs={defs} steps={steps} taken={fields.filter((f) => f !== editing).map((f) => String(f.key))} onClose={() => setEditing(null)}
          onSave={(next) => {
            const saved = { ...next, entity };
            onFields(editing === "new" ? [...all, saved] : all.map((x) => (x === editing ? saved : x)));
            setEditing(null);
          }} />
      )}
    </SettingsSection>
  );
}

/* ---------- Making one field ---------- */

function FieldDrawer({ field, defs, steps, taken, onClose, onSave }: { field?: Rec; defs: Rec[]; steps?: { value: string; label: string }[]; taken: string[]; onClose: () => void; onSave: (f: Rec) => void }) {
  const [draft, setDraft] = useState<Rec>(field ?? { type: "text", ...(steps ? { placement: steps[0]!.value, askedOf: "office" } : {}) });
  const [choiceText, setChoiceText] = useState(((field?.options ?? []) as string[]).join("\n"));
  const info = fieldTypeInfo(draft.type);
  const takes = (x: string) => (info as { takes?: string[] }).takes?.includes(x);
  const key = field ? String(field.key) : keyFromLabel(String(draft.label ?? ""));
  const options = choiceText.split("\n").map((s) => s.trim()).filter(Boolean);
  const set = (change: Rec) => setDraft((d) => ({ ...d, ...change }));
  const pickType = (type: string) => setDraft((d) => ({ label: d.label, helpText: d.helpText, required: d.required, placement: d.placement, askedOf: d.askedOf, printOn: d.printOn, type }));
  const clash = taken.includes(key);
  const problem = !String(draft.label ?? "").trim() ? "Give it a name." : clash ? "This master already has a field with that name." : takes("choices") && !options.length ? "Add at least one choice." : takes("master") && !draft.referenceMaster ? "Choose which master it links to." : undefined;
  const save = () => {
    const out: Rec = { key, label: String(draft.label).trim(), type: draft.type };
    if (draft.required) out.required = true;
    if (draft.helpText) out.helpText = draft.helpText;
    if (takes("choices")) out.options = [...new Set(options)];
    if (takes("master")) out.referenceMaster = draft.referenceMaster;
    if (takes("length") && draft.maxLength) out.maxLength = Number(draft.maxLength);
    if (takes("range") && draft.min !== undefined && draft.min !== "") out.min = Number(draft.min);
    if (takes("range") && draft.max !== undefined && draft.max !== "") out.max = Number(draft.max);
    if (takes("pattern") && draft.pattern) out.pattern = draft.pattern;
    if (steps) { out.placement = draft.placement; out.askedOf = draft.askedOf; if ((draft.printOn as string[] | undefined)?.length) out.printOn = draft.printOn; }
    onSave(out);
  };
  return (
    <Drawer open title={field ? `Change ${String(field.label)}` : "Add a field"} onClose={onClose} width={720}
      footer={<><span className="su-drawer-problem">{draft.label ? problem : ""}</span><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" disabled={Boolean(problem)} onClick={save}>{field ? "Save field" : "Add field"}</Button></>}>
      <div className="su-stack">
        <Field label="Name *" hint={key && !field ? `Stored as ${key}.` : undefined}><input className="input" autoFocus value={String(draft.label ?? "")} onChange={(e) => set({ label: e.target.value })} placeholder="Medical certificate number" /></Field>
        <FieldGroup label="What it holds" wide hint={field ? "A field's kind can't change once it's made, so existing values stay valid." : undefined}>
          <div className="su-types" role="radiogroup" aria-label="What it holds">
            {FIELD_TYPE_INFO.map((t) => {
              const Icon = t.icon;
              return (
                <button key={t.type} type="button" role="radio" aria-checked={draft.type === t.type} disabled={Boolean(field) && draft.type !== t.type} className={draft.type === t.type ? "on" : ""} onClick={() => pickType(t.type)}>
                  <Icon size={16} aria-hidden /><strong>{t.label}</strong><small>{t.text}</small>
                </button>
              );
            })}
          </div>
        </FieldGroup>
        {takes("choices") && <Field label="Choices *" hint="One per line. People pick from these, in this order."><textarea className="input" rows={5} value={choiceText} onChange={(e) => setChoiceText(e.target.value)} placeholder={"Class A\nClass B\nClass C"} /></Field>}
        {takes("master") && (
          <Field label="Links to *" hint="People pick a record of this master.">
            <select className="input" value={String(draft.referenceMaster ?? "")} onChange={(e) => set({ referenceMaster: e.target.value })}>
              <option value="">Choose a master</option>
              {defs.map((d) => <option key={String(d.key)} value={String(d.key)}>{String(d.label)}</option>)}
            </select>
          </Field>
        )}
        {takes("range") && (
          <div className="grid-2">
            <Field label="Smallest allowed"><input className="input" type="number" value={String(draft.min ?? "")} onChange={(e) => set({ min: e.target.value })} /></Field>
            <Field label="Largest allowed"><input className="input" type="number" value={String(draft.max ?? "")} onChange={(e) => set({ max: e.target.value })} /></Field>
          </div>
        )}
        <Field label="Help text" hint="Shown under the field, for whoever fills it in."><input className="input" value={String(draft.helpText ?? "")} onChange={(e) => set({ helpText: e.target.value })} /></Field>
        <SettingRow title="Required" description="A record can't be saved without it. Records already there are only asked when next changed.">
          <Switch label="Required" checked={Boolean(draft.required)} onChange={(v) => set({ required: v })} />
        </SettingRow>
        {steps && (
          <div className="grid-2">
            <Field label="Asked when">
              <select className="input" value={String(draft.placement ?? steps[0]!.value)} onChange={(e) => set({ placement: e.target.value })}>{steps.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
            </Field>
            <Field label="Answered by">
              <select className="input" value={String(draft.askedOf ?? "office")} onChange={(e) => set({ askedOf: e.target.value })}><option value="office">The office</option><option value="driver">The driver</option></select>
            </Field>
          </div>
        )}
        <FieldGroup label="How it will look" wide>
          <div className="su-field-preview"><FieldPreview draft={draft} options={options} /></div>
        </FieldGroup>
      </div>
    </Drawer>
  );
}

function FieldPreview({ draft, options }: { draft: Rec; options: string[] }) {
  const title = `${String(draft.label || "Your field")}${draft.required ? " *" : ""}`;
  const hint = draft.helpText ? String(draft.helpText) : undefined;
  switch (draft.type) {
    case "boolean": return <SettingRow title={title} description={hint}><Switch label={title} checked={false} onChange={() => undefined} /></SettingRow>;
    case "long_text": return <Field label={title} hint={hint}><textarea className="input" rows={2} readOnly /></Field>;
    case "select": return <Field label={title} hint={hint}><select className="input"><option>Choose</option>{options.map((o) => <option key={o}>{o}</option>)}</select></Field>;
    case "reference": return <Field label={title} hint={hint}><select className="input"><option>Choose a record</option></select></Field>;
    case "multi_select": return <FieldGroup label={title} hint={hint}><div className="choice-chips">{(options.length ? options : ["First choice", "Second choice"]).map((o) => <button key={o} type="button">{o}</button>)}</div></FieldGroup>;
    case "date": return <Field label={title} hint={hint}><input className="input" type="date" readOnly /></Field>;
    case "number": return <Field label={title} hint={hint}><input className="input" type="number" readOnly /></Field>;
    default: return <Field label={title} hint={hint}><input className="input" readOnly placeholder={draft.type === "email" ? "name@example.com" : draft.type === "phone" ? "+260…" : ""} /></Field>;
  }
}

/* ---------- A master of the company's own ---------- */

function OwnMaster({ master, onEdit, onRemove }: { master: Rec; onEdit: () => void; onRemove: () => void }) {
  return (
    <div className="su-stack">
      <header className="su-master-head">
        <div><h2>{String(master.name)}</h2><p>{String(master.description ?? "A master made for this company. It gets its own list, form and import, like any other.")}</p></div>
        <span className="su-actions"><Button onClick={onEdit}>Change</Button><Button tone="quiet" onClick={onRemove}>Remove</Button></span>
      </header>
      <div className="cust-table-wrap">
        <table className="cust-table">
          <thead><tr><th>Field</th><th>Holds</th><th>Required</th></tr></thead>
          <tbody>{((master.fields ?? []) as Rec[]).map((f) => (
            <tr key={String(f.key)}><td>{String(f.label)}{f.key === master.titleField && <> <Status tone="mute">Names each record</Status></>}</td><td>{fieldTypeInfo(f.type).label}</td><td>{f.required ? "Yes" : "No"}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function MasterDrawer({ master, defs, taken, onClose, onSave }: { master?: Rec; defs: Rec[]; taken: string[]; onClose: () => void; onSave: (m: Rec) => void }) {
  const [name, setName] = useState(String(master?.name ?? ""));
  const [description, setDescription] = useState(String(master?.description ?? ""));
  const [fields, setFields] = useState<Rec[]>((master?.fields ?? [{ key: "name", label: "Name", type: "text", required: true }]) as Rec[]);
  const [titleField, setTitleField] = useState(String(master?.titleField ?? "name"));
  const [editing, setEditing] = useState<Rec | "new" | null>(null);
  const code = master ? String(master.code) : name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const clash = !master && taken.includes(code);
  const problem = !name.trim() ? "" : clash ? "A master with this name already exists." : !/^[a-z][a-z0-9-]{1,39}$/.test(code) ? "The name should start with a letter." : !fields.length ? "Add at least one field." : undefined;
  if (editing !== null) {
    return <FieldDrawer field={editing === "new" ? undefined : editing} defs={defs} taken={fields.filter((f) => f !== editing).map((f) => String(f.key))} onClose={() => setEditing(null)}
      onSave={(f) => { setFields(editing === "new" ? [...fields, f] : fields.map((x) => (x === editing ? f : x))); setEditing(null); }} />;
  }
  return (
    <Drawer open title={master ? `Change ${String(master.name)}` : "Add a master"} onClose={onClose} width={720}
      footer={<><span className="su-drawer-problem">{problem}</span><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!name.trim() || Boolean(problem)} onClick={() => onSave({ code, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), titleField: fields.some((f) => f.key === titleField) ? titleField : String(fields[0]!.key), fields })}>{master ? "Save master" : "Add master"}</Button></>}>
      <div className="su-stack">
        <p className="su-lead">A list of records this company keeps that the app doesn't already have: health cards, permits, weighbridges, anything.</p>
        <Field label="Name *"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Health cards" /></Field>
        <Field label="What it's for"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <SettingsSection title="Its fields">
          {fields.map((f) => (
            <SettingRow key={String(f.key)} title={<>{String(f.label)}{f.required ? <span className="status status-info area-early">Required</span> : null}</>} description={fieldTypeInfo(f.type).label}>
              <span className="su-actions">
                <Button size="sm" onClick={() => setEditing(f)}>Change</Button>
                <Button size="sm" tone="quiet" disabled={fields.length === 1} onClick={() => setFields(fields.filter((x) => x !== f))}>Remove</Button>
              </span>
            </SettingRow>
          ))}
          <div className="su-pad"><Button onClick={() => setEditing("new")}><Plus size={15} /> Add a field</Button></div>
        </SettingsSection>
        <Field label="Each record is known by" hint="The field shown wherever a record is listed or linked to.">
          <select className="input" value={titleField} onChange={(e) => setTitleField(e.target.value)}>{fields.map((f) => <option key={String(f.key)} value={String(f.key)}>{String(f.label)}</option>)}</select>
        </Field>
      </div>
    </Drawer>
  );
}
