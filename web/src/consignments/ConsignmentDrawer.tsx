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
import { calendarDate, clockTime, day, num, phonePlaceholder } from "../ui/format";
import { cnFrom, CN_STATUS_LABEL, cnStatusTone, maySplit, type Cn, type CnLeg } from "./model";
import { moneyText, qtyText } from "./TripConsignments";
import { RATE_BASES } from "./ConsignmentRows";
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
type Form = {
  consignmentTypeId: string; customerId: string; consignor: PartyPick; consignee: PartyPick; paymentTerms: "to_be_billed" | "paid" | "to_pay";
  rateBasis: string; ratePrice: string; rateCurrencyId: string; rateOn: "" | "loaded" | "delivered";
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
  };
}

function bodyFrom(f: Form, base: { id: string; minorUnits: number } | undefined, currencies: Units[] = []): Rec {
  const rateUnits = currencies.find((x) => x.id === f.rateCurrencyId)?.minorUnits ?? base?.minorUnits ?? 2;
  const rate = f.ratePrice.trim() && f.rateCurrencyId
    ? { basis: f.rateBasis, price: { amountMinor: Math.round(Number(f.ratePrice) * 10 ** rateUnits * 1e4) / 1e4, currencyId: f.rateCurrencyId }, ...(f.rateOn && !["per_consignment", "per_km"].includes(f.rateBasis) ? { chargeOn: f.rateOn } : {}) }
    : null;
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
    rate,
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
  // Rates are money: only for those who may see it (consignment-revenue's sensitive switch).
  const seesMoney = can(me, "consignment-revenue", "sensitive");
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
  const [splitting, setSplitting] = useState(false);
  useEffect(() => setForm(saved), [saved]);
  const dirty = JSON.stringify(bodyFrom(form, base, data.currencies)) !== JSON.stringify(bodyFrom(saved, base, data.currencies));
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
      if (id) {
        const { rate, ...rest } = bodyFrom(form, base, data.currencies);
        await api(`/consignments/${id}`, { method: "PATCH", body: { version: c!.version, ...rest, ...(seesMoney ? { rate } : {}) } });
      }
      else {
        const { rate, ...rest } = bodyFrom(form, base, data.currencies);
        await api("/consignments", { method: "POST", body: { tripId, ...rest, ...(rate && seesMoney ? { rate } : {}) } });
      }
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
              {([["details", "Details"], ["legs", "Loads and drops"], ["documents", "Papers"], ...(c?.revenue ? [["revenue", "Revenue"]] : []), ["history", "History"]] as [Tab, string][]).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
              ))}
            </div>
          )}
          {problem && <p className="form-problem" role="alert">{problem}</p>}

          {tab === "details" && (
            <fieldset className="cn-form" disabled={!editable}>
              <Field label={`${one} type`} hint="The type sets the cargo kind, whether it may have several pickups or drops, and the papers it needs. Empty: the company's default.">
                <select value={form.consignmentTypeId} onChange={(e) => set("consignmentTypeId", e.target.value)}>
                  <option value="">The company's default</option>
                  {(types.data ?? []).map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>)}
                </select>
              </Field>

              <h4>Parties</h4>
              <div className="grid-2">
                <Field label="Bill to">
                  <select value={form.customerId} onChange={(e) => set("customerId", e.target.value)}>
                    {data.customers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <FieldPayment value={form.paymentTerms} onChange={(v) => set("paymentTerms", v)} />
                <PartyField data={data} label="Consignor" value={form.consignor} onChange={(v) => set("consignor", v)} emptyText="The customer" />
                <PartyField data={data} label="Consignee" value={form.consignee} onChange={(v) => set("consignee", v)} emptyText="The customer" phone />
              </div>

              {seesMoney && <>
              <h4>Rate</h4>
              <div className="cn-row-rate-controls">
                <UnitInput label="Price" unit={data.currencies?.find((x) => x.id === form.rateCurrencyId)?.code ?? ""} value={form.ratePrice} onChange={(v) => set("ratePrice", v)} />
                {(data.currencies?.length ?? 0) > 1 && (
                  <select className="input" aria-label="Currency of the price" value={form.rateCurrencyId} onChange={(e) => set("rateCurrencyId", e.target.value)}>
                    {(data.currencies ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
                  </select>
                )}
                <select className="input" aria-label="Per what" value={form.rateBasis} onChange={(e) => set("rateBasis", e.target.value)}>
                  {RATE_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                </select>
                {!["per_consignment", "per_km"].includes(form.rateBasis) && (
                  <select className="input" aria-label="On which quantity" value={form.rateOn} onChange={(e) => set("rateOn", e.target.value as Form["rateOn"])}>
                    <option value="">on the company's usual quantity</option>
                    <option value="loaded">on the loaded quantity</option>
                    <option value="delivered">on the delivered quantity</option>
                  </select>
                )}
              </div>
              <p className="muted">{form.ratePrice.trim() ? "This price is used instead of any tariff." : "Empty: a matching tariff prices it, or it stays unpriced until a price is set."}</p>
              </>}

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
                        <Field label="Pieces"><UnitInput label={`Pieces, line ${i + 1}`} unit="pieces" step={1} value={l.pieces} onChange={(v) => setLine(l.key, { pieces: v })} /></Field>
                        <Field label="Gross weight"><UnitInput label={`Gross weight, line ${i + 1}`} unit="kg" value={l.grossKg} onChange={(v) => setLine(l.key, { grossKg: v })} /></Field>
                        <Field label="Volume"><UnitInput label={`Volume, line ${i + 1}`} unit="m³" value={l.volumeM3} onChange={(v) => setLine(l.key, { volumeM3: v })} /></Field>
                        <Field label="Declared value"><UnitInput label={`Declared value, line ${i + 1}`} unit={base?.code ?? ""} value={l.declaredValue} onChange={(v) => setLine(l.key, { declaredValue: v })} /></Field>
                        <SwitchField label="Hazardous" checked={l.hazard} onChange={(on) => setLine(l.key, { hazard: on })} />
                      </div>
                    </div>
                  );
                })}
                {editable && <div><Button size="sm" onClick={() => set("lines", [...form.lines, newLine()])}><Plus size={14} /> Add a line</Button></div>}
              </div>

              <h4>References</h4>
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
              {!id && <p className="muted">It is loaded at the {wl(data, "trip")}'s next loading stop and dropped at the offloading stop after it. Change that under Loads and drops once it is added.</p>}
            </fieldset>
          )}

          {tab === "legs" && c && <Legs data={data} c={c} splittable={maySplit(c, types.data)} onSplit={() => setSplitting(true)} />}
          {tab === "documents" && c && <Papers data={data} c={c} />}
          {tab === "revenue" && c?.revenue && <RevenuePanel c={c} onChanged={() => after("Revenue updated.")} />}
          {tab === "history" && c && <History data={data} c={c} />}
        </>
      )}
      {splitting && c && <SplitDelivery c={c} onClose={() => setSplitting(false)} onSaved={() => { setSplitting(false); void after("The drops are saved and the driver has the new stops."); }} />}
    </Drawer>
  );
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
function Legs({ data, c, splittable, onSplit }: { data: ReturnType<typeof useApp>["data"]; c: Cn; splittable: boolean; onSplit: () => void }) {
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
      {open && splittable && <div><Button onClick={onSplit}>Split delivery</Button></div>}
      {open && !splittable && <p className="muted">This {w(data, "consignment").toLowerCase()}'s type is dropped at one place. To split it between places, give it a type that allows several drops under Details.</p>}
    </div>
  );
}

