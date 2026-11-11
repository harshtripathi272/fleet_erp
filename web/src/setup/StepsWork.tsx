import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { CARGO_KINDS, DUE_SOON, NUMBERS, OUTCOMES, PERIODS } from "../masters/CompanyPanel";
import { DesksEditor, type DeskSetup } from "../masters/DesksEditor";
import { PermissionMatrix } from "../masters/PermissionMatrix";
import { Button, ChoiceChips, Drawer, Field, FieldGroup, Segmented, SettingRow, SettingsSection, Switch, UnitInput } from "../ui/kit";
import { useSetUp, withValue } from "./context";

/* ---------- How you work ---------- */

const TERM_NOTE: Record<string, string> = {
  trip: "One truck's journey from loading to delivery.",
  nomination: "A customer's request to move a load, before it becomes a trip.",
  driver: "The person driving the truck.",
  truck: "The vehicle that pulls.",
  trailer: "What the truck pulls.",
  customer: "Who the load is moved for.",
  advance: "Cash given to the driver for a trip.",
  fuelRequest: "Fuel asked for on the way.",
  expense: "Money spent on a trip.",
  settlement: "Squaring up with the driver after a trip.",
  statement: "The driver's account on paper.",
  tripSheet: "The paper that travels with the truck.",
  consignment: "One customer's goods on a trip, with its own papers and proof of delivery.",
  consignmentNote: "The note that goes with a consignment (an LR in India).",
};

interface Workspace {
  terms: Record<string, { singular: string; plural: string }>;
  stages: { key: string; defaultName: string; optional: boolean }[];
  views: { key: string; name: string; on: boolean; area?: string }[];
  icons: string[];
  defaultDesks: DeskSetup[];
}

