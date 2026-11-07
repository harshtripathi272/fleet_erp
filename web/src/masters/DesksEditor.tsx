import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, ChoiceChips, Field, FieldGroup, Segmented, SettingRow, SettingsSection } from "../ui/kit";

/**
 * The desks people choose from after signing in, and the screens each lists. Shaped here on the company page and in
 * "Set up a company", so it holds no state of its own beyond what it's given.
 */

export type DeskKind = "owner" | "operations" | "finance" | "roles";
export type DeskSetup = { key: string; name: string; icon: string; views: string[]; kind: DeskKind; roleKeys?: string[]; actsAs?: "owner" | "operations" | "finance" };

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

const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "desk";
function uniqueKey(base: string, desks: DeskSetup[], self: number) {
  const start = /^[a-z]/.test(base) && base.length >= 2 ? base : `desk-${base}`.slice(0, 30);
  let key = start;
  for (let n = 2; desks.some((d, j) => j !== self && d.key === key); n += 1) key = `${start.slice(0, 27)}-${n}`;
  return key;
}

export function DesksEditor({ desks, onChange, views, icons, defaultDesks, savedKeys, viewName, roleOptions, writable = true }: {
  desks: DeskSetup[];
  onChange: (desks: DeskSetup[]) => void;
  views: { key: string; name: string; on: boolean; area?: string }[];
  icons: string[];
  defaultDesks: DeskSetup[];
  savedKeys: string[];
  viewName: (key: string) => string;
  roleOptions: { value: string; label: string }[];
  writable?: boolean;
}) {
  const setDesk = (i: number, change: Partial<DeskSetup>) => onChange(desks.map((x, j) => (j === i ? { ...x, ...change } : x)));
  const moveDesk = (i: number, by: number) => {
    const next = [...desks];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const inOrder = (picked: string[], first?: string) => {
    const rest = views.map((v) => v.key).filter((k) => picked.includes(k) && k !== first);
    return first && picked.includes(first) ? [first, ...rest] : rest;
  };
  const addDesk = () => {
    let key = "new-desk";
    for (let n = 2; desks.some((x) => x.key === key); n += 1) key = `new-desk-${n}`;
    onChange([...desks, { key, name: "New desk", icon: "clipboard", views: ["trips"], kind: "roles", roleKeys: [], actsAs: "operations" }]);
  };
  return (
        <SettingsSection title="Desks" description="The desks people choose from after signing in, and the screens each lists, in order. A desk for named roles follows one of the built-in desks for what it needs to act on. Screens for an area that is switched off are left out until it is on again.">
      {desks.map((desk, i) => (
        <div key={i} className="form-section desk-setup">
          <h4>{desk.name || "Unnamed desk"}</h4>
          <div className="grid-2">
            <Field label="Name"><input className="input" maxLength={50} value={desk.name} onChange={(e) => setDesk(i, { name: e.target.value, ...(defaultDesks.some((d) => d.key === desk.key) || savedKeys.includes(desk.key) ? {} : { key: uniqueKey(slug(e.target.value), desks, i) }) })} /></Field>
            <Field label="Icon">
              <select className="input" value={desk.icon} onChange={(e) => setDesk(i, { icon: e.target.value })}>
                {icons.map((icon) => <option key={icon} value={icon}>{ICON_NAME[icon] ?? icon}</option>)}
              </select>
            </Field>
            <FieldGroup label="Screens" hint="Listed in this order, after the one it opens on." wide>
              <ChoiceChips
                label={`Screens on ${desk.name}`}
                options={views.map((v) => ({ value: v.key, label: v.on ? viewName(v.key) : `${viewName(v.key)} (area off)` }))}
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
            <Button size="sm" tone="quiet" disabled={i === desks.length - 1} onClick={() => moveDesk(i, 1)}><ArrowDown size={14} /> Later</Button>
            <Button size="sm" tone="quiet" disabled={desks.length === 1} onClick={() => onChange(desks.filter((_, j) => j !== i))}><Trash2 size={14} /> Remove</Button>
          </div>
        </div>
      ))}
      <SettingRow title="Add a desk" description="For example a Workshop desk with Maintenance and Masters, for the roles that run the yard.">
        <span className="desk-setup-add">
          <Button disabled={desks.length >= 12} onClick={addDesk}><Plus size={15} /> Add a desk</Button>
          <Button tone="quiet" onClick={() => onChange(defaultDesks.map((x) => ({ ...x, roleKeys: [] })))}>Back to the default desks</Button>
        </span>
      </SettingRow>
    </SettingsSection>
  );
}
