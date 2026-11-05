import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, ChoiceChips, Empty, Field, FieldGroup, SaveBar, Segmented, SettingRow, SettingsSection, Switch } from "../ui/kit";

/**
 * The company's words, trip stages and desks (#73), stored on the company (PUT /company: vocabulary, stages,
 * desks). Only what differs from the defaults is stored, so a default the code improves later still reaches a
 * company that never changed it.
 */

type Words = Record<string, { singular: string; plural: string }>;
type Stage = { key: string; name: string; defaultName: string; optional: boolean; switchedOff: boolean; areaOff: boolean; area?: string };
type DeskKind = "owner" | "operations" | "finance" | "roles";
type DeskSetup = { key: string; name: string; icon: string; views: string[]; kind: DeskKind; roleKeys?: string[]; actsAs?: "owner" | "operations" | "finance" };
interface Workspace {
  words: Words;
  terms: Words;
  stages: Stage[];
  views: { key: string; name: string; on: boolean; area?: string }[];
  icons: string[];
  deskSetup: DeskSetup[];
  defaultDesks: DeskSetup[];
}
interface Draft { words: Words; stages: Record<string, { name: string; off: boolean }>; desks: DeskSetup[] }

/** What each term is, for the person renaming it. */
const TERM_NOTE: Record<string, string> = {
  trip: "One truck's journey from loading to delivery.",
  nomination: "A customer's request to move a load, before it becomes a trip.",
  driver: "The person driving the truck.",
  truck: "The vehicle that pulls.",
  trailer: "What the truck pulls.",
  customer: "Who the load is moved for.",
  advance: "Cash given to the driver for a trip.",
  fuelRequest: "Fuel asked for on the way.",
  expense: "Money the driver spent on a trip.",
  settlement: "Squaring up with a driver after trips.",
  statement: "The driver's printed account of a settlement.",
  tripSheet: "The printed record of one trip.",
};
const ICON_NAME: Record<string, string> = { gauge: "Gauge", grid: "Grid", wallet: "Wallet", wrench: "Spanner", truck: "Truck", clipboard: "Clipboard", users: "People", map: "Map" };
const KIND: { value: DeskKind; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "operations", label: "Operations" },
  { value: "finance", label: "Finance" },
  { value: "roles", label: "Named roles" },
];
const KIND_NOTE: Record<DeskKind, string> = {
  owner: "Everyone who may change everything, or who approves at the second level.",
  operations: "Everyone who may create trips, nominations, consignments or requests.",
  finance: "Everyone who may approve, pay or settle, or who approves at the first level.",
  roles: "Only people with one of the roles below. Administrators see it too, to set it up.",
};

