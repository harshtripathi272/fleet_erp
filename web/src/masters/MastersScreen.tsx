import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, History, Link2, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { api, ApiError, request } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Drawer, Empty, Field, Status } from "../ui/kit";

/**
 * One screen for every master, built from GET /meta/masters: groups, fields, links, choices and the
 * caller's permissions. Masters, custom fields and custom masters added later appear without code changes.
 * A few masters add their own actions on top (pairings, numbering series, message templates, trucks' place).
 */

type Def = Rec;
type Schema = Rec;

const useMasters = () => useQuery({ queryKey: ["meta-masters"], queryFn: () => api<Def[]>("/meta/masters"), staleTime: 5 * 60_000 });
const OBJECT_ID = "^[0-9a-fA-F]{24}$";
const BASE_KEYS = new Set(["status", "validFrom", "validTo", "branchIds", "tags", "notes", "externalRefs", "attachments", "custom"]);

export function MastersScreen({ initialEntity }: { initialEntity?: string }) {
  const masters = useMasters();
  const customMasters = useQuery({ queryKey: ["custom-masters"], queryFn: () => api<Rec[]>("/custom-masters", { query: { limit: 100 } }) });
  const [selected, setSelected] = useState<string>(initialEntity && !initialEntity.includes(":") ? initialEntity : "vehicles");
  const [filter, setFilter] = useState("");
  const defs = (masters.data ?? []).filter((d) => d.key !== "custom-records" && d.permissions?.read);
  const groups = useMemo(() => {
    const out = new Map<string, Def[]>();
    for (const d of defs) if (!filter || `${d.label} ${d.description}`.toLowerCase().includes(filter.toLowerCase())) out.set(d.group, [...(out.get(d.group) ?? []), d]);
    return [...out.entries()];
  }, [defs, filter]);
  if (masters.isLoading) return <p className="muted">Loading the masters…</p>;
  if (masters.error) return <Empty title="Could not load the masters">{(masters.error as Error).message}</Empty>;
  const custom = selected.startsWith("custom:") ? customMasters.data?.find((c) => `custom:${c.id}` === selected) : undefined;
  const def = defs.find((d) => d.key === selected) ?? defs[0];
  return (
    <div className="masters">
      <aside className="masters-nav" aria-label="Masters">
        <label className="search">
          <Search size={15} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a master" />
        </label>
        {groups.map(([group, list]) => (
          <section key={group}>
            <h3>{group}</h3>
            {list.map((d) => (
              <button key={d.key} className={d.key === selected ? "on" : ""} onClick={() => setSelected(d.key)}>{d.label}</button>
            ))}
          </section>
        ))}
        {(customMasters.data ?? []).length > 0 && (
          <section>
            <h3>Your own records</h3>
            {customMasters.data!.filter((c) => c.status === "active").map((c) => (
              <button key={c.id} className={`custom:${c.id}` === selected ? "on" : ""} onClick={() => setSelected(`custom:${c.id}`)}>{c.name}</button>
            ))}
          </section>
        )}
      </aside>
      <section className="masters-main">
        {custom ? <CustomRecords master={custom} defs={defs} /> : def ? <Records key={def.key} def={def} defs={defs} /> : null}
      </section>
    </div>
  );
}

/* ---------- Lists ---------- */

