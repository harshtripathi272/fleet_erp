import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { useApp } from "../store";
import { can } from "../api/session";
import { placeName } from "../domain/helpers";
import { byId } from "../domain/calc";
import { w, wl } from "../domain/words";
import { Button, Drawer, Empty, Field, Segmented, Status, SwitchField, UnitInput } from "../ui/kit";
import { calendarDate, clockTime, day, hoursText, num, phonePlaceholder } from "../ui/format";
import { cnFrom, CN_STATUS_LABEL, cnStatusTone, maySplit, type Cn, type CnLeg } from "./model";
import { moneyText, qtyText } from "./TripConsignments";
import type { AppData } from "../domain/types";
import { RateChoice, rateBody, useContractLine, type RateDraft } from "./RateChoice";
import { RevenuePanel } from "./RevenuePanel";
import { SplitDelivery } from "./SplitDelivery";

/**
 * One consignment (#135, design 3.11.3): a wide drawer with its details, its pickups and drops, its papers, its
 * revenue and its history. A new one is made on a trip (`POST /consignments` with `tripId`); an existing one is saved
 * with `PATCH /consignments/:id` under its version.
 */

type Tab = "details" | "legs" | "documents" | "revenue" | "history";
type PartyPick = { partyId: string; name: string; phone: string };
type LineForm = { key: string; id?: string; productId: string; description: string; plannedQty: string; pieces: string; grossKg: string; volumeM3: string; declaredValue: string; hazard: boolean };
type Form = RateDraft & {
  consignmentTypeId: string; customerId: string; consignor: PartyPick; consignee: PartyPick; paymentTerms: "to_be_billed" | "paid" | "to_pay";
  lines: LineForm[]; customerRef: string; orderNo: string; lrNo: string; ewayBillNo: string; ewayBillValidUntil: string; sealNos: string; permitNo: string; notes: string;
};

let lineKeys = 0;
const newLine = (): LineForm => ({ key: `n${++lineKeys}`, productId: "", description: "", plannedQty: "", pieces: "", grossKg: "", volumeM3: "", declaredValue: "", hazard: false });
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

type Units = { id: string; code: string; minorUnits: number };
function formFrom(c: Cn | undefined, customerId: string, baseUnits: number, currencies: Units[] = [], baseId = ""): Form {
  const rateUnits = currencies.find((x) => x.id === c?.rate?.price.currencyId)?.minorUnits ?? baseUnits;
  const pick = (partyId: unknown, contact: Cn["consignee"]): PartyPick => ({ partyId: str(partyId), name: contact?.name ?? "", phone: contact?.phone ?? "" });
  return {
    consignmentTypeId: str(c?.consignmentTypeId), customerId: str(c?.customerId ?? customerId),
    consignor: pick(c?.consignorPartyId, c?.consignor), consignee: pick(c?.consigneePartyId, c?.consignee), paymentTerms: c?.paymentTerms ?? "to_be_billed",
    lines: c?.lines.length ? c.lines.map((l) => ({
      key: l.id, id: l.id, productId: l.productId, description: str(l.description), plannedQty: str(l.plannedQty), pieces: str(l.pieces), grossKg: str(l.grossKg),
      volumeM3: str(l.volumeM3), declaredValue: l.declaredValue ? String(l.declaredValue.amountMinor / 10 ** baseUnits) : "", hazard: Boolean(l.hazard),
    })) : [newLine()],
    customerRef: str(c?.references?.customerRef), orderNo: str(c?.references?.orderNo), lrNo: str(c?.references?.lrNo), ewayBillNo: str(c?.references?.ewayBillNo),
    ewayBillValidUntil: str(c?.references?.ewayBillValidUntil).slice(0, 10), sealNos: (c?.references?.sealNos ?? []).join(", "), permitNo: str(c?.references?.permitNo),
    notes: str((c as Rec | undefined)?.notes),
    rateBasis: c?.rate?.basis ?? "per_consignment", ratePrice: c?.rate ? String(c.rate.price.amountMinor / 10 ** rateUnits) : "",
    rateCurrencyId: c?.rate?.price.currencyId ?? baseId, rateOn: c?.rate?.chargeOn ?? "",
    useContract: c?.priceFrom?.kind !== "own" || c.priceFrom.approval === "rejected", rateReason: c?.priceFrom?.reason ?? "",
  };
}

/** The price part of the body: the contract, a typed rate with its reason, or the typed rate taken off. */
function priceBody(data: AppData, f: Form, underContract: boolean, hadRate: boolean): Rec {
  const body: Rec = rateBody(data, f, underContract);
  if (!("rate" in body) && !underContract && hadRate) body.rate = null;
  return body;
}