function draftFrom(ws: Workspace | undefined): Draft {
  return {
    words: Object.fromEntries(Object.entries(ws?.terms ?? {}).map(([k, d]) => {
      const own = ws?.words[k];
      return [k, { singular: own && own.singular !== d.singular ? own.singular : "", plural: own && own.plural !== d.plural ? own.plural : "" }];
    })),
    stages: Object.fromEntries((ws?.stages ?? []).map((s) => [s.key, { name: s.name !== s.defaultName ? s.name : "", off: s.switchedOff }])),
    desks: (ws?.deskSetup ?? []).map((d) => ({ ...d, roleKeys: d.roleKeys ?? [] })),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "desk";

export function WorkspacePanel() {
  const { me, toast, refreshReference } = useApp();
  const client = useQueryClient();
  const writable = can(me, "company", "update");
  const ws = useQuery({ queryKey: ["workspace"], queryFn: () => api<Workspace>("/meta/workspace") });
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Rec>("/company").catch(() => null) });
  const roles = useQuery({ queryKey: ["workspace-roles"], queryFn: () => api<Rec[]>("/roles", { query: { limit: 100 } }) });
  const saved = useMemo(() => draftFrom(ws.data), [ws.data]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = ws.data !== undefined && !same(draft, saved);

  if (ws.isLoading || company.isLoading) return <p className="muted">Loading…</p>;
  if (ws.error) return <Empty title="Could not load the words and desks">{(ws.error as Error).message}</Empty>;
  if (!company.data) return <Empty title="Save the company first">Words, stages and desks belong to the company. Fill in its details on the Company page, then come back.</Empty>;
  const data = ws.data!;
  const viewName = (key: string) => {
    if (key === "trips") return draft.words.trip?.plural || data.terms.trip?.plural || "Trips";
    if (key === "nominations") return draft.words.nomination?.plural || data.terms.nomination?.plural || "Nominations";
    return data.views.find((v) => v.key === key)?.name ?? key;
  };

  const setWord = (term: string, change: Partial<{ singular: string; plural: string }>) =>
    setDraft((d) => ({ ...d, words: { ...d.words, [term]: { ...d.words[term], ...change } } }));
  const setStage = (key: string, change: Partial<{ name: string; off: boolean }>) =>
    setDraft((d) => ({ ...d, stages: { ...d.stages, [key]: { ...d.stages[key], ...change } } }));
  const setDesk = (i: number, change: Partial<DeskSetup>) =>
    setDraft((d) => ({ ...d, desks: d.desks.map((x, j) => (j === i ? { ...x, ...change } : x)) }));
  const moveDesk = (i: number, by: number) =>
    setDraft((d) => {
      const desks = [...d.desks];
      const j = i + by;
      if (j < 0 || j >= desks.length) return d;
      [desks[i], desks[j]] = [desks[j], desks[i]];
      return { ...d, desks };
    });
  /** The picked screens in the app's order, with the one the desk opens on first. */
  const inOrder = (picked: string[], first?: string) => {
    const rest = data.views.map((v) => v.key).filter((k) => picked.includes(k) && k !== first);
    return first && picked.includes(first) ? [first, ...rest] : rest;
  };
  const addDesk = () =>
    setDraft((d) => {
      let key = "new-desk";
      for (let n = 2; d.desks.some((x) => x.key === key); n += 1) key = `new-desk-${n}`;
      return { ...d, desks: [...d.desks, { key, name: "New desk", icon: "clipboard", views: ["trips"], kind: "roles", roleKeys: [], actsAs: "operations" }] };
    });

  const problems: string[] = [];
  draft.desks.forEach((d) => {
    if (!d.name.trim()) problems.push("Every desk needs a name.");
    if (!d.views.length) problems.push(`${d.name || "A desk"} needs at least one screen.`);
    if (d.kind === "roles" && !d.roleKeys?.length) problems.push(`${d.name || "A desk"} is for named roles but names none.`);
  });
  Object.entries(draft.words).forEach(([k, v]) => {
    if (Boolean(v.singular.trim()) !== Boolean(v.plural.trim())) problems.push(`Give both forms of "${data.terms[k].singular}", or neither.`);
  });

  const save = async () => {
    if (problems.length) {
      toast(problems[0], "error");
      return;
    }
    setBusy(true);
    try {
      const vocabulary = Object.fromEntries(
        Object.entries(draft.words).filter(([, v]) => v.singular.trim() && v.plural.trim()).map(([k, v]) => [k, { singular: v.singular.trim(), plural: v.plural.trim() }]),
      );
      const stages = Object.fromEntries(
        Object.entries(draft.stages)
          .map(([k, v]) => [k, { ...(v.name.trim() ? { name: v.name.trim() } : {}), ...(v.off ? { off: true } : {}) }] as const)
          .filter(([, v]) => Object.keys(v).length > 0),
      );
      const desks = draft.desks.map((d) => ({
        key: d.key,
        name: d.name.trim(),
        icon: d.icon,
        views: d.views,
        kind: d.kind,
        ...(d.kind === "roles" ? { roleKeys: d.roleKeys ?? [], actsAs: d.actsAs ?? "operations" } : {}),
      }));
      // The defaults are stored as nothing, so later improvements to them still apply.
      const defaults = data.defaultDesks.map((d) => ({ key: d.key, name: d.name, icon: d.icon, views: d.views, kind: d.kind }));
      await api("/company", { method: "PUT", body: { version: company.data!.version, vocabulary, stages, desks: same(desks, defaults) ? [] : desks } });
      toast("Words, stages and desks saved.");
      await client.invalidateQueries({ queryKey: ["workspace"] });
      await client.invalidateQueries({ queryKey: ["company"] });
      refreshReference();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const roleOptions = (roles.data ?? []).map((r) => ({ value: String(r.key), label: String(r.name ?? r.key) }));
  return (
    <div className="desk">
      <header className="masters-head">
        <div className="masters-title">
          <h2>Words, stages and desks</h2>
          <p>What the app calls things, the stages a trip goes through, and the desks people work at. Empty boxes use the default shown in grey.</p>
        </div>
      </header>
      <fieldset className="company-form settings-page" disabled={!writable}>
        <SettingsSection title="Words" description="What the screens, documents and messages call things. A company that says job for trip, or float for cash advance, changes it here. Give both forms, one and many, or leave both empty.">
          <div className="cust-table-wrap">
            <table className="cust-table">
              <thead><tr><th>Term</th><th>One</th><th>Many</th></tr></thead>
              <tbody>
                {Object.entries(data.terms).map(([key, d]) => (
                  <tr key={key}>
                    <td>
                      <strong>{d.singular}</strong>
                      <span className="term-note">{TERM_NOTE[key] ?? ""}</span>
                    </td>
                    <td><input className="input" aria-label={`${d.singular}, one`} placeholder={d.singular} maxLength={40} value={draft.words[key]?.singular ?? ""} onChange={(e) => setWord(key, { singular: e.target.value })} /></td>
                    <td><input className="input" aria-label={`${d.singular}, many`} placeholder={d.plural} maxLength={40} value={draft.words[key]?.plural ?? ""} onChange={(e) => setWord(key, { plural: e.target.value })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsSection>

        <SettingsSection title="Trip stages" description="The stages the desks show for every trip, in order. Rename any of them. Funding and settlement can be switched off for a company that doesn't advance cash or settle drivers through the app: trips then go from planning to loading, and are complete when closed.">
          <div className="cust-table-wrap">
            <table className="cust-table">
              <thead><tr><th>Stage</th><th>Name</th><th>Used</th></tr></thead>
              <tbody>
                {data.stages.map((s) => (
                  <tr key={s.key}>
                    <td><strong>{s.defaultName}</strong></td>
                    <td><input className="input" aria-label={`Name of the ${s.defaultName} stage`} placeholder={s.defaultName} maxLength={40} value={draft.stages[s.key]?.name ?? ""} onChange={(e) => setStage(s.key, { name: e.target.value })} /></td>
                    <td>
                      {!s.optional ? <span className="setting-fixed">Always</span>
                        : s.areaOff ? <span className="setting-fixed">Off while Money is off</span>
                        : <Switch label={`Use the ${s.defaultName} stage`} checked={!draft.stages[s.key]?.off} onChange={(on) => setStage(s.key, { off: !on })} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsSection>

        <SettingsSection title="Desks" description="The desks people choose from after signing in, and the screens each lists, in order. A desk for named roles follows one of the built-in desks for what it needs to act on. Screens for an area that is switched off are left out until it is on again.">
          {draft.desks.map((desk, i) => (
            <div key={i} className="form-section desk-setup">
              <h4>{desk.name || "Unnamed desk"}</h4>
              <div className="grid-2">
                <Field label="Name"><input className="input" maxLength={50} value={desk.name} onChange={(e) => setDesk(i, { name: e.target.value, ...(data.defaultDesks.some((d) => d.key === desk.key) || saved.desks.some((d) => d.key === desk.key) ? {} : { key: uniqueKey(slug(e.target.value), draft.desks, i) }) })} /></Field>
                <Field label="Icon">
                  <select className="input" value={desk.icon} onChange={(e) => setDesk(i, { icon: e.target.value })}>
                    {data.icons.map((icon) => <option key={icon} value={icon}>{ICON_NAME[icon] ?? icon}</option>)}
                  </select>
                </Field>
                <FieldGroup label="Screens" hint="Listed in this order, after the one it opens on." wide>
                  <ChoiceChips
                    label={`Screens on ${desk.name}`}
                    options={data.views.map((v) => ({ value: v.key, label: v.on ? viewName(v.key) : `${viewName(v.key)} (area off)` }))}
                    value={desk.views}
                    onChange={(views) => setDesk(i, { views: inOrder(views, desk.views[0]) })}
                  />
                </FieldGroup>
                <Field label="Opens on" hint="The screen shown first, and at the top of the list.">
                  <select className="input" value={desk.views[0] ?? ""} disabled={!desk.views.length} onChange={(e) => setDesk(i, { views: inOrder(desk.views, e.target.value) })}>
                    {desk.views.map((v) => <option key={v} value={v}>{viewName(v)}</option>)}
                  </select>
                </Field>
                <FieldGroup label="Who sees it" hint={KIND_NOTE[desk.kind]} wide>
                  <Segmented choice label={`Who sees ${desk.name}`} value={desk.kind} options={KIND} disabled={!writable}
                    onChange={(kind) => setDesk(i, { kind: kind as DeskKind, ...(kind === "roles" ? { actsAs: desk.actsAs ?? "operations" } : {}) })} />
                </FieldGroup>
                {desk.kind === "roles" && (
                  <>
                    <FieldGroup label="Roles" wide>
                      {roleOptions.length ? <ChoiceChips label={`Roles that see ${desk.name}`} options={roleOptions} value={desk.roleKeys ?? []} onChange={(roleKeys) => setDesk(i, { roleKeys })} />
                        : <span className="muted">No roles yet. Add them under Roles.</span>}
                    </FieldGroup>
                    <Field label="Works like" hint="Whose waiting work it lists under Needs me, and whose messages it reads.">
                      <select className="input" value={desk.actsAs ?? "operations"} onChange={(e) => setDesk(i, { actsAs: e.target.value as DeskSetup["actsAs"] })}>
                        <option value="owner">Owner</option>
                        <option value="operations">Operations</option>
                        <option value="finance">Finance</option>
                      </select>
                    </Field>
                  </>
                )}
              </div>
              <div className="desk-setup-actions">
                <Button size="sm" tone="quiet" disabled={i === 0} onClick={() => moveDesk(i, -1)}><ArrowUp size={14} /> Earlier</Button>
                <Button size="sm" tone="quiet" disabled={i === draft.desks.length - 1} onClick={() => moveDesk(i, 1)}><ArrowDown size={14} /> Later</Button>
                <Button size="sm" tone="quiet" disabled={draft.desks.length === 1} onClick={() => setDraft((d) => ({ ...d, desks: d.desks.filter((_, j) => j !== i) }))}><Trash2 size={14} /> Remove</Button>
              </div>
            </div>
          ))}
          <SettingRow title="Add a desk" description="For example a Workshop desk with Maintenance and Masters, for the roles that run the yard.">
            <span className="desk-setup-add">
              <Button disabled={draft.desks.length >= 12} onClick={addDesk}><Plus size={15} /> Add a desk</Button>
              <Button tone="quiet" onClick={() => setDraft((d) => ({ ...d, desks: data.defaultDesks.map((x) => ({ ...x, roleKeys: [] })) }))}>Back to the default desks</Button>
            </span>
          </SettingRow>
        </SettingsSection>
      </fieldset>
      {writable && <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onDiscard={() => setDraft(saved)} />}
    </div>
  );
}

function uniqueKey(base: string, desks: DeskSetup[], self: number) {
  const start = /^[a-z]/.test(base) && base.length >= 2 ? base : `desk-${base}`.slice(0, 30);
  let key = start;
  for (let n = 2; desks.some((d, j) => j !== self && d.key === key); n += 1) key = `${start.slice(0, 27)}-${n}`;
  return key;
}
