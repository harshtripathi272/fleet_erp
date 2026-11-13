import { useEffect } from "react";
import { Plus } from "lucide-react";
import { Button, Field, UnitInput } from "../ui/kit";
import { num, phonePlaceholder } from "../ui/format";
import { w, wl } from "../domain/words";
import type { AppData, Product, RouteStop, Trailer, Truck } from "../domain/types";
import { RateChoice, rateBody, useContractLine, type RateDraft } from "./RateChoice";

export { RATE_BASES } from "./RateChoice";

/**
 * The consignments of a new trip (#135 Part 1): each decided while the trip is made. Its goods, quantity, consignor,
 * consignee and phone; where it is picked up and dropped (the route's stops, or another place, which becomes a stop);
 * and its price: the customer's rate contract when it covers the route and goods, else a rate typed now (#151). A company with one load and one drop gets one row already pointing at the route's loading and
 * offloading points.
 */

/** A pickup or a drop: a place, or "" for the route's own loading (or offloading) point; a drop may be "tbc". */
export interface DraftLeg { key: string; placeId: string; qty: string }
export interface DraftConsignment extends RateDraft {
  key: string;
  /** Who is billed; empty: the trip's customer (#102). */
  customerId?: string;
  productId: string;
  qty: string;
  /** A customer picked by name, or a name typed for a consignor or consignee who isn't a party. */
  consignorPartyId?: string;
  consignorName: string;
  consigneePartyId?: string;
  consigneeName: string;
  consigneePhone: string;
  pickups: DraftLeg[];
  drops: DraftLeg[];
  /** The rate contract that covers this row, as the server found it; empty when none does. */
  contractCode?: string;
}

let keys = 0;
const legKey = () => `l${++keys}`;
export const draftConsignment = (currencyId = ""): DraftConsignment => ({
  key: `c${++keys}`, productId: "", qty: "", consignorName: "", consigneeName: "", consigneePhone: "",
  pickups: [{ key: legKey(), placeId: "", qty: "" }], drops: [{ key: legKey(), placeId: "", qty: "" }],
  rateBasis: "per_consignment", ratePrice: "", rateCurrencyId: currencyId, rateOn: "", useContract: true, rateReason: "",
});


/** A row with nothing in it is left out: the consignment is then added at loading. */
export const isEmptyDraft = (d: DraftConsignment) => !d.productId && !d.qty.trim() && !d.consigneeName.trim() && !d.consigneePhone.trim() && !d.ratePrice.trim();

const routePoint = (stops: RouteStop[], kind: "load" | "offload") => stops.find((s) => s.kind === kind)?.placeId ?? "";
/** The place a leg names, with "" read as the route's loading or offloading point. */
const placeOf = (leg: DraftLeg, stops: RouteStop[], kind: "pickup" | "drop") => (leg.placeId === "tbc" ? "" : leg.placeId || routePoint(stops, kind === "pickup" ? "load" : "offload"));

/**
 * The trip's stops built from the rows (#135 Part 1), when no saved route is chosen: the truck's place, every place
 * something is picked up (in the rows' order), every place something is dropped, and the end at the last drop. A
 * place that is both a pickup and a drop (C in "C offloads two and loads one") appears as a loading and an offloading
 * stop. The person can still re-order them in the stop list.
 */
export function stopsFromRows(drafts: DraftConsignment[], truckPlaceId: string | undefined): RouteStop[] | null {
  const loads = [...new Set(drafts.flatMap((d) => d.pickups.map((p) => p.placeId)).filter((x) => x && x !== "tbc"))];
  const drops = [...new Set(drafts.flatMap((d) => d.drops.map((p) => p.placeId)).filter((x) => x && x !== "tbc"))];
  if (!loads.length && !drops.length) return null;
  return [
    { placeId: truckPlaceId ?? "", kind: "start" },
    ...loads.map((placeId) => ({ placeId, kind: "load" as const })),
    ...drops.map((placeId) => ({ placeId, kind: "offload" as const })),
    { placeId: drops.at(-1) ?? loads.at(-1) ?? truckPlaceId ?? "", kind: "end" },
  ];
}

