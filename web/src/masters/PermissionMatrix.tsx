import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";
import { ChoiceChips, Segmented, Switch } from "../ui/kit";

/**
 * A role's permissions: for each area (every master, the company, the audit log and the trip and money work),
 * one access level, and whether it may see sensitive fields. Levels are named sets of actions; a role whose
 * actions match no level shows as Custom, with each action to tick. Rows come from GET /roles/resources, so a
 * master added later shows up here without a change to this screen.
 */

type Permission = { resource: string; actions: string[] };
const ACTION_LABEL: Record<string, string> = { read: "See", create: "Add", update: "Change", archive: "Archive", delete: "Delete", sensitive: "Sensitive", "*": "All" };
/** Areas that are not masters, in words people use. */
const AREA_LABEL: Record<string, string> = {
  "*": "Everything",
  company: "Company settings",
  "audit-logs": "Audit log",
  nominations: "Nominations",
  trips: "Trips",
  "vehicle-states": "Truck position and fuel",
  "fund-requests": "Fuel and cash requests",
  "fund-approvals": "Approving requests (no policy)",
  payments: "Paying out approved requests",
  "driver-documents": "Driver documents",
  consignments: "Loading and delivery",
  "shortage-decisions": "Shortage decisions",
  expenses: "Expenses",
  "expense-approvals": "Approving expenses",
  settlements: "Settling drivers",
  "settlement-requests": "Asking for a settlement",
  messages: "Messages",
  activity: "Activity",
};
const WORK = new Set(Object.keys(AREA_LABEL).filter((k) => !["*", "company", "audit-logs"].includes(k)));

/** Access levels, each the actions it allows. "Full" is every action, delete and sensitive included. */
const LEVELS = [
  { key: "none", label: "None", actions: [] as string[] },
  { key: "see", label: "See", actions: ["read"] },
  { key: "edit", label: "Edit", actions: ["read", "create", "update"] },
  { key: "manage", label: "Manage", actions: ["read", "create", "update", "archive"] },
  { key: "full", label: "Full", actions: ["*"] },
] as const;
type Level = (typeof LEVELS)[number]["key"] | "custom";
const RANK: Record<string, number> = { none: 0, see: 1, edit: 2, manage: 3, full: 4 };

/** The level a set of actions matches (sensitive aside), or "custom". */
function levelOf(actions: string[]): Level {
  if (actions.includes("*")) return "full";
  const plain = actions.filter((a) => a !== "sensitive").sort().join(",");
  return LEVELS.find((l) => l.key !== "full" && [...l.actions].sort().join(",") === plain)?.key ?? "custom";
}

