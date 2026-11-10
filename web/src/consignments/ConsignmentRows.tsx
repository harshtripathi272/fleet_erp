import { Plus } from "lucide-react";
import { Button, Field, UnitInput } from "../ui/kit";
import { num, phonePlaceholder } from "../ui/format";
import { w, wl } from "../domain/words";
import type { AppData, Product, Trailer, Truck } from "../domain/types";

/**
 * The short consignment rows on a new trip (#135, design 3.11.1): product, quantity, consignee and the consignee's
 * phone, one line each. For the one-load company this is the old Product and Planned quantity, plus the consignee.
 * Everything else about a consignment (parties, papers, its own pickups and drops) is on the consignment itself.
 */

export interface DraftConsignment {
  key: string;
  productId: string;
  qty: string;
  /** A customer picked by name, or a name and phone typed for a consignee who isn't a party. */
  consigneePartyId?: string;
  consigneeName: string;
  consigneePhone: string;
}

let keys = 0;
export const draftConsignment = (): DraftConsignment => ({ key: `c${++keys}`, productId: "", qty: "", consigneeName: "", consigneePhone: "" });

/** A row with nothing in it is left out: the consignment is then added at loading. */
export const isEmptyDraft = (d: DraftConsignment) => !d.productId && !d.qty.trim() && !d.consigneeName.trim() && !d.consigneePhone.trim();

/** What is missing on a row that has something in it, in words, or nothing. */
export function draftProblem(data: AppData, d: DraftConsignment, n: number): string | undefined {
  if (isEmptyDraft(d)) return undefined;
  const which = `${wl(data, "consignment")} ${n}`;
  if (!d.productId) return `Choose the goods on ${which}.`;
  if (d.qty.trim() && !(Number(d.qty) > 0)) return `The quantity on ${which} must be more than 0.`;
  if (data.settings.freight.consigneeMustBeParty && d.consigneeName.trim() && !d.consigneePartyId) return `Pick the consignee on ${which} from the ${wl(data, "customer", true)}: this company needs a record for every consignee.`;
  if (data.settings.freight.consigneePhoneRequired && !d.consigneePhone.trim() && !d.consigneePartyId) return `Enter the consignee's phone number on ${which}.`;
  return undefined;
}

/** The body `POST /trips` takes for each row (contract 1.1 without `tripId`): the trip's customer, route stops and type fill the rest. */
export function consignmentBody(d: DraftConsignment) {
  return {
    lines: [{ productId: d.productId, ...(d.qty.trim() ? { plannedQty: Number(d.qty) } : {}) }],
    ...(d.consigneePartyId ? { consigneePartyId: d.consigneePartyId }
      : d.consigneeName.trim() ? { consignee: { name: d.consigneeName.trim(), ...(d.consigneePhone.trim() ? { phone: d.consigneePhone.trim() } : {}) } } : {}),
  };
}

const MASS: Record<string, number> = { kg: 1, kgs: 1, t: 1000, mt: 1000, tonne: 1000, tonnes: 1000, ton: 1000, tons: 1000 };
const VOLUME: Record<string, number> = { l: 1, ltr: 1, litre: 1, litres: 1, liter: 1, liters: 1, m3: 1000, "m³": 1000, cbm: 1000 };

