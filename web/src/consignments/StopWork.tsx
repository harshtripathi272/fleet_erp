import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Plus } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { useApp } from "../store";
import { placeName } from "../domain/helpers";
import { byId, measureFuel, round } from "../domain/calc";
import { w, wl } from "../domain/words";
import type { DriverDoc, Product, Stop, Trip } from "../domain/types";
import { Button, Empty, Field, Status, UnitInput } from "../ui/kit";
import { clockTime, day, hoursText, num } from "../ui/format";
import { DocHeader, DocPhoto, ReturnDoc, UploadDoc } from "../desks/stages";
import { usePlacement } from "../desks/usePlacement";
import { CN_STATUS_LABEL, REFUSAL_OUTCOME, cnStatusTone, maySplit, type Cn, type CnLeg, type CnRefusal } from "./model";
import { ConsignmentDrawer } from "./ConsignmentDrawer";
import { SplitDelivery } from "./SplitDelivery";

/**
 * Loading and offloading by stop (#135, design 3.11.4 and 3.11.5), because that is how the work arrives: per stop a
 * heading line, a table of the consignments picked up or dropped there, and "Record" opening a working area with the
 * driver's photo beside the form. Photos not yet filed on a consignment are filed in two clicks. The gate says in
 * words what holds the truck. With one consignment and one stop it is one heading and one row.
 */

type Kind = "pickup" | "drop";
type Gate = { gate: { index: number; stopId: string; reason: string; why: string } | null };

export function StopWork({ trip, kind }: { trip: Trip; kind: Kind }) {
  const { data } = useApp();
  const [adding, setAdding] = useState(false);
  const cns = data.cns.filter((c) => c.tripId === trip.id && c.status !== "cancelled");
  const stopKind = kind === "pickup" ? "load" : "offload";
  // Stops of this kind in route order, and any other stop a consignment's leg of this kind is attached to.
  const stops = trip.stops.filter((s) => s.kind === stopKind || cns.some((c) => c.legs.some((l) => l.kind === kind && l.stopId === s.id)));
  const gate = useQuery({ queryKey: ["trip-gate", trip.id, cns.map((c) => c.version).join()], queryFn: () => api<Gate>(`/trips/${trip.id}/gate`).catch(() => null) });
  const docKind = kind === "pickup" ? "loading" : "delivery";
  const unfiled = data.docs.filter((d) => d.tripId === trip.id && d.status === "new" && !d.consignmentId && (d.kind === docKind || d.kind === "other" || d.kind === "pod" || d.kind === "weighbridge"));
  const current = stops.find((s) => !s.leftAt) ?? stops[stops.length - 1];
  if (!trip.dispatchedAt && kind === "pickup")
    return <Empty title={`Loading at ${placeName(data, stops[0]?.placeId)}`}>Opens once the truck is dispatched.</Empty>;
  return (
    <div className="stop-work stack">
      {unfiled.length > 0 && <PhotosToFile trip={trip} docs={unfiled} cns={cns} kind={kind} />}
      {kind === "drop" && cns.flatMap((c) => (c.refusals ?? []).filter((r) => r.status === "to_decide").map((r) => <RefusalDecision key={r.id} c={c} r={r} />))}
      {stops.map((s) => (
        <StopBlock key={s.id} trip={trip} stop={s} kind={kind} cns={cns} openByDefault={s.id === current?.id} />
      ))}
      {kind === "pickup" && !trip.endedAt && (
        <div><Button tone="quiet" onClick={() => setAdding(true)}><Plus size={15} /> Add a {wl(data, "consignment")} at this stop</Button></div>
      )}
      {/* Only what the server says: a gate that couldn't be read says nothing rather than "free to go". */}
      {gate.data && (
        <p className="framed-line stop-gate">
          {gate.data?.gate ? gate.data.gate.reason : `${byId(data.trucks, trip.truckId)?.plate ?? "The truck"} is free to go on.`}
        </p>
      )}
      {adding && <ConsignmentDrawer tripId={trip.id} onClose={() => setAdding(false)} />}
    </div>
  );
}