function Papers({ data, c }: { data: ReturnType<typeof useApp>["data"]; c: Cn }) {
  const where = (legId?: string) => {
    const l = c.legs.find((x) => x.id === legId);
    return l ? `${l.kind === "pickup" ? "Pickup" : "Drop"} at ${l.placeId ? placeName(data, l.placeId) : "a place to be confirmed"}` : "The consignment";
  };
  if (!c.documents.length) return <Empty title="No papers yet">The loading invoice, weighbridge ticket, delivery note and proof of delivery appear here as they are recorded.</Empty>;
  return (
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
  );
}

function History({ data, c }: { data: ReturnType<typeof useApp>["data"]; c: Cn }) {
  const moves = ((c as unknown as Rec).movements ?? []) as Rec[];
  return (
    <div className="cn-history">
      <p>Booked {day(c.bookedAt)} {clockTime(c.bookedAt)}{c.loadedAt ? ` · loaded ${day(c.loadedAt)}` : ""}{c.deliveredAt ? ` · delivered ${day(c.deliveredAt)}` : ""}.</p>
      {moves.length > 0 && (
        <>
          <h4>Trips it has been on</h4>
          <ol className="plain">
            {moves.map((m, i) => (
              <li key={i}><span className="mono">{byId(data.trips, String(m.tripId))?.no ?? "A trip"}</span> from {day(String(m.from))}{m.to ? ` to ${day(String(m.to))}` : ", now"}{m.reason && m.reason !== "assigned" ? ` · ${String(m.reason)}` : ""}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