export function PermissionMatrix({ value, onChange, defs, readOnly }: { value: Permission[]; onChange: (v: Permission[]) => void; defs: Rec[]; readOnly?: boolean }) {
  const catalogue = useQuery({ queryKey: ["role-resources"], queryFn: () => api<{ resources: string[]; actions: string[] }>("/roles/resources"), staleTime: 5 * 60_000 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!catalogue.data) return <p className="muted">Loading the areas…</p>;
  const actions = catalogue.data.actions.filter((a) => a !== "*" && a !== "sensitive");
  const byKey = new Map(defs.map((d) => [String(d.key), d]));
  const name = (r: string) => AREA_LABEL[r] ?? String(byKey.get(r)?.label ?? r);
  // Group rows the way the Masters list does, then the trip and money work, then the rest.
  const groups = new Map<string, string[]>();
  const add = (group: string, r: string) => groups.set(group, [...(groups.get(group) ?? []), r]);
  for (const r of catalogue.data.resources) {
    if (r === "*") continue;
    if (byKey.has(r)) add(String(byKey.get(r)!.group), r);
    else if (WORK.has(r)) add("Trips and money work", r);
    else add("Company and records", r);
  }
  const of = (r: string) => value.find((p) => p.resource === r)?.actions ?? [];
  const everything = of("*");
  /** What a row allows: its own grant plus what "Everything" grants every area. */
  const effective = (r: string) => (r === "*" ? everything : [...new Set([...everything, ...of(r)])]);
  const write = (changes: Record<string, string[]>) => {
    const rest = value.filter((p) => !(p.resource in changes));
    const added = Object.entries(changes).filter(([, a]) => a.length).map(([resource, a]) => ({ resource, actions: a }));
    onChange([...rest, ...added]);
  };
  /** Keeps only what "Everything" doesn't already give, so a role reads the way it was meant. */
  const own = (r: string, wanted: string[]) => (r === "*" || everything.includes("*") ? wanted : wanted.filter((a) => !everything.includes(a)));
  const setLevel = (r: string, level: Level, sensitive: boolean) => {
    if (level === "custom") return setOpen(new Set([...open, r]));
    const base = [...(LEVELS.find((l) => l.key === level)?.actions ?? [])];
    write({ [r]: own(r, level === "full" || !sensitive ? base : [...base, "sensitive"]) });
  };
  const inheritedRank = RANK[levelOf(everything)] ?? 0;
  const row = (r: string) => {
    const eff = effective(r);
    const level = levelOf(eff);
    const sensitive = eff.includes("*") || eff.includes("sensitive");
    const sensitiveInherited = everything.includes("*") || everything.includes("sensitive");
    const custom = level === "custom" || open.has(r);
    return (
      <tr key={r} className={r === "*" ? "perm-all" : undefined}>
        <th scope="row">{r === "*" ? "Every area" : name(r)}</th>
        <td>
          <Segmented choice label={`Access to ${name(r)}`} value={custom ? "custom" : level} disabled={readOnly}
            options={[...LEVELS.map((l) => ({ value: l.key as Level, label: l.label, disabled: r !== "*" && RANK[l.key]! < inheritedRank })), { value: "custom" as Level, label: "Custom" }]}
            onChange={(v) => setLevel(r, v, sensitive && !sensitiveInherited)} />
          {custom && (
            <div className="perm-custom">
              <ChoiceChips label={`Actions on ${name(r)}`} disabled={readOnly || level === "full"}
                options={actions.map((a) => ({ value: a, label: ACTION_LABEL[a] ?? a }))}
                value={eff.includes("*") ? actions : eff.filter((a) => a !== "sensitive")}
                onChange={(next) => write({ [r]: own(r, [...next, ...(sensitive && !sensitiveInherited ? ["sensitive"] : [])]) })} />
            </div>
          )}
        </td>
        <td>
          <Switch label={`Sensitive fields: ${name(r)}`} checked={sensitive} disabled={readOnly || level === "none" || level === "full" || (r !== "*" && sensitiveInherited)}
            onChange={(on) => write({ [r]: own(r, on ? [...new Set([...eff, "sensitive"])] : eff.filter((a) => a !== "sensitive")) })} />
        </td>
      </tr>
    );
  };
  return (
    <div className="perm-editor">
      <p className="perm-legend">
        <b>See</b>: look only. <b>Edit</b>: also add and change. <b>Manage</b>: also archive. <b>Full</b>: everything, delete included.
        {" "}<b>Sensitive</b> fields are ID, passport and tax numbers and bank details.
      </p>
      <div className="perm-wrap">
        <table className="perm">
          <thead><tr><th>Area</th><th>Access</th><th>Sensitive</th></tr></thead>
          <tbody>
            {row("*")}
          </tbody>
          {[...groups].map(([group, rows]) => (
            <tbody key={group}>
              <tr className="perm-group">
                <th scope="rowgroup">{group}</th>
                <td colSpan={2}>
                  {!readOnly && (
                    <select className="input perm-setall" value="" aria-label={`Set every area in ${group}`}
                      onChange={(e) => {
                        const lvl = e.target.value as Level;
                        if (!lvl) return;
                        const base = [...(LEVELS.find((l) => l.key === lvl)?.actions ?? [])];
                        write(Object.fromEntries(rows.map((r) => [r, own(r, base)])));
                      }}>
                      <option value="">Set all to…</option>
                      {LEVELS.filter((l) => RANK[l.key]! >= inheritedRank).map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                    </select>
                  )}
                </td>
              </tr>
              {rows.map(row)}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