/** What is missing on a row that has something in it, in words, or nothing. */
export function draftProblem(data: AppData, d: DraftConsignment, n: number): string | undefined {
  if (isEmptyDraft(d)) return undefined;
  const which = `${wl(data, "consignment")} ${n}`;
  if (!d.productId) return `Choose the goods on ${which}.`;
  if (d.qty.trim() && !(Number(d.qty) > 0)) return `The quantity on ${which} must be more than 0.`;
  if (data.settings.freight.consigneeMustBeParty && d.consigneeName.trim() && !d.consigneePartyId) return `Pick the consignee on ${which} from the ${wl(data, "customer", true)}: this company needs a record for every consignee.`;
  if (data.settings.freight.consigneePhoneRequired && !d.consigneePhone.trim() && !d.consigneePartyId) return `Enter the consignee's phone number on ${which}.`;
  if (d.drops.length > 1) {
    const placed = d.drops.reduce((s, x) => s + (Number(x.qty) || 0), 0);
    if (d.qty.trim() && Math.abs(placed - Number(d.qty)) > 0.001) return `The drops on ${which} add up to ${num(placed, 0, 3)}, not ${num(Number(d.qty), 0, 3)}.`;
  }
  if (d.ratePrice.trim() && !(Number(d.ratePrice) >= 0)) return `The rate on ${which} must be a price.`;
  if (d.contractCode && !d.useContract && !d.ratePrice.trim()) return `Type the other rate on ${which}, or use rate contract ${d.contractCode}.`;
  if (d.contractCode && !d.useContract && !d.rateReason.trim()) return `Say why ${which} isn't charged under rate contract ${d.contractCode}.`;
  return undefined;
}

/** The body `POST /trips` takes for each row: the route's loading and offloading points unless the row says otherwise. */
export function consignmentBody(data: AppData, d: DraftConsignment, stops: RouteStop[]) {
  const usual = d.pickups.length === 1 && d.drops.length === 1 && !d.pickups[0]!.placeId && !d.drops[0]!.placeId;
  return {
    lines: [{ productId: d.productId, ...(d.qty.trim() ? { plannedQty: Number(d.qty) } : {}) }],
    ...(d.customerId ? { customerId: d.customerId } : {}),
    ...(d.consignorPartyId ? { consignorPartyId: d.consignorPartyId } : d.consignorName.trim() ? { consignor: { name: d.consignorName.trim() } } : {}),
    ...(d.consigneePartyId ? { consigneePartyId: d.consigneePartyId }
      : d.consigneeName.trim() ? { consignee: { name: d.consigneeName.trim(), ...(d.consigneePhone.trim() ? { phone: d.consigneePhone.trim() } : {}) } } : {}),
    // One load and one drop at the route's own points: left to the server, as before.
    ...(usual ? {} : {
      legs: [
        ...d.pickups.map((p) => ({ kind: "pickup", ...(placeOf(p, stops, "pickup") ? { placeId: placeOf(p, stops, "pickup") } : {}) })),
        ...d.drops.map((x) => ({
          kind: "drop", ...(placeOf(x, stops, "drop") ? { placeId: placeOf(x, stops, "drop") } : {}),
          ...(d.drops.length > 1 && Number(x.qty) > 0 ? { planned: [{ line: 0, qty: Number(x.qty) }] } : {}),
        })),
      ],
    }),
    ...rateBody(data, d, Boolean(d.contractCode)),
  };
}

const MASS: Record<string, number> = { kg: 1, kgs: 1, t: 1000, mt: 1000, tonne: 1000, tonnes: 1000, ton: 1000, tons: 1000 };
const VOLUME: Record<string, number> = { l: 1, ltr: 1, litre: 1, litres: 1, liter: 1, liters: 1, m3: 1000, "m³": 1000, cbm: 1000 };