function bodyFrom(f: Form, base: { id: string; minorUnits: number } | undefined): Rec {
  const n = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const party = (p: PartyPick, key: "consignor" | "consignee") =>
    p.partyId ? { [`${key}PartyId`]: p.partyId } : p.name.trim() ? { [key]: { name: p.name.trim(), ...(p.phone.trim() ? { phone: p.phone.trim() } : {}) } } : {};
  const references = Object.fromEntries(Object.entries({
    customerRef: f.customerRef.trim(), orderNo: f.orderNo.trim(), lrNo: f.lrNo.trim(), ewayBillNo: f.ewayBillNo.trim(), ewayBillValidUntil: f.ewayBillValidUntil,
    permitNo: f.permitNo.trim(), sealNos: f.sealNos.split(",").map((s) => s.trim()).filter(Boolean),
  }).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
  return {
    ...(f.consignmentTypeId ? { consignmentTypeId: f.consignmentTypeId } : {}),
    ...(f.customerId ? { customerId: f.customerId } : {}),
    ...party(f.consignor, "consignor"), ...party(f.consignee, "consignee"),
    paymentTerms: f.paymentTerms,
    lines: f.lines.filter((l) => l.productId).map((l) => Object.fromEntries(Object.entries({
      id: l.id, productId: l.productId, description: l.description.trim() || undefined, plannedQty: n(l.plannedQty), pieces: n(l.pieces), grossKg: n(l.grossKg), volumeM3: n(l.volumeM3),
      declaredValue: l.declaredValue.trim() && base ? { amountMinor: Math.round(Number(l.declaredValue) * 10 ** base.minorUnits), currencyId: base.id } : undefined,
      hazard: l.hazard || undefined,
    }).filter(([, v]) => v !== undefined))),
    ...(Object.keys(references).length ? { references } : {}),
    ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
  };
}

export function ConsignmentDrawer({ id, tripId, onClose }: { id?: string; tripId: string; onClose: () => void }) {
  const { data, toast, me } = useApp();
  // Revenue is money: only for those who may see it. A rate typed while booking is anyone's (#151, Q9).
  const decidesRates = can(me, "consignment-revenue", "update");
  const client = useQueryClient();
  const trip = byId(data.trips, tripId);
  const one = w(data, "consignment");
  const record = useQuery({ queryKey: ["consignment", id], queryFn: () => api<Rec>(`/consignments/${id}`), enabled: Boolean(id) });
  const types = useQuery({ queryKey: ["consignment-types-active"], queryFn: () => api<Rec[]>("/consignment-types", { query: { limit: 100, status: "active" } }).catch(() => []) });
  const partyName = (pid: unknown) => (pid ? byId(data.customers, String(pid))?.name : undefined);
  const partyPhone = (pid: unknown) => (pid ? byId(data.customers, String(pid))?.phone : undefined);
  const c = useMemo(() => (record.data ? cnFrom(record.data, partyName, partyPhone) : undefined), [record.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = data.baseCurrency;
  const saved = useMemo(() => formFrom(c, trip?.customerId ?? "", base?.minorUnits ?? 2, data.currencies ?? [], base?.id ?? ""), [c, trip?.customerId, base?.minorUnits, base?.id, data.currencies]);
  const [form, setForm] = useState<Form>(saved);
  const [tab, setTab] = useState<Tab>("details");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [splitting, setSplitting] = useState<null | "split" | "change">(null);
  // The extra fields sit under "More" (#135 Part 5); open from the start when any of them is filled, so nothing is hidden.
  const [more, setMore] = useState(() => hasExtras(saved));
  useEffect(() => setForm(saved), [saved]);
  const pickupAt = c?.legs.find((l) => l.kind === "pickup")?.placeId;
  const dropAt = c?.legs.filter((l) => l.kind === "drop" && l.placeId).at(-1)?.placeId;
  const contract = useContractLine({ customerId: form.customerId || undefined, productId: form.lines[0]?.productId || undefined, tripId, fromPlaceId: pickupAt ? String(pickupAt) : undefined, toPlaceId: dropAt ? String(dropAt) : undefined });
  const underContract = Boolean(contract.data?.line);
  const price = (f: Form) => priceBody(data, f, underContract, Boolean(c?.rate));
  const dirty = JSON.stringify({ ...bodyFrom(form, base), ...price(form) }) !== JSON.stringify({ ...bodyFrom(saved, base), ...price(saved) });
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setLine = (key: string, patch: Partial<LineForm>) => set("lines", form.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const closed = Boolean(c && ["delivered", "closed", "cancelled", "returned", "written_off"].includes(c.status));

  const after = async (message: string) => {
    toast(message);
    await client.invalidateQueries({ queryKey: ["consignment", id] });
    await client.invalidateQueries({ queryKey: ["trip-capacity", tripId] });
    await client.refetchQueries({ queryKey: ["operations"] });
  };
  const save = async () => {
    setBusy(true);
    setProblem("");
    try {
      if (underContract && !form.useContract && !form.rateReason.trim()) throw new ApiError(`Say why this ${wl(data, "consignment")} isn't charged under rate contract ${contract.data?.line?.code}.`, 400);
      // The price is sent only when it changed, so saving the goods doesn't choose the price again.
      const priceChanged = JSON.stringify(price(form)) !== JSON.stringify(price(saved));
      if (id) await api(`/consignments/${id}`, { method: "PATCH", body: { version: c!.version, ...bodyFrom(form, base), ...(priceChanged ? price(form) : {}) } });
      else await api("/consignments", { method: "POST", body: { tripId, ...bodyFrom(form, base), ...price(form) } });
      await after(id ? `${one} saved.` : `${one} added to the ${wl(data, "trip")}.`);
      if (!id) onClose();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await api(`/consignments/${id}/cancel`, { method: "POST", body: { version: c!.version, reason: reason.trim() } });
      await after(`${c!.number} cancelled.`);
      onClose();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const title = c ? c.consigneeName : `New ${wl(data, "consignment")}`;
  const plate = trip ? byId(data.trucks, trip.truckId)?.plate : undefined;
  const editable = !id || !closed;
  return (
    <Drawer open title={title} onClose={onClose} width={typeof window !== "undefined" && window.innerWidth >= 1600 ? 880 : 720}
      footer={editable && tab === "details" ? (
        <>
          {id && !cancelling && <Button tone="quiet" className="cn-cancel" onClick={() => setCancelling(true)}>Cancel this {wl(data, "consignment")}</Button>}
          {cancelling && (
            <span className="cn-cancel-confirm">
              <input className="input" placeholder="Why it is cancelled" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Why it is cancelled" />
              <Button tone="danger" disabled={!reason.trim()} busy={busy} onClick={() => void cancel()}>Cancel it</Button>
              <Button tone="quiet" onClick={() => setCancelling(false)}>Keep it</Button>
            </span>
          )}
          <Button tone="quiet" onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} disabled={(Boolean(id) && !dirty) || !form.lines.some((l) => l.productId)} onClick={() => void save()}>{id ? "Save" : `Add ${wl(data, "consignment")}`}</Button>
        </>
      ) : undefined}>
      {c && (
        <p className="cn-ids">
          <span className="mono">{c.number}</span> · <Status tone={cnStatusTone(c.status)}>{CN_STATUS_LABEL[c.status] ?? c.status}</Status>
          {c.consignmentTypeId && <> · {String((types.data ?? []).find((t) => t.id === c.consignmentTypeId)?.name ?? "")}</>}
          {trip && <> · <span className="mono">{trip.no}</span>{plate && <> · {plate}</>}</>}
        </p>
      )}
      {id && record.isLoading && <p className="muted">Loading…</p>}
      {id && record.error && <Empty title={`Could not load the ${wl(data, "consignment")}`}>{(record.error as Error).message}</Empty>}
      {(!id || c) && (
        <>
          {id && (
            <div className="seg-tabs" role="tablist" aria-label={one}>
              {([["details", "Details"], ["legs", "Loads and drops"], ["documents", "Papers"], ...(c?.revenue ? [["revenue", "Revenue"]] : []), ["history", "Timeline"]] as [Tab, string][]).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
              ))}
            </div>
          )}
          {problem && <p className="form-problem" role="alert">{problem}</p>}

          {tab === "details" && (
            <fieldset className="cn-form" disabled={!editable}>
              <h4>Parties</h4>
              <div className="grid-2">
                <Field label="Bill to">
                  <select value={form.customerId} onChange={(e) => set("customerId", e.target.value)}>
                    {data.customers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <PartyField data={data} label="Consignor" value={form.consignor} onChange={(v) => set("consignor", v)} emptyText="The customer" />
                <PartyField data={data} label="Consignee" value={form.consignee} onChange={(v) => set("consignee", v)} emptyText="The customer" phone />
              </div>

              <h4>Price</h4>
              {c?.priceFrom && <PriceFromLine data={data} c={c} decides={decidesRates} onDecided={() => after("Rate decided.")} />}
              <RateChoice data={data} d={form} set={(patch) => setForm((f) => ({ ...f, ...patch }))} answer={contract.data} label={one} />


              <h4>Goods</h4>
              <div className="cn-lines">
                {form.lines.map((l, i) => {
                  const product = byId(data.products, l.productId);
                  return (
                    <div key={l.key} className="item-card">
                      <header>
                        <strong>Line {i + 1}</strong>
                        {form.lines.length > 1 && <Button size="sm" tone="quiet" onClick={() => set("lines", form.lines.filter((x) => x.key !== l.key))}>Remove</Button>}
                      </header>
                      <div className="cn-line-grid">
                        <Field label="Goods">
                          <select value={l.productId} onChange={(e) => setLine(l.key, { productId: e.target.value })}>
                            <option value="">Choose…</option>
                            {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </Field>
                        <Field label="As on the papers"><input value={l.description} placeholder={product?.name ?? ""} onChange={(e) => setLine(l.key, { description: e.target.value })} /></Field>
                        <Field label="Planned quantity"><UnitInput label={`Planned quantity, line ${i + 1}`} unit={product?.unit ?? ""} value={l.plannedQty} onChange={(v) => setLine(l.key, { plannedQty: v })} /></Field>
                        {more && <>
                        <Field label="Pieces"><UnitInput label={`Pieces, line ${i + 1}`} unit="pieces" step={1} value={l.pieces} onChange={(v) => setLine(l.key, { pieces: v })} /></Field>
                        <Field label="Gross weight"><UnitInput label={`Gross weight, line ${i + 1}`} unit="kg" value={l.grossKg} onChange={(v) => setLine(l.key, { grossKg: v })} /></Field>
                        <Field label="Volume"><UnitInput label={`Volume, line ${i + 1}`} unit="m³" value={l.volumeM3} onChange={(v) => setLine(l.key, { volumeM3: v })} /></Field>
                        <Field label="Declared value"><UnitInput label={`Declared value, line ${i + 1}`} unit={base?.code ?? ""} value={l.declaredValue} onChange={(v) => setLine(l.key, { declaredValue: v })} /></Field>
                        <SwitchField label="Hazardous" checked={l.hazard} onChange={(on) => setLine(l.key, { hazard: on })} />
                        </>}
                      </div>
                    </div>
                  );
                })}
                {editable && <div><Button size="sm" onClick={() => set("lines", [...form.lines, newLine()])}><Plus size={14} /> Add a line</Button></div>}
              </div>

              {editable && <div>
                <Button size="sm" tone="quiet" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Fewer details" : "More details"}</Button>
                {!more && <span className="muted"> Type, payment terms, pieces, weight, declared value, hazardous, references, e-way bill, permit and notes.</span>}
              </div>}
              {more && <>
              <h4>More details</h4>
              <div className="grid-2">
                <Field label={`${one} type`} hint="The type sets the cargo kind, whether it may have several pickups or drops, and the papers it needs. Empty: the company's default.">
                  <select value={form.consignmentTypeId} onChange={(e) => set("consignmentTypeId", e.target.value)}>
                    <option value="">The company's default</option>
                    {(types.data ?? []).map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>)}
                  </select>
                </Field>
                <FieldPayment value={form.paymentTerms} onChange={(v) => set("paymentTerms", v)} />
              </div>
              <h5>References</h5>
              <div className="grid-2">
                <Field label="Customer reference"><input value={form.customerRef} onChange={(e) => set("customerRef", e.target.value)} /></Field>
                <Field label="Order number"><input value={form.orderNo} onChange={(e) => set("orderNo", e.target.value)} /></Field>
                <Field label={`${w(data, "consignmentNote")} number`} hint="The company's own book, when it keeps one apart from these numbers."><input value={form.lrNo} onChange={(e) => set("lrNo", e.target.value)} /></Field>
                <Field label="Seal numbers" hint="Separated by commas."><input value={form.sealNos} onChange={(e) => set("sealNos", e.target.value)} /></Field>
                <Field label="E-way bill"><input value={form.ewayBillNo} onChange={(e) => set("ewayBillNo", e.target.value)} /></Field>
                <Field label="E-way bill valid until"><input type="date" value={form.ewayBillValidUntil} onChange={(e) => set("ewayBillValidUntil", e.target.value)} /></Field>
                <Field label="Permit"><input value={form.permitNo} onChange={(e) => set("permitNo", e.target.value)} /></Field>
              </div>
              <Field label="Notes"><textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
              </>}
              {!id && <p className="muted">It is loaded at the {wl(data, "trip")}'s next loading stop and dropped at the offloading stop after it. Change that under Loads and drops once it is added.</p>}
            </fieldset>
          )}

          {tab === "legs" && c && <Legs data={data} c={c} splittable={maySplit(c, types.data)} onSplit={() => setSplitting("split")} onChange={() => setSplitting("change")} />}
          {tab === "documents" && c && <Papers data={data} c={c} onAdded={() => void after("Paper added.")} />}
          {tab === "revenue" && c?.revenue && <RevenuePanel c={c} onChanged={() => after("Revenue updated.")} />}
          {tab === "history" && c && <Timeline data={data} c={c} />}
        </>
      )}
      {splitting && c && <SplitDelivery c={c} mode={splitting} onClose={() => setSplitting(null)} onSaved={() => { setSplitting(null); void after("Saved. The trip's stops follow, and the driver has the new list."); }} />}
    </Drawer>
  );
}

/** Whether any field under "More" holds something (the type shows in the header, so it doesn't count). */
function hasExtras(f: Form) {
  return f.paymentTerms !== "to_be_billed" || [f.customerRef, f.orderNo, f.lrNo, f.sealNos, f.ewayBillNo, f.ewayBillValidUntil, f.permitNo, f.notes].some((v) => v.trim())
    || f.lines.some((l) => l.hazard || [l.pieces, l.grossKg, l.volumeM3, l.declaredValue].some((v) => String(v ?? "").trim()));
}

function FieldPayment({ value, onChange }: { value: Form["paymentTerms"]; onChange: (v: Form["paymentTerms"]) => void }) {
  return (
    <div className="field" role="group" aria-label="Payment terms">
      <span className="field-label">Payment terms</span>
      <Segmented choice label="Payment terms" value={value} onChange={onChange}
        options={[{ value: "to_be_billed", label: "To be billed" }, { value: "paid", label: "Paid" }, { value: "to_pay", label: "To pay" }]} />
    </div>
  );
}

/** A party picked from the customers by name, or a name and phone typed for someone who isn't a party. */
function PartyField({ data, label, value, onChange, emptyText, phone }: { data: ReturnType<typeof useApp>["data"]; label: string; value: PartyPick; onChange: (v: PartyPick) => void; emptyText: string; phone?: boolean }) {
  const listId = `parties-${label}`;
  const shown = value.partyId ? byId(data.customers, value.partyId)?.name ?? value.name : value.name;
  const typed = (name: string) => {
    const party = data.customers.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
    onChange(party ? { partyId: party.id, name: party.name, phone: party.phone ?? "" } : { partyId: "", name, phone: value.phone });
  };
  return (
    <div className="cn-party-field">
      <Field label={label} hint={value.partyId ? "A saved party." : value.name.trim() ? "Only a name and phone, typed here." : undefined}>
        <input list={listId} value={shown} placeholder={emptyText} onChange={(e) => typed(e.target.value)} />
      </Field>
      <datalist id={listId}>{data.customers.map((p) => <option key={p.id} value={p.name} />)}</datalist>
      {phone && (
        <Field label={`${label}'s phone`}>
          <input type="tel" value={value.partyId ? byId(data.customers, value.partyId)?.phone ?? "" : value.phone} disabled={Boolean(value.partyId)} placeholder={phonePlaceholder()} onChange={(e) => onChange({ ...value, phone: e.target.value })} />
        </Field>
      )}
    </div>
  );
}

function legQty(c: Cn, l: CnLeg) {
  const unit = c.lines[0]?.unit ?? "";
  if (l.status === "done") return qtyText(l.actual?.reduce((s, m) => s + (m.accepted ?? m.qty), 0), unit);
  const planned = l.planned?.reduce((s, p) => s + (p.qty ?? 0), 0);
  return planned ? `${qtyText(planned, unit)} planned` : "";
}

/** Loads and drops (design 3.11.3): pickups, then drops, each a numbered card; "Split delivery" when it may have several drops. */
function Legs({ data, c, splittable, onSplit, onChange }: { data: ReturnType<typeof useApp>["data"]; c: Cn; splittable: boolean; onSplit: () => void; onChange: () => void }) {
  const open = c.legs.some((l) => l.kind === "drop" && l.status === "planned");
  const card = (l: CnLeg, n: number) => (
    <div key={l.id} className="item-card">
      <header>
        <strong>{l.kind === "pickup" ? "Pickup" : "Drop"} {n}</strong>
        <Status tone={l.status === "done" ? "ok" : l.status === "skipped" ? "mute" : "wait"}>{l.status === "done" ? (l.outcome === "partial" ? "Part delivered" : "Done") : l.status === "skipped" ? "Skipped" : "Planned"}</Status>
      </header>
      <div className="cn-leg-body">
        <span><b>{l.placeId ? placeName(data, l.placeId) : "To be confirmed"}</b></span>
        <span className="num">{legQty(c, l)}</span>
        {l.recordedAt && <span className="muted">Recorded {day(l.recordedAt)} {clockTime(l.recordedAt)}</span>}
        {l.pod?.number && <span>Proof of delivery <span className="mono">{l.pod.number}</span>{l.pod.receivedBy ? `, received by ${l.pod.receivedBy}` : ""}</span>}
        {l.pod?.remarks && <span className="muted">“{l.pod.remarks}”</span>}
        {l.contact && <span>{l.contact.name}{l.contact.phone ? ` · ${l.contact.phone}` : ""}</span>}
        {l.actual?.some((m) => m.damaged) && <span className="cn-warn">{num(l.actual.reduce((s, m) => s + (m.damaged ?? 0), 0), 0, 3)} damaged</span>}
      </div>
    </div>
  );
  const pickups = c.legs.filter((l) => l.kind === "pickup");
  const drops = c.legs.filter((l) => l.kind === "drop");
  return (
    <div className="cn-legs">
      <h4>Pickups</h4>
      {pickups.map((l, i) => card(l, i + 1))}
      <h4>Drops</h4>
      {drops.map((l, i) => card(l, i + 1))}
      {c.legs.some((l) => l.status === "planned") && (
        <div className="row-actions">
          <Button onClick={onChange}>Change pickups and drops</Button>
          {open && splittable && <Button onClick={onSplit}>Split delivery</Button>}
        </div>
      )}
      {open && !splittable && <p className="muted">This {w(data, "consignment").toLowerCase()}'s type is dropped at one place. To split it between places, give it a type that allows several drops under Details.</p>}
    </div>
  );
}

/** The office adds a paper it holds, or one to follow, to a pickup or drop (#102: a truck waited for an invoice nobody could add). */
function AddPaper({ c, onAdded }: { c: Cn; onAdded: () => void }) {
  const { data, toast } = useApp();
  const types = useQuery({ queryKey: ["consignment-document-types"], queryFn: () => api<Rec[]>("/consignment-document-types", { query: { status: "active", limit: 100 } }).catch(() => []) });
  const [legId, setLegId] = useState(c.legs.find((l) => l.kind === "pickup")?.id ?? "");
  const [documentTypeId, setType] = useState("");
  const [number, setNumber] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const leg = c.legs.find((l) => l.id === legId);
  const offered = (types.data ?? []).filter((t) => !leg || t.step === (leg.kind === "pickup" ? "pickup" : "drop"));
  // The usual paper for the leg is chosen at first, once in the list, not twice (#102).
  const usual = offered.find((t) => t.code === (leg?.kind === "drop" ? "POD" : "LOADING_INVOICE"));
  const chosen = documentTypeId || (usual ? String(usual.id) : "");
  const add = async () => {
    setBusy(true);
    try {
      await api(`/consignments/${c.id}/documents`, { method: "POST", body: { ...(legId ? { legId } : {}), ...(chosen ? { documentTypeId: chosen } : {}), number: number.trim(), ...(date ? { date } : {}) } });
      setNumber(""); setDate("");
      onAdded();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cn-add-paper">
      <h4>Add a paper</h4>
      <div className="cn-add-paper-grid">
        <Field label="For">
          <select value={legId} onChange={(e) => { setLegId(e.target.value); setType(""); }}>
            {c.legs.map((l, i) => <option key={l.id} value={l.id}>{l.kind === "pickup" ? "Pickup" : "Drop"} {i + 1}{l.placeId ? ` at ${placeName(data, l.placeId)}` : ""}</option>)}
          </select>
        </Field>
        <Field label="Paper">
          <select value={chosen} onChange={(e) => setType(e.target.value)}>
            {!usual && <option value="">{leg?.kind === "drop" ? "Proof of delivery" : "Loading invoice"}</option>}
            {offered.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>)}
          </select>
        </Field>
        <Field label="Number"><input value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <div><Button size="sm" busy={busy} disabled={!number.trim()} onClick={() => void add()}>Add the paper</Button></div>
    </div>
  );
}

function Papers({ data, c, onAdded }: { data: ReturnType<typeof useApp>["data"]; c: Cn; onAdded: () => void }) {
  const where = (legId?: string) => {
    const l = c.legs.find((x) => x.id === legId);
    return l ? `${l.kind === "pickup" ? "Pickup" : "Drop"} at ${l.placeId ? placeName(data, l.placeId) : "a place to be confirmed"}` : "The consignment";
  };
  if (!c.documents.length) return <><Empty title="No papers yet">The loading invoice, weighbridge ticket, delivery note and proof of delivery appear here as they are recorded.</Empty><AddPaper c={c} onAdded={onAdded} /></>;
  return (
    <>
    <div className="table-frame">
      <table className="table">
        <thead><tr><th>Paper</th><th>Number</th><th>Date</th><th>For</th><th>From</th><th className="num">Value</th></tr></thead>
        <tbody>
          {c.documents.map((d) => (
            <tr key={d.id}>
              <td>{d.label ?? "Paper"}</td>
              <td className="mono">{d.number ?? "—"}</td>
              <td>{d.date ? calendarDate(d.date) : d.at ? calendarDate(d.at) : "—"}</td>
              <td>{where(d.legId)}</td>
              <td>{d.driverDocId ? "The driver" : d.fileId ? "The office, uploaded" : "The office, typed"}</td>
              <td className="num">{d.amount ? moneyText(data, d.amount.amountMinor, d.amount.currencyId) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  
    <AddPaper c={c} onAdded={onAdded} />
    </>
  );
}

/**
 * The consignment's timeline (#135 Part 3): one line per pickup and per drop, with the place, when the truck arrived,
 * when the load or drop was recorded, when the truck left, the quantity, and each paper as in or missing; the time
 * from first loading to last drop, and the trips it has been on. Read from what is already stored: no new records.
 */
function Timeline({ data, c }: { data: ReturnType<typeof useApp>["data"]; c: Cn }) {
  const types = useQuery({ queryKey: ["consignment-document-types"], queryFn: () => api<Rec[]>("/consignment-document-types", { query: { status: "active", limit: 100 } }).catch(() => []) });
  const moves = ((c as unknown as Rec).movements ?? []) as Rec[];
  const trip = byId(data.trips, c.tripId ?? undefined);
  const stopOf = (stopId: string | null) => trip?.stops.find((s) => s.id === stopId);
  const when = (iso?: string | null) => (iso ? `${day(iso)} ${clockTime(iso)}` : "—");
  const unit = c.lines[0]?.unit ?? "";
  const usual = new Set(["LOADING_INVOICE", "POD"]);
  const papersFor = (l: CnLeg) => {
    const step = l.kind === "pickup" ? "pickup" : "drop";
    const asked = (types.data ?? []).filter((t) => t.step === step && (usual.has(String(t.code)) || (t.requiredBy && t.requiredBy !== "none")));
    const have = c.documents.filter((d) => d.legId === l.id);
    const podIn = Boolean(l.pod?.number || l.pod?.docIds?.length);
    return asked.map((t) => {
      const doc = have.find((d) => d.documentTypeId === t.id);
      const isIn = Boolean(doc) || (t.driverKind === "pod" || t.driverKind === "delivery" ? podIn : false);
      return { name: String(t.name), isIn, number: doc?.number ?? (isIn ? l.pod?.number : undefined) };
    });
  };
  const firstUp = c.legs.filter((l) => l.kind === "pickup" && l.recordedAt).map((l) => l.recordedAt!).sort()[0];
  const lastDown = c.legs.filter((l) => l.kind === "drop" && l.recordedAt).map((l) => l.recordedAt!).sort().at(-1);
  const allDropped = c.legs.filter((l) => l.kind === "drop" && l.status !== "skipped").every((l) => l.status === "done");
  const onRoad = firstUp && lastDown && allDropped ? (new Date(lastDown).getTime() - new Date(firstUp).getTime()) / 36e5 : undefined;
  return (
    <div className="cn-timeline">
      <p>
        Booked {when(c.bookedAt)}.{" "}
        {onRoad !== undefined ? `From first loading to last drop: ${hoursText(onRoad)}.` : firstUp ? `Loading began ${when(firstUp)}; still on the way.` : "Not loaded yet."}
      </p>
      <ol className="cn-timeline-list">
        {c.legs.map((l) => {
          const stop = stopOf(l.stopId);
          // The gate times typed with the record win over the stop's (#102).
          const arrived = l.times?.arrivedAt ?? stop?.arrivedAt;
          const left = l.times?.leftAt ?? stop?.leftAt;
          const waited = arrived ? ((left ? new Date(left) : new Date()).getTime() - new Date(arrived).getTime()) / 36e5 : undefined;
          const qty = l.status === "done" ? l.actual?.reduce((s2, m) => s2 + (m.accepted ?? m.qty), 0) : l.planned?.reduce((s2, p) => s2 + (p.qty ?? 0), 0);
          return (
            <li key={l.id}>
              <div className="cn-timeline-head">
                <strong>{l.kind === "pickup" ? "Loaded at" : "Dropped at"} {l.placeId ? placeName(data, l.placeId) : "a place to be confirmed"}</strong>
                <Status tone={l.status === "done" ? "ok" : l.status === "skipped" ? "mute" : "wait"}>{l.status === "done" ? "Done" : l.status === "skipped" ? "Skipped" : "To come"}</Status>
              </div>
              <dl className="cn-timeline-facts">
                <div><dt>Arrived</dt><dd>{when(arrived)}</dd></div>
                {l.times?.waitedMinutes !== undefined && <div><dt>Waited before {l.kind === "pickup" ? "loading" : "offloading"}</dt><dd>{hoursText(l.times.waitedMinutes / 60)}</dd></div>}
                {l.times?.startedAt && <div><dt>{l.kind === "pickup" ? "Loading" : "Offloading"}</dt><dd>{when(l.times.startedAt)}{l.times.finishedAt ? ` to ${when(l.times.finishedAt)}` : ""}</dd></div>}
                <div><dt>{l.kind === "pickup" ? "Loading recorded" : "Drop recorded"}</dt><dd>{when(l.recordedAt)}</dd></div>
                <div><dt>Left</dt><dd>{when(left)}</dd></div>
                <div><dt>At the stop</dt><dd>{waited !== undefined ? `${hoursText(waited)}${left ? "" : " so far"}` : "—"}</dd></div>
                {l.loading && <div><dt>Loading order</dt><dd>{[l.loading.orderNo, l.loading.bay, l.loading.supervisor].filter(Boolean).join(" · ")}</dd></div>}
                <div><dt>Quantity</dt><dd className="num">{qty ? `${num(qty, 0, 3)}\u00a0${unit}${l.status === "done" ? "" : " planned"}` : "—"}</dd></div>
              </dl>
              {papersFor(l).length > 0 && (
                <p className="cn-timeline-papers">
                  {papersFor(l).map((p, i) => <span key={p.name}>{i ? " · " : ""}{p.name}: {p.isIn ? <>in{p.number ? <> (<span className="mono">{p.number}</span>)</> : null}</> : <span className="cn-warn">missing</span>}</span>)}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {moves.length > 0 && (
        <>
          <h4>Trips it has been on</h4>
          <ol className="plain">
            {moves.map((m, i) => (
              <li key={i}><span className="mono">{byId(data.trips, String(m.tripId))?.no ?? "A trip"}</span> from {day(String(m.from))}{m.to ? ` to ${day(String(m.to))}` : ["delivered", "closed", "cancelled", "returned", "written_off"].includes(c.status) ? "" : ", now"}{m.reason && m.reason !== "assigned" ? ` · ${String(m.reason)}` : ""}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/**
 * Where the price comes from, in one line (#151): the rate contract, or a typed rate with its reason, and whether it
 * waits for Finance. Someone who decides prices approves or refuses a waiting rate here.
 */
function PriceFromLine({ data, c, decides, onDecided }: { data: AppData; c: Cn; decides: boolean; onDecided: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const from = c.priceFrom!;
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setProblem("");
    try {
      await api(`/consignments/${c.id}/rate-decision`, { method: "POST", body: { decision, ...(note.trim() ? { note: note.trim() } : {}) } });
      await onDecided();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  const text = from.kind === "contract"
    ? `Priced by rate contract ${from.contractCode ?? ""}.${from.approval === "rejected" ? ` Another rate was asked for${from.reason ? ` (${from.reason})` : ""} and refused${from.decisionNote ? `: ${from.decisionNote}` : ""}.` : ""}`
    : from.contractCode
      ? `Charged at a typed rate instead of rate contract ${from.contractCode}${from.reason ? `, because: ${from.reason}` : ""}.${from.approval === "pending" ? ` Waiting for Finance; until then ${from.contractCode} prices it.` : from.approval === "approved" ? " Approved by Finance." : ""}`
      : `Charged at the rate typed for this ${wl(data, "consignment")}.`;
  return (
    <div className="price-from">
      <p>{from.approval === "pending" && <Status tone="wait">Waiting for Finance</Status>} {text}</p>
      {from.approval === "pending" && decides && (
        <div className="price-from-decide">
          <input className="input" aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" tone="primary" busy={busy} onClick={() => void decide("approve")}>Approve the rate</Button>
          <Button size="sm" busy={busy} onClick={() => void decide("reject")}>Refuse: use the contract</Button>
        </div>
      )}
      {problem && <p className="form-problem" role="alert">{problem}</p>}
    </div>
  );
}