function StopBlock({ trip, stop, kind, cns, openByDefault }: { trip: Trip; stop: Stop; kind: Kind; cns: Cn[]; openByDefault: boolean }) {
  const { data } = useApp();
  const [open, setOpen] = useState(openByDefault);
  const [working, setWorking] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<Cn | null>(null);
  const here = cns.flatMap((c) => c.legs.filter((l) => l.kind === kind && l.stopId === stop.id).map((l) => ({ c, l })));
  const types = useQuery({ queryKey: ["consignment-types-active"], queryFn: () => api<Rec[]>("/consignment-types", { query: { limit: 100, status: "active" } }).catch(() => []) });
  const since = stop.arrivedAt && !stop.leftAt ? (Date.now() + data.settings.clockOffsetMs - new Date(stop.arrivedAt).getTime()) / 36e5 : undefined;
  const verb = kind === "pickup" ? "loading" : "delivery";
  return (
    <section className="stop-block">
      <header className="stop-head">
        <div>
          <h3>{placeName(data, stop.placeId)}</h3>
          <p className="muted">
            {kind === "pickup" ? "Loading" : "Offloading"} · {stop.arrivedAt ? `Arrived ${day(stop.arrivedAt)} ${clockTime(stop.arrivedAt)}${stop.arrivedVia === "gps" ? " (GPS)" : ""}` : "On the way"}
            {since !== undefined && ` · Here ${hoursText(since)}`}
            {stop.leftAt && ` · Left ${clockTime(stop.leftAt)}`}
          </p>
        </div>
        {!openByDefault && <Button size="sm" tone="quiet" onClick={() => setOpen(!open)}>{open ? "Hide" : `Show ${here.length}`}</Button>}
      </header>
      {open && (
        here.length === 0 ? <p className="muted">No {wl(data, "consignment", true)} {kind === "pickup" ? "load" : "drop"} here.</p> : (
          <div className="table-frame">
            <table className="table">
              <thead>
                <tr><th>Number</th><th /><th>Status</th><th>{kind === "pickup" ? "Consignor → consignee" : "Consignee"}</th><th>Goods</th><th className="num">Planned</th><th className="num">{kind === "pickup" ? "Loaded" : "Delivered"}</th><th>Papers</th></tr>
              </thead>
              <tbody>
                {here.map(({ c, l }) => {
                  const unit = c.lines[0]?.unit ?? "";
                  // A single drop is planned to take all that was loaded, or the booked quantity before loading (#102).
                  const booked = c.lines.reduce((s, x) => s + (x.plannedQty ?? 0), 0);
                  const loaded = c.legs.filter((x) => x.kind === "pickup").flatMap((x) => x.actual ?? []).reduce((s, m) => s + (m.qty ?? 0), 0);
                  const onlyDrop = c.legs.filter((x) => x.kind === "drop").length === 1;
                  const planned = l.planned?.reduce((s, p) => s + (p.qty ?? 0), 0) ?? (kind === "pickup" ? booked : onlyDrop ? loaded || booked : 0);
                  const done = l.actual?.reduce((s, m) => s + (m.accepted ?? m.qty), 0);
                  const photo = data.docs.find((d) => d.status === "new" && d.consignmentId === c.id && (!d.legId || d.legId === l.id));
                  const papers = c.documents.filter((d) => d.legId === l.id).length;
                  return (
                    <tr key={l.id} className={working === l.id ? "on" : ""}>
                      <td className="mono">{c.number}</td>
                      <td className="stop-actions">
                        {l.status === "planned" && working !== l.id && (
                          <Button size="sm" tone={photo || stop.arrivedAt ? "primary" : "secondary"} onClick={() => setWorking(l.id)}>
                            {photo || stop.arrivedAt ? `Record ${verb}` : "Type it without a photo"}
                          </Button>
                        )}
                        {kind === "drop" && l.status === "planned" && maySplit(c, types.data) && <Button size="sm" tone="quiet" onClick={() => setSplitting(c)}>Split delivery</Button>}
                      </td>
                      <td><Status tone={l.status === "done" ? "ok" : cnStatusTone(c.status)}>{l.status === "done" ? (l.outcome === "partial" ? "Part delivered" : "Done") : CN_STATUS_LABEL[c.status]}</Status></td>
                      <td className="cn-party">{kind === "pickup" ? `${c.consignorName} → ${c.consigneeName}` : l.contact?.name ?? c.consigneeName}</td>
                      <td>{byId(data.products, c.lines[0]?.productId)?.name ?? "—"}{c.lines.length > 1 ? ` +${c.lines.length - 1}` : ""}</td>
                      <td className="num">{planned ? `${num(planned, 0, 3)} ${unit}` : "—"}</td>
                      <td className="num">{done !== undefined && l.status === "done" ? `${num(done, 0, 3)} ${unit}` : "—"}</td>
                      <td>{papers ? `${papers} in` : photo ? "A photo is waiting" : l.status === "done" && kind === "pickup" ? <span className="cn-warn">Invoice missing</span> : <span className="muted">None yet</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
      {working && (() => {
        const found = here.find((x) => x.l.id === working);
        return found ? <RecordLeg key={working} trip={trip} c={found.c} leg={found.l} kind={kind} onDone={() => setWorking(null)} /> : null;
      })()}
      {splitting && <SplitDelivery c={splitting} onClose={() => setSplitting(null)} onSaved={() => setSplitting(null)} />}
    </section>
  );
}

type MeasureForm = { lineId: string; qty: string; ambientL: string; tempC: string; density: string; cert: string; gross: string; tare: string; ticketNo: string; pieces: string; accepted: string; damaged: string };
type DocForm = { key: string; documentTypeId: string; number: string; date: string; amount: string };
let docKeys = 0;

/** The working area for one pickup or drop: the photo at reading size on the left, the form on the right. */
function RecordLeg({ trip, c, leg, kind, onDone }: { trip: Trip; c: Cn; leg: CnLeg; kind: Kind; onDone: () => void }) {
  const { data, toast } = useApp();
  const client = useQueryClient();
  const photo = data.docs.find((d) => d.status === "new" && d.tripId === trip.id && (d.consignmentId === c.id || (!d.consignmentId && d.kind === (kind === "pickup" ? "loading" : "delivery"))));
  const read = photo?.read ?? {};
  const types = useQuery({ queryKey: ["consignment-document-types"], queryFn: () => api<Rec[]>("/consignment-document-types", { query: { status: "active", limit: 100 } }).catch(() => []) });
  const step = kind === "pickup" ? "pickup" : "drop";
  const offered = (types.data ?? []).filter((t) => t.step === step);
  // The company's own fields at loading or delivery (Customise), as the single-load form had them (#102).
  const company = usePlacement("consignments", kind === "pickup" ? "loading" : "delivery", c.custom);
  const [docs, setDocs] = useState<DocForm[]>([{ key: `k${++docKeys}`, documentTypeId: "", number: String(read.docNo ?? ""), date: "", amount: "" }]);
  const [measures, setMeasures] = useState<MeasureForm[]>(() => c.lines.map((l) => ({
    lineId: l.id, qty: "", ambientL: read.ambientL != null ? String(read.ambientL) : "", tempC: read.tempC != null ? String(read.tempC) : "", density: read.density != null ? String(read.density) : "",
    cert: read.certStd20L != null ? String(read.certStd20L) : "", gross: "", tare: "", ticketNo: "", pieces: "", accepted: "", damaged: "",
  })));
  const [pod, setPod] = useState({ number: String(read.docNo ?? ""), receivedBy: "", receivedAt: "", remarks: "" });
  const [seals, setSeals] = useState((c.references?.sealNos ?? []).join(", "));
  const [override, setOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const setM = (lineId: string, patch: Partial<MeasureForm>) => setMeasures(measures.map((m) => (m.lineId === lineId ? { ...m, ...patch } : m)));
  const setD = (key: string, patch: Partial<DocForm>) => setDocs(docs.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const productOf = (lineId: string) => byId(data.products, c.lines.find((l) => l.id === lineId)?.productId) as Product | undefined;
  const base = data.baseCurrency;

  const body = useMemo(() => {
    const n = (v: string) => (v.trim() === "" ? undefined : Number(v));
    const out: Rec = {
      measures: measures.map((m) => {
        const p = productOf(m.lineId);
        const fuel = p?.kind === "fuel";
        const weighed = p?.measure === "weighed";
        return Object.fromEntries(Object.entries({
          lineId: m.lineId,
          ...(fuel ? { ambientL: n(m.ambientL), tempC: n(m.tempC), density: n(m.density), certStd20L: n(m.cert), qty: n(m.ambientL) }
            : weighed ? { gross: n(m.gross), tare: n(m.tare), ticketNo: m.ticketNo.trim() || undefined }
            : { qty: n(m.qty), pieces: n(m.pieces) }),
          ...(kind === "drop" ? { accepted: n(m.accepted), damaged: n(m.damaged) } : {}),
        }).filter(([, v]) => v !== undefined));
      }).filter((m) => Object.keys(m).length > 1),
      documents: docs.filter((d) => d.number.trim() || d.documentTypeId).map((d) => Object.fromEntries(Object.entries({
        documentTypeId: d.documentTypeId || undefined, number: d.number.trim() || undefined, date: d.date || undefined,
        amount: d.amount.trim() && base ? { amountMinor: Math.round(Number(d.amount) * 10 ** base.minorUnits), currencyId: base.id } : undefined,
      }).filter(([, v]) => v !== undefined))),
      ...(photo ? { docId: photo.id } : {}),
      ...(kind === "pickup" && seals.trim() ? { sealNos: seals.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(kind === "drop" && (pod.number.trim() || pod.receivedBy.trim()) ? { pod: Object.fromEntries(Object.entries({ number: pod.number.trim() || undefined, receivedBy: pod.receivedBy.trim() || undefined, receivedAt: pod.receivedAt ? new Date(pod.receivedAt).toISOString() : undefined, remarks: pod.remarks.trim() || undefined }).filter(([, v]) => v !== undefined)) } : {}),
      ...(override.trim() ? { override: { reason: override.trim() } } : {}),
      ...(company.custom ? { custom: company.custom } : {}),
    };
    return out;
  }, [measures, docs, photo, seals, pod, override, kind, base, company.custom]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = (body.measures as Rec[]).length > 0 && company.ready;

  const record = async () => {
    setBusy(true);
    setProblem("");
    try {
      const res = await api<Rec>(`/consignments/${c.id}/legs/${leg.id}/record`, { method: "POST", body });
      const checks = res.checks as Rec | undefined;
      const warnings = [...(((checks?.capacity as Rec | undefined)?.warnings as string[] | undefined) ?? []), ...(((checks?.papers as Rec | undefined)?.warnings as string[] | undefined) ?? [])];
      toast(warnings?.length ? warnings.join(" ") : kind === "pickup" ? `Loading of ${c.number} recorded. The driver is told.` : `Delivery of ${c.number} recorded.`);
      await client.refetchQueries({ queryKey: ["operations"] });
      onDone();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="record-leg">
      <div className="record-photo">
        {photo ? <><DocPhoto doc={photo} /><DocHeader doc={photo} /><MovePhoto trip={trip} doc={photo} kind={kind} onMoved={onDone} /></> : (
          <div className="record-nophoto">
            <p className="muted">No photo. Type the figures from the paper, or upload it.</p>
            <UploadDoc trip={trip} kind={kind === "pickup" ? "loading" : "delivery"} label={kind === "pickup" ? "Upload the invoice" : "Upload the delivery note"} />
          </div>
        )}
      </div>
      <div className="record-form">
        <h4>{c.number} · {kind === "pickup" ? c.consignorName : leg.contact?.name ?? c.consigneeName}</h4>
        <section>
          <h5>Papers</h5>
          {docs.map((d, i) => {
            const t = offered.find((x) => x.id === d.documentTypeId);
            return (
              <div key={d.key} className="record-doc">
                <Field label={i ? "Another paper" : "Paper"}>
                  <select value={d.documentTypeId} onChange={(e) => setD(d.key, { documentTypeId: e.target.value })}>
                    <option value="">{kind === "pickup" ? "Loading invoice" : "Delivery note"}</option>
                    {offered.map((x) => <option key={String(x.id)} value={String(x.id)}>{String(x.name)}</option>)}
                  </select>
                </Field>
                <Field label="Number"><input value={d.number} onChange={(e) => setD(d.key, { number: e.target.value })} /></Field>
                {(t?.hasDate ?? false) && <Field label="Date"><input type="date" value={d.date} onChange={(e) => setD(d.key, { date: e.target.value })} /></Field>}
                {(t?.hasAmount ?? (!d.documentTypeId && kind === "pickup")) && <Field label="Value"><UnitInput label="Value" unit={base?.code ?? ""} value={d.amount} onChange={(v) => setD(d.key, { amount: v })} /></Field>}
                {docs.length > 1 && <Button size="sm" tone="quiet" onClick={() => setDocs(docs.filter((x) => x.key !== d.key))}>Remove</Button>}
              </div>
            );
          })}
          <Button size="sm" onClick={() => setDocs([...docs, { key: `k${++docKeys}`, documentTypeId: "", number: "", date: "", amount: "" }])}><Plus size={14} /> Add another paper</Button>
        </section>

        <section>
          <h5>Quantities</h5>
          {measures.map((m) => {
            const line = c.lines.find((l) => l.id === m.lineId)!;
            const p = productOf(m.lineId);
            return <MeasureBlock key={m.lineId} product={p} line={line} value={m} onChange={(patch) => setM(m.lineId, patch)} drop={kind === "drop"} multi={c.lines.length > 1} />;
          })}
        </section>

        {kind === "pickup" && !docs.some((d) => d.number.trim()) && (
          <p className="cn-warn">No paper number yet. The truck waits at this stop until the loading invoice is in: type its number above, or add it later under the {wl(data, "consignment")}'s Papers.</p>
        )}
        {kind === "pickup" && <Field label="Seal numbers" hint="Separated by commas."><input value={seals} onChange={(e) => setSeals(e.target.value)} /></Field>}
        {kind === "drop" && (
          <section className="grid-2">
            <Field label="Proof of delivery number"><input value={pod.number} onChange={(e) => setPod({ ...pod, number: e.target.value })} /></Field>
            <Field label="Received by"><input value={pod.receivedBy} onChange={(e) => setPod({ ...pod, receivedBy: e.target.value })} /></Field>
            <Field label="Received at"><input type="datetime-local" value={pod.receivedAt} onChange={(e) => setPod({ ...pod, receivedAt: e.target.value })} /></Field>
            <Field label="Remarks on the paper"><input value={pod.remarks} placeholder="2 bags torn" onChange={(e) => setPod({ ...pod, remarks: e.target.value })} /></Field>
          </section>
        )}
        {company.block}
        {problem && (
          <div className="form-problem" role="alert">
            {problem}
            {/Give a reason to record it anyway/.test(problem) && <Field label="Why record it anyway"><input value={override} onChange={(e) => setOverride(e.target.value)} /></Field>}
          </div>
        )}
        <div className="record-actions">
          {photo && <ReturnDoc doc={photo as DriverDoc} />}
          <Button tone="quiet" onClick={onDone}>Cancel</Button>
          <Button tone="primary" busy={busy} disabled={!ready} onClick={() => void record()}><Check /> {kind === "pickup" ? "Record loading" : "Record delivery"}</Button>
        </div>
      </div>
    </div>
  );
}

/** The quantities of one goods line, shaped by the product (today's measure form, kept whole). */
function MeasureBlock({ product, line, value, onChange, drop, multi }: { product?: Product; line: Cn["lines"][number]; value: MeasureForm; onChange: (p: Partial<MeasureForm>) => void; drop: boolean; multi: boolean }) {
  const fuel = product?.kind === "fuel";
  const weighed = product?.measure === "weighed";
  const unit = product?.unit ?? line.unit;
  const measure = fuel && product && value.ambientL && value.tempC && value.density ? measureFuel(product, { ambientL: Number(value.ambientL), tempC: Number(value.tempC), density: Number(value.density) }) : undefined;
  const net = weighed && value.gross && value.tare && Number(value.gross) > Number(value.tare) ? round(Number(value.gross) - Number(value.tare), product?.decimals ?? 3) : undefined;
  return (
    <div className="measure-block">
      {multi && <p className="measure-line">{product?.name ?? "Goods"}{line.plannedQty ? <span className="muted"> · {num(line.plannedQty, 0, 3)}&nbsp;{unit} planned</span> : null}</p>}
      <div className="grid-3">
        {fuel ? (
          <>
            <Field label="Observed litres"><UnitInput label="Observed litres" unit="L" value={value.ambientL} onChange={(v) => onChange({ ambientL: v })} /></Field>
            <Field label="Temperature"><UnitInput label="Temperature" unit="°C" step={0.1} value={value.tempC} onChange={(v) => onChange({ tempC: v })} /></Field>
            <Field label="Density"><UnitInput label="Density" unit="kg/m³" step={0.1} value={value.density} onChange={(v) => onChange({ density: v })} /></Field>
            <Field label="Certificate at 20 °C" hint="Only if the terminal printed one."><UnitInput label="Certificate at 20 °C" unit="L" value={value.cert} onChange={(v) => onChange({ cert: v })} /></Field>
          </>
        ) : weighed ? (
          <>
            <Field label="Weighbridge ticket"><input value={value.ticketNo} onChange={(e) => onChange({ ticketNo: e.target.value })} /></Field>
            <Field label="Gross"><UnitInput label="Gross" unit={unit} value={value.gross} onChange={(v) => onChange({ gross: v })} /></Field>
            <Field label="Tare"><UnitInput label="Tare" unit={unit} value={value.tare} onChange={(v) => onChange({ tare: v })} /></Field>
          </>
        ) : (
          <>
            <Field label="Quantity"><UnitInput label="Quantity" unit={unit} value={value.qty} onChange={(v) => onChange({ qty: v })} /></Field>
            <Field label="Pieces"><UnitInput label="Pieces" unit="pieces" step={1} value={value.pieces} onChange={(v) => onChange({ pieces: v })} /></Field>
          </>
        )}
        {drop && (
          <>
            <Field label="Accepted" hint="Empty: all of it."><UnitInput label="Accepted" unit={fuel ? "L" : unit} value={value.accepted} onChange={(v) => onChange({ accepted: v })} /></Field>
            <Field label="Damaged"><UnitInput label="Damaged" unit={fuel ? "L" : unit} value={value.damaged} onChange={(v) => onChange({ damaged: v })} /></Field>
          </>
        )}
      </div>
      {measure && (
        <div className="calc-strip" aria-live="polite">
          <span>{num(Number(value.ambientL))}&nbsp;L × <b>{measure.vcf?.toFixed(5)}</b> correction</span>
          <ArrowRight size={15} />
          <strong>{num(value.cert ? Number(value.cert) : measure.std20L ?? 0)}&nbsp;L at 20&nbsp;°C</strong>
        </div>
      )}
      {net !== undefined && <div className="calc-strip"><strong>{num(net, 0, 3)}&nbsp;{unit} net</strong></div>}
    </div>
  );
}

/**
 * Goods the consignee refused at a drop (#102): they arrived, the customer isn't billed for them, and the trip can't
 * close until the office says what happens to them.
 */
function RefusalDecision({ c, r }: { c: Cn; r: CnRefusal }) {
  const { data, toast } = useApp();
  const client = useQueryClient();
  const [outcome, setOutcome] = useState<NonNullable<CnRefusal["outcome"]>>("return");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const leg = c.legs.find((l) => l.id === r.legId);
  const decide = async () => {
    setBusy(true);
    try {
      await api(`/consignments/${c.id}/refusals/${r.id}/decide`, { method: "POST", body: { outcome, ...(note.trim() ? { note: note.trim() } : {}) } });
      toast("Decided.");
      await client.refetchQueries({ queryKey: ["operations"] });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="refusal-decision">
      <h3>{num(r.qty, 0, 3)} {r.unit} of {c.number} refused{leg?.placeId ? ` at ${placeName(data, leg.placeId)}` : ""}</h3>
      <p className="muted">{r.reason ? `${r.reason}. ` : ""}The customer isn't billed for it. Say what happens to it before the {wl(data, "trip")} closes.</p>
      <div className="grid-3">
        <Field label="What happens to it">
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as NonNullable<CnRefusal["outcome"]>)}>
            {(Object.keys(REFUSAL_OUTCOME) as Array<keyof typeof REFUSAL_OUTCOME>).map((k) => <option key={k} value={k}>{REFUSAL_OUTCOME[k]}</option>)}
          </select>
        </Field>
        <Field label="Note"><input value={note} placeholder="Water in it; poured off at the depot" onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="refusal-actions"><Button tone="primary" busy={busy} onClick={() => void decide()}>Decide</Button></div>
      </div>
    </section>
  );
}

/** Photos the driver sent that aren't filed on a consignment yet: say what each is and which consignment it is for. */
function PhotosToFile({ trip, docs, cns, kind }: { trip: Trip; docs: DriverDoc[]; cns: Cn[]; kind: Kind }) {
  const { data, toast } = useApp();
  const client = useQueryClient();
  const types = useQuery({ queryKey: ["consignment-document-types"], queryFn: () => api<Rec[]>("/consignment-document-types", { query: { status: "active", limit: 100 } }).catch(() => []) });
  const [choice, setChoice] = useState<Record<string, { documentTypeId: string; target: string }>>({});
  const file = async (d: DriverDoc) => {
    const pick = choice[d.id];
    if (!pick?.target) return;
    const [consignmentId, legId] = pick.target.split(":");
    try {
      await api(`/driver-documents/${d.id}/file`, { method: "POST", body: { ...(pick.documentTypeId ? { documentTypeId: pick.documentTypeId } : {}), consignmentId, ...(legId ? { legId } : {}) } });
      toast("Filed.");
      await client.refetchQueries({ queryKey: ["operations"] });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "error");
    }
  };
  const targets = cns.flatMap((c) => c.legs.filter((l) => l.kind === kind && l.status !== "skipped").map((l) => ({ value: `${c.id}:${l.id}`, label: `${c.number} · ${kind === "pickup" ? "pickup" : "drop"} at ${l.placeId ? placeName(data, l.placeId) : "a place to be confirmed"}` })));
  return (
    <section className="photos-to-file">
      <h3>Photos to file</h3>
      <p className="muted">The driver sent these without saying which {wl(data, "consignment")} they are for.</p>
      <div className="photo-strip">
        {docs.map((d) => (
          <div key={d.id} className="photo-file">
            <DocPhoto doc={d} size="sm" />
            <Field label="This is">
              <select value={choice[d.id]?.documentTypeId ?? ""} onChange={(e) => setChoice({ ...choice, [d.id]: { target: choice[d.id]?.target ?? "", documentTypeId: e.target.value } })}>
                <option value="">As sent ({d.kind})</option>
                {(types.data ?? []).map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>)}
              </select>
            </Field>
            <Field label="For">
              <select value={choice[d.id]?.target ?? ""} onChange={(e) => setChoice({ ...choice, [d.id]: { documentTypeId: choice[d.id]?.documentTypeId ?? "", target: e.target.value } })}>
                <option value="">Choose…</option>
                {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Button size="sm" disabled={!choice[d.id]?.target} onClick={() => void file(d)}>File it</Button>
          </div>
        ))}
      </div>
      {trip.endedAt && <p className="muted">The {wl(data, "trip")} has ended; filing still puts the paper on its {w(data, "consignment").toLowerCase()}.</p>}
    </section>
  );
}

/** The driver picked the wrong consignment: the office moves the photo to the right one (#135 Part 2). */
function MovePhoto({ trip, doc, kind, onMoved }: { trip: Trip; doc: DriverDoc; kind: Kind; onMoved: () => void }) {
  const { data, toast } = useApp();
  const client = useQueryClient();
  const [target, setTarget] = useState("");
  const options = data.cns.filter((c) => c.tripId === trip.id && c.status !== "cancelled").flatMap((c) => c.legs
    .filter((l) => l.kind === kind && l.status === "planned" && !(c.id === doc.consignmentId && l.id === doc.legId))
    .map((l) => ({ value: `${c.id}:${l.id}`, label: `${c.number} · ${kind === "pickup" ? c.consignorName : l.contact?.name ?? c.consigneeName}${l.placeId ? ` at ${placeName(data, l.placeId)}` : ""}` })));
  if (!options.length) return null;
  const move = async () => {
    const [consignmentId, legId] = target.split(":");
    try {
      await api(`/driver-documents/${doc.id}/file`, { method: "POST", body: { consignmentId, legId, ...(doc.documentTypeId ? { documentTypeId: doc.documentTypeId } : {}) } });
      toast("Moved.");
      await client.refetchQueries({ queryKey: ["operations"] });
      onMoved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "error");
    }
  };
  const current = data.cns.find((c) => c.id === doc.consignmentId);
  return (
    <div className="move-photo">
      <span className="muted">{current ? `The driver sent it for ${current.number}.` : "Not filed on a consignment yet."}</span>
      <div className="cn-row-leg">
        <select className="input" aria-label="It is for" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{current ? "It is for another one…" : "It is for…"}</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Button size="sm" disabled={!target} onClick={() => void move()}>Move it</Button>
      </div>
    </div>
  );
}