/**
 * What is on board between each pair of stops, from where each row is picked up and dropped, against the truck's
 * and the trailer's limits. Places not on the route yet are added as stops when the trip is made, so they are counted
 * then; the line says so.
 */
export function capacityLine(data: AppData, drafts: DraftConsignment[], stops: RouteStop[], truck?: Truck, trailer?: Trailer) {
  const legs = stops.map(() => ({ kg: 0, l: 0 }));
  let offRoute = false;
  for (const d of drafts) {
    const p = data.products.find((x) => x.id === d.productId) as Product | undefined;
    const q = Number(d.qty);
    if (!p || !(q > 0)) continue;
    const u = String(p.unit).toLowerCase();
    const kgEach = MASS[u] ? MASS[u]! : 0;
    const lEach = VOLUME[u] ? VOLUME[u]! : 0;
    if (!kgEach && !lEach) continue;
    const at = (placeId: string, kind: RouteStop["kind"]) => {
      const exact = stops.findIndex((s) => s.placeId === placeId && s.kind === kind);
      return exact >= 0 ? exact : stops.findIndex((s) => s.placeId === placeId);
    };
    const from = at(placeOf(d.pickups[0]!, stops, "pickup"), "load");
    if (from < 0) { offRoute = true; continue; }
    const drops = d.drops.map((x) => ({ i: x.placeId === "tbc" ? stops.length - 1 : at(placeOf(x, stops, "drop"), "offload"), qty: d.drops.length > 1 ? Number(x.qty) || 0 : q }));
    if (drops.some((x) => x.i < 0)) offRoute = true;
    for (const x of drops.filter((y) => y.i > from)) {
      for (let i = from; i < x.i; i++) { legs[i]!.kg += x.qty * kgEach; legs[i]!.l += x.qty * lEach; }
    }
  }
  // The smaller of the truck's payload and the trailer's weight limit, and the trailer's litres: what the server checks (#102).
  const trailerKg = trailer?.capacityKg ?? (trailer?.unit === "t" && trailer.capacity ? trailer.capacity * 1000 : undefined);
  const limitKg = Math.min(truck?.capacityT ? truck.capacityT * 1000 : Infinity, trailerKg ?? Infinity);
  const limitL = trailer?.capacityL ?? (trailer?.unit === "L" && trailer.capacity ? trailer.capacity : Infinity);
  const tolerance = 1 + data.settings.freight.capacityTolerancePercent / 100;
  const most = legs.reduce((m, x) => ({ kg: Math.max(m.kg, x.kg), l: Math.max(m.l, x.l) }), { kg: 0, l: 0 });
  const parts: string[] = [];
  if (most.kg || Number.isFinite(limitKg)) parts.push(`${num(most.kg / 1000, 0, 2)} t${Number.isFinite(limitKg) ? ` of ${num(limitKg / 1000, 0, 2)} t` : ""}`);
  if (most.l || Number.isFinite(limitL)) parts.push(`${num(most.l)} L${Number.isFinite(limitL) ? ` of ${num(limitL)} L` : ""}`);
  const name = (i: number) => data.places.find((p) => p.id === stops[i]?.placeId)?.name ?? `stop ${i + 1}`;
  const over = legs.flatMap((x, i) => [
    ...(x.kg > limitKg * tolerance ? [`From ${name(i)} to ${name(i + 1)}: ${num(x.kg / 1000, 0, 2)} t on board, more than ${trailerKg !== undefined && limitKg === trailerKg ? trailer?.plate ?? "the trailer" : truck?.plate ?? "the truck"} carries.`] : []),
    ...(x.l > limitL * tolerance ? [`From ${name(i)} to ${name(i + 1)}: ${num(x.l)} L on board, more than the trailer holds.`] : []),
  ]);
  return {
    text: parts.length ? `Most on board between two stops: ${parts.join(" · ")}` : "",
    note: offRoute ? "Places that aren't on the route yet become stops when the trip is made, and are counted then." : undefined,
    over, refuse: data.settings.freight.capacityCheck === "refuse",
  };
}