export function WorkStep() {
  const { file, set, replace } = useSetUp();
  const ws = useQuery({ queryKey: ["workspace"], queryFn: () => api<Workspace>("/meta/workspace") });
  const roles = useQuery({ queryKey: ["workspace-roles"], queryFn: () => api<Rec[]>("/roles", { query: { limit: 100 } }) });
  const words = (file.workspace?.vocabulary ?? {}) as Record<string, { singular?: string; plural?: string }>;
  const stages = (file.workspace?.stages ?? {}) as Record<string, { name?: string; off?: boolean }>;
  const ops = (file.operations ?? {}) as Rec;
  const maintenance = (file.maintenance ?? {}) as Rec;
  const areasOn = (file.areas as string[] | undefined);
  const has = (area: string) => !areasOn || areasOn.includes(area);

  /** A word counts only when both forms are there; half-typed ones aren't sent. */
  const setWord = (term: string, form: "singular" | "plural", value: string) => {
    const defaults = ws.data!.terms[term]!;
    const next = { ...(words[term] ?? {}), [form]: value };
    const filled = { singular: next.singular ?? "", plural: next.plural ?? "" };
    if (!filled.singular && !filled.plural) { replace(withValue(file, `workspace.vocabulary.${term}`, undefined)); return; }
    // The other form follows the one typed until it's changed, so renaming takes one box, not two.
    if (form === "singular" && (!words[term]?.plural || words[term]?.plural === `${words[term]?.singular}s`)) filled.plural = value ? `${value}s` : "";
    replace(withValue(file, `workspace.vocabulary.${term}`, { singular: filled.singular || defaults.singular, plural: filled.plural || defaults.plural }));
  };
  const setStage = (key: string, change: { name?: string; off?: boolean }) => {
    const next = { ...(stages[key] ?? {}), ...change };
    if (!next.name) delete next.name;
    if (!next.off) delete next.off;
    replace(withValue(file, `workspace.stages.${key}`, Object.keys(next).length ? next : undefined));
  };
  if (ws.isLoading || !ws.data) return <p className="muted">Loading…</p>;

  return (
    <div className="su-stack">
      <SettingsSection title="The company's words" description="What screens, documents and messages call things. A company that says job for trip, or float for cash advance, types it here. Leave a row empty to keep the usual word.">
        <div className="cust-table-wrap su-table">
          <table className="cust-table">
            <thead><tr><th>The usual word</th><th>One</th><th>Many</th></tr></thead>
            <tbody>
              {Object.entries(ws.data.terms).map(([key, d]) => (
                <tr key={key}>
                  <td><strong>{d.singular}</strong><span className="term-note">{TERM_NOTE[key] ?? ""}</span></td>
                  <td><input className="input" aria-label={`${d.singular}, one`} placeholder={d.singular} maxLength={40} value={words[key]?.singular ?? ""} onChange={(e) => setWord(key, "singular", e.target.value)} /></td>
                  <td><input className="input" aria-label={`${d.singular}, many`} placeholder={d.plural} maxLength={40} value={words[key]?.plural ?? ""} onChange={(e) => setWord(key, "plural", e.target.value)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>

      <SettingsSection title="Trip stages" description="The stages every trip goes through on the desks, in order. Rename any of them. Funding and settlement can be switched off for a company that doesn't advance cash or settle drivers.">
        <div className="cust-table-wrap su-table">
          <table className="cust-table">
            <thead><tr><th>Stage</th><th>Called</th><th>Used</th></tr></thead>
            <tbody>
              {ws.data.stages.map((s) => (
                <tr key={s.key}>
                  <td><strong>{s.defaultName}</strong></td>
                  <td><input className="input" aria-label={`Name of the ${s.defaultName} stage`} placeholder={s.defaultName} maxLength={40} value={stages[s.key]?.name ?? ""} onChange={(e) => setStage(s.key, { name: e.target.value })} /></td>
                  <td>{s.optional
                    ? <Switch label={`Use the ${s.defaultName} stage`} checked={!stages[s.key]?.off} onChange={(on) => setStage(s.key, { off: !on })} />
                    : <span className="setting-fixed">Always</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>

      <SettingsSection title="Trips" description="Rules the desks follow. Masters such as fuel norms and routes take precedence where they set a value.">
        <SettingRow title="Start a trip from the truck" description="Picking a truck fills in its trailer and usual driver. Off: each is chosen on its own.">
          <Switch label="Start a trip from the truck" checked={ops.tripStartsFromTruck ?? true} onChange={(v) => set("operations.tripStartsFromTruck", v)} />
        </SettingRow>
        <SettingRow title="Allow stopping a trip before loading" description="Operations can stop a trip that left but never loaded, and free the truck for other work.">
          <Switch label="Allow stopping a trip before loading" checked={ops.stopBeforeLoading ?? true} onChange={(v) => set("operations.stopBeforeLoading", v)} />
        </SettingRow>
        <SettingRow title="Kinds of cargo the company carries" description="Liquids are corrected to 20 °C, weighed goods take a weighbridge ticket, and counted goods take a count.">
          <ChoiceChips label="Kinds of cargo" options={CARGO_KINDS} value={(ops.cargoKinds as string[]) ?? CARGO_KINDS.map((c) => c.value)} onChange={(v) => v.length && set("operations.cargoKinds", v)} />
        </SettingRow>
        <SettingRow title="A loaded trip that can't deliver may" description="What the office can do with the load after an accident or a refusal.">
          <ChoiceChips label="A loaded trip that can't deliver may" options={OUTCOMES} value={(ops.loadedTripOutcomes as string[]) ?? OUTCOMES.map((c) => c.value)} onChange={(v) => set("operations.loadedTripOutcomes", v)} />
        </SettingRow>
        <SettingRow title="A write-off needs the owner's approval" description="The trip stays open until the owner decides. Off: it takes effect when the person deciding confirms it.">
          <Switch label="A write-off needs the owner's approval" checked={ops.writeOffNeedsOwner ?? true} onChange={(v) => set("operations.writeOffNeedsOwner", v)} />
        </SettingRow>
        {NUMBERS.map((n) => (
          <SettingRow key={n.key} title={n.title} description={n.description}>
            <UnitInput label={n.title} unit={n.unit} step={n.step} value={(ops[n.key] as number | undefined) ?? n.fallback} onChange={(v) => set(`operations.${n.key}`, v === "" ? undefined : Number(v))} />
          </SettingRow>
        ))}
      </SettingsSection>

      {has("finance") && (
        <SettingsSection title="Money">
          <SettingRow title="How often drivers are settled" description="Any time lets the office settle a driver whenever a trip closes.">
            <Segmented choice label="How often drivers are settled" value={String(ops.settlementPeriod ?? "any")} options={PERIODS} onChange={(v) => set("operations.settlementPeriod", v)} />
          </SettingRow>
        </SettingsSection>
      )}

      {has("maintenance") && (
        <SettingsSection title="Maintenance">
          <SettingRow title="A work order stops the truck" description="A truck in the workshop can't be picked for a trip until its work order is done.">
            <Switch label="A work order stops the truck" checked={maintenance.workOrderStopsTruck ?? true} onChange={(v) => set("maintenance.workOrderStopsTruck", v)} />
          </SettingRow>
          {DUE_SOON.map((n) => (
            <SettingRow key={n.key} title={n.title} description={n.description}>
              <UnitInput label={n.title} unit={n.unit} step={n.step} value={(maintenance[n.key] as number | undefined) ?? n.fallback} onChange={(v) => set(`maintenance.${n.key}`, v === "" ? undefined : Number(v))} />
            </SettingRow>
          ))}
        </SettingsSection>
      )}

      <DesksEditor
        desks={(file.workspace?.desks as DeskSetup[] | undefined) ?? ws.data.defaultDesks}
        onChange={(desks) => replace(withValue(file, "workspace.desks", desks))}
        views={ws.data.views.map((v) => (v.area && Array.isArray(file.areas) ? { ...v, on: (file.areas as string[]).includes(v.area) } : v))}
        icons={ws.data.icons}
        defaultDesks={ws.data.defaultDesks}
        savedKeys={ws.data.defaultDesks.map((d) => d.key)}
        viewName={(key) => (key === "trips" ? words.trip?.plural || ws.data!.terms.trip?.plural || "Trips" : key === "nominations" ? words.nomination?.plural || ws.data!.terms.nomination?.plural || "Nominations" : ws.data!.views.find((v) => v.key === key)?.name ?? key)}
        roleOptions={[...(roles.data ?? []).map((r) => ({ value: String(r.key), label: String(r.name ?? r.key) })), ...((file.roles ?? []) as Rec[]).map((r) => ({ value: String(r.key), label: String(r.name) }))]}
      />
    </div>
  );
}

/* ---------- People and roles ---------- */

const emailLike = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function PeopleStep() {
  const { file, set, replace, err, me } = useSetUp();
  const roles = useQuery({ queryKey: ["roles", "all"], queryFn: () => api<Rec[]>("/roles", { query: { limit: 100 } }) });
  const masters = useQuery({ queryKey: ["meta-masters"], queryFn: () => api<Rec[]>("/meta/masters"), staleTime: 60_000 });
  const staff = (file.staff ?? []) as Rec[];
  const custom = (file.roles ?? []) as Rec[];
  const [pasting, setPasting] = useState(false);
  const [editingRole, setEditingRole] = useState<number | "new" | null>(null);

  const options = useMemo(() => [
    ...(roles.data ?? []).filter((r) => r.key !== "owner" && r.status === "active" && !custom.some((c) => c.key === r.key)).map((r) => ({ value: String(r.key), label: String(r.name) })),
    ...custom.map((r) => ({ value: String(r.key), label: String(r.name) })),
  ], [roles.data, custom]);
  const setPerson = (i: number, change: Rec) => set("staff", staff.map((p, j) => (j === i ? { ...p, ...change } : p)));

  return (
    <div className="su-stack">
      <SettingsSection title="The owner" description="Full access to everything. On a new copy they get an e-mail to choose a password. You can add others, or be the owner yourself.">
        <div className="su-pad grid-2">
          <Field label="Name"><input className="input" value={String(file.owner?.name ?? "")} onChange={(e) => set("owner.name", e.target.value)} /></Field>
          <Field label="E-mail *" hint={err("owner.email") ?? (file.owner?.email === me.email ? "That's you, signed in now." : undefined)}><input className="input" type="email" value={String(file.owner?.email ?? "")} onChange={(e) => set("owner.email", e.target.value.trim().toLowerCase())} /></Field>
        </div>
      </SettingsSection>

      <SettingsSection title="Staff" description={err("staff") ?? "Everyone else who works at a desk. Each gets an e-mail to choose a password, once. Drivers are added under Data, as records, not here."}>
        {staff.length > 0 && (
          <div className="cust-table-wrap su-table">
            <table className="cust-table su-people">
              <thead><tr><th>Name</th><th>E-mail</th><th>Phone</th><th>Roles</th><th aria-label="Remove" /></tr></thead>
              <tbody>
                {staff.map((p, i) => {
                  const bad = err(`staff.${i}.email`) || (p.email && !emailLike.test(String(p.email)));
                  return (
                    <tr key={i}>
                      <td><input className="input" aria-label={`Name of person ${i + 1}`} value={String(p.name ?? "")} onChange={(e) => setPerson(i, { name: e.target.value })} /></td>
                      <td><input className={`input ${bad ? "su-bad" : ""}`} aria-label={`E-mail of person ${i + 1}`} type="email" value={String(p.email ?? "")} onChange={(e) => setPerson(i, { email: e.target.value.trim().toLowerCase() })} /></td>
                      <td><input className="input" aria-label={`Phone of person ${i + 1}`} value={String(p.phone ?? "")} placeholder="+260…" onChange={(e) => setPerson(i, { phone: e.target.value.replace(/[\s()-]/g, "") || undefined })} /></td>
                      <td><ChoiceChips label={`Roles of person ${i + 1}`} options={options} value={(p.roles ?? []) as string[]} onChange={(next) => setPerson(i, { roles: next })} /></td>
                      <td><Button size="sm" tone="quiet" onClick={() => set("staff", staff.filter((_, j) => j !== i))}>Remove</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="su-pad su-actions">
          <Button onClick={() => set("staff", [...staff, { name: "", email: "", roles: [] }])}><Plus size={15} /> Add someone</Button>
          <Button tone="quiet" onClick={() => setPasting(true)}>Paste a list</Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Roles" description="Owner, Administrator, Operations, Finance and Viewer come with every copy. Add one when someone's job doesn't fit them, like a workshop manager.">
        {(roles.data ?? []).filter((r) => r.isSystem).map((r) => (
          <SettingRow key={String(r.key)} title={String(r.name)} description={String(r.description ?? "")}><span className="setting-fixed">Built in</span></SettingRow>
        ))}
        {custom.map((r, i) => (
          <SettingRow key={String(r.key)} title={String(r.name)} description={err(`roles.${i}`) ?? `${(r.permissions ?? []).length} areas${r.description ? ` · ${String(r.description)}` : ""}`}>
            <span className="su-actions">
              <Button size="sm" onClick={() => setEditingRole(i)}>Change</Button>
              <Button size="sm" tone="quiet" onClick={() => set("roles", custom.filter((_, j) => j !== i))}>Remove</Button>
            </span>
          </SettingRow>
        ))}
        <div className="su-pad"><Button onClick={() => setEditingRole("new")}><Plus size={15} /> Add a role</Button></div>
      </SettingsSection>

      <SettingsSection title="Signing up">
        <SettingRow title="Let people create their own account" description="Anyone with the app's address can sign up. They start as Viewer, able to see but not change anything, until someone gives them a role. Most companies leave this off.">
          <Switch label="Let people create their own account" checked={Boolean(file.selfSignUp)} onChange={(v) => replace({ ...file, selfSignUp: v })} />
        </SettingRow>
      </SettingsSection>

      {pasting && <PasteList options={options} onClose={() => setPasting(false)} onAdd={(people) => { set("staff", [...staff.filter((p) => p.email || p.name), ...people]); setPasting(false); }} existing={[String(file.owner?.email), ...staff.map((p) => String(p.email))]} />}
      {editingRole !== null && (
        <RoleDrawer role={editingRole === "new" ? undefined : custom[editingRole]} defs={masters.data ?? []} taken={options.map((o) => o.value)} onClose={() => setEditingRole(null)}
          onSave={(role) => { set("roles", editingRole === "new" ? [...custom, role] : custom.map((r, j) => (j === editingRole ? role : r))); setEditingRole(null); }} />
      )}
    </div>
  );
}

function PasteList({ options, existing, onClose, onAdd }: { options: { value: string; label: string }[]; existing: string[]; onClose: () => void; onAdd: (people: Rec[]) => void }) {
  const [text, setText] = useState("");
  const parsed = useMemo(() => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\t|,|;/).map((p) => p.trim());
    const email = parts.find((p) => emailLike.test(p))?.toLowerCase();
    const others = parts.filter((p) => p.toLowerCase() !== email);
    const role = options.find((o) => others.some((p) => p.toLowerCase() === o.label.toLowerCase() || p.toLowerCase() === o.value));
    const name = others.find((p) => p.toLowerCase() !== role?.label.toLowerCase() && p.toLowerCase() !== role?.value);
    return { line, email, name, role };
  }), [text, options]);
  const usable = parsed.filter((p) => p.email && !existing.includes(p.email));
  return (
    <Drawer open title="Paste a list of people" onClose={onClose} width={620}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!usable.length} onClick={() => onAdd(usable.map((p) => ({ name: p.name ?? "", email: p.email!, roles: p.role ? [p.role.value] : [] })))}>Add {usable.length || ""} {usable.length === 1 ? "person" : "people"}</Button></>}>
      <div className="su-stack">
        <Field label="One person per line" hint="Name, e-mail and role, from a spreadsheet or typed. Only the e-mail is needed.">
          <textarea className="input" rows={7} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={"Grace Banda, grace@acme.example, Operations\nJohn Phiri, john@acme.example, Finance"} />
        </Field>
        {parsed.length > 0 && (
          <div className="cust-table-wrap">
            <table className="cust-table">
              <thead><tr><th>Name</th><th>E-mail</th><th>Role</th></tr></thead>
              <tbody>{parsed.map((p, i) => (
                <tr key={i}>
                  <td>{p.name ?? "—"}</td>
                  <td>{p.email ? (existing.includes(p.email) ? <>{p.email} <span className="muted">· already listed</span></> : p.email) : <span className="su-bad-text">No e-mail in "{p.line}"</span>}</td>
                  <td>{p.role?.label ?? <span className="muted">Choose after</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function RoleDrawer({ role, defs, taken, onClose, onSave }: { role?: Rec; defs: Rec[]; taken: string[]; onClose: () => void; onSave: (role: Rec) => void }) {
  const [name, setName] = useState(String(role?.name ?? ""));
  const [description, setDescription] = useState(String(role?.description ?? ""));
  const [permissions, setPermissions] = useState<{ resource: string; actions: string[] }[]>((role?.permissions ?? []) as { resource: string; actions: string[] }[]);
  const key = role ? String(role.key) : name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const clash = !role && taken.includes(key);
  return (
    <Drawer open title={role ? `Change ${String(role.name)}` : "Add a role"} onClose={onClose} width={860}
      footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!/^[a-z][a-z0-9_-]{1,39}$/.test(key) || clash} onClick={() => onSave({ key, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), permissions })}>{role ? "Save role" : "Add role"}</Button></>}>
      <div className="su-stack">
        <div className="grid-2">
          <Field label="Name *" hint={clash ? "A role with this name already exists." : undefined}><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Workshop manager" /></Field>
          <Field label="What they do"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <FieldGroup label="What they can do" wide>
          <PermissionMatrix value={permissions as never} onChange={(v) => setPermissions(v as never)} defs={defs} />
        </FieldGroup>
      </div>
    </Drawer>
  );
}
