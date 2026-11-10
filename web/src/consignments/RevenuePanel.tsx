import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { Rec } from "../api/adapter";
import { can } from "../api/session";
import { useApp } from "../store";
import { Button, Field, Modal, Status, Switch, SwitchField, UnitInput } from "../ui/kit";
import { num } from "../ui/format";
import { REVENUE_LABEL, revenueTone, type Cn, type Revenue } from "./model";
import { moneyText } from "./TripConsignments";

/**
 * What a consignment is worth, and why (#135, design 3.11.7): the figure line, the lines with where each came from,
 * the engine's own sentences, and the actions a person may take: reprice, add a charge, set the price by hand,
 * freeze or reopen. An unpriced one says why and how to get out of it.
 */

const SOURCE: Record<string, string> = { tariff: "Tariff", auto: "Automatic", manual: "Typed" };
const CHARGE_ON: Record<string, string> = { loaded: "Loaded", delivered: "Delivered", planned: "Planned", greater_of: "The greater", lesser_of: "The lesser" };

export function RevenuePanel({ c, onChanged }: { c: Cn; onChanged: () => void }) {
  const { data, me, toast, nav } = useApp();
  const revenue = useQuery({ queryKey: ["revenue", c.id, c.version], queryFn: () => api<Revenue>(`/consignments/${c.id}/revenue`).catch(() => c.revenue ?? null), initialData: c.revenue });
  const r = revenue.data ?? c.revenue;
  const [dialog, setDialog] = useState<null | "charge" | "manual" | "reopen">(null);
  const [busy, setBusy] = useState(false);
  const mayUpdate = can(me, "consignment-revenue", "update");
  const mayManage = can(me, "consignment-revenue", "archive");
  if (!r) return null;
  const cur = r.currencyId;
  const fixed = r.status === "frozen" || r.status === "invoiced";

  const act = async (path: string, body: Rec | undefined, message: string) => {
    setBusy(true);
    try {
      await api(`/consignments/${c.id}${path}`, { method: path.startsWith("/revenue/lines/") ? "PATCH" : "POST", body });
      toast(message);
      setDialog(null);
      await revenue.refetch();
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
    }
  };

  const base = data.baseCurrency;
  return (
    <div className="revenue-panel">
      <div className="figure-line">
        <div><span>Status</span><Status tone={revenueTone(r.status)}>{REVENUE_LABEL[r.status]}</Status></div>
        <div><span>Tariff</span><b>{r.tariff ? <>{r.tariff.name ?? r.tariff.code}{r.tariff.version ? <span className="muted"> v{r.tariff.version}</span> : null}</> : r.manual ? "Priced by hand" : "None"}</b></div>
        <div><span>Charged on</span><b>{r.basis?.chargeOn ? `${CHARGE_ON[r.basis.chargeOn] ?? r.basis.chargeOn}${r.basis.qty !== undefined ? ` · ${num(r.basis.qty, 0, 3)} ${r.basis.unit ?? ""}` : ""}` : "—"}</b></div>
        <div><span>Total</span><b className="num">{r.status === "unpriced" ? "—" : moneyText(data, r.totalMinor, cur)}</b></div>
        {base && cur !== base.id && r.status !== "unpriced" && <div><span>In {base.code}</span><b className="num">{r.baseTotalMinor !== undefined ? `${moneyText(data, r.baseTotalMinor, base.id)}${r.rateToBase ? ` at ${num(r.rateToBase, 0, 4)}` : ""}` : "No rate yet"}</b></div>}
      </div>

      {r.status === "unpriced" && (
        <div className="revenue-unpriced" role="status">
          <p>{r.problem ?? "No tariff covers this consignment."}</p>
          {mayUpdate && (
            <div className="row-actions">
              {can(me, "tariffs", "create") && <Button onClick={() => nav({ view: "masters", masterEntity: "tariffs" })}>Add a tariff</Button>}
              <Button onClick={() => setDialog("manual")}>Set the price by hand</Button>
            </div>
          )}
        </div>
      )}

      {r.lines.length > 0 && (
        <div className="table-frame">
          <table className="table">
            <thead><tr><th>Charge</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Amount</th><th className="num">Tax</th><th>From</th><th>Include</th></tr></thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id} className={l.accepted === false ? "muted" : ""}>
                  <td>{l.description}{l.note ? <span className="muted"> · {l.note}</span> : null}</td>
                  <td className="num">{l.qty === undefined ? "" : `${num(l.qty, 0, 3)}${l.unit ? ` ${l.unit}` : ""}`}</td>
                  <td className="num">{l.unitPriceMinor === undefined ? "" : unitPrice(data, l.unitPriceMinor, cur)}</td>
                  <td className="num">{moneyText(data, l.amountMinor, cur)}</td>
                  <td className="num">{l.taxMinor ? moneyText(data, l.taxMinor, cur) : ""}</td>
                  <td>{SOURCE[l.source] ?? l.source}</td>
                  <td>{(l.source === "auto" || l.source === "manual") && mayUpdate && !fixed
                    ? <Switch label={`Include ${l.description}`} checked={l.accepted !== false} onChange={(on) => void act(`/revenue/lines/${l.id}`, { accepted: on }, on ? "Line included." : "Line left out.")} disabled={busy} />
                    : <span className="muted">{l.accepted === false ? "No" : "Yes"}</span>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={3}>Before tax</td><td className="num">{moneyText(data, r.subtotalMinor, cur)}</td><td colSpan={3} /></tr>
              {r.taxMinor ? <tr><td colSpan={3}>Tax</td><td className="num">{moneyText(data, r.taxMinor, cur)}</td><td colSpan={3} /></tr> : null}
              <tr><td colSpan={3}><b>Total</b></td><td className="num"><b>{moneyText(data, r.totalMinor, cur)}</b></td><td colSpan={3} /></tr>
            </tfoot>
          </table>
        </div>
      )}

      {r.explanation.length > 0 && !(r.status === "unpriced" && r.explanation.length === 1) && (
        <section>
          <h4>How this was worked out</h4>
          <ol className="revenue-explain">{r.explanation.map((s, i) => <li key={i}>{s}</li>)}</ol>
          {r.lines.filter((l) => l.formula).map((l) => (
            <p key={l.id} className="muted">{l.description}: <span className="mono">{l.formula}</span>{l.variables ? `, with ${Object.entries(l.variables).map(([k, v]) => `${k} = ${typeof v === "number" ? num(v, 0, 3) : String(v)}`).join(", ")}` : ""}</p>
          ))}
        </section>
      )}

      {mayUpdate && (
        <div className="row-actions revenue-actions">
          {!fixed && <Button busy={busy} onClick={() => void act("/reprice", undefined, "Worked out again.")}>Reprice</Button>}
          {!fixed && <Button onClick={() => setDialog("charge")}>Add a charge</Button>}
          {!fixed && r.status !== "unpriced" && <Button onClick={() => setDialog("manual")}>Set the price by hand</Button>}
          {!fixed && r.status !== "unpriced" && <Button onClick={() => void act("/revenue/freeze", undefined, "The price is frozen.")}>Freeze</Button>}
          {r.status === "frozen" && mayManage && <Button onClick={() => setDialog("reopen")}>Reopen pricing</Button>}
        </div>
      )}

      {dialog === "charge" && <AddCharge currencyId={cur} busy={busy} onClose={() => setDialog(null)} onSave={(body) => void act("/revenue/lines", body, "Charge added.")} />}
      {dialog === "manual" && <ManualPrice currencyId={cur ?? base?.id} needsReason={data.settings.freight.manualPriceNeedsReason} busy={busy} onClose={() => setDialog(null)} onSave={(body) => void act("/revenue/manual", body, "Price set by hand.")} />}
      {dialog === "reopen" && <Reopen busy={busy} onClose={() => setDialog(null)} onSave={(reason) => void act("/revenue/reopen", { reason }, "Pricing reopened.")} />}
    </div>
  );
}