function Records({ def, defs }: { def: Def; defs: Def[] }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<string>(def.defaultSort ?? def.sortFields[0]);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | "new" | null>(null);
  const rows = useQuery({
    queryKey: ["records", def.key, search, status, sort, page],
    queryFn: () => request<Rec[]>(`/${def.key}`, { query: { search: search.trim() || undefined, status: status || undefined, sort, page, limit: 25 } }),
  });
  const columns = listColumns(def);
  return (
    <div className="desk">
      <header className="masters-head">
        <div>
          <h2>{def.label}</h2>
          <p className="muted">{def.description}</p>
        </div>
        {def.permissions?.create && !def.managed?.create && (
          <Button tone="primary" onClick={() => setOpen("new")}><Plus size={16} /> New {def.singular.toLowerCase()}</Button>
        )}
      </header>
      <div className="desk-tools">
        <label className="search">
          <Search size={15} />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={`Search ${def.label.toLowerCase()}`} />
        </label>
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">
          <option value="">Active and inactive</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          {(def.sortFields as string[]).flatMap((f) => [f, `-${f}`]).map((s) => <option key={s} value={s}>{label(s.replace(/^-/, ""))}{s.startsWith("-") ? " (descending)" : ""}</option>)}
        </select>
      </div>
      {rows.error ? <Empty title="Could not load">{(rows.error as Error).message}</Empty> : (
        <div className="table-frame">
          <table className="table">
            <thead><tr>{columns.map((c) => <th key={c.path}>{c.label}</th>)}<th>Status</th></tr></thead>
            <tbody>
              {(rows.data?.data ?? []).map((r) => (
                <tr key={r.id} onClick={() => setOpen(r.id)} className="clickable">
                  {columns.map((c) => <td key={c.path}><Value value={get(r, c.path)} field={c.field} defs={defs} /></td>)}
                  <td><Status tone={r.status === "active" ? "ok" : r.status === "archived" ? "mute" : "wait"}>{r.status}</Status></td>
                </tr>
              ))}
              {rows.data && !rows.data.data.length && <tr><td colSpan={columns.length + 1} className="muted">Nothing here yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {rows.data?.meta && rows.data.meta.totalPages > 1 && (
        <div className="pager">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <span className="muted">Page {page} of {rows.data.meta.totalPages} · {rows.data.meta.total} records</span>
          <Button size="sm" disabled={!rows.data.meta.hasNextPage} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
      {open && <RecordDrawer def={def} defs={defs} id={open === "new" ? undefined : open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function listColumns(def: Def) {
  const fields = def.fields as Rec[];
  const top = (p: string) => !p.includes(".");
  const title = fields.find((f) => f.path === def.titleField);
  const code = def.titleField !== "code" ? fields.find((f) => f.path === "code") : undefined;
  const extra = fields.filter((f) => top(f.path) && f.group === "master" && !f.hidden && f.type !== "object" && !f.array && f.path !== def.titleField && f.path !== "code" && (f.required || f.ref || f.enum)).slice(0, 3);
  return [title, code, ...extra].filter(Boolean).map((f) => ({ path: f!.path as string, label: label(f!.path), field: f! }));
}

/* ---------- One record ---------- */

function RecordDrawer({ def, defs, id, onClose }: { def: Def; defs: Def[]; id?: string; onClose: () => void }) {
  const client = useQueryClient();
  const { refreshReference, toast } = useApp();
  const record = useQuery({ queryKey: ["record", def.key, id], queryFn: () => api<Rec>(`/${def.key}/${id}`), enabled: Boolean(id) });
  const [tab, setTab] = useState<"details" | "usage" | "history">("details");
  const [draft, setDraft] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const canSensitive = Boolean(def.permissions?.sensitive);
  const writable = !id ? def.permissions?.create && !def.managed?.create : def.permissions?.update && !def.managed?.update && record.data?.status !== "archived";
  const base = id ? record.data : undefined;
  const value = draft ?? (base ? pick(base, def.createSchema) : {});
  const done = async (message: string) => {
    toast(message);
    await client.invalidateQueries({ queryKey: ["records", def.key] });
    await client.invalidateQueries({ queryKey: ["record", def.key, id] });
    refreshReference();
  };
  const act = async (fn: () => Promise<unknown>, message: string, close = false) => {
    setBusy(true);
    try {
      await fn();
      await done(message);
      setDraft(null);
      if (close) onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };
  const save = () => act(async () => {
    const body = withoutHidden(clean(value), def, canSensitive);
    if (!id) return api(`/${def.key}`, { method: "POST", body });
    const before = withoutHidden(clean(pick(base!, def.createSchema)), def, canSensitive);
    const changes: Rec = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(body)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(body[key])) changes[key] = body[key] === undefined ? null : body[key];
    }
    if (!Object.keys(changes).length) return;
    return api(`/${def.key}/${id}`, { method: "PATCH", body: { ...changes, version: base!.version } });
  }, id ? `${def.singular} saved` : `${def.singular} created`, !id);
  const title = id ? String(base?.[def.titleField] ?? def.singular) : `New ${def.singular.toLowerCase()}`;
  return (
    <Drawer
      open
      title={title}
      onClose={onClose}
      width={640}
      footer={
        <>
          {id && def.permissions?.archive && !def.managed?.archive && base && (base.status === "archived"
            ? <Button tone="quiet" disabled={busy} onClick={() => act(() => api(`/${def.key}/${id}/restore`, { method: "POST" }), "Restored")}><RotateCcw size={15} /> Restore</Button>
            : <Button tone="quiet" disabled={busy} onClick={() => act(() => api(`/${def.key}/${id}/archive`, { method: "POST", body: {} }), "Archived")}><Archive size={15} /> Archive</Button>)}
          {id && def.permissions?.delete && !def.managed?.delete && (
            <Button tone="danger" disabled={busy} onClick={() => confirm(`Delete this ${def.singular.toLowerCase()}? Only records nothing uses can be deleted.`) && act(() => api(`/${def.key}/${id}`, { method: "DELETE" }), "Deleted", true)}><Trash2 size={15} /> Delete</Button>
          )}
          <span className="spacer" />
          {writable && <Button tone="primary" busy={busy} onClick={save}>{id ? "Save" : "Create"}</Button>}
        </>
      }
    >
      {id && (
        <div className="seg-tabs" role="tablist">
          {(["details", "usage", "history"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{label(t)}</button>)}
        </div>
      )}
      {id && record.isLoading && <p className="muted">Loading…</p>}
      {tab === "details" && (!id || base) && (
        <>
          <Extras def={def} id={id} record={base} />
          <SchemaForm schema={def.createSchema} def={def} defs={defs} value={value} onChange={setDraft} readOnly={!writable} canSensitive={canSensitive} />
        </>
      )}
      {tab === "usage" && id && <Usage def={def} id={id} />}
      {tab === "history" && id && <HistoryList def={def} id={id} />}
    </Drawer>
  );
}

/** Actions some masters add beyond create, edit, archive and delete. */
function Extras({ def, id, record }: { def: Def; id?: string; record?: Rec }) {
  const { data, me, toast, refreshReference } = useApp();
  const [preview, setPreview] = useState<string>("");
  if (!id || !record) return null;
  if (def.key === "pairings" && record.open !== false && !record.to)
    return <div className="extra"><Button size="sm" onClick={async () => { try { await api(`/pairings/${id}/end`, { method: "POST", body: { reason: "Ended from Masters" } }); toast("Pairing ended"); refreshReference(); } catch (e) { toast((e as Error).message, "error"); } }}>End this pairing</Button></div>;
  if (def.key === "numbering-series")
    return <div className="extra"><Button size="sm" onClick={async () => setPreview(`Next: ${(await api<Rec>(`/numbering-series/${id}/preview`)).next}`)}>Preview the next number</Button> <span className="mono">{preview}</span></div>;
  if (def.key === "message-templates")
    return <div className="extra"><Button size="sm" onClick={async () => { try { setPreview(JSON.stringify(await api(`/message-templates/${id}/preview`, { method: "POST", body: {} }))); } catch (e) { setPreview((e as Error).message); } }}>Preview with sample values</Button><pre className="mono preview">{preview}</pre></div>;
  if (def.key === "vehicles" && can(me, "vehicle-states", "update")) {
    const truck = data.trucks.find((t) => t.id === id);
    return <TruckNow truckId={id} placeId={truck?.placeId ?? ""} fuelL={truck?.fuelL ?? 0} tankL={truck?.tankL ?? 0} places={data.places} onSave={(placeId, fuelL) => void saveState(id, placeId, fuelL, toast)} />;
  }
  return null;
}

async function saveState(vehicleId: string, placeId: string, fuelL: number, toast: (t: string, tone?: "ok" | "error") => void) {
  try {
    await api(`/vehicle-states/${vehicleId}`, { method: "PUT", body: { ...(placeId ? { placeId } : {}), fuelL } });
    toast("Truck updated");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

/** Where a truck is and how much fuel it has: kept with the trips, corrected here when the truck is off the road. */
function TruckNow({ truckId, placeId, fuelL, tankL, places, onSave }: { truckId: string; placeId: string; fuelL: number; tankL: number; places: { id: string; name: string }[]; onSave: (placeId: string, fuelL: number) => void }) {
  const [place, setPlace] = useState(placeId);
  const [fuel, setFuel] = useState(String(fuelL));
  return (
    <fieldset className="form-group extra" key={truckId}>
      <legend>Now</legend>
      <div className="grid-2">
        <Field label="Where it is"><select value={place} onChange={(e) => setPlace(e.target.value)}><option value="">—</option>{places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label={`Fuel in the tank (L)${tankL ? ` of ${tankL}` : ""}`}><input type="number" min={0} value={fuel} onChange={(e) => setFuel(e.target.value)} /></Field>
      </div>
      <Button size="sm" onClick={() => onSave(place, Number(fuel) || 0)}>Save place and fuel</Button>
    </fieldset>
  );
}

function Usage({ def, id }: { def: Def; id: string }) {
  const usage = useQuery({ queryKey: ["usage", def.key, id], queryFn: () => api<Rec>(`/${def.key}/${id}/usage`) });
  if (!usage.data) return <p className="muted">Loading…</p>;
  if (!usage.data.total) return <p className="muted"><Link2 size={14} /> Nothing uses this {def.singular.toLowerCase()}; it can be deleted.</p>;
  return <ul className="plain">{(usage.data.usage as Rec[]).map((u) => <li key={`${u.master}${u.path}`}>{u.count} × {u.label} ({label(u.path)})</li>)}</ul>;
}

function HistoryList({ def, id }: { def: Def; id: string }) {
  const history = useQuery({ queryKey: ["history", def.key, id], queryFn: () => api<Rec[]>(`/${def.key}/${id}/history`, { query: { limit: 50 } }) });
  if (!history.data) return <p className="muted">Loading…</p>;
  return (
    <ol className="history">
      {history.data.map((h) => (
        <li key={h.id}>
          <strong><History size={13} /> {label(h.action)}</strong> <span className="muted">{new Date(h.at).toLocaleString("en-GB")}</span>
          {h.summary && <div>{h.summary}</div>}
          {(h.changes as Rec[]).slice(0, 8).map((c) => <div key={c.path} className="mono small">{c.path}: {short(c.from)} → {short(c.to)}</div>)}
        </li>
      ))}
    </ol>
  );
}

/* ---------- Custom masters ---------- */

function CustomRecords({ master, defs }: { master: Rec; defs: Def[] }) {
  const client = useQueryClient();
  const { toast } = useApp();
  const rows = useQuery({ queryKey: ["custom-records", master.id], queryFn: () => api<Rec[]>(`/custom-masters/${master.id}/records`, { query: { limit: 100, status: "all" } }) });
  const [open, setOpen] = useState<Rec | "new" | null>(null);
  const [draft, setDraft] = useState<Rec>({});
  const fields = (master.fields ?? []) as Rec[];
  const save = async () => {
    try {
      if (open === "new") await api(`/custom-masters/${master.id}/records`, { method: "POST", body: { data: clean(draft) } });
      else if (open) await api(`/custom-masters/${master.id}/records/${open.id}`, { method: "PATCH", body: { data: clean(draft), version: open.version } });
      toast("Saved");
      setOpen(null);
      await client.invalidateQueries({ queryKey: ["custom-records", master.id] });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="desk">
      <header className="masters-head">
        <div><h2>{master.name}</h2><p className="muted">{master.description}</p></div>
        <Button tone="primary" onClick={() => { setDraft({}); setOpen("new"); }}><Plus size={16} /> New record</Button>
      </header>
      <div className="table-frame">
        <table className="table">
          <thead><tr>{fields.slice(0, 4).map((f) => <th key={f.key}>{f.label}</th>)}<th>Status</th></tr></thead>
          <tbody>
            {(rows.data ?? []).map((r) => (
              <tr key={r.id} className="clickable" onClick={() => { setDraft(r.data ?? {}); setOpen(r); }}>
                {fields.slice(0, 4).map((f) => <td key={f.key}><Value value={r.data?.[f.key]} field={{ ref: f.referenceMaster, type: f.type }} defs={defs} /></td>)}
                <td><Status tone={r.status === "active" ? "ok" : "mute"}>{r.status}</Status></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <Drawer open title={open === "new" ? `New ${master.name.toLowerCase()} record` : master.name} onClose={() => setOpen(null)} footer={<><span className="spacer" /><Button tone="primary" onClick={save}>Save</Button></>}>
          <div className="grid-2">
            {fields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`}>
                {f.type === "reference"
                  ? <RefSelect target={f.referenceMaster} defs={defs} value={draft[f.key] ?? ""} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
                  : <ScalarInput type={f.type} value={draft[f.key]} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />}
              </Field>
            ))}
          </div>
        </Drawer>
      )}
    </div>
  );
}

/* ---------- Forms from the API's JSON schema ---------- */

const refOf = (def: Def, path: string) => (def.fields as Rec[]).find((f) => f.path === path)?.ref as string | undefined;
const fieldOf = (def: Def, path: string) => (def.fields as Rec[]).find((f) => f.path === path);
const isSensitive = (def: Def, path: string) => (def.sensitive as string[]).some((s) => s === path || s.startsWith(`${path}.`));

/** Drops `null`/`anyOf` wrappers zod adds for optional and nullable fields. */
function unwrap(schema: Schema): Schema {
  if (schema?.anyOf) {
    const real = (schema.anyOf as Schema[]).filter((s) => s.type !== "null");
    if (real.length === 1) return unwrap(real[0]!);
    if (real.every((s) => s.format === "date" || s.format === "date-time")) return { type: "string", format: "date" };
    return real[0] ?? schema;
  }
  return schema ?? {};
}

function SchemaForm({ schema, def, defs, value, onChange, readOnly, canSensitive, path = "" }: { schema: Schema; def: Def; defs: Def[]; value: Rec; onChange: (v: Rec) => void; readOnly?: boolean; canSensitive: boolean; path?: string }) {
  const props = Object.entries((schema.properties ?? {}) as Record<string, Schema>);
  const required = new Set((schema.required ?? []) as string[]);
  const main = props.filter(([k]) => path || !BASE_KEYS.has(k));
  const more = path ? [] : props.filter(([k]) => BASE_KEYS.has(k) && !["externalRefs", "attachments", "custom"].includes(k));
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  const render = ([key, raw]: [string, Schema]) => {
    const full = path ? `${path}.${key}` : key;
    const hidden = isSensitive(def, full) && !canSensitive;
    return (
      <FieldInput key={full} name={key} path={full} schema={unwrap(raw)} required={required.has(key)} def={def} defs={defs}
        value={value[key]} onChange={(v) => set(key, v)} readOnly={readOnly || hidden} canSensitive={canSensitive} />
    );
  };
  return (
    <div className="schema-form">
      <div className="grid-2">{main.map(render)}</div>
      {!path && (def.customFields as Rec[]).length > 0 && (
        <fieldset className="form-group">
          <legend>Company fields</legend>
          <div className="grid-2">
            {(def.customFields as Rec[]).map((f) => (
              <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`}>
                <ScalarInput type={f.type} value={(value.custom ?? {})[f.key]} disabled={readOnly} onChange={(v) => set("custom", { ...(value.custom ?? {}), [f.key]: v })} />
              </Field>
            ))}
          </div>
        </fieldset>
      )}
      {more.length > 0 && (
        <details className="form-group">
          <summary>Status, validity, branches and notes</summary>
          <div className="grid-2">{more.map(render)}</div>
        </details>
      )}
    </div>
  );
}

function FieldInput({ name, path, schema, required, def, defs, value, onChange, readOnly, canSensitive }: { name: string; path: string; schema: Schema; required: boolean; def: Def; defs: Def[]; value: unknown; onChange: (v: unknown) => void; readOnly?: boolean; canSensitive: boolean }) {
  const title = `${label(name)}${required ? " *" : ""}`;
  const ref = refOf(def, path);
  const info = fieldOf(def, path);
  if (schema.type === "object" && schema.properties?.amountMinor && schema.properties?.currencyId)
    return <Field label={title}><MoneyInput value={value as Rec | undefined} onChange={onChange} disabled={readOnly} /></Field>;
  if (schema.type === "object")
    return (
      <fieldset className="form-group field-wide">
        <legend>{title}</legend>
        <SchemaForm schema={schema} def={def} defs={defs} value={(value as Rec) ?? {}} onChange={onChange} readOnly={readOnly} canSensitive={canSensitive} path={path} />
      </fieldset>
    );
  if (schema.type === "array") {
    const item = unwrap(schema.items ?? {});
    const list = (value as unknown[] | undefined) ?? [];
    if (item.type === "object")
      return (
        <fieldset className="form-group field-wide">
          <legend>{title}</legend>
          {list.map((row, i) => (
            <div key={i} className="array-row">
              <SchemaForm schema={item} def={def} defs={defs} value={(row as Rec) ?? {}} onChange={(v) => onChange(list.map((r, j) => (j === i ? v : r)))} readOnly={readOnly} canSensitive={canSensitive} path={path} />
              {!readOnly && <Button size="sm" tone="quiet" onClick={() => onChange(list.filter((_, j) => j !== i))}>Remove</Button>}
            </div>
          ))}
          {!readOnly && <Button size="sm" onClick={() => onChange([...list, {}])}><Plus size={14} /> Add</Button>}
        </fieldset>
      );
    if (ref || item.pattern === OBJECT_ID)
      return <Field label={title} wide><RefMulti target={ref ?? ""} defs={defs} value={list as string[]} onChange={onChange} disabled={readOnly} /></Field>;
    if (item.enum)
      return (
        <Field label={title} wide>
          <div className="checks">
            {(item.enum as string[]).map((o) => (
              <label key={o} className="check-box"><input type="checkbox" disabled={readOnly} checked={list.includes(o)} onChange={(e) => onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o))} /> {label(o)}</label>
            ))}
          </div>
        </Field>
      );
    return <Field label={title} hint="Separate with commas" wide><input disabled={readOnly} value={list.join(", ")} onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} /></Field>;
  }
  if (ref || schema.pattern === OBJECT_ID) return <Field label={title}><RefSelect target={ref ?? ""} defs={defs} value={(value as string) ?? ""} onChange={onChange} disabled={readOnly} /></Field>;
  if (schema.enum) return <Field label={title}><select disabled={readOnly} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)}><option value="">—</option>{(schema.enum as string[]).map((o) => <option key={o} value={o}>{label(o)}</option>)}</select></Field>;
  const type = schema.type === "boolean" ? "boolean" : schema.type === "number" || schema.type === "integer" ? "number" : schema.format === "date" || schema.format === "date-time" || info?.type === "date" ? "date" : (schema.maxLength ?? 0) > 300 ? "longtext" : "text";
  return <Field label={title} wide={type === "longtext"}><ScalarInput type={type} value={value} onChange={onChange} disabled={readOnly} /></Field>;
}

function ScalarInput({ type, value, onChange, disabled }: { type: string; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  if (type === "boolean") return <input type="checkbox" disabled={disabled} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  if (type === "number") return <input type="number" disabled={disabled} value={value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
  if (type === "date") return <input type="date" disabled={disabled} value={value ? String(value).slice(0, 10) : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
  if (type === "longtext") return <textarea disabled={disabled} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} />;
  return <input disabled={disabled} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />;
}

function MoneyInput({ value, onChange, disabled }: { value?: Rec; onChange: (v: unknown) => void; disabled?: boolean }) {
  const { data } = useApp();
  const currency = data.currencies?.find((c) => c.id === value?.currencyId) ?? data.baseCurrency;
  const units = 10 ** (currency?.minorUnits ?? 2);
  return (
    <span className="money-input">
      <input type="number" step="any" disabled={disabled} value={value?.amountMinor === undefined ? "" : String(value.amountMinor / units)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : { amountMinor: Math.round(Number(e.target.value) * units), currencyId: value?.currencyId ?? currency?.id })} />
      <select disabled={disabled} value={value?.currencyId ?? currency?.id ?? ""} onChange={(e) => onChange({ amountMinor: value?.amountMinor ?? 0, currencyId: e.target.value })}>
        {(data.currencies ?? []).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
      </select>
    </span>
  );
}

/** Active records of the linked master, by name; loads the first 100 and searches beyond them. */
function useOptions(target: string, defs: Def[], search = "") {
  const def = defs.find((d) => d.key === target);
  return useQuery({
    queryKey: ["options", target, search],
    queryFn: async () => (await api<Rec[]>(`/${target}`, { query: { status: "active", limit: 100, search: search || undefined } })).map((r) => ({ id: String(r.id), name: titleOf(r, def) })),
    enabled: Boolean(target && def?.permissions?.read),
    staleTime: 30_000,
  });
}

function RefSelect({ target, defs, value, onChange, disabled }: { target: string; defs: Def[]; value: string; onChange: (v: unknown) => void; disabled?: boolean }) {
  const options = useOptions(target, defs);
  const list = options.data ?? [];
  return (
    <select disabled={disabled} value={value} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">—</option>
      {value && !list.some((o) => o.id === value) && <option value={value}><RefName target={target} id={value} defs={defs} /></option>}
      {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

function RefMulti({ target, defs, value, onChange, disabled }: { target: string; defs: Def[]; value: string[]; onChange: (v: unknown) => void; disabled?: boolean }) {
  const options = useOptions(target, defs);
  return (
    <div className="chips">
      {value.map((id) => (
        <span key={id} className="chip"><RefName target={target} id={id} defs={defs} />{!disabled && <button aria-label="Remove" onClick={() => onChange(value.filter((v) => v !== id))}>×</button>}</span>
      ))}
      {!disabled && (
        <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">Add…</option>
          {(options.data ?? []).filter((o) => !value.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}
    </div>
  );
}

function RefName({ target, id, defs }: { target: string; id: string; defs: Def[] }) {
  const def = defs.find((d) => d.key === target);
  const rec = useQuery({ queryKey: ["ref", target, id], queryFn: () => api<Rec>(`/${target}/${id}`), enabled: Boolean(def?.permissions?.read), staleTime: 5 * 60_000, retry: false });
  return <>{rec.data ? titleOf(rec.data, def) : `…${id.slice(-6)}`}</>;
}

function Value({ value, field, defs }: { value: unknown; field: Rec; defs: Def[] }): ReactNode {
  if (value === undefined || value === null || value === "") return <span className="muted">—</span>;
  if (field.ref && typeof value === "string") return <RefName target={field.ref} id={value} defs={defs} />;
  if (field.type === "date") return String(value).slice(0, 10);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return short(value);
  return field.enum ? label(String(value)) : String(value);
}

/* ---------- Helpers ---------- */

const titleOf = (r: Rec, def?: Def) => String(r[def?.titleField ?? "name"] ?? r.name ?? r.code ?? r.registrationNumber ?? r.id);
const get = (r: Rec, path: string) => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Rec)[k] : undefined), r);
const short = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 60 ? `${s.slice(0, 57)}…` : s ?? "—"; };
export const label = (key: string) => key.replace(/Id(s)?$/, "$1").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/\bkm\b/i, "km").replace(/ Minor$/, "");

/** The fields a form may send: those the create schema accepts. */
function pick(record: Rec, schema: Schema): Rec {
  const out: Rec = {};
  for (const key of Object.keys(schema.properties ?? {})) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

/** Drops empty values a form leaves behind. */
function clean(value: unknown): Rec {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== undefined);
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Rec).map(([k, x]) => [k, walk(x)] as const).filter(([, x]) => x !== undefined && x !== "");
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    return v === "" ? undefined : v;
  };
  return (walk(value) as Rec) ?? {};
}

/** A role that sees masked values never sends them back. */
function withoutHidden(value: Rec, def: Def, canSensitive: boolean): Rec {
  if (canSensitive) return value;
  const out = structuredClone(value);
  for (const path of def.sensitive as string[]) {
    const keys = path.split(".");
    const parentPath = keys.slice(0, -1);
    const parents = parentPath.reduce<unknown[]>((list, k) => list.flatMap((p) => (p && typeof p === "object" ? [].concat((p as Rec)[k] ?? []) : [])), [out]);
    for (const p of parents) if (p && typeof p === "object") delete (p as Rec)[keys.at(-1)!];
  }
  return out;
}