/** A row's price: asks which contract line covers it and keeps the answer on the row for the form's checks. */
function RowRate({ data, d, set, label, customerId, routeId, stops }: { data: AppData; d: DraftConsignment; set: (patch: Partial<DraftConsignment>) => void; label: string; customerId?: string; routeId?: string; stops: RouteStop[] }) {
  const fromPlaceId = placeOf(d.pickups[0]!, stops, "pickup") || undefined;
  const toPlaceId = [...d.drops].reverse().map((x) => placeOf(x, stops, "drop")).find(Boolean) || undefined;
  const found = useContractLine({ customerId: d.customerId || customerId, productId: d.productId || undefined, routeId: routeId || undefined, fromPlaceId, toPlaceId });
  const code = found.data?.line?.code;
  useEffect(() => { if (code !== d.contractCode) set({ contractCode: code }); }, [code, d.contractCode, set]);
  return <RateChoice data={data} d={d} set={set} answer={found.data} label={label} />;
}

export function ConsignmentRows({ data, value, stops, onChange, routeChosen, customerId, routeId }: { data: AppData; value: DraftConsignment[]; stops: RouteStop[]; onChange: (next: DraftConsignment[]) => void; routeChosen: boolean; customerId?: string; routeId?: string }) {
  const rules = data.settings.freight;
  const one = wl(data, "consignment");
  const canAdd = !rules.maxConsignmentsPerTrip || value.length < rules.maxConsignmentsPerTrip;
  const set = (key: string, patch: Partial<DraftConsignment>) => onChange(value.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  // Any saved party, not only customers: a consignee is often a depot or a co-operative (#102).
  const party = (name: string) => (data.parties ?? data.customers).find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
  const loadAt = data.places.find((p) => p.id === routePoint(stops, "load"))?.name;
  const dropAt = data.places.find((p) => p.id === routePoint(stops, "offload"))?.name;
  const onRoute = stops.filter((s) => s.placeId && s.kind !== "start" && s.kind !== "end");
  const others = data.places.filter((p) => !onRoute.some((s) => s.placeId === p.id));
  // With a saved route, an empty choice is the route's own point; with none, the rows build the route.
  const fromRows = !routeChosen;
  const placeOptions = (kind: "pickup" | "drop") => (
    <>
      <option value="">{fromRows ? "Choose a place…" : kind === "pickup" ? `The route's loading point${loadAt ? ` (${loadAt})` : ""}` : `The route's offloading point${dropAt ? ` (${dropAt})` : ""}`}</option>
      {kind === "drop" && <option value="tbc">To be confirmed</option>}
      <optgroup label={fromRows ? "Already on this trip" : "On the route"}>
        {onRoute.map((s, i) => <option key={`${s.placeId}-${i}`} value={s.placeId}>{data.places.find((p) => p.id === s.placeId)?.name ?? "—"}</option>)}
      </optgroup>
      <optgroup label={fromRows ? "Places" : "Another place (becomes a stop)"}>
        {others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </optgroup>
    </>
  );
  const legList = (d: DraftConsignment, kind: "pickups" | "drops", i: number) => {
    const list = d[kind];
    const unit = data.products.find((p) => p.id === d.productId)?.unit ?? "";
    const setLeg = (k: string, patch: Partial<DraftLeg>) => set(d.key, { [kind]: list.map((x) => (x.key === k ? { ...x, ...patch } : x)) });
    return (
      <div className="cn-row-legs">
        <span className="field-label">{kind === "pickups" ? "Picked up at" : "Dropped at"}</span>
        {list.map((x, j) => (
          <div key={x.key} className="cn-row-leg">
            <select className="input" aria-label={`${kind === "pickups" ? "Pickup" : "Drop"} ${j + 1} of ${one} ${i + 1}`} value={x.placeId} onChange={(e) => setLeg(x.key, { placeId: e.target.value })}>
              {placeOptions(kind === "pickups" ? "pickup" : "drop")}
            </select>
            {kind === "drops" && list.length > 1 && <UnitInput label={`Quantity at drop ${j + 1}`} unit={unit} value={x.qty} onChange={(v) => setLeg(x.key, { qty: v })} />}
            {list.length > 1 && <Button size="sm" tone="quiet" onClick={() => set(d.key, { [kind]: list.filter((y) => y.key !== x.key) })}>Remove</Button>}
          </div>
        ))}
        <button type="button" className="link-btn" onClick={() => set(d.key, { [kind]: [...list, { key: legKey(), placeId: "", qty: "" }] })}>
          {kind === "pickups" ? "Add another pickup" : "Add another drop"}
        </button>
      </div>
    );
  };
  return (
    <section className="consignment-rows" aria-label={w(data, "consignment", true)}>
      <h3>{w(data, "consignment", true)}</h3>
      <p className="muted">
        Each {one} is loaded and dropped where its row says, at the price agreed for it.
        {rules.consignmentBy === "loading" ? ` Leave a row empty to add the ${one} at loading.` : ` The trip can't leave without its ${one}.`}
      </p>
      <datalist id="party-names">{(data.parties ?? data.customers).map((c) => <option key={c.id} value={c.name} />)}</datalist>
      {value.map((d, i) => {
        const product = data.products.find((p) => p.id === d.productId);
        return (
          <div key={d.key} className="consignment-row">
            <header className="consignment-row-head">
              <strong>{w(data, "consignment")} {i + 1}</strong>
              {value.length > 1 && <Button size="sm" tone="quiet" onClick={() => onChange(value.filter((x) => x.key !== d.key))}>Remove</Button>}
            </header>
            <div className="consignment-row-grid">
              <Field label="Goods">
                <select value={d.productId} onChange={(e) => set(d.key, { productId: e.target.value })}>
                  <option value="">{rules.consignmentBy === "loading" ? "Add it at loading" : "Choose…"}</option>
                  {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Quantity">
                <UnitInput label={`Quantity on ${one} ${i + 1}`} unit={product?.unit ?? ""} value={d.qty} onChange={(v) => set(d.key, { qty: v })} />
              </Field>
              <Field label="Bill to">
                <select value={d.customerId ?? ""} onChange={(e) => set(d.key, { customerId: e.target.value || undefined })}>
                  <option value="">The {wl(data, "trip")}'s {wl(data, "customer")}</option>
                  {data.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Consignor" hint={d.consignorPartyId ? "A saved party." : undefined}>
                <input list="party-names" value={d.consignorName} placeholder="The customer, unless you say" onChange={(e) => set(d.key, { consignorName: e.target.value, consignorPartyId: party(e.target.value)?.id })} />
              </Field>
              <Field label="Consignee" hint={d.consigneePartyId ? "A saved party." : d.consigneeName.trim() ? "Only a name and phone." : undefined}>
                <input list="party-names" value={d.consigneeName} placeholder="The customer, unless you say" onChange={(e) => { const p = party(e.target.value); set(d.key, { consigneeName: e.target.value, consigneePartyId: p?.id, ...(p?.phone ? { consigneePhone: p.phone } : {}) }); }} />
              </Field>
              <Field label="Consignee phone">
                <input type="tel" value={d.consigneePhone} placeholder={phonePlaceholder()} disabled={Boolean(d.consigneePartyId)} onChange={(e) => set(d.key, { consigneePhone: e.target.value })} />
              </Field>
              <RowRate data={data} d={d} set={(patch) => set(d.key, patch)} label={`${one} ${i + 1}`} customerId={customerId} routeId={routeId} stops={stops} />
            </div>
            <div className="consignment-row-legs">
              {legList(d, "pickups", i)}
              {legList(d, "drops", i)}
            </div>
          </div>
        );
      })}
      {canAdd && <div><Button size="sm" onClick={() => onChange([...value, draftConsignment(data.baseCurrency?.id)])}><Plus size={14} /> Add {one}</Button></div>}
    </section>
  );
}