/** A unit price keeps fractions of a minor unit: 0.085 USD a litre. */
function unitPrice(data: ReturnType<typeof useApp>["data"], minor: number, currencyId?: string) {
  const c = data.currencies?.find((x) => x.id === currencyId);
  const units = c?.minorUnits ?? 2;
  return `${num(minor / 10 ** units, 0, units + 4)} ${c?.code ?? ""}`.trim();
}

function useCurrency(currencyId?: string) {
  const { data } = useApp();
  return data.currencies?.find((c) => c.id === currencyId) ?? data.baseCurrency;
}

function AddCharge({ currencyId, busy, onClose, onSave }: { currencyId?: string; busy: boolean; onClose: () => void; onSave: (body: Rec) => void }) {
  const types = useQuery({ queryKey: ["charge-types-active"], queryFn: () => api<Rec[]>("/charge-types", { query: { status: "active", limit: 100 } }) });
  const cur = useCurrency(currencyId);
  const [chargeTypeId, setType] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [description, setDescription] = useState("");
  const units = 10 ** (cur?.minorUnits ?? 2);
  return (
    <Modal open title="Add a charge" onClose={onClose} footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" busy={busy} disabled={!chargeTypeId || price === "" || !cur} onClick={() => onSave({ chargeTypeId, ...(description.trim() ? { description: description.trim() } : {}), qty: Number(qty || 1), unitPrice: { amountMinor: Math.round(Number(price) * units), currencyId: cur!.id }, ...(note.trim() ? { note: note.trim() } : {}) })}>Add the charge</Button></>}>
      <div className="grid-2">
        <Field label="Charge">
          <select value={chargeTypeId} onChange={(e) => setType(e.target.value)}>
            <option value="">Choose…</option>
            {(types.data ?? []).map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>)}
          </select>
        </Field>
        <Field label="Words on the bill" hint="Empty: the charge's name."><input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Quantity"><UnitInput label="Quantity" unit="" value={qty} onChange={setQty} /></Field>
        <Field label="Price each"><UnitInput label="Price each" unit={cur?.code ?? ""} value={price} onChange={setPrice} /></Field>
      </div>
      <Field label="Note"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it is charged" /></Field>
    </Modal>
  );
}