/** What the rows would put on board at most, against the truck's and the trailer's limits, as one framed line. */
export function capacityLine(data: AppData, drafts: DraftConsignment[], truck?: Truck, trailer?: Trailer) {
  let kg = 0;
  let litres = 0;
  for (const d of drafts) {
    const p = data.products.find((x) => x.id === d.productId) as Product | undefined;
    const q = Number(d.qty);
    if (!p || !(q > 0)) continue;
    const u = String(p.unit).toLowerCase();
    if (MASS[u]) kg += q * MASS[u]!;
    else if (VOLUME[u]) litres += q * VOLUME[u]!;
  }
  const limitKg = Math.min(...[truck?.capacityT ? truck.capacityT * 1000 : Infinity, trailer?.unit === "t" && trailer.capacity ? trailer.capacity * 1000 : Infinity]);
  const limitL = trailer?.unit === "L" && trailer.capacity ? trailer.capacity : Infinity;
  const tolerance = 1 + data.settings.freight.capacityTolerancePercent / 100;
  const parts: string[] = [];
  const over: string[] = [];
  if (kg || Number.isFinite(limitKg)) parts.push(`${num(kg / 1000, 0, 2)} t${Number.isFinite(limitKg) ? ` of ${num(limitKg / 1000, 0, 2)} t` : ""}`);
  if (litres || Number.isFinite(limitL)) parts.push(`${num(litres)} L${Number.isFinite(limitL) ? ` of ${num(limitL)} L` : ""}`);
  if (kg > limitKg * tolerance) over.push(`${num(kg / 1000, 0, 2)} t is more than ${truck?.plate ?? "the truck"} carries.`);
  if (litres > limitL * tolerance) over.push(`${num(litres)} L is more than the trailer holds.`);
  return { text: parts.length ? `On board at most: ${parts.join(" · ")}` : "", over, refuse: data.settings.freight.capacityCheck === "refuse" };
}

export function ConsignmentRows({ data, value, onChange }: { data: AppData; value: DraftConsignment[]; onChange: (next: DraftConsignment[]) => void }) {
  const rules = data.settings.freight;
  const one = wl(data, "consignment");
  const canAdd = !rules.maxConsignmentsPerTrip || value.length < rules.maxConsignmentsPerTrip;
  const set = (key: string, patch: Partial<DraftConsignment>) => onChange(value.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const pickConsignee = (key: string, name: string) => {
    const party = data.customers.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    set(key, { consigneeName: name, consigneePartyId: party?.id, ...(party && party.phone ? { consigneePhone: party.phone } : {}) });
  };
  return (
    <section className="consignment-rows" aria-label={w(data, "consignment", true)}>
      <h3>{w(data, "consignment", true)}</h3>
      <p className="muted">
        {rules.consignmentBy === "loading"
          ? `Leave a row empty to add the ${one} at loading. It is loaded at the route's loading point and dropped at its offloading point unless you change that on the ${one}.`
          : `The trip can't leave without its ${one}. It is loaded at the route's loading point and dropped at its offloading point unless you change that on the ${one}.`}
      </p>
      <datalist id="consignee-names">{data.customers.map((c) => <option key={c.id} value={c.name} />)}</datalist>
      {value.map((d, i) => {
        const product = data.products.find((p) => p.id === d.productId);
        return (
          <div key={d.key} className="consignment-row">
            <span className="consignment-row-n">{i + 1}</span>
            <Field label="Goods">
              <select value={d.productId} onChange={(e) => set(d.key, { productId: e.target.value })}>
                <option value="">{rules.consignmentBy === "loading" ? "Add it at loading" : "Choose…"}</option>
                {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Quantity">
              <UnitInput label={`Quantity on ${one} ${i + 1}`} unit={product?.unit ?? ""} value={d.qty} onChange={(v) => set(d.key, { qty: v })} />
            </Field>
            <Field label="Consignee" hint={d.consigneePartyId ? "A saved party." : d.consigneeName.trim() ? "Only a name and phone." : undefined}>
              <input list="consignee-names" value={d.consigneeName} placeholder="The customer, unless you say" onChange={(e) => pickConsignee(d.key, e.target.value)} />
            </Field>
            <Field label="Consignee phone">
              <input type="tel" value={d.consigneePhone} placeholder={phonePlaceholder()} disabled={Boolean(d.consigneePartyId)} onChange={(e) => set(d.key, { consigneePhone: e.target.value })} />
            </Field>
            {value.length > 1 && <Button size="sm" tone="quiet" onClick={() => onChange(value.filter((x) => x.key !== d.key))}>Remove</Button>}
          </div>
        );
      })}
      {canAdd && <div><Button size="sm" onClick={() => onChange([...value, draftConsignment()])}><Plus size={14} /> Add {one}</Button></div>}
    </section>
  );
}
