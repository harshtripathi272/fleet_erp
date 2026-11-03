import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Rec } from "../api/adapter";

/**
 * A role's permissions as a grid: one row per area (every master, the company, the audit log and the trip
 * and money work), one column per action. Rows come from GET /roles/resources, so a master added later
 * shows up here without a change to this screen.
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

export function PermissionMatrix({ value, onChange, defs, readOnly }: { value: Permission[]; onChange: (v: Permission[]) => void; defs: Rec[]; readOnly?: boolean }) {
  const catalogue = useQuery({ queryKey: ["role-resources"], queryFn: () => api<{ resources: string[]; actions: string[] }>("/roles/resources"), staleTime: 5 * 60_000 });
  if (!catalogue.data) return <p className="muted">Loading the areas…</p>;
  const actions = catalogue.data.actions.filter((a) => a !== "*");
  const byKey = new Map(defs.map((d) => [String(d.key), d]));
  const name = (r: string) => AREA_LABEL[r] ?? String(byKey.get(r)?.label ?? r);
  // Group rows the way the Masters list does, then the trip and money work, then the rest.
  const groups = new Map<string, string[]>();
  const add = (group: string, r: string) => groups.set(group, [...(groups.get(group) ?? []), r]);
  for (const r of catalogue.data.resources) {
    if (r === "*") add("All areas", r);
    else if (byKey.has(r)) add(String(byKey.get(r)!.group), r);
    else if (WORK.has(r)) add("Trips and money work", r);
    else add("Company and records", r);
  }
  const of = (r: string) => value.find((p) => p.resource === r)?.actions ?? [];
  const set = (r: string, next: string[]) => {
    const rest = value.filter((p) => p.resource !== r);
    onChange(next.length ? [...rest, { resource: r, actions: next }] : rest);
  };
  const toggle = (r: string, a: string, on: boolean) => {
    const current = of(r);
    if (a === "*") return set(r, on ? ["*"] : []);
    // Picking one action under "All" spells "All" out, so it can be narrowed.
    const base = current.includes("*") ? actions : current;
    set(r, on ? [...new Set([...base, a])] : base.filter((x) => x !== a));
  };
  const everything = of("*");
  return (
    <div className="perm-wrap">
      <table className="perm">
        <thead>
          <tr><th>Area</th>{actions.map((a) => <th key={a}>{ACTION_LABEL[a] ?? a}</th>)}<th>{ACTION_LABEL["*"]}</th></tr>
        </thead>
        {[...groups].map(([group, rows]) => (
          <tbody key={group}>
            <tr className="perm-group"><th colSpan={actions.length + 2}>{group}</th></tr>
            {rows.map((r) => {
              const own = of(r);
              const all = own.includes("*");
              return (
                <tr key={r}>
                  <th scope="row">{name(r)}</th>
                  {actions.map((a) => {
                    // A grant on "Everything" already covers this cell: shown ticked and greyed.
                    const inherited = r !== "*" && (everything.includes("*") || everything.includes(a));
                    return (
                      <td key={a}>
                        <input type="checkbox" aria-label={`${ACTION_LABEL[a] ?? a}: ${name(r)}`} checked={all || own.includes(a) || inherited}
                          disabled={readOnly || inherited} onChange={(e) => toggle(r, a, e.target.checked)} />
                      </td>
                    );
                  })}
                  <td>
                    <input type="checkbox" aria-label={`All: ${name(r)}`} checked={all || (r !== "*" && everything.includes("*"))}
                      disabled={readOnly || (r !== "*" && everything.includes("*"))} onChange={(e) => toggle(r, "*", e.target.checked)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}