function ManualPrice({ currencyId, needsReason, busy, onClose, onSave }: { currencyId?: string; needsReason: boolean; busy: boolean; onClose: () => void; onSave: (body: Rec) => void }) {
  const { data } = useApp();
  const [cid, setCid] = useState(currencyId ?? data.baseCurrency?.id ?? "");
  const cur = data.currencies?.find((c) => c.id === cid);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [whole, setWhole] = useState(false);
  const units = 10 ** (cur?.minorUnits ?? 2);
  return (
    <Modal open title="Set the price by hand" onClose={onClose} footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" busy={busy} disabled={amount === "" || !cid || (needsReason && !reason.trim())} onClick={() => onSave({ amount: { amountMinor: Math.round(Number(amount) * units), currencyId: cid }, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(whole ? { whole: true } : {}) })}>Set the price</Button></>}>
      <p className="muted">It replaces the tariff's freight. Extra charges and deductions are still worked out, unless this is the whole price. A reprice keeps it.</p>
      <div className="grid-2">
        <Field label="Freight"><UnitInput label="Freight" unit={cur?.code ?? ""} value={amount} onChange={setAmount} /></Field>
        <Field label="Currency">
          <select value={cid} onChange={(e) => setCid(e.target.value)}>{(data.currencies ?? []).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select>
        </Field>
      </div>
      <Field label={needsReason ? "Why" : "Why (optional)"}><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Spot rate agreed by phone" /></Field>
      <SwitchField label="This is the whole price" hint="Nothing else is added or taken off." checked={whole} onChange={setWhole} />
    </Modal>
  );
}

function Reopen({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open title="Reopen pricing" onClose={onClose} footer={<><Button tone="quiet" onClick={onClose}>Cancel</Button><Button tone="primary" busy={busy} disabled={!reason.trim()} onClick={() => onSave(reason.trim())}>Reopen</Button></>}>
      <p className="muted">The price is worked out again from the facts and the tariff. An invoiced price can't be reopened; it is corrected with a credit note.</p>
      <Field label="Why"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
