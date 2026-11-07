import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Empty, Field, SaveBar, SettingsSection, Switch } from "../ui/kit";
import { DesksEditor, type DeskSetup } from "./DesksEditor";

/**
 * The company's words, trip stages and desks (#73), stored on the company (PUT /company: vocabulary, stages,
 * desks). Only what differs from the defaults is stored, so a default the code improves later still reaches a
 * company that never changed it.
 */

type Words = Record<string, { singular: string; plural: string }>;
type Stage = { key: string; name: string; defaultName: string; optional: boolean; switchedOff: boolean; areaOff: boolean; area?: string };
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

        <DesksEditor desks={draft.desks} onChange={(desks) => setDraft((d) => ({ ...d, desks }))} views={data.views} icons={data.icons} defaultDesks={data.defaultDesks} savedKeys={saved.desks.map((d) => d.key)} viewName={viewName} roleOptions={roleOptions} writable={writable} />
      </fieldset>
      {writable && <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} onDiscard={() => setDraft(saved)} />}
    </div>
  );
}
